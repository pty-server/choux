use std::{
    ffi::OsString,
    fmt, io,
    pin::Pin,
    process::Stdio,
    task::{Context, Poll},
    time::Duration,
};

use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, ReadBuf},
    process::{Child, ChildStderr, ChildStdin, ChildStdout, Command},
    task::JoinHandle,
};

use super::pool::LinkFailure;

const STDERR_TAIL_BYTES: usize = 8 * 1024;
const EXIT_GRACE: Duration = Duration::from_secs(2);

#[derive(Debug, PartialEq, Eq)]
pub struct CommandSpec {
    pub program: OsString,
    pub args: Vec<OsString>,
    pub env: Vec<(OsString, OsString)>,
}

pub struct BridgeProcess {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: ChildStdout,
    stderr: StderrTail,
}

struct StderrTail(JoinHandle<Vec<u8>>);

impl Drop for StderrTail {
    fn drop(&mut self) {
        self.0.abort();
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct BridgeExit {
    pub code: Option<i32>,
    pub stderr: String,
}

impl BridgeProcess {
    pub fn spawn(spec: &CommandSpec) -> io::Result<Self> {
        let mut child = Command::new(&spec.program)
            .args(&spec.args)
            .envs(spec.env.iter().map(|(name, value)| (name, value)))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()?;
        let (Some(stdin), Some(stdout), Some(stderr)) =
            (child.stdin.take(), child.stdout.take(), child.stderr.take())
        else {
            return Err(io::Error::other("the bridge started without piped stdio"));
        };
        Ok(Self {
            child,
            stdin: Some(stdin),
            stdout,
            stderr: StderrTail(tokio::spawn(stderr_tail(stderr))),
        })
    }

    pub fn has_exited(&mut self) -> bool {
        !matches!(self.child.try_wait(), Ok(None))
    }

    pub async fn finish(self) -> BridgeExit {
        let Self {
            mut child,
            stdin,
            stdout,
            mut stderr,
        } = self;
        drop(stdin);
        drop(stdout);
        let status = match tokio::time::timeout(EXIT_GRACE, child.wait()).await {
            Ok(status) => status.ok(),
            Err(_) => {
                let _ = child.kill().await;
                child.try_wait().ok().flatten()
            }
        };
        let stderr = tokio::time::timeout(EXIT_GRACE, &mut stderr.0)
            .await
            .ok()
            .and_then(Result::ok)
            .unwrap_or_default();
        BridgeExit {
            code: status.and_then(|status| status.code()),
            stderr: String::from_utf8_lossy(&stderr).into_owned(),
        }
    }
}

async fn stderr_tail(mut stderr: ChildStderr) -> Vec<u8> {
    let mut tail = Vec::new();
    let mut chunk = [0; 1024];
    loop {
        match stderr.read(&mut chunk).await {
            Ok(0) | Err(_) => return tail,
            Ok(read) => {
                tail.extend_from_slice(&chunk[..read]);
                tail.drain(..tail.len().saturating_sub(STDERR_TAIL_BYTES));
            }
        }
    }
}

impl BridgeExit {
    pub fn is_permanent(&self) -> bool {
        matches!(self.code, Some(2..=4))
    }
}

impl fmt::Display for BridgeExit {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.code {
            Some(code) => write!(formatter, "the bridge exited with code {code}")?,
            None => formatter.write_str("the bridge was terminated")?,
        }
        match self
            .stderr
            .lines()
            .map(str::trim)
            .rfind(|line| !line.is_empty())
        {
            Some(line) => write!(formatter, ": {line}"),
            None => Ok(()),
        }
    }
}

impl From<BridgeExit> for LinkFailure {
    fn from(exit: BridgeExit) -> Self {
        Self {
            permanent: exit.is_permanent(),
            message: exit.to_string(),
        }
    }
}

impl AsyncRead for BridgeProcess {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.stdout).poll_read(cx, buf)
    }
}

impl AsyncWrite for BridgeProcess {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        match self.stdin.as_mut() {
            Some(stdin) => Pin::new(stdin).poll_write(cx, buf),
            None => Poll::Ready(Err(io::ErrorKind::BrokenPipe.into())),
        }
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.stdin.as_mut() {
            Some(stdin) => Pin::new(stdin).poll_flush(cx),
            None => Poll::Ready(Ok(())),
        }
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.stdin = None;
        Poll::Ready(Ok(()))
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use tokio::io::AsyncWriteExt;

    fn shell(script: &str) -> CommandSpec {
        CommandSpec {
            program: "sh".into(),
            args: vec!["-c".into(), script.into()],
            env: Vec::new(),
        }
    }

    #[tokio::test]
    async fn carries_bytes_both_ways_and_ends_on_stdin_eof() {
        let mut bridge = BridgeProcess::spawn(&shell("exec cat")).unwrap();
        bridge.write_all(b"hello\0\r\n\x1a").await.unwrap();
        bridge.shutdown().await.unwrap();
        let mut output = Vec::new();
        bridge.read_to_end(&mut output).await.unwrap();

        assert_eq!(output, b"hello\0\r\n\x1a");
        assert_eq!(
            bridge.finish().await,
            BridgeExit {
                code: Some(0),
                stderr: String::new()
            }
        );
    }

    #[tokio::test]
    async fn passes_its_environment_to_the_program() {
        let mut spec = shell("printf %s \"$CHOUX_BRIDGE_TEST\"");
        spec.env
            .push(("CHOUX_BRIDGE_TEST".into(), "a b;'c'".into()));
        let mut bridge = BridgeProcess::spawn(&spec).unwrap();
        let mut output = String::new();
        bridge.read_to_string(&mut output).await.unwrap();

        assert_eq!(output, "a b;'c'");
    }

    #[tokio::test]
    async fn reports_a_permanent_exit_with_its_last_stderr_line() {
        let mut bridge = BridgeProcess::spawn(&shell(
            "echo first >&2; echo 'ptys bridge: no server is running' >&2; exit 3",
        ))
        .unwrap();
        let mut output = Vec::new();
        bridge.read_to_end(&mut output).await.unwrap();
        while !bridge.has_exited() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let exit = bridge.finish().await;

        assert!(output.is_empty());
        assert!(exit.is_permanent());
        assert_eq!(
            exit.to_string(),
            "the bridge exited with code 3: ptys bridge: no server is running"
        );
    }

    #[tokio::test]
    async fn keeps_only_the_tail_of_a_noisy_stderr() {
        let bridge = BridgeProcess::spawn(&shell(
            "head -c 20000 /dev/zero | tr '\\0' x >&2; echo last >&2; exit 1",
        ))
        .unwrap();
        let exit = bridge.finish().await;

        assert_eq!(exit.code, Some(1));
        assert!(!exit.is_permanent());
        assert!(exit.stderr.len() <= STDERR_TAIL_BYTES);
        assert!(exit.stderr.ends_with("xxlast\n"), "{}", exit.stderr);
    }

    #[tokio::test]
    async fn kills_a_bridge_that_ignores_the_end_of_its_input() {
        let bridge = BridgeProcess::spawn(&shell("exec sleep 30")).unwrap();
        let exit = bridge.finish().await;

        assert_eq!(exit.to_string(), "the bridge was terminated");
    }

    #[tokio::test]
    async fn fails_to_start_a_missing_program() {
        let spec = CommandSpec {
            program: "choux-no-such-bridge-program".into(),
            args: Vec::new(),
            env: Vec::new(),
        };

        assert_eq!(
            BridgeProcess::spawn(&spec).err().map(|error| error.kind()),
            Some(io::ErrorKind::NotFound)
        );
    }
}
