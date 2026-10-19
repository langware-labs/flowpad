//! The decision order of the walk and the envelope of the stream, on a tree
//! built in a temp dir. Parity with Python on real trees is the bench rig's job
//! (`bench/rust_scan/`); these pin the rules a reader of §1 / §13 can check by eye.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

use serde_json::{json, Value};

use crate::request;

static NEXT: AtomicU32 = AtomicU32::new(0);

/// A fresh directory under the system temp dir, removed on drop.
struct Tree(PathBuf);

impl Tree {
    fn new() -> Tree {
        let dir = std::env::temp_dir()
            .join(format!("flowpad-diskio-test-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::SeqCst)));
        fs::create_dir_all(&dir).unwrap();
        Tree(fs::canonicalize(&dir).unwrap())
    }
    fn file(&self, rel: &str, text: &str) -> &Tree {
        let path = self.0.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
        self
    }
    fn dir(&self, rel: &str) -> &Tree {
        fs::create_dir_all(self.0.join(rel)).unwrap();
        self
    }
    fn path(&self, rel: &str) -> String {
        if rel.is_empty() { self.0.to_string_lossy().into_owned() } else { self.0.join(rel).to_string_lossy().into_owned() }
    }
}

impl Drop for Tree {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn policy(gitignore: bool, file_exts: Value) -> Value {
    json!({
        "gitignore": gitignore,
        "file_exts": file_exts,
        "deny_basenames": ["build", "node_modules", ".git"],
        "skip_segments": [[".claude", "worktrees"]],
        "force_include": [".claude"],
    })
}

fn skill_spec() -> Value {
    json!({
        "spec_kind": "diskio.type_scan_spec",
        "type_name": "skill",
        "shape": {"kind": "folder", "main": "SKILL.md"},
        "walks": [
            {"roots": ["real_project_cwd"], "mounts": [".claude/skills"]},
            {"roots": ["folder"], "mounts": [".claude/skills"], "anywhere": true},
        ],
    })
}

/// Run one request; the parsed lines of the stream.
fn scan(root: &Path, policy: Value, specs: Value) -> Vec<Value> {
    let raw = json!({
        "roots": [{"path": root.to_string_lossy(), "kind": "real_project_cwd"}],
        "policy": policy, "specs": specs, "threads": 1,
    })
    .to_string();
    let mut out = Vec::new();
    crate::run(&request::parse(&raw).unwrap(), &mut out).unwrap();
    String::from_utf8(out).unwrap().lines().map(|line| serde_json::from_str(line).unwrap()).collect()
}

fn entries(lines: &[Value]) -> Vec<&Value> {
    lines.iter().filter(|l| l["spec_kind"] == "diskio.walk_entry").collect()
}

fn entry<'a>(lines: &'a [Value], dir: &str) -> &'a Value {
    entries(lines).into_iter().find(|l| l["dir"] == dir).unwrap_or_else(|| panic!("no walk_entry for {dir}"))
}

fn dirs(lines: &[Value]) -> Vec<String> {
    entries(lines).iter().map(|l| l["dir"].as_str().unwrap().to_string()).collect()
}

#[test]
fn the_walk_is_pre_order_and_sorted_and_lists_names() {
    let t = Tree::new();
    t.file("b/x.md", "").file("a/z/deep.md", "").file("a/y.txt", "").file("top.md", "");
    let lines = scan(&t.0, policy(false, Value::Null), json!([]));
    assert_eq!(dirs(&lines), [t.path(""), t.path("a"), t.path("a/z"), t.path("b")]);
    let root = entry(&lines, &t.path(""));
    assert_eq!(root["subdirs"], json!(["a", "b"]));
    assert_eq!(root["files"], json!(["top.md"]));
    assert_eq!(root["error"], Value::Null);
    assert_eq!(entry(&lines, &t.path("a"))["files"], json!(["y.txt"]));
}

#[test]
fn step_2_the_denylist_drops_files_and_dirs_by_basename() {
    let t = Tree::new();
    t.file("build", "a FILE named like a denylisted dir").file("src/build/out.md", "").file("src/keep.md", "");
    let lines = scan(&t.0, policy(false, Value::Null), json!([]));
    assert_eq!(dirs(&lines), [t.path(""), t.path("src")]);
    assert_eq!(entry(&lines, &t.path(""))["files"], json!([]));
    assert_eq!(entry(&lines, &t.path("src"))["subdirs"], json!([]));
}

#[test]
fn step_2_comes_before_the_force_include() {
    // `.claude` is force-included, `.claude/worktrees` is a skip segment: the skip wins.
    let t = Tree::new();
    t.file(".gitignore", ".claude/\n").file(".claude/worktrees/wt/a.md", "").file(".claude/skills/s/SKILL.md", "");
    let lines = scan(&t.0, policy(true, Value::Null), json!([]));
    assert_eq!(entry(&lines, &t.path(".claude"))["subdirs"], json!(["skills"]));
    assert!(!dirs(&lines).iter().any(|d| d.contains("worktrees")));
}

#[test]
fn step_3_force_include_beats_the_gitignore_for_the_whole_subtree() {
    let t = Tree::new();
    t.file(".gitignore", ".claude/\n*.md\n").file(".claude/skills/s/SKILL.md", "").file("other/x.md", "");
    let lines = scan(&t.0, policy(true, Value::Null), json!([]));
    assert_eq!(entry(&lines, &t.path(".claude/skills/s"))["files"], json!(["SKILL.md"]));
    assert_eq!(entry(&lines, &t.path("other"))["files"], json!([]));
}

#[test]
fn step_3_the_force_include_applies_only_when_gitignore_is_on() {
    let t = Tree::new();
    t.file(".gitignore", "*.md\n").file("x.md", "");
    let lines = scan(&t.0, policy(false, Value::Null), json!([]));
    assert_eq!(entry(&lines, &t.path(""))["files"], json!([".gitignore", "x.md"]));
}

#[test]
fn step_3_a_nested_gitignore_only_adds_ignores() {
    let t = Tree::new();
    t.file(".gitignore", "*.log\nsecret/\n")
        .file("sub/.gitignore", "!keep.log\n!secret/\nlocal.txt\n")
        .file("sub/keep.log", "")
        .file("sub/local.txt", "")
        .file("sub/ok.txt", "")
        .file("sub/secret/s.txt", "");
    let lines = scan(&t.0, policy(true, Value::Null), json!([]));
    let sub = entry(&lines, &t.path("sub"));
    assert_eq!(sub["files"], json!([".gitignore", "ok.txt"]));
    assert_eq!(sub["subdirs"], json!([]));
}

#[test]
fn step_3_negation_inside_one_file_works() {
    let t = Tree::new();
    t.file(".gitignore", "*.log\n!keep.log\n").file("a.log", "").file("keep.log", "");
    let lines = scan(&t.0, policy(true, Value::Null), json!([]));
    assert_eq!(entry(&lines, &t.path(""))["files"], json!([".gitignore", "keep.log"]));
}

#[test]
fn step_0_an_unparseable_gitignore_line_is_dropped() {
    let t = Tree::new();
    t.file(".gitignore", "a\\\n!\n*.tmp\n").file("x.tmp", "").file("a", "");
    let lines = scan(&t.0, policy(true, Value::Null), json!([]));
    assert_eq!(entry(&lines, &t.path(""))["files"], json!([".gitignore", "a"]));
}

#[test]
fn the_root_is_yielded_even_when_a_pattern_names_it() {
    let t = Tree::new();
    t.file("proj/.gitignore", "proj\n*\n").file("proj/x.md", "");
    let lines = scan(&t.0.join("proj"), policy(true, Value::Null), json!([]));
    assert_eq!(dirs(&lines), [t.path("proj")]);
    assert_eq!(lines[0]["files"], json!([]));
}

#[test]
fn step_4_file_exts_none_all_empty_none_listed_else_by_suffix() {
    let t = Tree::new();
    t.file("a.md", "").file("B.MD", "").file("c.txt", "").file(".md", "").file("d.md.bak", "");
    let all = scan(&t.0, policy(false, Value::Null), json!([]));
    assert_eq!(all[0]["files"], json!([".md", "B.MD", "a.md", "c.txt", "d.md.bak"]));
    let none = scan(&t.0, policy(false, json!([])), json!([]));
    assert_eq!(none[0]["files"], json!([]));
    let md = scan(&t.0, policy(false, json!([".md"])), json!([]));
    assert_eq!(md[0]["files"], json!(["B.MD", "a.md"]));
}

#[cfg(unix)]
#[test]
fn step_1_a_symlinked_dir_is_never_entered_and_a_symlinked_file_is_a_file() {
    let t = Tree::new();
    t.file("real/x.md", "").file("target.md", "");
    std::os::unix::fs::symlink(t.0.join("real"), t.0.join("linkdir")).unwrap();
    std::os::unix::fs::symlink(t.0.join("target.md"), t.0.join("linkfile.md")).unwrap();
    std::os::unix::fs::symlink(t.0.join("nowhere"), t.0.join("dangling.md")).unwrap();
    std::os::unix::fs::symlink(&t.0, t.0.join("real/loop")).unwrap();
    let lines = scan(&t.0, policy(false, Value::Null), json!([]));
    assert_eq!(dirs(&lines), [t.path(""), t.path("real")]);
    assert_eq!(lines[0]["files"], json!(["linkfile.md", "target.md"]));
    assert_eq!(entry(&lines, &t.path("real"))["files"], json!(["x.md"]));
}

#[cfg(unix)]
#[test]
fn an_unreadable_dir_is_yielded_empty_with_its_errno() {
    use std::os::unix::fs::PermissionsExt;
    let t = Tree::new();
    t.file("locked/x.md", "").file("open/y.md", "");
    fs::set_permissions(t.0.join("locked"), fs::Permissions::from_mode(0o000)).unwrap();
    let lines = scan(&t.0, policy(false, Value::Null), json!([]));
    fs::set_permissions(t.0.join("locked"), fs::Permissions::from_mode(0o755)).unwrap();
    if unsafe { libc::geteuid() } == 0 {
        return; // root reads anything
    }
    let locked = entry(&lines, &t.path("locked"));
    assert_eq!(locked["subdirs"], json!([]));
    assert_eq!(locked["files"], json!([]));
    assert_eq!(locked["error"], json!({"path": t.path("locked"), "kind": "unreadable", "detail": "EACCES"}));
    assert_eq!(entry(&lines, &t.path("open"))["files"], json!(["y.md"]));
}

#[test]
fn a_root_that_is_not_a_directory_writes_only_the_terminal_line() {
    let t = Tree::new();
    let lines = scan(&t.0.join("missing"), policy(true, Value::Null), json!([skill_spec()]));
    assert_eq!(
        lines,
        [json!({"spec_kind": "diskio.stream_end",
                "counts": {"diskio.walk_entry": 0, "diskio.scan_candidate": 0, "diskio.scan_problem": 0}})]
    );
}

#[test]
fn the_stream_order_is_root_scan_then_each_entry_with_its_folder_scan() {
    let t = Tree::new();
    t.file(".claude/skills/alpha/SKILL.md", "")
        .dir(".claude/skills/no_main")
        .file("loose/SKILL.md", "")
        .file("SKILL.md", "");
    let lines = scan(&t.0, policy(true, json!([])), json!([skill_spec()]));
    let brief: Vec<(String, String)> = lines
        .iter()
        .map(|l| {
            let at = l.get("dir").or(l.get("path")).and_then(Value::as_str).unwrap_or("");
            (l["spec_kind"].as_str().unwrap().to_string(), at.to_string())
        })
        .collect();
    let (entry, cand, problem) = ("diskio.walk_entry", "diskio.scan_candidate", "diskio.scan_problem");
    let expected = [
        (cand, t.path(".claude/skills/alpha")), // the root's own scan comes first: the mount …
        (problem, t.path(".claude/skills/no_main")), // … and its problem
        (entry, t.path("")),
        (cand, t.path("")), // the folder scan of the root: it holds a SKILL.md
        (entry, t.path(".claude")),
        (entry, t.path(".claude/skills")),
        (entry, t.path(".claude/skills/alpha")), // under the mount: not a second candidate
        (entry, t.path(".claude/skills/no_main")),
        (entry, t.path("loose")),
        (cand, t.path("loose")),
        ("diskio.stream_end", String::new()),
    ];
    let expected: Vec<(String, String)> = expected.iter().map(|(k, p)| (k.to_string(), p.clone())).collect();
    assert_eq!(brief, expected);
}

#[test]
fn every_line_is_tagged_and_carries_exactly_the_contract_fields() {
    let t = Tree::new();
    t.file(".claude/skills/alpha/SKILL.md", "").dir(".claude/skills/no_main");
    let lines = scan(&t.0, policy(true, json!([])), json!([skill_spec()]));
    let keys = |line: &Value| -> Vec<String> { line.as_object().unwrap().keys().cloned().collect() };
    for line in &lines {
        let mut found = keys(line);
        found.sort();
        let expected: &[&str] = match line["spec_kind"].as_str().unwrap() {
            "diskio.walk_entry" => &["dir", "error", "files", "spec_kind", "subdirs"],
            "diskio.scan_candidate" => &["layout", "parent", "path", "spec_kind", "type_name"],
            "diskio.scan_problem" => &["message", "path", "spec_kind", "type_name"],
            "diskio.stream_end" => &["counts", "spec_kind"],
            other => panic!("unknown kind {other}"),
        };
        assert_eq!(found, expected);
    }
    let candidate = lines.iter().find(|l| l["spec_kind"] == "diskio.scan_candidate").unwrap();
    assert_eq!(
        *candidate,
        json!({"spec_kind": "diskio.scan_candidate", "path": t.path(".claude/skills/alpha"),
               "type_name": "skill", "layout": "folder", "parent": t.path("")})
    );
    let problem = lines.iter().find(|l| l["spec_kind"] == "diskio.scan_problem").unwrap();
    assert_eq!(problem["message"], "directory in skills/ without SKILL.md");
}

#[test]
fn the_terminal_line_counts_what_was_written_and_is_last() {
    let t = Tree::new();
    t.file(".claude/skills/alpha/SKILL.md", "").dir(".claude/skills/no_main");
    let lines = scan(&t.0, policy(true, json!([])), json!([skill_spec()]));
    let count = |kind: &str| lines.iter().filter(|l| l["spec_kind"] == kind).count();
    let end = lines.last().unwrap();
    assert_eq!(end["spec_kind"], "diskio.stream_end");
    assert_eq!(count("diskio.stream_end"), 1);
    assert_eq!(
        end["counts"],
        json!({"diskio.walk_entry": count("diskio.walk_entry"),
               "diskio.scan_candidate": count("diskio.scan_candidate"),
               "diskio.scan_problem": count("diskio.scan_problem")})
    );
}

#[test]
fn a_kind_that_was_never_written_is_counted_as_zero() {
    let t = Tree::new();
    t.file("a/x.md", "");
    let lines = scan(&t.0, policy(false, json!([])), json!([]));
    assert_eq!(
        lines.last().unwrap()["counts"],
        json!({"diskio.walk_entry": 2, "diskio.scan_candidate": 0, "diskio.scan_problem": 0})
    );
}

#[test]
fn a_file_shape_scans_a_recursive_mount_and_skips_appledouble() {
    let t = Tree::new();
    t.file("docs/a.md", "").file("docs/sub/b.md", "").file("docs/._c.md", "").file("docs/UP.MD", "").file("docs/n.txt", "");
    let spec = json!({
        "type_name": "markdown", "shape": {"kind": "file", "ext": ".md"},
        "walks": [{"roots": ["real_project_cwd"], "mounts": ["docs"], "recursive": true}],
    });
    let lines = scan(&t.0, policy(false, json!([])), json!([spec]));
    let found: Vec<&str> = lines
        .iter()
        .filter(|l| l["spec_kind"] == "diskio.scan_candidate")
        .map(|l| l["path"].as_str().unwrap())
        .collect();
    assert_eq!(found, [t.path("docs/a.md"), t.path("docs/sub/b.md")]);
}

#[test]
fn a_request_that_cannot_be_parsed_is_refused() {
    for bad in ["", "not json", "[]", "{}", r#"{"roots": [], "specs": []}"#, r#"{"roots": [{"path": 1}], "policy": {}, "specs": []}"#] {
        assert!(request::parse(bad).is_err(), "{bad:?}");
    }
    let minimal = r#"{"spec_kind":"diskio.scan_request","roots":[],
        "policy":{"gitignore":true,"file_exts":null,"deny_basenames":[],"skip_segments":[],"force_include":[]},"specs":[]}"#;
    assert!(request::parse(minimal).is_ok());
}
