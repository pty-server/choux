use std::ffi::OsString;

use serde::Deserialize;

use super::bridge::{CommandSpec, Diagnostics};

const SYSTEM_PATH: &str = "/usr/local/bin:/usr/bin:/bin";
const SSH_CONNECT_TIMEOUT_SECONDS: u32 = 10;
const SSH_SERVER_ALIVE_INTERVAL_SECONDS: u32 = 15;
const INSTANCE_MAX: usize = 64;
const DISTRO_MAX: usize = 64;
const USER_MAX: usize = 32;
const HOST_MAX: usize = 255;
const NODE_BIN_MAX: usize = 512;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Hash)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Target {
    Local {
        instance: String,
    },
    Ssh {
        host: String,
        instance: String,
        node_bin: Option<String>,
    },
    Wsl {
        distro: String,
        user: String,
        instance: String,
        node_bin: Option<String>,
    },
}

#[derive(Debug, PartialEq, Eq)]
pub enum Route {
    Local(String),
    Bridge(CommandSpec),
}

impl Target {
    pub fn instance(&self) -> &str {
        match self {
            Self::Local { instance } | Self::Ssh { instance, .. } | Self::Wsl { instance, .. } => {
                instance
            }
        }
    }

    pub fn route(&self) -> Result<Route, String> {
        if !valid_instance(self.instance()) {
            return Err("Invalid ptys instance name.".into());
        }
        match self {
            Self::Local { instance } => Ok(Route::Local(instance.clone())),
            Self::Ssh {
                host,
                instance,
                node_bin,
            } => {
                if !valid_ssh_host(host) {
                    return Err("Invalid SSH host.".into());
                }
                let node_bin = checked_node_bin(node_bin.as_deref())?;
                Ok(Route::Bridge(ssh_bridge(
                    host,
                    instance,
                    node_bin.map(search_path),
                )))
            }
            Self::Wsl {
                distro,
                user,
                instance,
                node_bin,
            } => {
                if !valid_name(distro, DISTRO_MAX, u8::is_ascii_alphanumeric) {
                    return Err("Invalid WSL distribution name.".into());
                }
                if !valid_user(user) {
                    return Err("Invalid WSL user name.".into());
                }
                let node_bin = checked_node_bin(node_bin.as_deref())?;
                if node_bin.is_some_and(|dir| dir == "/mnt" || dir.starts_with("/mnt/")) {
                    return Err(
                        "The node directory is on a Windows drive; use a Node.js installed inside the distribution."
                            .into(),
                    );
                }
                Ok(Route::Bridge(wsl_bridge(
                    distro,
                    user,
                    instance,
                    node_bin.map_or_else(|| SYSTEM_PATH.to_string(), search_path),
                )))
            }
        }
    }
}

pub fn valid_instance(instance: &str) -> bool {
    valid_name(instance, INSTANCE_MAX, u8::is_ascii_alphanumeric)
}

fn valid_name(name: &str, max: usize, valid_first: fn(&u8) -> bool) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= max
        && valid_first(&bytes[0])
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn valid_user(user: &str) -> bool {
    valid_name(user, USER_MAX, |byte| {
        byte.is_ascii_alphanumeric() || *byte == b'_'
    })
}

fn valid_ssh_host(host: &str) -> bool {
    if host.len() > HOST_MAX {
        return false;
    }
    let (user, address) = match host.split_once('@') {
        Some((user, address)) => (Some(user), address),
        None => (None, host),
    };
    user.map_or(true, valid_user)
        && address
            .as_bytes()
            .first()
            .is_some_and(|byte| byte.is_ascii_alphanumeric() || *byte == b':')
        && address
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b':'))
}

fn checked_node_bin(node_bin: Option<&str>) -> Result<Option<&str>, String> {
    let Some(dir) = node_bin else {
        return Ok(None);
    };
    let valid = dir.starts_with('/')
        && dir.len() <= NODE_BIN_MAX
        && dir.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b'/' | b'+' | b'@')
        })
        && has_plain_segments(dir);
    if valid {
        Ok(Some(dir))
    } else {
        Err(
            "Invalid node directory: use a plain absolute path of letters, digits and . _ - / + @, without . or .. segments or //."
                .into(),
        )
    }
}

fn has_plain_segments(dir: &str) -> bool {
    let segments: Vec<&str> = dir.split('/').skip(1).collect();
    let last = segments.len().saturating_sub(1);
    segments.iter().enumerate().all(|(index, segment)| {
        !matches!(*segment, "." | "..") && (!segment.is_empty() || index == last)
    })
}

fn search_path(node_bin: &str) -> String {
    format!("{node_bin}:{SYSTEM_PATH}")
}

fn bridge_args(instance: &str, path: Option<String>) -> Vec<String> {
    let mut args = Vec::new();
    if let Some(path) = path {
        args.extend(["env".to_string(), format!("PATH={path}")]);
    }
    args.extend(["ptys", "bridge", "--instance", instance].map(String::from));
    args
}

fn shell_quote(arg: &str) -> String {
    format!("'{}'", arg.replace('\'', r"'\''"))
}

fn ssh_bridge(host: &str, instance: &str, path: Option<String>) -> CommandSpec {
    let remote_command = bridge_args(instance, path)
        .iter()
        .map(|arg| shell_quote(arg))
        .collect::<Vec<_>>()
        .join(" ");
    let args = [
        "-T".to_string(),
        "-e".into(),
        "none".into(),
        "-o".into(),
        "BatchMode=yes".into(),
        "-o".into(),
        format!("ConnectTimeout={SSH_CONNECT_TIMEOUT_SECONDS}"),
        "-o".into(),
        format!("ServerAliveInterval={SSH_SERVER_ALIVE_INTERVAL_SECONDS}"),
        "--".into(),
        host.into(),
        remote_command,
    ];
    CommandSpec {
        program: "ssh".into(),
        args: args.into_iter().map(OsString::from).collect(),
        env: Vec::new(),
        diagnostics: Diagnostics::Plain,
    }
}

fn wsl_bridge(distro: &str, user: &str, instance: &str, path: String) -> CommandSpec {
    let mut args: Vec<OsString> = ["-d", distro, "-u", user, "--exec"]
        .map(OsString::from)
        .into();
    args.extend(
        bridge_args(instance, Some(path))
            .into_iter()
            .map(OsString::from),
    );
    CommandSpec {
        program: "wsl.exe".into(),
        args,
        env: vec![("WSL_UTF8".into(), "1".into())],
        diagnostics: Diagnostics::Wsl,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn target(value: serde_json::Value) -> Target {
        serde_json::from_value(value).unwrap()
    }

    fn bridge(target: &Target) -> CommandSpec {
        match target.route() {
            Ok(Route::Bridge(spec)) => spec,
            other => panic!("{other:?}"),
        }
    }

    fn args(spec: &CommandSpec) -> Vec<&str> {
        spec.args.iter().map(|arg| arg.to_str().unwrap()).collect()
    }

    #[test]
    fn reads_every_kind_from_its_camel_case_form() {
        assert_eq!(
            target(json!({ "kind": "local", "instance": "default" })),
            Target::Local {
                instance: "default".into()
            }
        );
        assert_eq!(
            target(
                json!({ "kind": "ssh", "host": "me@box", "instance": "work", "nodeBin": "/opt/node/bin" })
            ),
            Target::Ssh {
                host: "me@box".into(),
                instance: "work".into(),
                node_bin: Some("/opt/node/bin".into()),
            }
        );
        assert_eq!(
            target(
                json!({ "kind": "wsl", "distro": "Debian", "user": "me", "instance": "default" })
            ),
            Target::Wsl {
                distro: "Debian".into(),
                user: "me".into(),
                instance: "default".into(),
                node_bin: None,
            }
        );
        assert!(
            serde_json::from_value::<Target>(json!({ "kind": "tcp", "instance": "default" }))
                .is_err()
        );
    }

    #[test]
    fn routes_a_local_instance_to_its_control_socket() {
        let local = target(json!({ "kind": "local", "instance": "work.dev" }));

        assert_eq!(local.route(), Ok(Route::Local("work.dev".into())));
    }

    #[test]
    fn builds_a_non_interactive_ssh_bridge() {
        let spec = bridge(&target(
            json!({ "kind": "ssh", "host": "me@box.lan", "instance": "work" }),
        ));

        assert_eq!(spec.program, "ssh");
        assert_eq!(
            args(&spec),
            [
                "-T",
                "-e",
                "none",
                "-o",
                "BatchMode=yes",
                "-o",
                "ConnectTimeout=10",
                "-o",
                "ServerAliveInterval=15",
                "--",
                "me@box.lan",
                "'ptys' 'bridge' '--instance' 'work'",
            ]
        );
        assert!(spec.env.is_empty());
        assert_eq!(spec.diagnostics, Diagnostics::Plain);
    }

    #[test]
    fn puts_the_node_directory_first_on_the_remote_path() {
        let spec = bridge(&target(json!({
            "kind": "ssh",
            "host": "box",
            "instance": "default",
            "nodeBin": "/home/me/.nvm/versions/node/v24.21.0/bin",
        })));

        assert_eq!(
            args(&spec).last(),
            Some(&"'env' 'PATH=/home/me/.nvm/versions/node/v24.21.0/bin:/usr/local/bin:/usr/bin:/bin' 'ptys' 'bridge' '--instance' 'default'")
        );
    }

    #[test]
    fn builds_a_wsl_bridge_that_never_goes_through_a_shell() {
        let spec = bridge(&target(json!({
            "kind": "wsl",
            "distro": "Debian",
            "user": "me",
            "instance": "default",
            "nodeBin": "/home/me/.nvm/versions/node/v24.21.0/bin",
        })));

        assert_eq!(spec.program, "wsl.exe");
        assert_eq!(
            args(&spec),
            [
                "-d",
                "Debian",
                "-u",
                "me",
                "--exec",
                "env",
                "PATH=/home/me/.nvm/versions/node/v24.21.0/bin:/usr/local/bin:/usr/bin:/bin",
                "ptys",
                "bridge",
                "--instance",
                "default",
            ]
        );
        assert_eq!(spec.env, [("WSL_UTF8".into(), "1".into())]);
        assert_eq!(spec.diagnostics, Diagnostics::Wsl);
    }

    #[test]
    fn gives_a_wsl_bridge_the_system_path_without_a_node_directory() {
        let spec = bridge(&target(
            json!({ "kind": "wsl", "distro": "Ubuntu-24.04", "user": "me", "instance": "default" }),
        ));

        assert_eq!(args(&spec)[6], "PATH=/usr/local/bin:/usr/bin:/bin");
    }

    #[test]
    fn rejects_fields_outside_their_charset() {
        let rejected = [
            json!({ "kind": "local", "instance": "" }),
            json!({ "kind": "local", "instance": "-work" }),
            json!({ "kind": "local", "instance": "a/b" }),
            json!({ "kind": "local", "instance": "x".repeat(65) }),
            json!({ "kind": "ssh", "host": "-oProxyCommand=evil", "instance": "default" }),
            json!({ "kind": "ssh", "host": "box; rm -rf ~", "instance": "default" }),
            json!({ "kind": "ssh", "host": "me@-box", "instance": "default" }),
            json!({ "kind": "ssh", "host": "-me@box", "instance": "default" }),
            json!({ "kind": "ssh", "host": "a@b@c", "instance": "default" }),
            json!({ "kind": "ssh", "host": "", "instance": "default" }),
            json!({ "kind": "ssh", "host": "box", "instance": "default", "nodeBin": "relative/bin" }),
            json!({ "kind": "ssh", "host": "box", "instance": "default", "nodeBin": "/opt/node bin" }),
            json!({ "kind": "ssh", "host": "box", "instance": "default", "nodeBin": "/opt/'bin" }),
            json!({ "kind": "ssh", "host": "box", "instance": "default", "nodeBin": "/opt:/evil" }),
            json!({ "kind": "ssh", "host": "box", "instance": "default", "nodeBin": "/opt/../etc" }),
            json!({ "kind": "wsl", "distro": "-d", "user": "me", "instance": "default" }),
            json!({ "kind": "wsl", "distro": "Debian", "user": "-u", "instance": "default" }),
            json!({ "kind": "wsl", "distro": "Debian", "user": "me", "instance": "default", "nodeBin": "/mnt/c/Program Files/nodejs" }),
            json!({ "kind": "wsl", "distro": "Debian", "user": "me", "instance": "default", "nodeBin": "/mnt/c/nodejs" }),
            json!({ "kind": "wsl", "distro": "Debian", "user": "me", "instance": "default", "nodeBin": "/./mnt/c/nodejs" }),
            json!({ "kind": "wsl", "distro": "Debian", "user": "me", "instance": "default", "nodeBin": "//mnt/c/nodejs" }),
            json!({ "kind": "ssh", "host": "box", "instance": "default", "nodeBin": "/opt/./node" }),
            json!({ "kind": "ssh", "host": "box", "instance": "default", "nodeBin": "/opt//node" }),
        ];

        for value in rejected {
            assert!(target(value.clone()).route().is_err(), "{value}");
        }
    }

    #[test]
    fn accepts_ordinary_hosts_users_and_addresses() {
        for host in [
            "box",
            "me@box.lan",
            "_svc@10.0.0.2",
            "fe80::1",
            "::1",
            "me@::1",
            "build-01.example.com",
        ] {
            let ssh = target(json!({ "kind": "ssh", "host": host, "instance": "default" }));
            assert!(ssh.route().is_ok(), "{host}");
        }
        for node_bin in [
            "/opt/node/bin/",
            "/",
            "/home/me/.nvm/versions/node/v24.21.0/bin",
        ] {
            let ssh = target(
                json!({ "kind": "ssh", "host": "box", "instance": "default", "nodeBin": node_bin }),
            );
            assert!(ssh.route().is_ok(), "{node_bin}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_posix_shell_reads_every_quoted_argument_back_unchanged() {
        let awkward = [
            "plain",
            "two words",
            "it's",
            "$HOME",
            "back\\slash",
            "",
            "semi;colon",
            "'",
        ];
        let script = std::iter::once("printf '[%s]'".to_string())
            .chain(awkward.iter().map(|arg| shell_quote(arg)))
            .collect::<Vec<_>>()
            .join(" ");
        let output = std::process::Command::new("sh")
            .args(["-c", &script])
            .output()
            .unwrap();

        let expected: String = awkward.iter().map(|arg| format!("[{arg}]")).collect();
        assert_eq!(String::from_utf8(output.stdout).unwrap(), expected);
    }
}
