use cef::*;
use std::sync::atomic::Ordering;

use super::commands::quit;
use super::config::CoreConfig;
use super::handlers::MirinApp;
use super::state::{ICON_PATH, IDENTIFIER, IS_DEV, RESOURCES_PATH, STARTUP_URL};

#[cfg(target_os = "macos")]
use crate::mac;
#[cfg(target_os = "windows")]
use crate::win;

/// What `load_cef` returns and the caller holds for the process lifetime. On
/// macOS this is the framework loader (must outlive CEF). On Windows/Linux there
/// is nothing to keep alive — the unit type stands in.
#[cfg(target_os = "macos")]
type Library = library_loader::LibraryLoader;
#[cfg(not(target_os = "macos"))]
type Library = ();

/// Run the browser process: load CEF, init, message loop, shutdown. Called on
/// the process main thread. Does not return until the app quits.
#[cfg_attr(not(target_os = "windows"), allow(unused_mut))]
pub fn run_core(mut config: CoreConfig) -> i32 {
    IS_DEV.store(config.dev, Ordering::Relaxed);
    // Per-Monitor-v2 DPI awareness + an explicit AppUserModelID (so the taskbar
    // shows our icon, not Bun's) must be set before any window/CEF init.
    #[cfg(target_os = "windows")]
    {
        win::set_dpi_awareness();
        win::set_app_id(config.dev);
        if config.single_instance {
            if !win::acquire_single_instance(config.dev) {
                win::activate_existing_instance();
                return 0;
            }
        } else {
            config.cache_path = format!(
                "{}-{}",
                config.cache_path.trim_end_matches(['/', '\\']),
                std::process::id()
            );
        }
    }
    #[cfg(target_os = "macos")]
    let _library = load_cef();
    #[cfg(not(target_os = "macos"))]
    load_cef();

    let args = cef::args::Args::new();
    let Some(cmd_line) = args.as_cmd_line() else {
        return 1;
    };
    let main_args = args.as_main_args();

    let type_switch = CefString::from("type");
    let is_browser_process = cmd_line.has_switch(Some(&type_switch)) != 1;
    let ret = execute_process(Some(main_args), None, std::ptr::null_mut());
    if !is_browser_process {
        return if ret >= 0 { 0 } else { 1 };
    }
    debug_assert_eq!(ret, -1, "cannot execute browser process");

    let cache_path = if config.cache_path.is_empty() {
        default_cache_dir(config.dev, &config.identifier)
    } else {
        config.cache_path.clone()
    };
    std::fs::create_dir_all(&cache_path).ok();

    let subprocess_path = if config.subprocess_path.is_empty() {
        derive_subprocess_path()
    } else {
        Some(config.subprocess_path.clone())
    };

    STARTUP_URL.with(|u| *u.borrow_mut() = config.startup_url.clone());
    RESOURCES_PATH.with(|p| *p.borrow_mut() = config.resources_path.clone());
    ICON_PATH.with(|p| *p.borrow_mut() = config.icon_path.clone());
    IDENTIFIER.with(|p| *p.borrow_mut() = config.identifier.clone());

    let mut app = MirinApp::new(std::cell::RefCell::new(None));
    let mut settings = Settings {
        no_sandbox: !cfg!(feature = "sandbox") as _,
        root_cache_path: CefString::from(cache_path.as_str()),
        windowless_rendering_enabled: 1,
        // 0 disables remote debugging; nonzero binds the DevTools protocol on
        // loopback for mirin's devtools (docs/agent-devtools.md).
        remote_debugging_port: config.debug_port(),
        ..Default::default()
    };
    if let Some(path) = subprocess_path {
        settings.browser_subprocess_path = CefString::from(path.as_str());
    }

    if initialize(
        Some(main_args),
        Some(&settings),
        Some(&mut app),
        std::ptr::null_mut(),
    ) != 1
    {
        eprintln!(
            "[mirin] CEF did not initialize — another instance of this app is \
             likely already running (same cache dir). Exiting."
        );
        return 1;
    }

    #[cfg(target_os = "macos")]
    let _delegate = mac::setup_app_delegate();

    if let Ok(Ok(ms)) = std::env::var("MIRIN_AUTOQUIT_MS").map(|s| s.parse::<u64>()) {
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(ms));
            quit();
        });
    }

    run_message_loop();
    shutdown();
    0
}

#[cfg(target_os = "macos")]
fn load_cef() -> Library {
    let loader = library_loader::LibraryLoader::new(&std::env::current_exe().unwrap(), false);
    assert!(loader.load(), "failed to load Chromium Embedded Framework");
    let _ = api_hash(sys::CEF_API_VERSION_LAST, 0);
    mac::setup_application();
    loader
}

/// Windows/Linux: libcef is bound at load time via cef-dll-sys's import library.
#[cfg(any(target_os = "windows", target_os = "linux"))]
fn load_cef() -> Library {
    let _ = api_hash(sys::CEF_API_VERSION_LAST, 0);
}

/// Whether to force software rendering (disable the GPU process).
pub(crate) fn should_disable_gpu() -> bool {
    if std::env::var_os("MIRIN_DISABLE_GPU").is_some() {
        return true;
    }
    #[cfg(target_os = "windows")]
    {
        return win::is_remote_session();
    }
    #[allow(unreachable_code)]
    false
}

/// The ANGLE backend to force via `--use-angle`, or None to keep Chromium's default.
pub(crate) fn angle_backend() -> Option<String> {
    if let Some(angle) = std::env::var_os("MIRIN_ANGLE") {
        return angle.into_string().ok().filter(|s| !s.is_empty());
    }
    #[cfg(target_os = "windows")]
    if win::gpu::prefer_gl() {
        return Some("gl".to_string());
    }
    None
}

fn default_cache_dir(dev: bool, identifier: &str) -> String {
    let id = app_bundle_id()
        .or_else(|| {
            let sanitized: String = identifier
                .chars()
                .map(|c| {
                    if c.is_alphanumeric() || matches!(c, '.' | '-' | '_') {
                        c
                    } else {
                        '_'
                    }
                })
                .collect();
            (!sanitized.is_empty()).then_some(sanitized)
        })
        .unwrap_or_else(|| "app".into());
    let suffix = if dev { "-dev" } else { "" };
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
        format!("{home}/Library/Application Support/mirin/{id}{suffix}/cache")
    }
    #[cfg(target_os = "windows")]
    {
        let base = std::env::var("LOCALAPPDATA")
            .or_else(|_| std::env::var("TEMP"))
            .unwrap_or_else(|_| "C:\\Temp".into());
        format!("{base}\\mirin\\{id}{suffix}\\cache")
    }
    #[cfg(target_os = "linux")]
    {
        let base = std::env::var("XDG_CACHE_HOME")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| {
                let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
                format!("{home}/.cache")
            });
        format!("{base}/mirin/{id}{suffix}/cache")
    }
}

#[cfg(target_os = "macos")]
fn app_bundle_id() -> Option<String> {
    let id = objc2_foundation::NSBundle::mainBundle()
        .bundleIdentifier()?
        .to_string();
    if id.is_empty() {
        return None;
    }
    Some(id.replace(['/', '\\', ':'], "_"))
}

#[cfg(not(target_os = "macos"))]
fn app_bundle_id() -> Option<String> {
    None
}

#[cfg(target_os = "macos")]
fn derive_subprocess_path() -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    let stem = exe.file_name()?.to_str()?.to_string();
    let macos_dir = exe.parent()?;
    let contents = macos_dir.parent()?;
    let helper = contents
        .join("Frameworks")
        .join(format!("{stem} Helper.app"))
        .join("Contents/MacOS")
        .join(format!("{stem} Helper"));
    Some(helper.to_str()?.to_string())
}

#[cfg(target_os = "windows")]
fn derive_subprocess_path() -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    let helper = exe.parent()?.join("mirin-helper.exe");
    Some(helper.to_str()?.to_string())
}

#[cfg(target_os = "linux")]
fn derive_subprocess_path() -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    let helper = exe.parent()?.join("mirin-helper");
    Some(helper.to_str()?.to_string())
}
