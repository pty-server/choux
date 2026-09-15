mod gate;
#[cfg(all(test, windows))]
mod host_tests;
mod parse;
mod run;

use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::State;

pub use gate::{refusal, DistroGate, GatedConnector, Refusal};
use parse::{field, ListedDistro, MARKER};
pub use run::WslRunning;
use run::{os_args, Launch, WslOutput};

use crate::{
    connection::ConnectionHub,
    transport::{
        bridge::CommandSpec,
        target::{
            checked_node_bin, on_windows_drive, path_env, system_node_dir, valid_distro,
            valid_instance, valid_user, wsl_command, wsl_exe, wsl_host_path, SYSTEM_PATH,
        },
    },
};

const QUERY_DEADLINE: Duration = Duration::from_secs(15);
const PROBE_DEADLINE: Duration = Duration::from_secs(30);
const SHELL_DEADLINE: Duration = Duration::from_secs(10);
const START_DEADLINE: Duration = Duration::from_secs(60);
const INSTALL_DEADLINE: Duration = Duration::from_secs(600);
const SHELL_FLAGS: [&str; 3] = ["-lic", "-ic", "-lc"];
const FALLBACK_SHELL: &str = "/bin/sh";
const PACKAGE: &str = "@pty-server/ptys@latest";
const ALREADY_RUNNING: &str = "daemon already running";
const NOT_WINDOWS: &str = "WSL connections are only available on Windows.";
const OUTDATED: &str =
    "WSL is not installed, or it is older than 2.0.0. Run `wsl --install` or `wsl --update`, then retry.";

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WslDistro {
    name: String,
    default: bool,
    running: bool,
    version: Option<u8>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WslStatus {
    supported: bool,
    version: Option<String>,
    problem: Option<String>,
    distros: Vec<WslDistro>,
}

impl WslStatus {
    fn problem(version: Option<String>, problem: String) -> Self {
        Self {
            supported: true,
            version,
            problem: Some(problem),
            distros: Vec::new(),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WslProbe {
    user: String,
    home: Option<String>,
    node_available: bool,
    node_bin: Option<String>,
    npm_available: bool,
    ptys_version: Option<String>,
    message: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WslHost {
    distro: String,
    user: String,
    node_bin: Option<String>,
}

impl WslHost {
    async fn run(
        &self,
        program: &[&str],
        deadline: Duration,
        launch: Launch,
    ) -> Result<WslOutput, String> {
        if !cfg!(windows) {
            return Err(NOT_WINDOWS.into());
        }
        let path = wsl_host_path(&self.distro, &self.user, self.node_bin.as_deref())?;
        let spec = wsl_command(&self.distro, Some(&self.user), path_env(&path, program));
        run::run(&spec, deadline, launch).await
    }
}

type RunningGuard<'a> = Option<&'a ConnectionHub>;

fn identity_script() -> String {
    format!(
        r#"printf '%s\n' {MARKER} "user=$(id -un)" "home=$HOME" "shell=$SHELL" "node=$(command -v node)" {MARKER}"#
    )
}

fn node_script() -> String {
    format!(r#"printf '%s\n' {MARKER} "node=$(command -v node)" {MARKER}"#)
}

fn tools_script() -> String {
    format!(
        r#"printf '%s\n' {MARKER} "npm=$(command -v npm)" "ptys=$(command -v ptys)"
if version=$(ptys --version 2>&1); then printf 'version=%s\n' "$version"; else printf 'error=%s\n' "$version"; fi
printf '%s\n' {MARKER}"#
    )
}

#[tauri::command]
pub fn wsl_supported() -> bool {
    cfg!(windows)
}

struct VersionCheck {
    text: Option<String>,
    problem: Option<String>,
}

async fn check_version() -> VersionCheck {
    let output = match run::run(
        &wsl_exe(os_args(&["--version"])),
        QUERY_DEADLINE,
        Launch::Attached,
    )
    .await
    {
        Ok(output) => output,
        Err(problem) => {
            return VersionCheck {
                text: None,
                problem: Some(problem),
            }
        }
    };
    match parse::wsl_version(&output.stdout).filter(|_| output.succeeded()) {
        None => VersionCheck {
            text: None,
            problem: Some(OUTDATED.into()),
        },
        Some(version) if !version.is_supported() => VersionCheck {
            problem: Some(format!(
                "WSL {} is older than 2.0.0. Run `wsl --update`, then retry.",
                version.text
            )),
            text: Some(version.text),
        },
        Some(version) => VersionCheck {
            text: Some(version.text),
            problem: None,
        },
    }
}

#[tauri::command]
pub async fn wsl_status() -> WslStatus {
    if !cfg!(windows) {
        return WslStatus::default();
    }
    let version = check_version().await;
    if let Some(problem) = version.problem {
        return WslStatus::problem(version.text, problem);
    }
    let listed = match listed_distros().await {
        Ok(listed) => listed,
        Err(message) => return WslStatus::problem(version.text, message),
    };
    let running = run::running_distros().await.unwrap_or_default();
    WslStatus {
        supported: true,
        version: version.text,
        problem: None,
        distros: listed
            .into_iter()
            .map(|listed| WslDistro {
                running: running.contains(&listed.name),
                name: listed.name,
                default: listed.default,
                version: listed.version,
            })
            .collect(),
    }
}

async fn listed_distros() -> Result<Vec<ListedDistro>, String> {
    let output = run::run(
        &wsl_exe(os_args(&["-l", "-v"])),
        QUERY_DEADLINE,
        Launch::Attached,
    )
    .await?;
    if output.succeeded() {
        Ok(parse::listed_distros(&output.stdout))
    } else if parse::reports_no_distributions(&output.stdout) {
        Ok(Vec::new())
    } else {
        Err(output.message())
    }
}

async fn ensure_usable_distro(distro: &str) -> Result<(), String> {
    if let Some(problem) = check_version().await.problem {
        return Err(problem);
    }
    match listed_distros()
        .await?
        .iter()
        .find(|listed| listed.name == distro)
    {
        None => Err(format!("There is no WSL distribution named {distro}.")),
        Some(listed) if listed.version == Some(1) => Err(format!(
            "{distro} runs on WSL 1, which Choux does not support. Convert it with `wsl --set-version {distro} 2`."
        )),
        Some(_) => Ok(()),
    }
}

#[tauri::command]
pub async fn wsl_probe(
    hub: State<'_, ConnectionHub>,
    distro: String,
    user: Option<String>,
    only_running: Option<bool>,
) -> Result<WslProbe, String> {
    let guard = (only_running == Some(true)).then_some(&*hub);
    let probe = inspect(distro, user, guard).await;
    hub.forget_running_distros().await;
    probe
}

async fn inspect(
    distro: String,
    user: Option<String>,
    guard: RunningGuard<'_>,
) -> Result<WslProbe, String> {
    if !cfg!(windows) {
        return Err(NOT_WINDOWS.into());
    }
    if !valid_distro(&distro) {
        return Err("Invalid WSL distribution name.".into());
    }
    if user.as_deref().is_some_and(|user| !valid_user(user)) {
        return Err("Invalid WSL user name.".into());
    }
    ensure_usable_distro(&distro).await?;
    probe(&distro, user.as_deref(), guard).await
}

async fn probe(
    distro: &str,
    user: Option<&str>,
    guard: RunningGuard<'_>,
) -> Result<WslProbe, String> {
    let identity = probe_block(
        guard,
        distro,
        wsl_command(
            distro,
            user,
            path_env(SYSTEM_PATH, &["sh", "-c", &identity_script()]),
        ),
        PROBE_DEADLINE,
    )
    .await?;
    let user = field(&identity, "user")
        .filter(|user| valid_user(user))
        .ok_or_else(|| format!("Choux could not read the user name in {distro}."))?
        .to_string();
    let home = field(&identity, "home")
        .filter(|home| home.starts_with('/'))
        .map(String::from);
    let system_node = field(&identity, "node").map(String::from);
    let mut environments = Vec::new();
    if let Some(node) = &system_node {
        environments.push(environment(guard, distro, &user, Some(node)).await?);
    }
    if !environments.iter().any(Environment::runs_ptys) {
        let from_shell = shell_node(guard, distro, &user, field(&identity, "shell"))
            .await
            .filter(|node| Some(node) != system_node.as_ref());
        if from_shell.is_some() || environments.is_empty() {
            environments.push(environment(guard, distro, &user, from_shell.as_deref()).await?);
        }
    }
    let chosen =
        preferred(environments).ok_or_else(|| format!("Choux could not inspect {distro}."))?;
    Ok(chosen.into_probe(distro, user, home))
}

async fn probe_block(
    guard: RunningGuard<'_>,
    distro: &str,
    spec: CommandSpec,
    deadline: Duration,
) -> Result<String, String> {
    if let Some(hub) = guard {
        hub.distro_running(distro).await?;
    }
    let output = run::run(&spec, deadline, Launch::Attached).await?;
    parse::marked_block(&output.stdout)
        .map(String::from)
        .ok_or_else(|| output.message())
}

fn usable_shell(shell: &str) -> bool {
    shell.starts_with('/')
        && !shell
            .bytes()
            .any(|byte| byte.is_ascii_whitespace() || byte.is_ascii_control())
}

async fn shell_node(
    guard: RunningGuard<'_>,
    distro: &str,
    user: &str,
    shell: Option<&str>,
) -> Option<String> {
    let shell = shell
        .filter(|shell| usable_shell(shell))
        .unwrap_or(FALLBACK_SHELL);
    for flags in SHELL_FLAGS {
        let spec = wsl_command(
            distro,
            Some(user),
            vec![shell.to_string(), flags.to_string(), node_script()],
        );
        let Ok(block) = probe_block(guard, distro, spec, SHELL_DEADLINE).await else {
            continue;
        };
        if let Some(node) = field(&block, "node") {
            return Some(node.to_string());
        }
    }
    None
}

async fn environment(
    guard: RunningGuard<'_>,
    distro: &str,
    user: &str,
    node: Option<&str>,
) -> Result<Environment, String> {
    let node = NodeLookup::from_path(distro, node);
    let path = wsl_host_path(distro, user, node.bin.as_deref())?;
    let block = probe_block(
        guard,
        distro,
        wsl_command(
            distro,
            Some(user),
            path_env(&path, &["sh", "-c", &tools_script()]),
        ),
        PROBE_DEADLINE,
    )
    .await?;
    Ok(Environment {
        node,
        path,
        tools: Tools::read(&block),
    })
}

fn preferred(mut environments: Vec<Environment>) -> Option<Environment> {
    let index = environments
        .iter()
        .position(Environment::runs_ptys)
        .or_else(|| environments.iter().rposition(Environment::has_node))
        .or_else(|| environments.len().checked_sub(1))?;
    Some(environments.swap_remove(index))
}

#[derive(Debug, PartialEq, Eq)]
struct Environment {
    node: NodeLookup,
    path: String,
    tools: Tools,
}

impl Environment {
    fn has_node(&self) -> bool {
        self.node.problem.is_none()
    }

    fn runs_ptys(&self) -> bool {
        self.has_node() && self.tools.version.is_some()
    }

    fn into_probe(self, distro: &str, user: String, home: Option<String>) -> WslProbe {
        let node_available = self.has_node();
        let npm_available = node_available && self.tools.npm;
        let message = self
            .node
            .problem
            .or_else(|| self.tools.problem(distro, &self.path, npm_available));
        WslProbe {
            user,
            home,
            node_available,
            node_bin: self.node.bin,
            npm_available,
            ptys_version: self.tools.version,
            message,
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
struct NodeLookup {
    bin: Option<String>,
    problem: Option<String>,
}

impl NodeLookup {
    fn from_path(distro: &str, node: Option<&str>) -> Self {
        let found = |bin: Option<&str>| Self {
            bin: bin.map(String::from),
            problem: None,
        };
        let missing = |problem: String| Self {
            bin: None,
            problem: Some(problem),
        };
        match node.and_then(parse::parent_dir) {
            None => missing(format!(
                "Node.js is not installed in {distro}. Install it inside the distribution, then check again."
            )),
            Some(dir) if on_windows_drive(dir) => missing(format!(
                "Only a Windows Node.js ({dir}) is visible in {distro}. Install Node.js inside the distribution, then check again."
            )),
            Some(dir) if system_node_dir(dir) => found(None),
            Some(dir) => match checked_node_bin(Some(dir)) {
                Ok(_) => found(Some(dir)),
                Err(problem) => missing(format!(
                    "Node.js is in {dir}, which Choux cannot use. {problem}"
                )),
            },
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
struct Tools {
    npm: bool,
    ptys: Option<String>,
    version: Option<String>,
    error: Option<String>,
}

impl Tools {
    fn read(block: &str) -> Self {
        let ptys = field(block, "ptys").map(String::from);
        Self {
            npm: field(block, "npm").is_some(),
            version: field(block, "version")
                .filter(|_| ptys.is_some())
                .map(String::from),
            error: field(block, "error").map(String::from),
            ptys,
        }
    }

    fn problem(&self, distro: &str, path: &str, npm_available: bool) -> Option<String> {
        match (&self.ptys, &self.version) {
            (Some(ptys), None) => Some(format!(
                "ptys at {ptys} did not run: {}",
                self.error.as_deref().unwrap_or("it printed nothing")
            )),
            (None, _) if !npm_available => Some(format!(
                "Neither ptys nor npm is on the PATH Choux uses in {distro} ({path})."
            )),
            _ => None,
        }
    }
}

#[tauri::command]
pub async fn wsl_candidates(
    hub: State<'_, ConnectionHub>,
    host: WslHost,
) -> Result<Vec<String>, String> {
    if !cfg!(windows) {
        return Err(NOT_WINDOWS.into());
    }
    match hub.distro_running(&host.distro).await {
        Err(Refusal::NotRunning(_)) => Ok(Vec::new()),
        Err(refused) => Err(refused.into()),
        Ok(()) => alive_daemons(&host).await,
    }
}

async fn alive_daemons(host: &WslHost) -> Result<Vec<String>, String> {
    let output = host
        .run(
            &["ptys", "server", "status", "--json"],
            QUERY_DEADLINE,
            Launch::Attached,
        )
        .await?;
    if !output.succeeded() {
        return Err(output.message());
    }
    parse::alive_instances(&output.stdout)
}

#[tauri::command]
pub async fn wsl_install(host: WslHost) -> Result<(), String> {
    let output = host
        .run(
            &["npm", "install", "--global", PACKAGE],
            INSTALL_DEADLINE,
            Launch::Attached,
        )
        .await?;
    if !output.succeeded() {
        return Err(output.message());
    }
    let located = host
        .run(
            &["sh", "-c", "command -v ptys"],
            QUERY_DEADLINE,
            Launch::Attached,
        )
        .await?;
    if located.succeeded() {
        Ok(())
    } else {
        Err(format!(
            "npm installed ptys, but it is not on the PATH Choux uses in {}. Set the node bin directory to where npm puts global commands.",
            host.distro
        ))
    }
}

#[tauri::command]
pub async fn wsl_start(
    hub: State<'_, ConnectionHub>,
    host: WslHost,
    instance: String,
) -> Result<(), String> {
    let started = start_daemon(host, instance).await;
    hub.forget_running_distros().await;
    started
}

async fn start_daemon(host: WslHost, instance: String) -> Result<(), String> {
    if !cfg!(windows) {
        return Err(NOT_WINDOWS.into());
    }
    if !valid_instance(&instance) {
        return Err("Invalid ptys instance name.".into());
    }
    ensure_usable_distro(&host.distro).await?;
    let output = host
        .run(
            &["ptys", "server", "start", "--instance", &instance],
            START_DEADLINE,
            Launch::Detached,
        )
        .await?;
    if output.succeeded() || output.stderr.contains(ALREADY_RUNNING) {
        Ok(())
    } else {
        Err(output.message())
    }
}

#[tauri::command]
pub async fn wsl_home(host: WslHost) -> Result<Option<String>, String> {
    let output = host
        .run(
            &["sh", "-c", r#"printf '%s' "$HOME""#],
            QUERY_DEADLINE,
            Launch::Attached,
        )
        .await?;
    if !output.succeeded() {
        return Err(output.message());
    }
    Ok(Some(output.stdout.trim())
        .filter(|home| home.starts_with('/'))
        .map(String::from))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn serializes_the_keys_the_client_reads() {
        let status = serde_json::to_value(WslStatus {
            supported: true,
            version: Some("2.7.14.0".into()),
            problem: None,
            distros: vec![WslDistro {
                name: "Debian".into(),
                default: true,
                running: false,
                version: Some(2),
            }],
        })
        .unwrap();
        let probe = serde_json::to_value(WslProbe {
            user: "me".into(),
            home: None,
            node_available: true,
            node_bin: Some("/opt/node/bin".into()),
            npm_available: true,
            ptys_version: Some("0.3.0".into()),
            message: None,
        })
        .unwrap();

        assert_eq!(
            status,
            json!({ "supported": true, "version": "2.7.14.0", "problem": null, "distros": [{ "name": "Debian", "default": true, "running": false, "version": 2 }] })
        );
        assert_eq!(probe["nodeBin"], "/opt/node/bin");
        assert_eq!(probe["nodeAvailable"], true);
        assert_eq!(probe["npmAvailable"], true);
        assert_eq!(probe["ptysVersion"], "0.3.0");
    }

    #[test]
    fn reads_a_host_from_its_camel_case_form() {
        let host: WslHost = serde_json::from_value(
            json!({ "distro": "Debian", "user": "me", "nodeBin": "/opt/node/bin" }),
        )
        .unwrap();

        assert_eq!(host.node_bin.as_deref(), Some("/opt/node/bin"));
    }

    #[test]
    fn keeps_a_node_directory_only_when_the_system_path_lacks_it() {
        assert_eq!(
            NodeLookup::from_path(
                "Debian",
                Some("/home/me/.nvm/versions/node/v24.21.0/bin/node")
            ),
            NodeLookup {
                bin: Some("/home/me/.nvm/versions/node/v24.21.0/bin".into()),
                problem: None
            }
        );
        assert_eq!(
            NodeLookup::from_path("Debian", Some("/usr/bin/node")),
            NodeLookup {
                bin: None,
                problem: None
            }
        );
    }

    #[test]
    fn explains_a_node_choux_cannot_use() {
        for (node, expected) in [
            (None, "Node.js is not installed in Debian."),
            (
                Some("/mnt/c/Program Files/nodejs/node"),
                "Only a Windows Node.js (/mnt/c/Program Files/nodejs) is visible in Debian.",
            ),
            (
                Some("/opt/my node/bin/node"),
                "Node.js is in /opt/my node/bin, which Choux cannot use.",
            ),
        ] {
            let lookup = NodeLookup::from_path("Debian", node);

            assert_eq!(lookup.bin, None, "{node:?}");
            assert!(
                lookup
                    .problem
                    .as_deref()
                    .is_some_and(|problem| problem.starts_with(expected)),
                "{lookup:?}"
            );
        }
    }

    #[test]
    fn names_what_keeps_ptys_from_running() {
        let broken =
            Tools::read("ptys=/usr/local/bin/ptys\nerror=env: 'node': No such file or directory\n");
        let missing = Tools::read("npm=\nptys=\n");
        let installable = Tools::read("npm=/usr/bin/npm\n");
        let ready = Tools::read("npm=/usr/bin/npm\nptys=/usr/bin/ptys\nversion=0.3.0\n");

        assert_eq!(
            broken.problem("Debian", SYSTEM_PATH, true),
            Some(
                "ptys at /usr/local/bin/ptys did not run: env: 'node': No such file or directory"
                    .into()
            )
        );
        assert_eq!(
            missing.problem("Debian", SYSTEM_PATH, false),
            Some(format!(
                "Neither ptys nor npm is on the PATH Choux uses in Debian ({SYSTEM_PATH})."
            ))
        );
        assert_eq!(installable.problem("Debian", SYSTEM_PATH, true), None);
        assert_eq!(ready.version.as_deref(), Some("0.3.0"));
        assert_eq!(ready.problem("Debian", SYSTEM_PATH, true), None);
    }

    fn sample(node: Option<&str>, tools: &str) -> Environment {
        let node = NodeLookup::from_path("Debian", node);
        Environment {
            path: wsl_host_path("Debian", "me", node.bin.as_deref()).unwrap(),
            node,
            tools: Tools::read(tools),
        }
    }

    const NVM_NODE: &str = "/home/me/.nvm/versions/node/v24.21.0/bin/node";
    const WITH_PTYS: &str = "npm=/x/npm\nptys=/x/ptys\nversion=0.3.0\n";
    const WITHOUT_PTYS: &str = "npm=/x/npm\n";

    #[test]
    fn prefers_the_environment_that_runs_ptys_then_the_users_own_node() {
        let system_without_ptys = || sample(Some("/usr/bin/node"), WITHOUT_PTYS);

        assert_eq!(
            preferred(vec![
                system_without_ptys(),
                sample(Some(NVM_NODE), WITH_PTYS)
            ]),
            Some(sample(Some(NVM_NODE), WITH_PTYS))
        );
        assert_eq!(
            preferred(vec![
                sample(Some("/usr/bin/node"), WITH_PTYS),
                sample(Some(NVM_NODE), WITH_PTYS)
            ]),
            Some(sample(Some("/usr/bin/node"), WITH_PTYS))
        );
        assert_eq!(
            preferred(vec![
                system_without_ptys(),
                sample(Some(NVM_NODE), WITHOUT_PTYS)
            ]),
            Some(sample(Some(NVM_NODE), WITHOUT_PTYS))
        );
        assert_eq!(
            preferred(vec![
                system_without_ptys(),
                sample(Some("/mnt/c/nodejs/node"), WITHOUT_PTYS)
            ]),
            Some(system_without_ptys())
        );
        assert_eq!(preferred(vec![sample(None, "")]), Some(sample(None, "")));
        assert_eq!(preferred(Vec::new()), None);
    }

    #[test]
    fn reports_the_chosen_environment_to_the_client() {
        let probe = sample(Some(NVM_NODE), WITH_PTYS).into_probe("Debian", "me".into(), None);
        let without_node =
            sample(None, "npm=/usr/bin/npm\n").into_probe("Debian", "me".into(), None);

        assert_eq!(
            probe.node_bin.as_deref(),
            Some("/home/me/.nvm/versions/node/v24.21.0/bin")
        );
        assert_eq!(probe.ptys_version.as_deref(), Some("0.3.0"));
        assert_eq!(probe.message, None);
        assert!(!without_node.npm_available);
        assert!(without_node
            .message
            .is_some_and(|message| message.starts_with("Node.js is not installed")));
    }

    #[test]
    fn accepts_only_an_absolute_shell_without_spaces() {
        assert!(usable_shell("/usr/bin/zsh"));
        assert!(!usable_shell("zsh"));
        assert!(!usable_shell("/bin/sh -x"));
        assert!(!usable_shell(""));
    }

    #[cfg(unix)]
    fn run_script(script: &str, path: &str) -> String {
        let output = std::process::Command::new("sh")
            .args(["-c", script])
            .env("PATH", path)
            .output()
            .unwrap();
        String::from_utf8(output.stdout).unwrap()
    }

    #[cfg(unix)]
    #[test]
    fn the_identity_script_reports_every_field_between_markers() {
        let output = run_script(&identity_script(), &std::env::var("PATH").unwrap());
        let block = parse::marked_block(&output).expect("markers");

        assert!(field(block, "user").is_some(), "{output}");
        assert!(output.contains("\nhome="), "{output}");
        assert!(output.contains("\nnode="), "{output}");
    }

    #[cfg(unix)]
    #[test]
    fn the_tools_script_reports_the_ptys_version_or_why_it_failed() {
        use std::{fs, os::unix::fs::PermissionsExt};

        let dir = std::env::temp_dir().join(format!("choux-wsl-tools-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let ptys = dir.join("ptys");
        let path = format!("{}:/usr/bin:/bin", dir.display());
        fs::write(&ptys, "#!/bin/sh\necho 9.9.9\n").unwrap();
        fs::set_permissions(&ptys, fs::Permissions::from_mode(0o755)).unwrap();
        let working = run_script(&tools_script(), &path);
        fs::write(
            &ptys,
            "#!/bin/sh\necho 'env: node: missing' >&2\nexit 127\n",
        )
        .unwrap();
        let failing = run_script(&tools_script(), &path);
        fs::remove_dir_all(&dir).unwrap();

        let working = Tools::read(parse::marked_block(&working).expect("markers"));
        let failing = Tools::read(parse::marked_block(&failing).expect("markers"));
        assert_eq!(working.version.as_deref(), Some("9.9.9"));
        assert_eq!(failing.version, None);
        assert_eq!(failing.error.as_deref(), Some("env: node: missing"));
    }
}
