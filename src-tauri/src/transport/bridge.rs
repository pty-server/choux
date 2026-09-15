use std::{
    ffi::OsString,
    io,
    pin::Pin,
    process::Stdio,
    sync::{Arc, Mutex, MutexGuard, PoisonError},
    task::{Context, Poll},
    time::Duration,
};

use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, ReadBuf},
    process::{Child, ChildStderr, ChildStdin, ChildStdout, Command},
    task::JoinHandle,
};

use super::exit::BridgeExit;
#[cfg(windows)]
use super::job::{self, Job};

const STDERR_TAIL_BYTES: usize = 8 * 1024;
const STDOUT_HEAD_BYTES: usize = 1024;
const EXIT_GRACE: Duration = Duration::from_secs(2);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Diagnostics {
    Plain,
    Wsl,
}

#[derive(Debug, PartialEq, Eq)]
pub struct CommandSpec {
    pub program: OsString,
    pub args: Vec<OsString>,
    pub env: Vec<(OsString, OsString)>,
    pub diagnostics: Diagnostics,
}

#[derive(Default)]
struct StdoutRecord {
    head: Vec<u8>,
    unread: Option<ChildStdout>,
}

type SharedRecord = Arc<Mutex<StdoutRecord>>;

pub struct BridgePipes {
    stdin: Option<ChildStdin>,
    stdout: Option<ChildStdout>,
    record: Option<SharedRecord>,
}

pub struct BridgeProcess {
    child: Child,
    #[cfg(windows)]
    job: Job,
    stderr: Supervised<Vec<u8>>,
    record: SharedRecord,
    diagnostics: Diagnostics,
}

struct Supervised<T>(JoinHandle<T>);

impl<T> Drop for Supervised<T> {
    fn drop(&mut self) {
        self.0.abort();
    }
}

pub fn spawn(spec: &CommandSpec) -> io::Result<(BridgePipes, BridgeProcess)> {
    let mut command = Command::new(&spec.program);
    command
        .args(&spec.args)
        .envs(spec.env.iter().map(|(name, value)| (name, value)))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(job::SUSPENDED_WITHOUT_WINDOW);
    #[cfg(windows)]
    let job = Job::new()?;
    let mut child = command.spawn()?;
    #[cfg(windows)]
    job.contain(&child)?;
    let (Some(stdin), Some(stdout), Some(stderr)) =
        (child.stdin.take(), child.stdout.take(), child.stderr.take())
    else {
        return Err(io::Error::other("the bridge started without piped stdio"));
    };
    let record = SharedRecord::default();
    let pipes = BridgePipes {
        stdin: Some(stdin),
        stdout: Some(stdout),
        record: (spec.diagnostics == Diagnostics::Wsl).then(|| Arc::clone(&record)),
    };
    let process = BridgeProcess {
        child,
        #[cfg(windows)]
        job,
        stderr: Supervised(tokio::spawn(stderr_tail(stderr))),
        record,
        diagnostics: spec.diagnostics,
    };
    Ok((pipes, process))
}

fn lock(record: &SharedRecord) -> MutexGuard<'_, StdoutRecord> {
    record.lock().unwrap_or_else(PoisonError::into_inner)
}

impl BridgeProcess {
    #[cfg(all(test, windows))]
    pub fn id(&self) -> u32 {
        self.child.id().expect("the bridge has already exited")
    }

    pub fn has_exited(&mut self) -> bool {
        !matches!(self.child.try_wait(), Ok(None))
    }

    pub async fn finish(mut self) -> BridgeExit {
        let unread = lock(&self.record).unread.take();
        let draining = unread
            .map(|stdout| Supervised(tokio::spawn(drain_stdout(stdout, Arc::clone(&self.record)))));
        let code = match tokio::time::timeout(EXIT_GRACE, self.child.wait()).await {
            Ok(status) => status.ok().and_then(|status| status.code()),
            Err(_) => {
                self.terminate();
                let _ = tokio::time::timeout(EXIT_GRACE, self.child.wait()).await;
                None
            }
        };
        if let Some(mut draining) = draining {
            if tokio::time::timeout(EXIT_GRACE, &mut draining.0)
                .await
                .is_err()
            {
                draining.0.abort();
                let _ = (&mut draining.0).await;
            }
        }
        let stderr = tokio::time::timeout(EXIT_GRACE, &mut self.stderr.0)
            .await
            .ok()
            .and_then(Result::ok)
            .unwrap_or_default();
        let stdout = std::mem::take(&mut lock(&self.record).head);
        BridgeExit::new(code, &stderr, &stdout, self.diagnostics)
    }

    fn terminate(&mut self) {
        #[cfg(windows)]
        {
            if self.job.terminate().is_ok() {
                return;
            }
        }
        let _ = self.child.start_kill();
    }
}

async fn drain_stdout(mut stdout: ChildStdout, record: SharedRecord) {
    let mut chunk = [0; STDOUT_HEAD_BYTES];
    loop {
        let read = match stdout.read(&mut chunk).await {
            Ok(0) | Err(_) => return,
            Ok(read) => read,
        };
        let mut shared = lock(&record);
        let room = STDOUT_HEAD_BYTES.saturating_sub(shared.head.len());
        shared.head.extend_from_slice(&chunk[..read.min(room)]);
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

impl BridgePipes {
    fn record_head(&mut self, read: &[u8]) {
        let Some(record) = &self.record else {
            return;
        };
        let mut shared = lock(record);
        let room = STDOUT_HEAD_BYTES - shared.head.len();
        shared.head.extend_from_slice(&read[..read.len().min(room)]);
        let full = shared.head.len() == STDOUT_HEAD_BYTES;
        drop(shared);
        if full {
            self.record = None;
        }
    }
}

impl Drop for BridgePipes {
    fn drop(&mut self) {
        if let Some(record) = self.record.take() {
            lock(&record).unread = self.stdout.take();
        }
    }
}

impl AsyncRead for BridgePipes {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let pipes = self.get_mut();
        let Some(stdout) = pipes.stdout.as_mut() else {
            return Poll::Ready(Ok(()));
        };
        let filled = buf.filled().len();
        let polled = Pin::new(stdout).poll_read(cx, buf);
        if polled.is_ready() {
            pipes.record_head(&buf.filled()[filled..]);
        }
        polled
    }
}

impl AsyncWrite for BridgePipes {
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
            diagnostics: Diagnostics::Plain,
        }
    }

    #[tokio::test]
    async fn carries_bytes_both_ways_and_ends_on_stdin_eof() {
        let (mut pipes, process) = spawn(&shell("exec cat")).unwrap();
        pipes.write_all(b"hello\0\r\n\x1a").await.unwrap();
        pipes.shutdown().await.unwrap();
        let mut output = Vec::new();
        pipes.read_to_end(&mut output).await.unwrap();
        drop(pipes);
        let exit = process.finish().await;

        assert_eq!(output, b"hello\0\r\n\x1a");
        assert_eq!((exit.code, exit.stderr.as_str()), (Some(0), ""));
    }

    #[tokio::test]
    async fn passes_its_environment_to_the_program() {
        let mut spec = shell("printf %s \"$CHOUX_BRIDGE_TEST\"");
        spec.env
            .push(("CHOUX_BRIDGE_TEST".into(), "a b;'c'".into()));
        let (mut pipes, _process) = spawn(&spec).unwrap();
        let mut output = String::new();
        pipes.read_to_string(&mut output).await.unwrap();

        assert_eq!(output, "a b;'c'");
    }

    #[tokio::test]
    async fn reports_a_permanent_exit_with_its_last_stderr_line() {
        let (mut pipes, mut process) = spawn(&shell(
            "echo first >&2; echo 'ptys bridge: no server is running' >&2; exit 3",
        ))
        .unwrap();
        let mut output = Vec::new();
        pipes.read_to_end(&mut output).await.unwrap();
        while !process.has_exited() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        drop(pipes);
        let exit = process.finish().await;

        assert!(output.is_empty());
        assert!(exit.is_permanent());
        assert_eq!(
            exit.to_string(),
            "the bridge exited with code 3: ptys bridge: no server is running"
        );
    }

    #[tokio::test]
    async fn keeps_only_the_tail_of_a_noisy_stderr() {
        let (pipes, process) = spawn(&shell(
            "head -c 20000 /dev/zero | tr '\\0' x >&2; echo last >&2; exit 1",
        ))
        .unwrap();
        drop(pipes);
        let exit = process.finish().await;

        assert_eq!(exit.code, Some(1));
        assert!(!exit.is_permanent());
        assert!(exit.stderr.len() <= STDERR_TAIL_BYTES);
        assert!(exit.stderr.ends_with("xxlast\n"), "{}", exit.stderr);
    }

    #[tokio::test]
    async fn kills_a_bridge_that_ignores_the_end_of_its_input() {
        let (pipes, process) = spawn(&shell("exec sleep 30")).unwrap();
        drop(pipes);
        let exit = process.finish().await;

        assert_eq!(exit.to_string(), "the bridge was terminated");
    }

    #[tokio::test]
    async fn fails_to_start_a_missing_program() {
        let spec = CommandSpec {
            program: "choux-no-such-bridge-program".into(),
            args: Vec::new(),
            env: Vec::new(),
            diagnostics: Diagnostics::Plain,
        };

        assert_eq!(
            spawn(&spec).err().map(|error| error.kind()),
            Some(io::ErrorKind::NotFound)
        );
    }

    #[tokio::test]
    async fn keeps_the_start_of_stdout_for_a_wsl_diagnosis_including_what_was_never_read() {
        let mut spec = shell("printf 'first\\n'; head -c 3000 /dev/zero | tr '\\0' x; exit 1");
        spec.diagnostics = Diagnostics::Wsl;
        let (mut pipes, process) = spawn(&spec).unwrap();
        let mut first = [0; 6];
        pipes.read_exact(&mut first).await.unwrap();
        drop(pipes);
        let exit = process.finish().await;

        assert_eq!(&first, b"first\n");
        assert_eq!(exit.stdout.len(), STDOUT_HEAD_BYTES);
        assert!(exit.stdout.starts_with("first\nxxx"), "{}", exit.stdout);
    }

    #[tokio::test]
    async fn keeps_no_stdout_for_a_plain_bridge() {
        let (pipes, process) = spawn(&shell("printf ignored; exit 1")).unwrap();
        drop(pipes);

        assert!(process.finish().await.stdout.is_empty());
    }

    #[tokio::test]
    async fn keeps_the_exit_code_of_a_wsl_bridge_that_writes_more_than_a_pipe_holds() {
        let mut spec = shell("head -c 300000 /dev/zero | tr '\\0' x; exit 3");
        spec.diagnostics = Diagnostics::Wsl;
        let (mut pipes, process) = spawn(&spec).unwrap();
        let mut first = [0; 1];
        pipes.read_exact(&mut first).await.unwrap();
        drop(pipes);
        let exit = process.finish().await;

        assert_eq!(exit.code, Some(3));
        assert_eq!(exit.stdout.len(), STDOUT_HEAD_BYTES);
    }
}
