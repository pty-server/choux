use std::{
    ffi::c_void,
    io, mem,
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle},
    ptr,
};

use tokio::process::Child;
use windows_sys::Win32::{
    Foundation::{HANDLE, INVALID_HANDLE_VALUE},
    System::{
        Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
        },
        JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        },
        Threading::{
            OpenThread, ResumeThread, CREATE_NO_WINDOW, CREATE_SUSPENDED, THREAD_SUSPEND_RESUME,
        },
    },
};

pub const SUSPENDED_WITHOUT_WINDOW: u32 = CREATE_NO_WINDOW | CREATE_SUSPENDED;
const TERMINATED_EXIT_CODE: u32 = 1;
const RESUME_FAILED: u32 = u32::MAX;

pub struct Job(OwnedHandle);

impl Job {
    pub fn new() -> io::Result<Self> {
        let job = Self(owned(
            unsafe { CreateJobObjectW(ptr::null(), ptr::null()) },
            ptr::null_mut(),
        )?);
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        check(unsafe {
            SetInformationJobObject(
                raw(&job.0),
                JobObjectExtendedLimitInformation,
                ptr::from_ref(&limits).cast::<c_void>(),
                mem::size_of_val(&limits) as u32,
            )
        })?;
        Ok(job)
    }

    pub fn contain(&self, child: &Child) -> io::Result<()> {
        let (Some(process), Some(pid)) = (child.raw_handle(), child.id()) else {
            return Err(io::Error::other(
                "the bridge exited before it could be contained",
            ));
        };
        check(unsafe { AssignProcessToJobObject(raw(&self.0), process as HANDLE) })?;
        resume_threads(pid)
    }

    pub fn terminate(&self) -> io::Result<()> {
        check(unsafe { TerminateJobObject(raw(&self.0), TERMINATED_EXIT_CODE) })
    }
}

fn resume_threads(pid: u32) -> io::Result<()> {
    let snapshot = owned(
        unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) },
        INVALID_HANDLE_VALUE,
    )?;
    let mut entry = THREADENTRY32 {
        dwSize: mem::size_of::<THREADENTRY32>() as u32,
        ..unsafe { mem::zeroed() }
    };
    let mut resumed = 0;
    let mut listed = unsafe { Thread32First(raw(&snapshot), &mut entry) } != 0;
    while listed {
        if entry.th32OwnerProcessID == pid {
            let thread = owned(
                unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) },
                ptr::null_mut(),
            )?;
            if unsafe { ResumeThread(raw(&thread)) } == RESUME_FAILED {
                return Err(io::Error::last_os_error());
            }
            resumed += 1;
        }
        listed = unsafe { Thread32Next(raw(&snapshot), &mut entry) } != 0;
    }
    if resumed == 0 {
        Err(io::Error::other(
            "the suspended bridge has no thread to resume",
        ))
    } else {
        Ok(())
    }
}

fn owned(handle: HANDLE, failed: HANDLE) -> io::Result<OwnedHandle> {
    if handle == failed {
        Err(io::Error::last_os_error())
    } else {
        Ok(unsafe { OwnedHandle::from_raw_handle(handle as RawHandle) })
    }
}

fn raw(handle: &OwnedHandle) -> HANDLE {
    handle.as_raw_handle() as HANDLE
}

fn check(result: i32) -> io::Result<()> {
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use crate::transport::{
        bridge::{spawn, CommandSpec, Diagnostics},
        process_tree::{all_exit_within, wait_for_tree, Holder},
    };

    const APPEAR: Duration = Duration::from_secs(10);
    const EXIT: Duration = Duration::from_secs(5);

    fn bridge_ignoring_its_input() -> CommandSpec {
        CommandSpec {
            program: "cmd.exe".into(),
            args: vec!["/d".into(), "/c".into(), "ping -n 60 127.0.0.1 >nul".into()],
            env: Vec::new(),
            diagnostics: Diagnostics::Plain,
        }
    }

    #[tokio::test]
    async fn dropping_a_bridge_ends_every_process_it_started() {
        let (pipes, process) = spawn(&bridge_ignoring_its_input()).unwrap();
        let tree = wait_for_tree(process.id(), "ping.exe", 1, APPEAR);
        drop(pipes);
        drop(process);

        assert_eq!(all_exit_within(&tree, EXIT), Ok(()));
    }

    #[tokio::test]
    async fn finishing_a_bridge_that_ignores_its_closed_input_ends_its_whole_tree() {
        let (pipes, process) = spawn(&bridge_ignoring_its_input()).unwrap();
        let tree = wait_for_tree(process.id(), "ping.exe", 1, APPEAR);
        drop(pipes);
        let exit = process.finish().await;

        assert_eq!(exit.to_string(), "the bridge was terminated");
        assert_eq!(all_exit_within(&tree, EXIT), Ok(()));
    }

    #[test]
    fn a_killed_owner_leaves_no_bridge_process_behind() {
        let mut holder = Holder::start(module_path!(), "holds_a_bridge_until_killed");
        let tree = wait_for_tree(holder.id(), "ping.exe", 1, APPEAR);
        holder.kill();

        assert_eq!(all_exit_within(&tree, EXIT), Ok(()));
    }

    #[tokio::test]
    #[ignore = "started by a_killed_owner_leaves_no_bridge_process_behind"]
    async fn holds_a_bridge_until_killed() {
        if !Holder::requested() {
            return;
        }
        let _bridge = spawn(&bridge_ignoring_its_input()).unwrap();
        Holder::announce_ready();
        tokio::time::sleep(Duration::from_secs(60)).await;
    }
}
