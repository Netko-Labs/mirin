//! mirin: render pipelines built on first use and shared by every window of
//! a GPU context (port of `../../../gpui`'s `BladePipelineCache` row).
//!
//! Upstream built all ten pipelines (and parsed the shaders twice, once for
//! the subpixel variant) when a window's renderer was created, and again when
//! the window turned out opaque (`update_transparency`): ~22 ms of a small
//! app's start, for a window that draws quads and text. Each pipeline is now
//! built by the first frame that draws with it, for the target format and
//! alpha mode it draws to; the shader modules and bind group layouts are
//! made once per context.

use crate::wgpu_renderer::WgpuBindGroupLayouts;
use parking_lot::Mutex;
use std::sync::{Arc, OnceLock};

/// What a set of pipelines depends on besides the device.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) struct PipelineKey {
    pub surface_format: wgpu::TextureFormat,
    pub alpha_mode: wgpu::CompositeAlphaMode,
    pub dual_source_blending: bool,
    pub uses_webgl_instance_data: bool,
    /// Whether the pass they draw in has a depth attachment
    /// (`wgpu_renderer.rs`'s `DEPTH_BUFFER_QUADS`): they test it then.
    pub depth: bool,
}

/// The pipelines of a context, one set per [`PipelineKey`], and what they
/// share. Lives as long as the context (a device recovery makes a new one).
#[derive(Default)]
pub(crate) struct PipelineCache {
    layouts: OnceLock<Arc<WgpuBindGroupLayouts>>,
    shaders: OnceLock<Arc<Shaders>>,
    sets: Mutex<Vec<Arc<WgpuPipelines>>>,
}

impl PipelineCache {
    /// The bind group layouts every renderer and pipeline of the context uses.
    pub fn layouts(
        &self,
        device: &wgpu::Device,
        uses_webgl_instance_data: bool,
    ) -> Arc<WgpuBindGroupLayouts> {
        self.layouts
            .get_or_init(|| Arc::new(WgpuBindGroupLayouts::new(device, uses_webgl_instance_data)))
            .clone()
    }

    /// Shader modules parsed ahead (`wgpu_prepare.rs`), for the pipelines
    /// to come. A module already parsed stays.
    /// `shaders` is still being parsed: the first pipeline that needs a
    /// module waits for it rather than parsing it again.
    pub fn seed_shaders(&self, shaders: sumi::Task<ParsedShaders>) {
        let cached = self.shaders.get_or_init(Default::default);
        *cached.pending.lock() = Some(shaders);
    }

    /// The set for `key`, made (empty) if no window drew with it yet.
    pub fn pipelines(&self, device: &Arc<wgpu::Device>, key: PipelineKey) -> Arc<WgpuPipelines> {
        let mut sets = self.sets.lock();
        if let Some(set) = sets.iter().find(|set| set.key == key) {
            return set.clone();
        }
        let set = Arc::new(WgpuPipelines {
            device: device.clone(),
            layouts: self.layouts(device, key.uses_webgl_instance_data),
            shaders: self.shaders.get_or_init(Default::default).clone(),
            key,
            quads: OnceLock::new(),
            opaque_quads: OnceLock::new(),
            shadows: OnceLock::new(),
            path_tiles: OnceLock::new(),
            underlines: OnceLock::new(),
            mono_sprites: OnceLock::new(),
            subpixel_sprites: OnceLock::new(),
            poly_sprites: OnceLock::new(),
        });
        sets.push(set.clone());
        set
    }
}

/// The shader modules a window on a native GPU draws with, parsed on a
/// background thread while the app starts (`wgpu_prepare.rs`).
pub(crate) struct ParsedShaders {
    storage: wgpu::ShaderModule,
    subpixel: Option<wgpu::ShaderModule>,
}

impl ParsedShaders {
    /// Parse the storage-buffer shaders, and the subpixel ones when the
    /// device has dual-source blending.
    pub fn parse(device: &wgpu::Device, dual_source_blending: bool) -> Self {
        let has_dual_source = device
            .features()
            .contains(wgpu::Features::DUAL_SOURCE_BLENDING);
        Self {
            storage: parse(
                device,
                "gpui_shaders",
                crate::wgpu_renderer::STORAGE_BUFFER_SHADERS,
            ),
            subpixel: (dual_source_blending && has_dual_source).then(|| {
                parse(
                    device,
                    "gpui_subpixel_shaders",
                    crate::wgpu_renderer::SUBPIXEL_SHADERS,
                )
            }),
        }
    }
}

fn parse(device: &wgpu::Device, label: &str, source: &'static str) -> wgpu::ShaderModule {
    let started = std::time::Instant::now();
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some(label),
        source: wgpu::ShaderSource::Wgsl(source.into()),
    });
    log::info!(
        target: "mirin::startup",
        "shaders {label} parsed in {:.1}ms",
        started.elapsed().as_secs_f64() * 1000.0
    );
    module
}

/// The shader modules, parsed by the first pipeline that needs each.
#[derive(Default)]
struct Shaders {
    storage: OnceLock<wgpu::ShaderModule>,
    webgl: OnceLock<wgpu::ShaderModule>,
    subpixel: OnceLock<wgpu::ShaderModule>,
    /// Modules being parsed on a background thread (`seed_shaders`).
    pending: Mutex<Option<sumi::Task<ParsedShaders>>>,
}

impl Shaders {
    /// Wait for the modules parsed ahead, if any, and keep them.
    fn take_pending(&self) {
        let Some(task) = self.pending.lock().take() else {
            return;
        };
        let parsed = sumi::block_on(task);
        let _ = self.storage.set(parsed.storage);
        if let Some(subpixel) = parsed.subpixel {
            let _ = self.subpixel.set(subpixel);
        }
    }
}

/// One target's pipelines, each built when first asked for. Upstream's
/// `surfaces` pipeline (macOS video surfaces, never drawn by this renderer)
/// is not built at all.
pub(crate) struct WgpuPipelines {
    device: Arc<wgpu::Device>,
    layouts: Arc<WgpuBindGroupLayouts>,
    shaders: Arc<Shaders>,
    key: PipelineKey,
    quads: OnceLock<wgpu::RenderPipeline>,
    opaque_quads: OnceLock<wgpu::RenderPipeline>,
    shadows: OnceLock<wgpu::RenderPipeline>,
    path_tiles: OnceLock<wgpu::RenderPipeline>,
    underlines: OnceLock<wgpu::RenderPipeline>,
    mono_sprites: OnceLock<wgpu::RenderPipeline>,
    subpixel_sprites: OnceLock<Option<wgpu::RenderPipeline>>,
    poly_sprites: OnceLock<wgpu::RenderPipeline>,
}

impl WgpuPipelines {
    /// Whether the target takes colors multiplied by their alpha, which
    /// the shaders are told in the globals (upstream kept it with the
    /// pipelines it built). mirin: `Inherit` too, which a surface offers
    /// when it can't say (Mesa's Venus): a Wayland compositor (and an X11
    /// one) composites a buffer's alpha as premultiplied, so straight alpha
    /// there shows a 10 % white fill as solid white over a dark backdrop.
    pub fn premultiplied_alpha(&self) -> bool {
        premultiplies(self.key.alpha_mode)
    }

    pub fn quads(&self) -> &wgpu::RenderPipeline {
        self.quads
            .get_or_init(|| self.build_color("quads", "vs_quad", "fs_quad", false, self.module()))
    }

    /// The opaque pass: no blending, and the one pipeline that writes depth.
    pub fn opaque_quads(&self) -> &wgpu::RenderPipeline {
        self.opaque_quads.get_or_init(|| {
            self.build(
                "opaque_quads",
                "vs_opaque_quad",
                "fs_opaque_quad",
                &self.layouts.instances,
                None,
                wgpu::ColorTargetState {
                    format: self.key.surface_format,
                    blend: None,
                    write_mask: wgpu::ColorWrites::ALL,
                },
                true,
                self.module(),
            )
        })
    }

    pub fn path_tiles(&self) -> &wgpu::RenderPipeline {
        self.path_tiles.get_or_init(|| {
            self.build(
                "path_tiles",
                "vs_path_tile",
                "fs_path_tile",
                &self.layouts.path_tiles,
                None,
                self.color_target(),
                false,
                self.module(),
            )
        })
    }

    pub fn shadows(&self) -> &wgpu::RenderPipeline {
        self.shadows.get_or_init(|| {
            self.build_color("shadows", "vs_shadow", "fs_shadow", false, self.module())
        })
    }

    pub fn underlines(&self) -> &wgpu::RenderPipeline {
        self.underlines.get_or_init(|| {
            self.build_color(
                "underlines",
                "vs_underline",
                "fs_underline",
                false,
                self.module(),
            )
        })
    }

    pub fn mono_sprites(&self) -> &wgpu::RenderPipeline {
        self.mono_sprites.get_or_init(|| {
            self.build_color(
                "mono_sprites",
                "vs_mono_sprite",
                "fs_mono_sprite",
                true,
                self.module(),
            )
        })
    }

    pub fn poly_sprites(&self) -> &wgpu::RenderPipeline {
        self.poly_sprites.get_or_init(|| {
            self.build_color(
                "poly_sprites",
                "vs_poly_sprite",
                "fs_poly_sprite",
                true,
                self.module(),
            )
        })
    }

    /// None without dual-source blending (the caller draws mono sprites).
    pub fn subpixel_sprites(&self) -> Option<&wgpu::RenderPipeline> {
        self.subpixel_sprites
            .get_or_init(|| {
                if !self.dual_source_blending() {
                    return None;
                }
                let subpixel_blend = wgpu::BlendState {
                    color: wgpu::BlendComponent {
                        src_factor: wgpu::BlendFactor::Src1,
                        dst_factor: wgpu::BlendFactor::OneMinusSrc1,
                        operation: wgpu::BlendOperation::Add,
                    },
                    alpha: wgpu::BlendComponent {
                        src_factor: wgpu::BlendFactor::One,
                        dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
                        operation: wgpu::BlendOperation::Add,
                    },
                };
                self.shaders.take_pending();
                let module = self.shaders.subpixel.get_or_init(|| {
                    self.parse(
                        "gpui_subpixel_shaders",
                        crate::wgpu_renderer::SUBPIXEL_SHADERS,
                    )
                });
                Some(self.build(
                    "subpixel_sprites",
                    "vs_subpixel_sprite",
                    "fs_subpixel_sprite",
                    &self.layouts.instances,
                    Some(&self.layouts.texture),
                    wgpu::ColorTargetState {
                        format: self.key.surface_format,
                        blend: Some(subpixel_blend),
                        write_mask: wgpu::ColorWrites::COLOR,
                    },
                    false,
                    module,
                ))
            })
            .as_ref()
    }

    /// Upstream's guard (ZED-5G1): dual-source blending only when the device
    /// really has the feature and the instance data is in storage buffers.
    fn dual_source_blending(&self) -> bool {
        let device_has_feature = self
            .device
            .features()
            .contains(wgpu::Features::DUAL_SOURCE_BLENDING);
        if self.key.dual_source_blending && !device_has_feature {
            log::error!(
                "BUG: dual_source_blending flag is true but device does not \
                 have DUAL_SOURCE_BLENDING enabled (device features: {:?}). \
                 Falling back to mono text rendering. Please report this at \
                 https://github.com/zed-industries/zed/issues",
                self.device.features(),
            );
        }
        self.key.dual_source_blending && device_has_feature && !self.key.uses_webgl_instance_data
    }

    fn module(&self) -> &wgpu::ShaderModule {
        if self.key.uses_webgl_instance_data {
            self.shaders
                .webgl
                .get_or_init(|| self.parse("gpui_shaders", crate::wgpu_renderer::WEBGL_SHADERS))
        } else {
            self.shaders.take_pending();
            self.shaders.storage.get_or_init(|| {
                self.parse("gpui_shaders", crate::wgpu_renderer::STORAGE_BUFFER_SHADERS)
            })
        }
    }

    fn parse(&self, label: &str, source: &'static str) -> wgpu::ShaderModule {
        parse(&self.device, label, source)
    }

    /// The window's target with its blending.
    fn color_target(&self) -> wgpu::ColorTargetState {
        let blend = if self.premultiplied_alpha() {
            wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING
        } else {
            wgpu::BlendState::ALPHA_BLENDING
        };
        wgpu::ColorTargetState {
            format: self.key.surface_format,
            blend: Some(blend),
            write_mask: wgpu::ColorWrites::ALL,
        }
    }

    /// A pipeline that draws instances to the window's target with its
    /// blending, tested against the depth the opaque pass wrote.
    fn build_color(
        &self,
        name: &str,
        vs_entry: &str,
        fs_entry: &str,
        textured: bool,
        module: &wgpu::ShaderModule,
    ) -> wgpu::RenderPipeline {
        self.build(
            name,
            vs_entry,
            fs_entry,
            &self.layouts.instances,
            textured.then_some(&self.layouts.texture),
            self.color_target(),
            false,
            module,
        )
    }

    /// Upstream's `create_pipeline`: with a depth buffer every pipeline tests
    /// depth (greater is nearer), and `depth_write_enabled` says whether it
    /// writes it.
    #[allow(clippy::too_many_arguments)]
    fn build(
        &self,
        name: &str,
        vs_entry: &str,
        fs_entry: &str,
        data_layout: &wgpu::BindGroupLayout,
        texture_layout: Option<&wgpu::BindGroupLayout>,
        color_target: wgpu::ColorTargetState,
        depth_write_enabled: bool,
        module: &wgpu::ShaderModule,
    ) -> wgpu::RenderPipeline {
        let started = std::time::Instant::now();
        let mut bind_group_layouts = vec![Some(&self.layouts.globals), Some(data_layout)];
        bind_group_layouts.extend(texture_layout.map(Some));
        let pipeline_layout = self
            .device
            .create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some(&format!("{name}_layout")),
                bind_group_layouts: &bind_group_layouts,
                immediate_size: 0,
            });

        let pipeline = self
            .device
            .create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(name),
                layout: Some(&pipeline_layout),
                vertex: wgpu::VertexState {
                    module,
                    entry_point: Some(vs_entry),
                    buffers: &[],
                    compilation_options: wgpu::PipelineCompilationOptions::default(),
                },
                fragment: Some(wgpu::FragmentState {
                    module,
                    entry_point: Some(fs_entry),
                    targets: &[Some(color_target)],
                    compilation_options: wgpu::PipelineCompilationOptions::default(),
                }),
                primitive: wgpu::PrimitiveState {
                    topology: wgpu::PrimitiveTopology::TriangleStrip,
                    strip_index_format: None,
                    front_face: wgpu::FrontFace::Ccw,
                    cull_mode: None,
                    polygon_mode: wgpu::PolygonMode::Fill,
                    unclipped_depth: false,
                    conservative: false,
                },
                depth_stencil: self.key.depth.then(|| wgpu::DepthStencilState {
                    format: crate::wgpu_renderer::DEPTH_FORMAT,
                    depth_write_enabled: Some(depth_write_enabled),
                    depth_compare: Some(wgpu::CompareFunction::Greater),
                    stencil: wgpu::StencilState::default(),
                    bias: wgpu::DepthBiasState::default(),
                }),
                multisample: wgpu::MultisampleState::default(),
                multiview_mask: None,
                cache: None,
            });
        log::info!(
            target: "mirin::startup",
            "pipeline {name} built in {:.1}ms",
            started.elapsed().as_secs_f64() * 1000.0
        );
        pipeline
    }
}

/// Whether a surface in `mode` takes premultiplied colors (`premultiplied_alpha`).
fn premultiplies(mode: wgpu::CompositeAlphaMode) -> bool {
    matches!(
        mode,
        wgpu::CompositeAlphaMode::PreMultiplied | wgpu::CompositeAlphaMode::Inherit
    )
}

#[cfg(test)]
mod premultiplied_tests {
    #[test]
    fn inherit_is_premultiplied_as_wayland_composites_it() {
        assert!(super::premultiplies(
            wgpu::CompositeAlphaMode::PreMultiplied
        ));
        assert!(super::premultiplies(wgpu::CompositeAlphaMode::Inherit));
        assert!(!super::premultiplies(wgpu::CompositeAlphaMode::Opaque));
        assert!(!super::premultiplies(
            wgpu::CompositeAlphaMode::PostMultiplied
        ));
    }
}
