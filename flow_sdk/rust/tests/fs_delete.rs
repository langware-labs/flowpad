//! The uninstaller's deleter on real NTFS (FLOWPAD-2250). Windows only; run on a Windows machine
//! as both an administrator and a standard user. The file name must not contain
//! "install"/"setup"/"update": Windows installer detection would demand elevation for the test exe.
#![cfg(windows)]

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use flow_rs::uninstall::delete::{FailureKind, Refused, Root};

fn scratch(name: &str) -> PathBuf {
    let p = std::env::temp_dir().join(format!("flowrs-fsdel-{}-{}", name, std::process::id()));
    let _ = fs::remove_dir_all(&p);
    fs::create_dir_all(&p).unwrap();
    p
}

fn write(p: &Path, s: &str) {
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, s).unwrap();
}

fn junction(link: &Path, target: &Path) {
    let out = Command::new("cmd").args(["/d", "/c", "mklink", "/J"]).arg(link).arg(target).output().unwrap();
    assert!(out.status.success(), "mklink /J failed: {}", String::from_utf8_lossy(&out.stdout));
}

/// Everything under `root`, relative, not descending into links.
fn residue(root: &Path) -> Vec<String> {
    fn walk(base: &Path, dir: &Path, out: &mut Vec<String>) {
        let Ok(rd) = fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let p = e.path();
            out.push(p.strip_prefix(base).unwrap().to_string_lossy().replace('\\', "/"));
            let md = fs::symlink_metadata(&p).unwrap();
            if md.is_dir() && !md.file_type().is_symlink() {
                walk(base, &p, out);
            }
        }
    }
    let mut out = Vec::new();
    walk(root, root, &mut out);
    out.sort();
    out
}

struct Canary(PathBuf);

impl Canary {
    fn new(dir: PathBuf) -> Canary {
        write(&dir.join("secret.txt"), "CANARY");
        write(&dir.join("deep").join("file.txt"), "CANARY-DEEP");
        write(&dir.join("hardlink-src.txt"), "CANARY-HARDLINK");
        Canary(dir)
    }
    fn intact(&self) -> bool {
        fs::read_to_string(self.0.join("secret.txt")).ok().as_deref() == Some("CANARY")
            && fs::read_to_string(self.0.join("deep").join("file.txt")).ok().as_deref() == Some("CANARY-DEEP")
            && fs::read_to_string(self.0.join("hardlink-src.txt")).ok().as_deref() == Some("CANARY-HARDLINK")
    }
}

fn cleanup(p: &Path) {
    if let Ok(root) = Root::open(p) {
        root.remove_contents(None);
    }
    let _ = fs::remove_dir_all(p);
}

#[test]
fn links_are_removed_as_links_and_their_targets_survive() {
    let base = scratch("links");
    let canary = Canary::new(base.join("canary"));
    let root = base.join("root");
    write(&root.join("a").join("f.txt"), "x");
    write(&root.join("b").join("c").join("g.txt"), "y");
    junction(&root.join("junction"), &canary.0);
    junction(&root.join("a").join("nested-junction"), &canary.0);
    fs::hard_link(canary.0.join("hardlink-src.txt"), root.join("b").join("hardlink.txt")).unwrap();
    // Symlinks need the privilege (admin or Developer Mode); covered when available.
    let _ = std::os::windows::fs::symlink_dir(&canary.0, root.join("dir-symlink"));
    let _ = std::os::windows::fs::symlink_file(canary.0.join("secret.txt"), root.join("file-symlink.txt"));

    let r = Root::open(&root).unwrap();
    let report = r.remove_contents(None);

    assert!(report.complete(), "{report:?}");
    assert!(residue(&root).is_empty(), "{:?}", residue(&root));
    assert!(canary.intact());
    r.remove_self().unwrap();
    assert!(!root.exists());
    cleanup(&base);
}

#[test]
fn the_gate_refuses_a_junction_root_and_a_junction_above_it() {
    let base = scratch("gate");
    let real = base.join("real");
    write(&real.join("inner").join("f.txt"), "x");
    junction(&base.join("junction-root"), &real.join("inner"));
    junction(&base.join("junction-mid"), &real);

    assert_eq!(Root::open(&base.join("junction-root")).err(), Some(Refused::ReparsePoint));
    assert!(matches!(Root::open(&base.join("junction-mid").join("inner")), Err(Refused::Redirected { .. })));
    assert_eq!(Root::open(&base.join("nope")).err(), Some(Refused::Missing));
    assert!(Root::open(&real.join("inner")).is_ok());
    assert!(real.join("inner").join("f.txt").exists(), "a refused root touches nothing");
    cleanup(&base);
}

#[test]
fn an_8dot3_short_path_is_the_same_root() {
    let base = scratch("short");
    let long = base.join("has a long name");
    write(&long.join("f.txt"), "x");
    let short = {
        use std::os::windows::ffi::{OsStrExt, OsStringExt};
        let w: Vec<u16> = long.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
        let mut buf = vec![0u16; 1024];
        let n = unsafe { windows::Win32::Storage::FileSystem::GetShortPathNameW(windows::core::PCWSTR(w.as_ptr()), Some(&mut buf)) } as usize;
        assert!(n > 0 && n < buf.len());
        PathBuf::from(std::ffi::OsString::from_wide(&buf[..n]))
    };
    if short == long {
        eprintln!("8.3 names are disabled on this volume; nothing to check");
        cleanup(&base);
        return;
    }
    let r = Root::open(&short).expect("a short path must not be refused");
    assert_eq!(r.path().file_name().unwrap(), "has a long name");
    drop(r);
    cleanup(&base);
}

#[test]
fn a_held_root_cannot_be_moved() {
    let base = scratch("hold");
    let root = base.join("root");
    write(&root.join("f.txt"), "x");
    let r = Root::open(&root).unwrap();
    assert!(fs::rename(&root, base.join("moved")).is_err(), "the held root was renamed");
    drop(r);
    cleanup(&base);
}

#[test]
fn locked_items_stay_their_siblings_go_and_acls_are_not_changed() {
    let base = scratch("locked");
    let root = base.join("root");
    write(&root.join("sub").join("locked.txt"), "l");
    write(&root.join("sub").join("sib1.txt"), "s");
    write(&root.join("sub").join("deeper").join("sib2.txt"), "s");
    write(&root.join("sub2").join("sib3.txt"), "s");
    write(&root.join("sub3").join("sib4.txt"), "s");
    write(&root.join("sub3").join("aclonly").join("acl.txt"), "a");
    write(&root.join("plain").join("sib5.txt"), "s");

    use std::os::windows::fs::OpenOptionsExt;
    let lock = fs::OpenOptions::new().read(true).share_mode(1 /* FILE_SHARE_READ */).open(root.join("sub").join("locked.txt")).unwrap();
    let exe = root.join("sub2").join("running.exe");
    fs::copy(r"C:\Windows\System32\PING.EXE", &exe).unwrap();
    let mut running = Command::new(&exe).args(["-n", "60", "127.0.0.1"]).stdout(Stdio::null()).spawn().unwrap();
    thread::sleep(Duration::from_millis(300));
    let acl_file = root.join("sub3").join("aclonly").join("acl.txt");
    let icacls = |p: &Path, args: &[&str]| String::from_utf8_lossy(&Command::new("icacls").arg(p).args(args).output().unwrap().stdout).to_string();
    icacls(&acl_file, &["/deny", "*S-1-1-0:(DE)"]);
    icacls(&root.join("sub3").join("aclonly"), &["/deny", "*S-1-1-0:(DC)"]);
    let acl_before = icacls(&acl_file, &[]);

    let report = Root::open(&root).unwrap().remove_contents(None);
    let left = residue(&root);
    let acl_after = icacls(&acl_file, &[]);

    drop(lock);
    let _ = running.kill();
    let _ = running.wait();
    icacls(&root, &["/reset", "/T", "/Q"]);
    cleanup(&base);

    assert_eq!(
        left,
        ["sub", "sub/locked.txt", "sub2", "sub2/running.exe", "sub3", "sub3/aclonly", "sub3/aclonly/acl.txt"],
        "only the three blocked items and their parents remain"
    );
    assert_eq!(acl_before, acl_after, "the ACL was changed");
    let kind = |suffix: &str| report.failures.iter().find(|f| f.path.ends_with(suffix)).map(|f| f.kind);
    assert_eq!(kind("locked.txt"), Some(FailureKind::Locked));
    assert_eq!(kind("running.exe"), Some(FailureKind::Locked));
    assert_eq!(kind("acl.txt"), Some(FailureKind::AccessDenied));
    assert_eq!(report.failures.len(), 3, "{:?}", report.failures);
}

#[test]
fn evidence_is_removed_last_and_kept_while_anything_remains() {
    let base = scratch("evidence");
    let root = base.join("venv");
    write(&root.join("uv-receipt.toml"), "receipt");
    write(&root.join("Lib").join("x.py"), "x");
    write(&root.join("Scripts").join("held.txt"), "h");

    use std::os::windows::fs::OpenOptionsExt;
    let lock = fs::OpenOptions::new().read(true).share_mode(1).open(root.join("Scripts").join("held.txt")).unwrap();
    let report = Root::open(&root).unwrap().remove_contents(Some("uv-receipt.toml"));
    assert!(report.evidence_kept);
    assert!(root.join("uv-receipt.toml").exists(), "the evidence must survive while something is left");
    assert!(!root.join("Lib").exists());
    drop(lock);

    let report = Root::open(&root).unwrap().remove_contents(Some("uv-receipt.toml"));
    assert!(report.complete(), "{report:?}");
    assert!(!root.join("uv-receipt.toml").exists());
    cleanup(&base);
}

#[test]
fn remove_child_touches_only_that_child() {
    let base = scratch("child");
    let root = base.join("Flowpad");
    write(&root.join("runtime").join("python-3.11.9").join("python.exe"), "p");
    write(&root.join("user-notes.txt"), "mine");
    write(&root.join("other").join("keep.txt"), "k");

    let r = Root::open(&root).unwrap();
    let report = r.remove_child("runtime");
    assert!(report.complete(), "{report:?}");
    assert_eq!(residue(&root), ["other", "other/keep.txt", "user-notes.txt"]);
    assert!(r.remove_child("never-there").complete(), "a missing child is a no-op");
    drop(r);
    cleanup(&base);
}

#[test]
fn remove_self_refuses_a_directory_put_in_its_place() {
    let base = scratch("swap");
    let root = base.join("root");
    fs::create_dir_all(&root).unwrap();
    let r = Root::open(&root).unwrap();
    // Simulate a swap after the hold is released: remove_self re-opens by path and must notice.
    let held_identity = r.identity();
    drop(r);
    fs::remove_dir(&root).unwrap();
    write(&root.join("someone-elses.txt"), "x");
    fs::remove_file(root.join("someone-elses.txt")).unwrap();
    let again = Root::open(&root).unwrap();
    assert_ne!(again.identity(), held_identity, "a recreated directory has a new identity");
    drop(again);
    cleanup(&base);
}

#[test]
fn swapping_directories_for_junctions_mid_run_never_reaches_the_target() {
    let base = scratch("race");
    let canary = Canary::new(base.join("canary"));
    let root = base.join("root");
    let pool = base.join("pool");
    let mid_run_swaps = Arc::new(AtomicU64::new(0));
    let iterations = 200u64;
    let mut iterations_with_swap = 0;
    for _ in 0..iterations {
        for d in ["x", "y"] {
            for n in 0..150 {
                write(&root.join(d).join("victim").join(format!("f{n}.txt")), "v");
            }
        }
        fs::create_dir_all(&pool).unwrap();
        for j in 0..6 {
            if fs::symlink_metadata(pool.join(format!("j{j}"))).is_err() {
                junction(&pool.join(format!("j{j}")), &canary.0);
            }
        }
        let stop = Arc::new(AtomicBool::new(false));
        let deleting = Arc::new(AtomicBool::new(false));
        let before = mid_run_swaps.load(Ordering::Relaxed);
        let (r, pl, s, del, sw) = (root.clone(), pool.clone(), stop.clone(), deleting.clone(), mid_run_swaps.clone());
        let swapper = thread::spawn(move || {
            let mut k = 0usize;
            while !s.load(Ordering::Relaxed) {
                let target = if k % 2 == 0 { r.join("x").join("victim") } else { r.join("y") };
                let moved = target.with_file_name(format!("{}.moved{k}", target.file_name().unwrap().to_string_lossy()));
                let j = pl.join(format!("j{}", k % 6));
                k += 1;
                if fs::rename(&target, &moved).is_ok() && fs::rename(&j, &target).is_ok() && del.load(Ordering::Relaxed) {
                    sw.fetch_add(1, Ordering::Relaxed);
                }
            }
        });
        thread::sleep(Duration::from_millis(1));
        deleting.store(true, Ordering::Relaxed);
        let root_handle = Root::open(&root).unwrap();
        root_handle.remove_contents(None);
        drop(root_handle);
        deleting.store(false, Ordering::Relaxed);
        stop.store(true, Ordering::Relaxed);
        swapper.join().unwrap();
        if mid_run_swaps.load(Ordering::Relaxed) > before {
            iterations_with_swap += 1;
        }
        assert!(canary.intact(), "the canary behind a swapped-in junction was modified");
        cleanup(&root);
    }
    assert!(iterations_with_swap * 2 >= iterations, "the race was not exercised: {iterations_with_swap}/{iterations}");
    cleanup(&base);
}
