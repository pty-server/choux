use std::{ffi::OsString, io, process::Stdio, time::Duration};

use tokio::process::{Child, Command};

use super::{
    gate::{RunningFuture, RunningQuery},
    parse,
};
use crate::transport::{
    bridge::CommandSpec,
    exit::{decode_wsl_output, wsl_failure},
    target::wsl_exe,
};

const RUNNING_DEADLINE: Duration = Duration::from_secs(10);
const MESSAGE_MAX: usize = 1200;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Launch {
    Attached,
    Detached,
}

#[derive(Debug)]
pub struct WslOutput {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

impl WslOutput {
    pub fn succeeded(&self) -> bool {
        self.code == Some(0)
    }

    pub fn message(&self) -> String {
        if let Some(failure) = wsl_failure(self.code, &self.stdout, &self.stderr) {
            return failure;
        }
        let text = format!("{}\n{}", self.stdout.trim(), self.stderr.trim());
        let text = text.trim();
        if !text.is_empty() {
            return text.chars().take(MESSAGE_MAX).collect();
        }
        match self.code {
            Some(code) => format!("wsl.exe exited with code {code}"),
            None => "wsl.exe was terminated".into(),
        }
    }
}

pub fn os_args(args: &[&str]) -> Vec<OsString> {
    args.iter().map(OsString::from).collect()
}

pub async fn run(
    spec: &CommandSpec,
    deadline: Duration,
    launch: Launch,
) -> Result<WslOutput, String> {
    let child = spawn(spec, launch)?;
    let output = tokio::time::timeout(deadline, child.wait_with_output())
        .await
        .map_err(|_| format!("wsl.exe did not finish within {}s.", deadline.as_secs()))?
        .map_err(|error| format!("Could not read the output of wsl.exe: {error}"))?;
    Ok(WslOutput {
        code: output.status.code(),
        stdout: decode_wsl_output(&output.stdout),
        stderr: decode_wsl_output(&output.stderr),
    })
}

fn spawn_failure(error: io::Error) -> String {
    match error.kind() {
        io::ErrorKind::NotFound => {
            "wsl.exe was not found. Install WSL with `wsl --install`, then retry.".to_string()
        }
        _ => format!("Could not run wsl.exe: {error}"),
    }
}

fn command(spec: &CommandSpec) -> Command {
    let mut command = Command::new(&spec.program);
    command
        .args(&spec.args)
        .envs(spec.env.iter().map(|(name, value)| (name, value)))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    command
}

#[cfg(windows)]
const KEPT_IN_JOB: &str = "Choux runs inside a Windows job that would stop ptys when Choux exits and does not let the daemon leave it. Start the daemon from a terminal inside the distribution with `ptys server start` instead.";

#[cfg(windows)]
fn spawn(spec: &CommandSpec, launch: Launch) -> Result<Child, String> {
    use windows_sys::Win32::{
        Foundation::ERROR_ACCESS_DENIED,
        System::Threading::{CREATE_BREAKAWAY_FROM_JOB, CREATE_NO_WINDOW},
    };

    if launch == Launch::Detached {
        match command(spec)
            .creation_flags(CREATE_NO_WINDOW | CREATE_BREAKAWAY_FROM_JOB)
            .spawn()
        {
            Err(error) if error.raw_os_error() == Some(ERROR_ACCESS_DENIED as i32) => {
                if own_job_kills_on_close() {
                    return Err(KEPT_IN_JOB.into());
                }
            }
            spawned => return spawned.map_err(spawn_failure),
        }
    }
    command(spec)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(spawn_failure)
}

#[cfg(windows)]
fn own_job_kills_on_close() -> bool {
    use std::{mem, ptr};
    use windows_sys::Win32::System::JobObjects::{
        JobObjectExtendedLimitInformation, QueryInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { mem::zeroed() };
    let queried = unsafe {
        QueryInformationJobObject(
            ptr::null_mut(),
            JobObjectExtendedLimitInformation,
            ptr::from_mut(&mut limits).cast(),
            mem::size_of_val(&limits) as u32,
            ptr::null_mut(),
        )
    };
    queried == 0
        || limits.BasicLimitInformation.LimitFlags & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE != 0
}

#[cfg(not(windows))]
fn spawn(spec: &CommandSpec, _launch: Launch) -> Result<Child, String> {
    command(spec).spawn().map_err(spawn_failure)
}

pub async fn running_distros() -> Option<Vec<String>> {
    let output = run(
        &wsl_exe(os_args(&["-l", "--running", "-q"])),
        RUNNING_DEADLINE,
        Launch::Attached,
    )
    .await
    .ok()?;
    output
        .succeeded()
        .then(|| parse::running_distros(&output.stdout))
}

#[derive(Default)]
pub struct WslRunning;

impl RunningQuery for WslRunning {
    fn running(&self) -> RunningFuture<'_> {
        Box::pin(running_distros())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::bridge::Diagnostics;

    fn output(code: Option<i32>, stdout: &str, stderr: &str) -> WslOutput {
        WslOutput {
            code,
            stdout: stdout.into(),
            stderr: stderr.into(),
        }
    }

    #[test]
    fn explains_a_failure_by_the_wsl_service_before_the_program_output() {
        assert_eq!(
            output(
                Some(-1),
                "There is no distribution with the supplied name.\r\nError code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND\r\n",
                ""
            )
            .message(),
            "There is no distribution with the supplied name. (Wsl/Service/WSL_E_DISTRO_NOT_FOUND)"
        );
        assert_eq!(
            output(Some(1), "", "npm error code EACCES\n").message(),
            "npm error code EACCES"
        );
        assert_eq!(
            output(Some(3), "", "").message(),
            "wsl.exe exited with code 3"
        );
        assert_eq!(output(None, "", "").message(), "wsl.exe was terminated");
    }

    #[test]
    fn keeps_a_long_message_short() {
        assert_eq!(
            output(Some(1), &"x".repeat(5000), "").message().len(),
            MESSAGE_MAX
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn runs_a_command_with_closed_input_and_reads_both_outputs() {
        let spec = CommandSpec {
            program: "sh".into(),
            args: os_args(&["-c", "cat; printf out; printf err >&2; exit 4"]),
            env: Vec::new(),
            diagnostics: Diagnostics::Wsl,
        };

        let output = run(&spec, Duration::from_secs(5), Launch::Detached)
            .await
            .unwrap();

        assert_eq!(
            (output.code, output.stdout.as_str(), output.stderr.as_str()),
            (Some(4), "out", "err")
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn gives_up_on_a_command_that_outlives_its_deadline() {
        let spec = CommandSpec {
            program: "sh".into(),
            args: os_args(&["-c", "exec sleep 30"]),
            env: Vec::new(),
            diagnostics: Diagnostics::Wsl,
        };

        assert!(run(&spec, Duration::from_millis(200), Launch::Attached)
            .await
            .unwrap_err()
            .starts_with("wsl.exe did not finish within"));
    }

    #[tokio::test]
    async fn reports_a_missing_wsl_as_something_to_install() {
        let spec = CommandSpec {
            program: "choux-no-such-wsl".into(),
            args: Vec::new(),
            env: Vec::new(),
            diagnostics: Diagnostics::Wsl,
        };

        assert!(run(&spec, Duration::from_secs(5), Launch::Attached)
            .await
            .unwrap_err()
            .starts_with("wsl.exe was not found"));
    }
}
