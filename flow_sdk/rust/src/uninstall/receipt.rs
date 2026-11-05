//! The parts of uv's `uv-receipt.toml` the uninstaller reads: the requirements (a `--with` extra
//! means someone customised the engine) and the entry points (the shims `uv` created). Mirrors
//! `electron/engine-ownership.js` `parseReceipt`; no TOML dependency for this small subset.

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Requirement {
    pub name: String,
    pub specifier: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entrypoint {
    pub name: String,
    pub install_path: String,
    pub from: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Receipt {
    pub requirements: Vec<Requirement>,
    pub entrypoints: Vec<Entrypoint>,
}

impl Receipt {
    /// Exactly one requirement, `flowpad` — nothing added with `--with`.
    pub fn is_plain_flowpad(&self) -> bool {
        self.requirements.len() == 1 && self.requirements[0].name == "flowpad"
    }
}

/// The raw text of `key = <value>` inside `[section]`, following a bracketed value across lines.
fn value<'a>(text: &'a str, section: &str, key: &str) -> Option<String> {
    let lines: Vec<&'a str> = text.lines().collect();
    let mut current = "";
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i].trim();
        if line.starts_with('[') && line.ends_with(']') && !line.contains('=') {
            current = line.trim_start_matches('[').trim_end_matches(']').trim();
            i += 1;
            continue;
        }
        if current == section {
            if let Some((k, v)) = line.split_once('=') {
                if k.trim() == key {
                    let mut out = v.trim().to_string();
                    let depth = |s: &str| s.matches(['[', '{']).count() as i64 - s.matches([']', '}']).count() as i64;
                    let mut d = depth(&out);
                    while d > 0 && i + 1 < lines.len() {
                        i += 1;
                        out.push('\n');
                        out.push_str(lines[i]);
                        d += depth(lines[i]);
                    }
                    return Some(out);
                }
            }
        }
        i += 1;
    }
    None
}

/// The `{ … }` tables inside an array value.
fn tables(array: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut rest = array;
    while let Some(start) = rest.find('{') {
        match rest[start..].find('}') {
            Some(end) => {
                out.push(&rest[start + 1..start + end]);
                rest = &rest[start + end + 1..];
            }
            None => break,
        }
    }
    out
}

/// `key = "value"` inside one inline table; TOML basic-string escapes `\\` and `\"` undone.
fn string_field(table: &str, key: &str) -> Option<String> {
    let mut search = table;
    loop {
        let at = search.find(key)?;
        let before_ok = at == 0 || !search.as_bytes()[at - 1].is_ascii_alphanumeric() && search.as_bytes()[at - 1] != b'-';
        let after = search[at + key.len()..].trim_start();
        if before_ok && after.starts_with('=') {
            let after = after[1..].trim_start();
            let body = after.strip_prefix('"')?;
            let mut out = String::new();
            let mut chars = body.chars();
            while let Some(c) = chars.next() {
                match c {
                    '"' => return Some(out),
                    '\\' => match chars.next()? {
                        'n' => out.push('\n'),
                        't' => out.push('\t'),
                        other => out.push(other),
                    },
                    c => out.push(c),
                }
            }
            return None;
        }
        search = &search[at + key.len()..];
    }
}

pub fn parse(text: &str) -> Receipt {
    let requirements = value(text, "tool", "requirements")
        .map(|v| {
            tables(&v)
                .into_iter()
                .filter_map(|t| {
                    Some(Requirement {
                        name: string_field(t, "name")?,
                        specifier: string_field(t, "specifier").unwrap_or_default(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let entrypoints = value(text, "tool", "entrypoints")
        .map(|v| {
            tables(&v)
                .into_iter()
                .filter_map(|t| {
                    Some(Entrypoint {
                        name: string_field(t, "name")?,
                        install_path: string_field(t, "install-path")?,
                        from: string_field(t, "from").unwrap_or_default(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Receipt { requirements, entrypoints }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DESKTOP: &str = r#"[tool]
requirements = [{ name = "flowpad", specifier = "==0.2.240" }]
python = "3.11"
entrypoints = [
    { name = "flow", install-path = "C:\\Users\\u\\.local\\bin\\flow.exe", from = "flowpad" },
    { name = "flow-sdk-mcp", install-path = "C:\\Users\\u\\.local\\bin\\flow-sdk-mcp.exe", from = "flowpad" },
]

[tool.options]
exclude-newer-package = { flowpad = "2026-10-26T17:57:25Z" }
compile-bytecode = true
"#;

    #[test]
    fn parses_requirements_and_entrypoints() {
        let r = parse(DESKTOP);
        assert_eq!(r.requirements, vec![Requirement { name: "flowpad".into(), specifier: "==0.2.240".into() }]);
        assert!(r.is_plain_flowpad());
        assert_eq!(r.entrypoints.len(), 2);
        assert_eq!(r.entrypoints[0].name, "flow");
        assert_eq!(r.entrypoints[0].install_path, r"C:\Users\u\.local\bin\flow.exe");
        assert_eq!(r.entrypoints[1].from, "flowpad");
    }

    #[test]
    fn a_with_extra_is_not_plain() {
        let r = parse(&DESKTOP.replace(
            r#"requirements = [{ name = "flowpad", specifier = "==0.2.240" }]"#,
            r#"requirements = [{ name = "flowpad", specifier = "==0.2.240" }, { name = "rich" }]"#,
        ));
        assert_eq!(r.requirements.len(), 2);
        assert!(!r.is_plain_flowpad());
    }

    #[test]
    fn options_tables_are_not_requirements() {
        // `exclude-newer-package` sits in [tool.options] and must not leak into [tool] keys.
        let r = parse(DESKTOP);
        assert!(r.requirements.iter().all(|q| q.name == "flowpad"));
    }

    #[test]
    fn an_empty_or_garbled_receipt_parses_to_nothing() {
        assert_eq!(parse(""), Receipt::default());
        assert!(!parse("not toml at all { [").is_plain_flowpad());
    }

    #[test]
    fn multi_line_requirements() {
        let r = parse(&DESKTOP.replace(
            r#"requirements = [{ name = "flowpad", specifier = "==0.2.240" }]"#,
            "requirements = [\n    { name = \"flowpad\", specifier = \"==0.2.240\" },\n]",
        ));
        assert!(r.is_plain_flowpad());
    }
}
