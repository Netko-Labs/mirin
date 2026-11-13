//! mirin: the GPU context started while the app starts, not when its first
//! window opens.
//!
//! Upstream makes the GPU context when the first window's renderer is
//! created: the Vulkan instance (loading the loader, the driver and, for
//! radv, LLVM: 12–15 ms), the adapters (~5 ms) and a device (~4 ms), one
//! after the other on the main thread, after the platform has connected and
//! the app has built its window. The platform now asks for them as it
//! connects (`WgpuContext::prepare_vulkan`), on a background thread; the
//! first window takes what is ready (waiting for the rest), makes its
//! surface on that instance and tests the device with it, as upstream's
//! adapter selection does. When the prepared device can't draw to the window
//! (or nothing was prepared), the window makes its context as upstream does.

use crate::wgpu_pipelines::ParsedShaders;
use crate::{CompositorGpuHint, WgpuContext, WgpuRenderer, WgpuSurfaceConfig};
use gpui_util::ResultExt as _;
use std::cell::RefCell;

/// A Vulkan instance, its hardware adapters in upstream's order of
/// preference, and a device made on the first of them.
pub(crate) struct PreparedVulkan {
    instance: wgpu::Instance,
    adapters: Vec<wgpu::Adapter>,
    first_device: Option<(wgpu::Device, wgpu::Queue, bool, wgpu::TextureFormat)>,
    /// The shaders, being parsed for `first_device` on another background
    /// thread (~4.5 ms the first frame spent otherwise).
    shaders: Option<gpui::Task<ParsedShaders>>,
}

thread_local! {
    /// The work `prepare_vulkan` started, until a window takes it.
    static PREPARED: RefCell<Option<gpui::Task<Option<PreparedVulkan>>>> =
        const { RefCell::new(None) };
}

impl WgpuContext {
    /// Start making the Vulkan instance, the adapters and a device on
    /// `executor`, for the first window's renderer to take; `compositor_gpu`
    /// (run there too) names the GPU to prefer. Call on the thread that
    /// creates windows.
    pub fn prepare_vulkan(
        executor: &gpui::BackgroundExecutor,
        compositor_gpu: impl FnOnce() -> Option<CompositorGpuHint> + Send + 'static,
    ) {
        let shaders_executor = executor.clone();
        let task = executor.spawn(async move { prepare(compositor_gpu(), shaders_executor).await });
        PREPARED.with(|slot| *slot.borrow_mut() = Some(task));
    }

    /// What `prepare_vulkan` made, once it is done; None if nothing was
    /// started, it was taken already, or no hardware adapter was found.
    pub(crate) fn take_prepared_vulkan() -> Option<PreparedVulkan> {
        let task = PREPARED.with(|slot| slot.borrow_mut().take())?;
        gpui::block_on(task)
    }

    /// The context on what was prepared, and the window's surface made on
    /// its instance by `create_surface`: the first adapter that can draw to
    /// the surface, tested by configuring it, as upstream selects one.
    pub(crate) fn from_prepared_vulkan(
        prepared: PreparedVulkan,
        create_surface: impl FnOnce(&wgpu::Instance) -> anyhow::Result<wgpu::Surface<'static>>,
        config: &WgpuSurfaceConfig,
    ) -> anyhow::Result<(Self, wgpu::Surface<'static>)> {
        let PreparedVulkan {
            instance,
            adapters,
            mut first_device,
            mut shaders,
        } = prepared;
        let surface = create_surface(&instance)?;
        for (index, adapter) in adapters.into_iter().enumerate() {
            let info = adapter.get_info();
            let prepared_device = if index == 0 {
                first_device.take()
            } else {
                None
            };
            let prepared_shaders = if prepared_device.is_some() {
                shaders.take()
            } else {
                None
            };
            let tested = gpui::block_on(async {
                match prepared_device {
                    Some(device) => test_device(&adapter, device, &surface, config).await,
                    None => Self::try_adapter_with_surface(&adapter, &surface, config).await,
                }
            });
            match tested {
                Ok((device, queue, dual_source_blending, color_texture_format)) => {
                    let context = Self::from_native_adapter_and_device(
                        instance,
                        adapter,
                        device,
                        queue,
                        dual_source_blending,
                        color_texture_format,
                    );
                    if let Some(shaders) = prepared_shaders {
                        context.pipeline_cache().seed_shaders(shaders);
                    }
                    return Ok((context, surface));
                }
                Err(error) => log::info!(
                    "Adapter {} ({:?}) failed: {error:#}, trying next...",
                    info.name,
                    info.backend
                ),
            }
        }
        anyhow::bail!("No prepared GPU adapter can configure the display surface")
    }
}

async fn prepare(
    compositor_gpu: Option<CompositorGpuHint>,
    executor: gpui::BackgroundExecutor,
) -> Option<PreparedVulkan> {
    let started = std::time::Instant::now();
    let instance = WgpuContext::vulkan_instance(None);
    let mut adapters = instance.enumerate_adapters(wgpu::Backends::all()).await;
    // Software adapters are left to upstream's way, which tries GL too.
    adapters.retain(|adapter| adapter.get_info().device_type != wgpu::DeviceType::Cpu);
    WgpuContext::sort_adapters(
        &mut adapters,
        WgpuContext::device_id_filter(),
        compositor_gpu.as_ref(),
    );
    let first = adapters.first()?;
    let first_device = WgpuContext::create_device(first).await.log_err();
    let shaders = first_device
        .as_ref()
        .map(|(device, _, dual_source_blending, _)| {
            let device = device.clone();
            let dual_source_blending = *dual_source_blending;
            executor.spawn(async move { ParsedShaders::parse(&device, dual_source_blending) })
        });
    log::info!(
        target: "mirin::startup",
        "gpu prepared in {:.1}ms ({} adapter(s))",
        started.elapsed().as_secs_f64() * 1000.0,
        adapters.len()
    );
    Some(PreparedVulkan {
        instance,
        adapters,
        first_device,
        shaders,
    })
}

/// Upstream's `try_adapter_with_surface` for a device made already.
async fn test_device(
    adapter: &wgpu::Adapter,
    (device, queue, dual_source_blending, color_texture_format): (
        wgpu::Device,
        wgpu::Queue,
        bool,
        wgpu::TextureFormat,
    ),
    surface: &wgpu::Surface<'_>,
    config: &WgpuSurfaceConfig,
) -> anyhow::Result<(wgpu::Device, wgpu::Queue, bool, wgpu::TextureFormat)> {
    let caps = surface.get_capabilities(adapter);
    if caps.formats.is_empty() {
        anyhow::bail!("no compatible surface formats");
    }
    if caps.alpha_modes.is_empty() {
        anyhow::bail!("no compatible alpha modes");
    }
    let (surface_config, _, _) =
        WgpuRenderer::surface_configuration(surface, adapter, &device, config)?;
    let error_scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
    surface.configure(&device, &surface_config);
    if let Some(error) = error_scope.pop().await {
        anyhow::bail!("surface configuration failed: {error}");
    }
    Ok((device, queue, dual_source_blending, color_texture_format))
}
