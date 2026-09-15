use crate::transport::target::{valid_distro, valid_instance};

pub const MARKER: &str = "__choux_probe__";
const MINIMUM_VERSION: [u32; 3] = [2, 0, 0];
const NO_DISTRIBUTIONS: &str = "WSL_E_DEFAULT_DISTRO_NOT_FOUND";

#[derive(Debug, PartialEq, Eq)]
pub struct WslVersion {
    pub text: String,
    parts: Vec<u32>,
}

impl WslVersion {
    pub fn is_supported(&self) -> bool {
        self.parts.as_slice() >= MINIMUM_VERSION.as_slice()
    }
}

pub fn wsl_version(output: &str) -> Option<WslVersion> {
    output.split_whitespace().find_map(|token| {
        let parts: Vec<u32> = token
            .split('.')
            .map(|part| part.parse().ok())
            .collect::<Option<_>>()?;
        (3..=4).contains(&parts.len()).then(|| WslVersion {
            text: token.to_string(),
            parts,
        })
    })
}

#[derive(Debug, PartialEq, Eq)]
pub struct ListedDistro {
    pub name: String,
    pub default: bool,
    pub version: Option<u8>,
}

pub fn listed_distros(output: &str) -> Vec<ListedDistro> {
    output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .skip(1)
        .filter_map(|line| {
            let mut tokens: Vec<&str> = line.split_whitespace().collect();
            let default = tokens.first() == Some(&"*");
            if default {
                tokens.remove(0);
            }
            let name = tokens.first().filter(|name| valid_distro(name))?;
            let version = (tokens.len() >= 3)
                .then(|| tokens.last()?.parse().ok())
                .flatten();
            Some(ListedDistro {
                name: name.to_string(),
                default,
                version,
            })
        })
        .collect()
}

pub fn reports_no_distributions(output: &str) -> bool {
    output.contains(NO_DISTRIBUTIONS)
}

pub fn running_distros(output: &str) -> Vec<String> {
    output
        .lines()
        .map(str::trim)
        .filter(|name| valid_distro(name))
        .map(String::from)
        .collect()
}

pub fn marked_block(output: &str) -> Option<&str> {
    let mut parts = output.split(MARKER);
    parts.next()?;
    let block = parts.next()?;
    parts.next().map(|_| block)
}

pub fn field<'a>(block: &'a str, key: &str) -> Option<&'a str> {
    block.lines().find_map(|line| {
        line.trim_end_matches('\r')
            .strip_prefix(key)?
            .strip_prefix('=')
            .map(str::trim)
            .filter(|value| !value.is_empty())
    })
}

pub fn alive_instances(output: &str) -> Result<Vec<String>, String> {
    let statuses = output
        .lines()
        .rev()
        .find_map(|line| serde_json::from_str::<Vec<serde_json::Value>>(line.trim()).ok())
        .ok_or("ptys server status did not report its daemons as JSON.")?;
    Ok(statuses
        .iter()
        .filter(|status| status.get("alive").and_then(serde_json::Value::as_bool) == Some(true))
        .filter_map(|status| status.get("instance")?.as_str())
        .filter(|instance| valid_instance(instance))
        .map(String::from)
        .collect())
}

pub fn parent_dir(path: &str) -> Option<&str> {
    match path.rsplit_once('/')? {
        ("", _) => Some("/"),
        (dir, _) => Some(dir),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const VERSION_OUTPUT: &str = "WSL version: 2.7.14.0\r\nKernel version: 6.18.33.2-2\r\nWSLg version: 1.0.73.2\r\nWindows version: 10.0.26200.9457\r\n";

    #[test]
    fn reads_the_wsl_version_whatever_the_label_says() {
        let english = wsl_version(VERSION_OUTPUT).unwrap();
        let german =
            wsl_version("WSL-Version: 2.7.14.0\r\nKernelversion: 6.18.33.2-2\r\n").unwrap();

        assert_eq!(english.text, "2.7.14.0");
        assert_eq!(german, english);
        assert!(english.is_supported());
    }

    #[test]
    fn compares_versions_numerically_against_the_floor() {
        for (text, supported) in [
            ("2.0.0", true),
            ("2.0.0.0", true),
            ("10.0.1", true),
            ("1.9.99.0", false),
            ("0.64.0", false),
        ] {
            assert_eq!(
                wsl_version(text).unwrap().is_supported(),
                supported,
                "{text}"
            );
        }
    }

    #[test]
    fn finds_no_version_in_the_help_text_of_an_inbox_wsl() {
        let help = "Copyright (c) Microsoft Corporation. All rights reserved.\r\n\r\nUsage: wsl.exe [Argument] [Options...] [CommandLine]\r\n";

        assert_eq!(wsl_version(help), None);
    }

    #[test]
    fn lists_distributions_by_name_default_marker_and_version_only() {
        let output = "  NAME            STATE           VERSION\r\n* Debian          Stopped         2\r\n  Ubuntu-24.04    Wird ausgeführt 2\r\n  Legacy          Running         1\r\n\r\n";

        assert_eq!(
            listed_distros(output),
            [
                ListedDistro {
                    name: "Debian".into(),
                    default: true,
                    version: Some(2)
                },
                ListedDistro {
                    name: "Ubuntu-24.04".into(),
                    default: false,
                    version: Some(2)
                },
                ListedDistro {
                    name: "Legacy".into(),
                    default: false,
                    version: Some(1)
                },
            ]
        );
    }

    #[test]
    fn skips_names_a_target_could_not_use_and_rows_without_a_version() {
        let output = "NAME STATE VERSION\n  -weird Stopped 2\n  Short\n";

        assert_eq!(
            listed_distros(output),
            [ListedDistro {
                name: "Short".into(),
                default: false,
                version: None
            }]
        );
    }

    #[test]
    fn reads_running_distribution_names_and_nothing_else() {
        assert_eq!(
            running_distros("Debian\r\nUbuntu-24.04\r\n\r\n"),
            ["Debian", "Ubuntu-24.04"]
        );
        assert!(running_distros("").is_empty());
        assert!(running_distros("There are no running distributions.\r\n").is_empty());
    }

    #[test]
    fn reads_fields_between_markers_and_ignores_shell_noise() {
        let output = format!(
            "Welcome to your shell\n{MARKER}\nuser=me\nhome=/home/me\r\nnode=\n{MARKER}\ntrailing noise\n"
        );
        let block = marked_block(&output).unwrap();

        assert_eq!(field(block, "user"), Some("me"));
        assert_eq!(field(block, "home"), Some("/home/me"));
        assert_eq!(field(block, "node"), None);
        assert_eq!(field(block, "shell"), None);
        assert_eq!(marked_block(&format!("{MARKER}\nuser=me\n")), None);
        assert_eq!(marked_block("user=me\n"), None);
    }

    #[test]
    fn keeps_only_alive_daemons_with_usable_instance_names() {
        let output = r#"[{"instance":"default","alive":true},{"instance":"old","alive":false},{"instance":"-bad","alive":true},{"alive":true}]"#;

        assert_eq!(alive_instances(output), Ok(vec!["default".to_string()]));
        assert_eq!(alive_instances("[]\n"), Ok(Vec::new()));
        assert!(alive_instances("ptys: unknown option\n").is_err());
    }

    #[test]
    fn takes_the_directory_of_an_executable() {
        assert_eq!(
            parent_dir("/home/me/.nvm/versions/node/v24.21.0/bin/node"),
            Some("/home/me/.nvm/versions/node/v24.21.0/bin")
        );
        assert_eq!(parent_dir("/node"), Some("/"));
        assert_eq!(parent_dir("node"), None);
    }
}
