//! GPU backend auto-selection. Chromium defaults to the D3D11 ANGLE backend,
//! which on some **hybrid iGPU/dGPU laptops** can't create its context in the
//! (sandboxed) GPU process ("Failed to create shared context for virtualization")
//! and the GPU process exits — rendering falls back to software, and Chromium does
//! NOT auto-try another backend.
//!
//! We can't predict this from the browser process: a direct ANGLE D3D11 EGL
//! init + context creation *succeeds* there (the driver is fine) yet the GPU
//! process still fails, so the differentiator is the GPU process picking the wrong
//! adapter on a multi-GPU machine. So we use a hybrid-GPU heuristic: if the system
//! has ≥2 display adapters, prefer the `gl` backend (verified to restore hardware
//! acceleration where D3D11 fails). Single-GPU machines keep Chromium's D3D11
//! default. Zero-config; `MIRIN_ANGLE` still overrides.

use windows_sys::Win32::System::Registry::{
    RegCloseKey, RegEnumKeyExW, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_LOCAL_MACHINE, KEY_READ,
};

/// The display-adapter device class. Its `NNNN` subkeys (with a `DriverDesc`) are
/// the installed GPUs.
const GPU_CLASS: &str =
    r"SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}";

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Whether to prefer the `gl` ANGLE backend — true on multi-GPU (hybrid) systems.
pub fn prefer_gl() -> bool {
    gpu_count() >= 2
}

/// Count installed display adapters (GPUs) via the registry. Best-effort: 1 on any
/// error (→ keep the D3D11 default).
fn gpu_count() -> u32 {
    let path = wide(GPU_CLASS);
    let mut key: HKEY = std::ptr::null_mut();
    // SAFETY: opening a well-known read-only registry key.
    if unsafe { RegOpenKeyExW(HKEY_LOCAL_MACHINE, path.as_ptr(), 0, KEY_READ, &mut key) } != 0 {
        return 1;
    }

    let mut count = 0u32;
    let mut index = 0u32;
    loop {
        let mut name = [0u16; 64];
        let mut name_len = name.len() as u32;
        // SAFETY: enumerating subkeys into a valid buffer + length.
        let r = unsafe {
            RegEnumKeyExW(
                key,
                index,
                name.as_mut_ptr(),
                &mut name_len,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        if r != 0 {
            break; // ERROR_NO_MORE_ITEMS
        }
        index += 1;
        if subkey_has_driver(key, &name[..name_len as usize]) {
            count += 1;
        }
    }

    // SAFETY: key is open.
    unsafe { RegCloseKey(key) };
    count.max(1)
}

/// Whether `<GPU_CLASS>\<name>` has a `DriverDesc` value (i.e. it's a real adapter,
/// not a sibling like `Properties`).
fn subkey_has_driver(parent: HKEY, name: &[u16]) -> bool {
    let mut sub_name: Vec<u16> = name.to_vec();
    sub_name.push(0);
    let mut sub: HKEY = std::ptr::null_mut();
    // SAFETY: opening a child of an open key, read-only.
    if unsafe { RegOpenKeyExW(parent, sub_name.as_ptr(), 0, KEY_READ, &mut sub) } != 0 {
        return false;
    }
    let value = wide("DriverDesc");
    // SAFETY: querying only for the value's existence (no output buffers).
    let has = unsafe {
        RegQueryValueExW(
            sub,
            value.as_ptr(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        ) == 0
    };
    // SAFETY: sub is open.
    unsafe { RegCloseKey(sub) };
    has
}
