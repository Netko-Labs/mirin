//! Load only the Vulkan driver of the GPU the compositor renders on.
//!
//! The Vulkan loader opens every installed driver at startup, even though
//! GPUI renders on one GPU. On a hybrid laptop that maps the other GPU's whole
//! driver stack (~150 MB resident for NVIDIA's) into every app and can wake
//! that GPU from runtime suspend. Desktop apps should render where the
//! compositor does, so buffers are shared without copies: the compositor
//! names its main device through `linux-dmabuf` feedback, and this module
//! limits the loader to that device's driver, once a child of the process
//! has seen that driver find a device (asked once per session); otherwise
//! (a VM's GPU without 3D, a card its Vulkan driver doesn't run) every
//! driver loads, software Vulkan included, and the app still gets a window.

use std::fs;
use std::path::{Path, PathBuf};

use wayland_client::globals::{registry_queue_init, GlobalListContents};
use wayland_client::protocol::wl_registry::WlRegistry;
use wayland_client::{Connection, Dispatch, QueueHandle};
use wayland_protocols::wp::linux_dmabuf::zv1::client::{
    zwp_linux_dmabuf_feedback_v1::{self, ZwpLinuxDmabufFeedbackV1},
    zwp_linux_dmabuf_v1::ZwpLinuxDmabufV1,
};

/// Restrict the Vulkan loader to the compositor GPU's driver by setting
/// `VK_LOADER_DRIVERS_SELECT`, unless the environment already chooses drivers
/// or `MIRIN_METAL_GPU=all` opts out. Without a Wayland compositor that
/// reports its device, nothing changes. Call before any other thread starts
/// and before GPUI initializes (the first line of `main`). Returns the filter.
pub fn prefer_display_gpu() -> Option<String> {
    let chosen = [
        "VK_LOADER_DRIVERS_SELECT",
        "VK_DRIVER_FILES",
        "VK_ICD_FILENAMES",
        "VK_ADD_DRIVER_FILES",
    ]
    .iter()
    .any(|name| std::env::var_os(name).is_some());
    if chosen || std::env::var("MIRIN_METAL_GPU").is_ok_and(|value| value == "all") {
        return None;
    }
    let device = compositor_main_device()?;
    let filter = driver_filter(Path::new("/sys/dev/char"), device)?;
    // A driver that is installed but finds no device (a VM's GPU without 3D,
    // an old card its Vulkan driver doesn't run) would leave GPUI with no
    // GPU at all and the app with no window. Ask a child of this process,
    // so the probe's driver threads never run beside the setenv below; with
    // no device there, every driver loads, software Vulkan included. A yes
    // is remembered for the session: the probe loads the driver (~18 ms of
    // a ~50 ms start), and every app of a desktop would ask the same thing.
    let marker = std::env::var_os("XDG_RUNTIME_DIR")
        .and_then(|dir| probe_marker(Path::new(&dir), &filter, device));
    let known = marker
        .as_deref()
        .is_some_and(|path| fs::symlink_metadata(path).is_ok_and(|file| file.is_file()));
    if !known {
        match driver_has_device(&filter) {
            Some(true) => {
                if let Some(path) = &marker {
                    let _ = fs::write(path, b"");
                }
            }
            Some(false) => return None,
            // The probe could not run: the filter stays, as before it existed.
            None => {}
        }
    }
    // Sound in practice: documented to run before any other thread exists.
    std::env::set_var("VK_LOADER_DRIVERS_SELECT", &filter);
    Some(filter)
}

/// The argument that makes this process answer [`driver_has_device`]'s question and exit.
pub const PROBE_ARG: &str = "--mirin-vulkan-probe";

/// Whether the Vulkan drivers `filter` selects see at least one device:
/// this program, run again with [`PROBE_ARG`] and the filter, says so by its
/// exit status. None when it could not say (it could not run, or died).
fn driver_has_device(filter: &str) -> Option<bool> {
    let program = std::env::current_exe().ok()?;
    let status = std::process::Command::new(program)
        .arg(PROBE_ARG)
        .env("VK_LOADER_DRIVERS_SELECT", filter)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .ok()?;
    match status.code() {
        Some(0) => Some(true),
        Some(PROBE_NO_DEVICE) => Some(false),
        _ => None,
    }
}

/// The file whose presence says the probe found a device for this driver
/// and compositor device, in the session's runtime directory (private to
/// the user, emptied at logout). None when the directory isn't an absolute
/// path or the filter names no driver.
fn probe_marker(runtime_dir: &Path, filter: &str, device: u64) -> Option<PathBuf> {
    let driver: String = filter.chars().filter(char::is_ascii_alphanumeric).collect();
    if !runtime_dir.is_absolute() || driver.is_empty() {
        return None;
    }
    let (major, minor) = split_dev(device);
    Some(runtime_dir.join(format!("mirin-metal-gpu-{driver}-{major}-{minor}")))
}

/// The probe's exit status when the drivers it was given see no device.
const PROBE_NO_DEVICE: i32 = 3;

/// Run as the probe (the program was started with [`PROBE_ARG`]): exit 0 if
/// Vulkan, as the environment selects it, sees a device, else
/// [`PROBE_NO_DEVICE`]. Call first thing in `main`.
pub fn answer_probe() -> ! {
    // SAFETY: loading the system's Vulkan loader runs its initializers; this
    // process does nothing else and exits right after.
    let found = unsafe { ash::Entry::load() }.ok().is_some_and(|entry| {
        let info = ash::vk::InstanceCreateInfo::default();
        // SAFETY: a default create info with no layers or extensions; the
        // instance is destroyed before the entry goes.
        match unsafe { entry.create_instance(&info, None) } {
            Ok(instance) => {
                // SAFETY: the instance is valid until destroyed just below.
                let count = unsafe { instance.enumerate_physical_devices() }
                    .map_or(0, |devices| devices.len());
                // SAFETY: nothing else uses the instance.
                unsafe { instance.destroy_instance(None) };
                count > 0
            }
            Err(_) => false,
        }
    });
    std::process::exit(if found { 0 } else { PROBE_NO_DEVICE })
}

/// The loader filter for a DRM device's kernel driver, e.g. `*radeon*`.
fn driver_filter(sys_dev_char: &Path, device: u64) -> Option<String> {
    let (major, minor) = split_dev(device);
    let driver = fs::read_link(sys_dev_char.join(format!("{major}:{minor}/device/driver"))).ok()?;
    let filter = match driver.file_name()?.to_str()? {
        "amdgpu" | "radeon" => "*radeon*",
        "i915" | "xe" => "*intel*",
        "nvidia" => "*nvidia*",
        "nouveau" => "*nouveau*",
        "virtio-pci" | "virtio_gpu" => "*virtio*",
        _ => return None,
    };
    Some(filter.to_string())
}

/// glibc's `major()`/`minor()` for a Linux `dev_t`.
fn split_dev(device: u64) -> (u64, u64) {
    let major = ((device >> 32) & 0xffff_f000) | ((device >> 8) & 0x0000_0fff);
    let minor = ((device >> 12) & 0xffff_ff00) | (device & 0x0000_00ff);
    (major, minor)
}

#[derive(Default)]
struct Feedback {
    main_device: Option<u64>,
    done: bool,
}

/// Ask the compositor for its main device (`linux-dmabuf` v4 default feedback).
fn compositor_main_device() -> Option<u64> {
    std::env::var_os("WAYLAND_DISPLAY")?;
    let connection = Connection::connect_to_env().ok()?;
    let (globals, mut queue) = registry_queue_init::<Feedback>(&connection).ok()?;
    let handle = queue.handle();
    let dmabuf: ZwpLinuxDmabufV1 = globals.bind(&handle, 4..=5, ()).ok()?;
    let feedback = dmabuf.get_default_feedback(&handle, ());
    let mut state = Feedback::default();
    for _ in 0..4 {
        if state.done {
            break;
        }
        queue.roundtrip(&mut state).ok()?;
    }
    feedback.destroy();
    dmabuf.destroy();
    state.main_device
}

impl Dispatch<WlRegistry, GlobalListContents> for Feedback {
    fn event(
        _: &mut Self,
        _: &WlRegistry,
        _: <WlRegistry as wayland_client::Proxy>::Event,
        _: &GlobalListContents,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}

impl Dispatch<ZwpLinuxDmabufV1, ()> for Feedback {
    fn event(
        _: &mut Self,
        _: &ZwpLinuxDmabufV1,
        _: <ZwpLinuxDmabufV1 as wayland_client::Proxy>::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}

impl Dispatch<ZwpLinuxDmabufFeedbackV1, ()> for Feedback {
    fn event(
        state: &mut Self,
        _: &ZwpLinuxDmabufFeedbackV1,
        event: zwp_linux_dmabuf_feedback_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        match event {
            zwp_linux_dmabuf_feedback_v1::Event::MainDevice { device } => {
                state.main_device = device
                    .get(..8)
                    .and_then(|bytes| bytes.try_into().ok())
                    .map(u64::from_ne_bytes);
            }
            zwp_linux_dmabuf_feedback_v1::Event::Done => state.done = true,
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    #[test]
    fn splits_dev_t_like_glibc() {
        // 226:128 is the first DRM render node.
        assert_eq!(split_dev((226 << 8) | 128), (226, 128));
        assert_eq!(split_dev((226 << 8) | 1), (226, 1));
    }

    #[test]
    fn names_the_probe_marker_by_driver_and_device() {
        let device = (226 << 8) | 128;
        assert_eq!(
            probe_marker(Path::new("/run/user/1000"), "*radeon*", device),
            Some(PathBuf::from(
                "/run/user/1000/mirin-metal-gpu-radeon-226-128"
            ))
        );
        // Nothing of the filter but letters and digits reaches the file name.
        assert_eq!(
            probe_marker(Path::new("/run/user/1000"), "../*intel*", device),
            Some(PathBuf::from(
                "/run/user/1000/mirin-metal-gpu-intel-226-128"
            ))
        );
        assert_eq!(probe_marker(Path::new("run"), "*radeon*", device), None);
        assert_eq!(probe_marker(Path::new("/run/user/1000"), "*", device), None);
    }

    #[test]
    fn maps_kernel_drivers_to_loader_filters() {
        let root =
            std::env::temp_dir().join(format!("mirin-metal-gpu-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        for (node, driver) in [("226:1", "amdgpu"), ("226:2", "nvidia"), ("226:3", "vkms")] {
            fs::create_dir_all(root.join(node).join("device")).unwrap();
            fs::create_dir_all(root.join("drivers").join(driver)).unwrap();
            symlink(
                root.join("drivers").join(driver),
                root.join(node).join("device/driver"),
            )
            .unwrap();
        }
        assert_eq!(
            driver_filter(&root, (226 << 8) | 1).as_deref(),
            Some("*radeon*")
        );
        assert_eq!(
            driver_filter(&root, (226 << 8) | 2).as_deref(),
            Some("*nvidia*")
        );
        assert_eq!(driver_filter(&root, (226 << 8) | 3), None);
        assert_eq!(driver_filter(&root, (226 << 8) | 9), None);
        let _ = fs::remove_dir_all(&root);
    }
}

#[cfg(test)]
mod live {
    /// `cargo test --release gpu::live -- --ignored --nocapture` inside a
    /// Wayland session prints what the compositor reports (no window).
    #[test]
    #[ignore = "needs a Wayland session"]
    fn reports_the_compositor_device() {
        let device = super::compositor_main_device();
        let filter =
            device.and_then(|d| super::driver_filter(std::path::Path::new("/sys/dev/char"), d));
        println!(
            "main device {:?} -> {:?}",
            device.map(super::split_dev),
            filter
        );
    }
}
