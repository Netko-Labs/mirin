use std::io;
use std::time::Duration;

pub fn boot_token() -> io::Result<String> {
    platform_boot_token()
}

pub fn process_token(pid: u32) -> io::Result<String> {
    if pid == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "process id must be positive",
        ));
    }
    platform_process_token(pid)
}

pub fn process_matches(pid: u32, expected: &str) -> bool {
    !expected.is_empty() && process_token(pid).is_ok_and(|actual| actual == expected)
}

pub fn wait_for_process_exit(pid: u32, expected: &str, timeout: Duration) -> io::Result<()> {
    platform_wait_for_exit(pid, expected, timeout)
}

pub fn terminate_process(pid: u32, expected: &str) -> io::Result<()> {
    platform_terminate_process(pid, expected)
}

#[cfg(target_os = "linux")]
fn platform_boot_token() -> io::Result<String> {
    let boot_id = std::fs::read_to_string("/proc/sys/kernel/random/boot_id")?;
    let boot_id = boot_id.trim();
    if boot_id.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Linux boot id is empty",
        ));
    }
    Ok(boot_id.to_owned())
}

#[cfg(target_os = "linux")]
fn platform_process_token(pid: u32) -> io::Result<String> {
    let boot_id = platform_boot_token()?;
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat"))?;
    let close = stat.rfind(')').ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidData, "malformed Linux process stat")
    })?;
    let fields: Vec<&str> = stat[close + 1..].split_whitespace().collect();
    match fields.first().copied() {
        Some("Z" | "X" | "x") => {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                "process has exited",
            ));
        }
        Some(_) => {}
        None => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Linux process stat is incomplete",
            ));
        }
    }
    let start = fields.get(19).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "Linux process stat is incomplete",
        )
    })?;
    start.parse::<u64>().map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "Linux process start time is invalid",
        )
    })?;
    Ok(format!("{boot_id}:{start}"))
}

#[cfg(target_os = "macos")]
fn platform_boot_token() -> io::Result<String> {
    let mut boot_time = std::mem::MaybeUninit::<libc::timeval>::zeroed();
    let mut length = std::mem::size_of::<libc::timeval>();
    let mut name = [libc::CTL_KERN, libc::KERN_BOOTTIME];
    // SAFETY: name selects kern.boottime and boot_time points to writable
    // timeval storage whose byte length is supplied through length.
    let result = unsafe {
        libc::sysctl(
            name.as_mut_ptr(),
            name.len() as libc::c_uint,
            boot_time.as_mut_ptr().cast(),
            &mut length,
            std::ptr::null_mut(),
            0,
        )
    };
    if result != 0 || length != std::mem::size_of::<libc::timeval>() {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: sysctl reported that it initialized a complete timeval.
    let boot_time = unsafe { boot_time.assume_init() };
    Ok(format!("{}:{}", boot_time.tv_sec, boot_time.tv_usec))
}

#[cfg(target_os = "macos")]
fn platform_process_token(pid: u32) -> io::Result<String> {
    let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
    // SAFETY: info points to writable storage of exactly proc_bsdinfo bytes.
    let result = unsafe {
        libc::proc_pidinfo(
            pid as libc::c_int,
            libc::PROC_PIDTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int,
        )
    };
    if result != std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: proc_pidinfo reported that it initialized the complete structure.
    let info = unsafe { info.assume_init() };
    Ok(format!(
        "{}:{}",
        info.pbi_start_tvsec, info.pbi_start_tvusec
    ))
}

#[cfg(windows)]
fn platform_boot_token() -> io::Result<String> {
    use windows_sys::Wdk::System::SystemInformation::NtQuerySystemInformation;

    // SYSTEM_BOOT_ENVIRONMENT_INFORMATION starts with a 16-byte boot GUID.
    // Keeping the complete documented buffer size avoids depending on Rust
    // layout for the following firmware type and boot flags.
    const SYSTEM_BOOT_ENVIRONMENT_INFORMATION: i32 = 90;
    let mut information = [0_u8; 32];
    let mut returned = 0_u32;
    // SAFETY: information is writable for the supplied byte length and
    // return-length points to an initialized u32.
    let status = unsafe {
        NtQuerySystemInformation(
            SYSTEM_BOOT_ENVIRONMENT_INFORMATION,
            information.as_mut_ptr().cast(),
            information.len() as u32,
            &mut returned,
        )
    };
    if status < 0 {
        return Err(io::Error::other(format!(
            "could not query Windows boot identity (NTSTATUS {status:#x})"
        )));
    }
    if information[..16].iter().all(|byte| *byte == 0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Windows boot identity is empty",
        ));
    }
    Ok(information[..16]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

#[cfg(windows)]
fn platform_process_token(pid: u32) -> io::Result<String> {
    use windows_sys::Win32::Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT};
    use windows_sys::Win32::System::Threading::{
        WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
    };

    let process = open_process(pid, PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE)?;
    let token = token_from_handle(process.0)?;
    // An exited Windows process object remains queryable while any handle keeps
    // it alive. Creation time alone therefore identifies the object but does not
    // establish that the process is still running.
    // SAFETY: process owns a valid synchronization handle.
    match unsafe { WaitForSingleObject(process.0, 0) } {
        WAIT_TIMEOUT => Ok(token),
        WAIT_OBJECT_0 => Err(io::Error::new(
            io::ErrorKind::NotFound,
            "process has exited",
        )),
        _ => Err(io::Error::last_os_error()),
    }
}

#[cfg(target_os = "linux")]
fn platform_wait_for_exit(pid: u32, expected: &str, timeout: Duration) -> io::Result<()> {
    use std::os::fd::RawFd;

    // SAFETY: pidfd_open takes a numeric PID and flags=0.
    let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid as libc::pid_t, 0) as RawFd };
    if fd < 0 {
        if !process_matches(pid, expected) {
            return Ok(());
        }
        return Err(io::Error::last_os_error());
    }
    struct PidFd(RawFd);
    impl Drop for PidFd {
        fn drop(&mut self) {
            // SAFETY: this type exclusively owns the descriptor.
            unsafe {
                libc::close(self.0);
            }
        }
    }
    let fd = PidFd(fd);
    // Opening first pins the kernel process object. Re-checking the creation
    // token afterward prevents a recycled numeric PID from binding this pidfd.
    if !process_matches(pid, expected) {
        return Ok(());
    }
    let mut poll_fd = libc::pollfd {
        fd: fd.0,
        events: libc::POLLIN,
        revents: 0,
    };
    let milliseconds = timeout.as_millis().min(i32::MAX as u128) as libc::c_int;
    // SAFETY: poll_fd points to one valid pollfd for the duration of the call.
    let result = unsafe { libc::poll(&mut poll_fd, 1, milliseconds) };
    if result > 0 {
        Ok(())
    } else if result == 0 {
        Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "process did not exit before the deadline",
        ))
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(target_os = "linux")]
fn platform_terminate_process(pid: u32, expected: &str) -> io::Result<()> {
    // SAFETY: pidfd_open takes a numeric PID and flags=0.
    let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid as libc::pid_t, 0) as libc::c_int };
    if fd < 0 {
        if !process_matches(pid, expected) {
            return Ok(());
        }
        return Err(io::Error::last_os_error());
    }
    struct PidFd(libc::c_int);
    impl Drop for PidFd {
        fn drop(&mut self) {
            // SAFETY: this type exclusively owns the descriptor.
            unsafe {
                libc::close(self.0);
            }
        }
    }
    let fd = PidFd(fd);
    // The pidfd pins the target across PID reuse; validate only after it exists.
    if !process_matches(pid, expected) {
        return Ok(());
    }
    send_pidfd_signal(fd.0, libc::SIGTERM)?;
    if platform_wait_for_pidfd_exit(fd.0, Duration::from_secs(2)) {
        return Ok(());
    }
    send_pidfd_signal(fd.0, libc::SIGKILL)?;
    if platform_wait_for_pidfd_exit(fd.0, Duration::from_secs(5)) {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "process could not be terminated",
        ))
    }
}

#[cfg(target_os = "linux")]
fn send_pidfd_signal(fd: libc::c_int, signal: libc::c_int) -> io::Result<()> {
    // SAFETY: the descriptor came from pidfd_open and the remaining pointer and
    // flags arguments are the documented null/zero values.
    let result = unsafe {
        libc::syscall(
            libc::SYS_pidfd_send_signal,
            fd,
            signal,
            std::ptr::null::<libc::siginfo_t>(),
            0,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(target_os = "linux")]
fn platform_wait_for_pidfd_exit(fd: libc::c_int, timeout: Duration) -> bool {
    let mut poll_fd = libc::pollfd {
        fd,
        events: libc::POLLIN,
        revents: 0,
    };
    let milliseconds = timeout.as_millis().min(i32::MAX as u128) as libc::c_int;
    // SAFETY: poll_fd points to one valid pollfd for the duration of the call.
    unsafe { libc::poll(&mut poll_fd, 1, milliseconds) > 0 }
}

#[cfg(target_os = "macos")]
fn platform_wait_for_exit(pid: u32, expected: &str, timeout: Duration) -> io::Result<()> {
    if !process_matches(pid, expected) {
        return Ok(());
    }
    // SAFETY: kqueue has no arguments and returns an owned descriptor.
    let queue = unsafe { libc::kqueue() };
    if queue < 0 {
        return Err(io::Error::last_os_error());
    }
    struct Queue(libc::c_int);
    impl Drop for Queue {
        fn drop(&mut self) {
            // SAFETY: this type exclusively owns the descriptor.
            unsafe {
                libc::close(self.0);
            }
        }
    }
    let queue = Queue(queue);
    let change = libc::kevent {
        ident: pid as libc::uintptr_t,
        filter: libc::EVFILT_PROC,
        flags: libc::EV_ADD | libc::EV_ENABLE | libc::EV_ONESHOT,
        fflags: libc::NOTE_EXIT,
        data: 0,
        udata: std::ptr::null_mut(),
    };
    // Register the filter first, then revalidate the creation token. The kqueue
    // filter remains attached to that process object if its PID is later reused.
    // SAFETY: change describes one initialized event and no output is requested.
    let registered = unsafe {
        libc::kevent(
            queue.0,
            &change,
            1,
            std::ptr::null_mut(),
            0,
            std::ptr::null(),
        )
    };
    if registered < 0 {
        if !process_matches(pid, expected) {
            return Ok(());
        }
        return Err(io::Error::last_os_error());
    }
    if !process_matches(pid, expected) {
        return Ok(());
    }
    let deadline = libc::timespec {
        tv_sec: timeout.as_secs().min(i64::MAX as u64) as libc::time_t,
        tv_nsec: timeout.subsec_nanos() as libc::c_long,
    };
    let mut event = std::mem::MaybeUninit::<libc::kevent>::uninit();
    // SAFETY: the filter is registered and event points to one writable value.
    let result = unsafe {
        libc::kevent(
            queue.0,
            std::ptr::null(),
            0,
            event.as_mut_ptr(),
            1,
            &deadline,
        )
    };
    if result > 0 {
        Ok(())
    } else if result == 0 {
        Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "process did not exit before the deadline",
        ))
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(target_os = "macos")]
fn platform_terminate_process(pid: u32, expected: &str) -> io::Result<()> {
    if !process_matches(pid, expected) {
        return Ok(());
    }
    // Darwin exposes process-bound kqueue monitoring but no unprivileged
    // handle-bound signal API. A raw kill(pid) after token validation would
    // still be able to hit a process that reused the PID in between. Fail safe
    // and leave the durable updater transaction for a later recovery instead.
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "exact process termination is unavailable on macOS",
    ))
}

#[cfg(windows)]
struct ProcessHandle(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
impl Drop for ProcessHandle {
    fn drop(&mut self) {
        // SAFETY: this type exclusively owns the valid process handle.
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

#[cfg(windows)]
fn open_process(pid: u32, access: u32) -> io::Result<ProcessHandle> {
    // SAFETY: OpenProcess takes a numeric PID and returns an owned handle.
    let handle = unsafe { windows_sys::Win32::System::Threading::OpenProcess(access, 0, pid) };
    if handle.is_null() {
        Err(io::Error::last_os_error())
    } else {
        Ok(ProcessHandle(handle))
    }
}

#[cfg(windows)]
fn token_from_handle(handle: windows_sys::Win32::Foundation::HANDLE) -> io::Result<String> {
    use windows_sys::Win32::Foundation::FILETIME;
    use windows_sys::Win32::System::Threading::GetProcessTimes;

    let mut creation = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let mut exit = creation;
    let mut kernel = creation;
    let mut user = creation;
    // SAFETY: all pointers refer to writable FILETIME values and handle has
    // PROCESS_QUERY_LIMITED_INFORMATION access.
    if unsafe { GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let value = (u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime);
    Ok(value.to_string())
}

#[cfg(windows)]
fn platform_wait_for_exit(pid: u32, expected: &str, timeout: Duration) -> io::Result<()> {
    use windows_sys::Win32::Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT};
    use windows_sys::Win32::System::Threading::{
        WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
    };

    let process = match open_process(pid, PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE) {
        Ok(process) => process,
        Err(error) if error.raw_os_error() == Some(87) => return Ok(()),
        Err(error) => return Err(error),
    };
    if token_from_handle(process.0)? != expected {
        return Ok(());
    }
    let milliseconds = timeout.as_millis().min(u32::MAX as u128) as u32;
    // SAFETY: process owns a valid synchronization handle.
    match unsafe { WaitForSingleObject(process.0, milliseconds) } {
        WAIT_OBJECT_0 => Ok(()),
        WAIT_TIMEOUT => Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "process did not exit before the deadline",
        )),
        _ => Err(io::Error::last_os_error()),
    }
}

#[cfg(windows)]
fn platform_terminate_process(pid: u32, expected: &str) -> io::Result<()> {
    use windows_sys::Win32::Foundation::WAIT_OBJECT_0;
    use windows_sys::Win32::System::Threading::{
        TerminateProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
        PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
    };

    let process = match open_process(
        pid,
        PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | PROCESS_SYNCHRONIZE,
    ) {
        Ok(process) => process,
        Err(error) if error.raw_os_error() == Some(87) => return Ok(()),
        Err(error) => return Err(error),
    };
    if token_from_handle(process.0)? != expected {
        return Ok(());
    }
    // SAFETY: the handle identifies the exact token-verified process and has
    // PROCESS_TERMINATE access.
    if unsafe { TerminateProcess(process.0, 1) } == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: process owns a valid synchronization handle.
    if unsafe { WaitForSingleObject(process.0, 5000) } == WAIT_OBJECT_0 {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "process could not be terminated",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Child, Command, Stdio};
    use std::thread;

    #[test]
    fn current_process_token_is_stable_and_rejects_another_token() {
        let pid = std::process::id();
        let token = process_token(pid).unwrap();
        assert!(!token.is_empty());
        assert_eq!(process_token(pid).unwrap(), token);
        assert!(process_matches(pid, &token));
        assert!(!process_matches(pid, "not-this-process"));
    }

    #[test]
    fn current_boot_token_is_stable() {
        let token = boot_token().unwrap();
        assert!(!token.is_empty());
        assert_eq!(boot_token().unwrap(), token);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn unreaped_zombie_is_not_a_live_process_identity() {
        let child = Command::new("/bin/sh")
            .args(["-c", "exit 0"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut child = ChildGuard(Some(child));
        let pid = child.0.as_ref().unwrap().id();
        let became_zombie = (0..200).any(|_| {
            let state = std::fs::read_to_string(format!("/proc/{pid}/stat"))
                .ok()
                .and_then(|stat| {
                    let close = stat.rfind(')')?;
                    stat[close + 1..]
                        .split_whitespace()
                        .next()
                        .map(str::to_owned)
                });
            if state.as_deref() == Some("Z") {
                true
            } else {
                thread::sleep(Duration::from_millis(10));
                false
            }
        });
        assert!(became_zombie, "child must remain as an unreaped zombie");
        assert_eq!(
            process_token(pid).unwrap_err().kind(),
            io::ErrorKind::NotFound
        );
        child.0.as_mut().unwrap().wait().unwrap();
        child.0 = None;
    }

    #[test]
    fn exact_process_termination_rejects_the_wrong_creation_token() {
        let executable = std::env::current_exe().unwrap();
        let child = Command::new(executable)
            .args([
                "--exact",
                "process_identity::tests::identity_test_child",
                "--nocapture",
            ])
            .env("MIRIN_IDENTITY_TEST_CHILD", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut child = ChildGuard(Some(child));
        let pid = child.0.as_ref().unwrap().id();
        let token = (0..200)
            .find_map(|_| {
                let token = process_token(pid).ok();
                if token.is_none() {
                    thread::sleep(Duration::from_millis(10));
                }
                token
            })
            .expect("child process must expose a creation token");

        terminate_process(pid, "different-creation-token").unwrap();
        assert!(process_matches(pid, &token));
        #[cfg(not(target_os = "macos"))]
        {
            terminate_process(pid, &token).unwrap();
            child.0.as_mut().unwrap().wait().unwrap();
        }
        #[cfg(target_os = "macos")]
        {
            assert_eq!(
                terminate_process(pid, &token).unwrap_err().kind(),
                io::ErrorKind::Unsupported
            );
            assert!(process_matches(pid, &token));
            child.0.as_mut().unwrap().kill().unwrap();
            child.0.as_mut().unwrap().wait().unwrap();
        }
        child.0 = None;
        assert!(!process_matches(pid, &token));
    }

    #[test]
    fn identity_test_child() {
        if std::env::var_os("MIRIN_IDENTITY_TEST_CHILD").is_some() {
            thread::sleep(Duration::from_secs(30));
        }
    }

    struct ChildGuard(Option<Child>);

    impl Drop for ChildGuard {
        fn drop(&mut self) {
            if let Some(child) = self.0.as_mut() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}
