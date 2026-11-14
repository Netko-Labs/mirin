//! Hardware counters for the frame trace (`--features profiling`, Linux on
//! x86-64): the instructions and CPU cycles the window's thread ran in user
//! space, read at the start and the end of a frame. A frame's time moves
//! with whatever else the machine is doing; its instructions do not, and
//! its cycles only with what the caches hold, so two hosts can be told
//! apart on a machine that is building something else
//! (`bench/stress.tsx`'s `cycles` and `instr` lines).
//!
//! The counters are the kernel's (`perf_event_open`), opened for this
//! thread alone the first time they are read; where the kernel refuses
//! (`perf_event_paranoid` above 2, no hardware counters in a virtual
//! machine) there are none and the trace says nothing of them.

/// The thread's counters when read.
// Never made where there are no counters to read.
#[cfg_attr(
    not(all(feature = "profiling", target_os = "linux", target_arch = "x86_64")),
    allow(dead_code)
)]
#[derive(Clone, Copy)]
pub(crate) struct Counted {
    instructions: u64,
    cycles: u64,
}

impl Counted {
    /// What ran since `before`, for a trace line: `, 1.23M instructions,
    /// 2.34M cycles`.
    pub(crate) fn since(self, before: Counted) -> String {
        format!(
            ", {:.3}M instructions, {:.3}M cycles",
            self.instructions.wrapping_sub(before.instructions) as f64 / 1e6,
            self.cycles.wrapping_sub(before.cycles) as f64 / 1e6
        )
    }
}

/// The calling thread's counters now, when tracing is on and it has any.
pub(crate) fn read() -> Option<Counted> {
    if !crate::trace::enabled() {
        return None;
    }
    imp::read()
}

#[cfg(all(feature = "profiling", target_os = "linux", target_arch = "x86_64"))]
mod imp {
    use std::cell::OnceCell;
    use std::ffi::{c_int, c_long, c_ulong};
    use std::fs::File;
    use std::io::Read;
    use std::os::fd::FromRawFd;

    use super::Counted;

    /// The first 64 bytes of the kernel's `perf_event_attr`
    /// (`PERF_ATTR_SIZE_VER0`): all a counting event needs.
    #[repr(C)]
    struct Attr {
        kind: u32,
        size: u32,
        config: u64,
        sample_period: u64,
        sample_type: u64,
        read_format: u64,
        flags: u64,
        wakeup_events: u32,
        bp_type: u32,
        config1: u64,
    }

    /// `PERF_TYPE_HARDWARE`'s `PERF_COUNT_HW_CPU_CYCLES` and
    /// `PERF_COUNT_HW_INSTRUCTIONS`.
    const CYCLES: u64 = 0;
    const INSTRUCTIONS: u64 = 1;

    thread_local! {
        /// This thread's counters (instructions, cycles), or none.
        static COUNTERS: OnceCell<Option<[File; 2]>> = const { OnceCell::new() };
    }

    /// Open a counter of this thread's user-space `config` events.
    fn open(config: u64) -> Option<File> {
        /// `perf_event_open` on x86-64.
        const PERF_EVENT_OPEN: c_long = 298;
        /// `exclude_kernel` and `exclude_hv`: what an unprivileged process
        /// may count.
        const USER_ONLY: u64 = (1 << 5) | (1 << 6);
        extern "C" {
            fn syscall(number: c_long, ...) -> c_long;
        }
        let attr = Attr {
            kind: 0,
            size: std::mem::size_of::<Attr>() as u32,
            config,
            sample_period: 0,
            sample_type: 0,
            read_format: 0,
            flags: USER_ONLY,
            wakeup_events: 0,
            bp_type: 0,
            config1: 0,
        };
        let (this_thread, any_cpu, no_group): (c_int, c_int, c_int) = (0, -1, -1);
        let flags: c_ulong = 0;
        // SAFETY: `attr` is a live `perf_event_attr` of the size it states,
        // which the kernel only reads; the other arguments are plain
        // integers of the types the system call takes.
        let fd = unsafe {
            syscall(
                PERF_EVENT_OPEN,
                &attr as *const Attr,
                this_thread,
                any_cpu,
                no_group,
                flags,
            )
        };
        let fd = c_int::try_from(fd).ok().filter(|fd| *fd >= 0)?;
        // SAFETY: the kernel just returned `fd` to this call, which owns it
        // alone; the `File` closes it.
        Some(unsafe { File::from_raw_fd(fd) })
    }

    fn value(mut file: &File) -> Option<u64> {
        let mut bytes = [0u8; 8];
        file.read_exact(&mut bytes).ok()?;
        Some(u64::from_ne_bytes(bytes))
    }

    pub(super) fn read() -> Option<Counted> {
        COUNTERS.with(|counters| {
            let [instructions, cycles] = counters
                .get_or_init(|| Some([open(INSTRUCTIONS)?, open(CYCLES)?]))
                .as_ref()?;
            Some(Counted {
                instructions: value(instructions)?,
                cycles: value(cycles)?,
            })
        })
    }
}

#[cfg(not(all(feature = "profiling", target_os = "linux", target_arch = "x86_64")))]
mod imp {
    pub(super) fn read() -> Option<super::Counted> {
        None
    }
}
