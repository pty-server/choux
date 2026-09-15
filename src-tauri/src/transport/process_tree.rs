use std::{
    env,
    io::{BufRead, BufReader, Write},
    mem,
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle},
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use windows_sys::Win32::{
    Foundation::{HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0},
    System::{
        Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        },
        Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE},
    },
};

const HOLDER_ENV: &str = "CHOUX_TEST_BRIDGE_HOLDER";
const HOLDER_READY: &str = "choux-test-bridge-holder-ready";
const POLL: Duration = Duration::from_millis(50);

pub struct TreeProcess {
    name: String,
    handle: OwnedHandle,
}

struct ProcessEntry {
    pid: u32,
    parent: u32,
    name: String,
}

fn processes() -> Vec<ProcessEntry> {
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    assert_ne!(snapshot, INVALID_HANDLE_VALUE, "no process snapshot");
    let snapshot = unsafe { OwnedHandle::from_raw_handle(snapshot as RawHandle) };
    let mut entry = PROCESSENTRY32W {
        dwSize: mem::size_of::<PROCESSENTRY32W>() as u32,
        ..unsafe { mem::zeroed() }
    };
    let mut entries = Vec::new();
    let mut listed =
        unsafe { Process32FirstW(snapshot.as_raw_handle() as HANDLE, &mut entry) } != 0;
    while listed {
        let length = entry
            .szExeFile
            .iter()
            .position(|unit| *unit == 0)
            .unwrap_or(entry.szExeFile.len());
        entries.push(ProcessEntry {
            pid: entry.th32ProcessID,
            parent: entry.th32ParentProcessID,
            name: String::from_utf16_lossy(&entry.szExeFile[..length]),
        });
        listed = unsafe { Process32NextW(snapshot.as_raw_handle() as HANDLE, &mut entry) } != 0;
    }
    entries
}

fn open(pid: u32, name: String) -> Option<TreeProcess> {
    let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
    (!handle.is_null()).then(|| TreeProcess {
        name,
        handle: unsafe { OwnedHandle::from_raw_handle(handle as RawHandle) },
    })
}

fn tree(root: u32) -> Vec<TreeProcess> {
    let entries = processes();
    let mut pids = vec![root];
    let mut index = 0;
    while index < pids.len() {
        let parent = pids[index];
        let children: Vec<u32> = entries
            .iter()
            .filter(|entry| entry.parent == parent && !pids.contains(&entry.pid))
            .map(|entry| entry.pid)
            .collect();
        pids.extend(children);
        index += 1;
    }
    pids.into_iter()
        .filter_map(|pid| {
            let name = entries
                .iter()
                .find(|entry| entry.pid == pid)
                .map_or_else(String::new, |entry| entry.name.clone());
            open(pid, name)
        })
        .collect()
}

pub fn wait_for_tree(root: u32, name: &str, count: usize, timeout: Duration) -> Vec<TreeProcess> {
    let deadline = Instant::now() + timeout;
    loop {
        let found = tree(root);
        let matching = found
            .iter()
            .filter(|process| process.name.eq_ignore_ascii_case(name))
            .count();
        if matching >= count {
            return found;
        }
        assert!(
            Instant::now() < deadline,
            "{count} {name} did not appear under {root}: {:?}",
            found
                .iter()
                .map(|process| &process.name)
                .collect::<Vec<_>>()
        );
        thread::sleep(POLL);
    }
}

pub fn all_exit_within(processes: &[TreeProcess], timeout: Duration) -> Result<(), Vec<String>> {
    let deadline = Instant::now() + timeout;
    let running: Vec<String> = processes
        .iter()
        .filter(|process| {
            let remaining = deadline
                .saturating_duration_since(Instant::now())
                .as_millis() as u32;
            let waited =
                unsafe { WaitForSingleObject(process.handle.as_raw_handle() as HANDLE, remaining) };
            waited != WAIT_OBJECT_0
        })
        .map(|process| process.name.clone())
        .collect();
    if running.is_empty() {
        Ok(())
    } else {
        Err(running)
    }
}

pub struct Holder(Child);

impl Holder {
    pub fn start(module: &str, test: &str) -> Self {
        let module = module.split_once("::").map_or(module, |(_, path)| path);
        let name = format!("{module}::{test}");
        let mut child = Command::new(env::current_exe().unwrap())
            .args([
                name.as_str(),
                "--exact",
                "--ignored",
                "--nocapture",
                "--test-threads=1",
            ])
            .env(HOLDER_ENV, "1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
        let ready = lines
            .by_ref()
            .map_while(Result::ok)
            .any(|line| line.contains(HOLDER_READY));
        thread::spawn(move || lines.for_each(drop));
        let holder = Self(child);
        assert!(ready, "{name} exited before it was ready");
        holder
    }

    pub fn requested() -> bool {
        env::var_os(HOLDER_ENV).is_some()
    }

    pub fn announce_ready() {
        let mut stdout = std::io::stdout();
        writeln!(stdout, "{HOLDER_READY}").unwrap();
        stdout.flush().unwrap();
    }

    pub fn id(&self) -> u32 {
        self.0.id()
    }

    pub fn kill(&mut self) {
        self.0.kill().unwrap();
        self.0.wait().unwrap();
    }
}

impl Drop for Holder {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
