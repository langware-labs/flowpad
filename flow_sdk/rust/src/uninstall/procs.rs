//! Which running processes the uninstaller may stop (FLOWPAD-2250, plan §2).
//!
//! A process is stopped only on verified association with FlowPad Desktop — never because it runs
//! a Python the engine also uses, never by name, and never because it listens on 9007:
//!
//! * the app: image exactly `<install dir>\Flowpad.exe`;
//! * a server: `server.json`'s pid, created at `server_create_time` (to 10 ms; a reused pid was
//!   created later), command line `flow_sdk.server.run`, image an engine interpreter, holding the
//!   recorded port if anything holds it, and `launched_by == "desktop"`. A server that matches all
//!   but the last is FlowPad's but independently started: left running, and the engine is shared;
//! * its monitor: `monitor_pid`, command line `flow_sdk.server.launch`, an engine interpreter, and
//!   `monitor_create_time` (or, from an older engine, the verified server's parent);
//! * workers: descendants of a verified server (created after their parent) that run an engine
//!   interpreter or the owned venv, with `flow_sdk` or the venv on their command line. Any other
//!   descendant (an agent CLI, a shell the user started) is left running and reported.
//!
//! [`select`] is pure; the snapshot that feeds it is taken by [`scan`] on Windows.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

/// One process from a snapshot.
#[derive(Debug, Clone, PartialEq)]
pub struct Proc {
    pub pid: u32,
    pub ppid: u32,
    /// Full image path, when readable (another session's or a protected process's is not).
    pub image: Option<String>,
    /// Creation time, seconds since the Unix epoch (psutil's `create_time()`).
    pub created: Option<f64>,
    pub cmdline: Option<String>,
}

/// The fields of an instance's `server.json` this module reads. `launched_by` distinguishes
/// absent (an engine older than the field) from null (a server the desktop did not launch).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct ServerInfo {
    pub port: Option<u16>,
    pub server_pid: Option<u32>,
    pub server_create_time: Option<f64>,
    pub monitor_pid: Option<u32>,
    pub monitor_create_time: Option<f64>,
    #[serde(default, deserialize_with = "present")]
    pub launched_by: Option<Option<String>>,
}

fn present<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(d).map(Some)
}

impl ServerInfo {
    pub fn parse(text: &str) -> Option<ServerInfo> {
        serde_json::from_str(super::classify::strip_bom(text)).ok()
    }
}

/// One desktop-managed instance's server record.
#[derive(Debug, Clone)]
pub struct InstanceServer {
    pub instance: String,
    pub info: ServerInfo,
}

#[derive(Debug, Clone, Default)]
pub struct Context {
    /// `<install dir>\Flowpad.exe`.
    pub app_exe: String,
    /// The engine's interpreters: the venv's `Scripts\python.exe` and its `pyvenv.cfg` `home` python.
    pub engine_interpreters: Vec<String>,
    /// The engine venv root, only when the engine is being removed.
    pub owned_venv: Option<String>,
    /// Servers of instances with `.desktop_managed`.
    pub servers: Vec<InstanceServer>,
    /// TCP listeners: port → owning pid.
    pub listeners: BTreeMap<u16, u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Role {
    App,
    Server,
    Monitor,
    Worker,
    VenvExecutable,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Verified {
    pub pid: u32,
    pub role: Role,
    pub image: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Selection {
    /// Processes that may be stopped.
    pub verified: Vec<Verified>,
    /// FlowPad servers running that the desktop did not launch (left running; the engine is shared).
    pub independent_servers: Vec<u32>,
    /// Descendants of a verified server that are not FlowPad processes (left running).
    pub orphans: Vec<u32>,
    /// Notes for the log: why a recorded pid was not accepted.
    pub notes: Vec<String>,
}

const SERVER_MARKER: &str = "flow_sdk.server.run";
const MONITOR_MARKER: &str = "flow_sdk.server.launch";
const CREATE_TIME_TOLERANCE: f64 = 0.010;

pub fn same_path_pub(a: &str, b: &str) -> bool {
    same_path(a, b)
}

fn same_path(a: &str, b: &str) -> bool {
    a.trim_end_matches('\\').eq_ignore_ascii_case(b.trim_end_matches('\\'))
}

/// `path` is inside `dir` — compared with a directory boundary, so `…\flowpad2\x` is not in `…\flowpad`.
pub fn under(path: &str, dir: &str) -> bool {
    let dir = dir.trim_end_matches('\\');
    path.len() > dir.len() + 1 && path[..dir.len()].eq_ignore_ascii_case(dir) && path.as_bytes()[dir.len()] == b'\\'
}

fn close(a: Option<f64>, b: Option<f64>) -> bool {
    matches!((a, b), (Some(x), Some(y)) if (x - y).abs() <= CREATE_TIME_TOLERANCE)
}

pub fn select(procs: &[Proc], ctx: &Context) -> Selection {
    let by_pid: BTreeMap<u32, &Proc> = procs.iter().map(|p| (p.pid, p)).collect();
    let is_interpreter = |p: &Proc| p.image.as_deref().is_some_and(|i| ctx.engine_interpreters.iter().any(|e| same_path(i, e)));
    let mut sel = Selection::default();
    let mut verified: BTreeMap<u32, Role> = BTreeMap::new();

    for p in procs {
        if p.image.as_deref().is_some_and(|i| same_path(i, &ctx.app_exe)) {
            verified.insert(p.pid, Role::App);
        }
    }

    let mut servers: Vec<u32> = Vec::new();
    for s in &ctx.servers {
        let info = &s.info;
        let tag = &s.instance;
        if let Some(pid) = info.server_pid {
            match by_pid.get(&pid) {
                None => sel.notes.push(format!("{tag}: server pid {pid} is not running")),
                Some(p) => {
                    let listener_ok = match info.port.and_then(|port| ctx.listeners.get(&port)) {
                        None => true,
                        Some(owner) => *owner == pid,
                    };
                    let flowpad_server = close(p.created, info.server_create_time)
                        && p.cmdline.as_deref().is_some_and(|c| c.contains(SERVER_MARKER))
                        && is_interpreter(p)
                        && listener_ok;
                    if !flowpad_server {
                        sel.notes.push(format!("{tag}: pid {pid} is not the recorded server (reused pid, or not FlowPad's)"));
                    } else if info.launched_by == Some(Some("desktop".into())) {
                        verified.insert(pid, Role::Server);
                        servers.push(pid);
                    } else {
                        sel.independent_servers.push(pid);
                        sel.notes.push(format!("{tag}: server {pid} was not launched by FlowPad Desktop; left running"));
                    }
                }
            }
        }
        if let Some(mpid) = info.monitor_pid {
            if let Some(m) = by_pid.get(&mpid) {
                let server_pid = info.server_pid.filter(|sp| servers.contains(sp));
                let parent_of_server = server_pid
                    .and_then(|sp| by_pid.get(&sp))
                    .is_some_and(|sp| sp.ppid == mpid && matches!((m.created, sp.created), (Some(a), Some(b)) if a <= b));
                let identity = match info.monitor_create_time {
                    Some(_) => close(m.created, info.monitor_create_time),
                    None => parent_of_server,
                };
                let ours = identity
                    && m.cmdline.as_deref().is_some_and(|c| c.contains(MONITOR_MARKER))
                    && is_interpreter(m)
                    && info.launched_by == Some(Some("desktop".into()));
                if ours {
                    verified.insert(mpid, Role::Monitor);
                } else {
                    sel.notes.push(format!("{tag}: monitor pid {mpid} not verified; left running"));
                }
            }
        }
    }

    if let Some(venv) = &ctx.owned_venv {
        for p in procs {
            if p.image.as_deref().is_some_and(|i| under(i, venv)) {
                verified.entry(p.pid).or_insert(Role::VenvExecutable);
            }
        }
    }

    // Workers: descendants of a verified server, each created after its parent.
    let mut children: BTreeMap<u32, Vec<&Proc>> = BTreeMap::new();
    for p in procs {
        children.entry(p.ppid).or_default().push(p);
    }
    let mut seen: BTreeSet<u32> = BTreeSet::new();
    let mut stack: Vec<u32> = servers.clone();
    while let Some(parent) = stack.pop() {
        if !seen.insert(parent) {
            continue;
        }
        let parent_created = by_pid.get(&parent).and_then(|p| p.created);
        for c in children.get(&parent).map(Vec::as_slice).unwrap_or(&[]) {
            if c.pid == parent || !matches!((parent_created, c.created), (Some(a), Some(b)) if b >= a) {
                continue;
            }
            let engine_image = is_interpreter(c) || ctx.owned_venv.as_deref().is_some_and(|v| c.image.as_deref().is_some_and(|i| under(i, v)));
            let flowpad_cmd = c.cmdline.as_deref().is_some_and(|cl| {
                cl.contains("flow_sdk") || ctx.owned_venv.as_deref().is_some_and(|v| cl.to_lowercase().contains(&v.to_lowercase()))
            });
            if engine_image && flowpad_cmd {
                verified.entry(c.pid).or_insert(Role::Worker);
            } else if !verified.contains_key(&c.pid) {
                sel.orphans.push(c.pid);
            }
            stack.push(c.pid);
        }
    }

    sel.verified = verified
        .into_iter()
        .map(|(pid, role)| Verified { pid, role, image: by_pid.get(&pid).and_then(|p| p.image.clone()).unwrap_or_default() })
        .collect();
    sel.orphans.sort_unstable();
    sel.orphans.dedup();
    sel
}

#[cfg(windows)]
pub use win::{scan, terminate};

#[cfg(windows)]
mod win {
    use super::Proc;
    use std::collections::BTreeMap;
    use windows::Wdk::System::Threading::{NtQueryInformationProcess, PROCESSINFOCLASS};
    use windows::Win32::Foundation::{CloseHandle, FILETIME, HANDLE, UNICODE_STRING};
    use windows::Win32::NetworkManagement::IpHelper::{
        GetExtendedTcpTable, MIB_TCPROW_OWNER_PID, MIB_TCPTABLE_OWNER_PID, TCP_TABLE_OWNER_PID_LISTENER,
    };
    use windows::Win32::Networking::WinSock::AF_INET;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, TerminateProcess, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE,
    };

    const PROCESS_COMMAND_LINE_INFORMATION: PROCESSINFOCLASS = PROCESSINFOCLASS(60);
    /// 100-ns intervals between 1601-01-01 and 1970-01-01.
    const EPOCH_DIFF: u64 = 116_444_736_000_000_000;

    struct Owned(HANDLE);
    impl Drop for Owned {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }

    fn details(pid: u32) -> (Option<String>, Option<f64>, Option<String>) {
        let Ok(h) = (unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }) else {
            return (None, None, None);
        };
        let h = Owned(h);
        let image = {
            let mut buf = vec![0u16; 32768];
            let mut len = buf.len() as u32;
            unsafe { QueryFullProcessImageNameW(h.0, PROCESS_NAME_WIN32, windows::core::PWSTR(buf.as_mut_ptr()), &mut len) }
                .ok()
                .map(|_| String::from_utf16_lossy(&buf[..len as usize]))
        };
        let created = {
            let (mut c, mut e, mut k, mut u) = (FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default());
            unsafe { GetProcessTimes(h.0, &mut c, &mut e, &mut k, &mut u) }.ok().map(|_| {
                let ft = ((c.dwHighDateTime as u64) << 32) | c.dwLowDateTime as u64;
                ft.saturating_sub(EPOCH_DIFF) as f64 / 10_000_000.0
            })
        };
        let cmdline = {
            let mut buf = vec![0u64; 8192];
            let mut len = 0u32;
            let st = unsafe {
                NtQueryInformationProcess(h.0, PROCESS_COMMAND_LINE_INFORMATION, buf.as_mut_ptr() as *mut _, (buf.len() * 8) as u32, &mut len)
            };
            if st.is_err() {
                None
            } else {
                let us = unsafe { &*(buf.as_ptr() as *const UNICODE_STRING) };
                let chars = unsafe { std::slice::from_raw_parts(us.Buffer.0, (us.Length / 2) as usize) };
                Some(String::from_utf16_lossy(chars))
            }
        };
        (image, created, cmdline)
    }

    /// Every process, with image, creation time and command line where this user may read them.
    pub fn scan() -> Vec<Proc> {
        let mut out = Vec::new();
        let Ok(snap) = (unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }) else { return out };
        let snap = Owned(snap);
        let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        let mut ok = unsafe { Process32FirstW(snap.0, &mut entry) }.is_ok();
        while ok {
            let (image, created, cmdline) = details(entry.th32ProcessID);
            out.push(Proc { pid: entry.th32ProcessID, ppid: entry.th32ParentProcessID, image, created, cmdline });
            ok = unsafe { Process32NextW(snap.0, &mut entry) }.is_ok();
        }
        out
    }

    /// TCP (IPv4) listeners: port → owning pid.
    pub fn listeners() -> BTreeMap<u16, u32> {
        let mut size = 0u32;
        unsafe { GetExtendedTcpTable(None, &mut size, false, AF_INET.0 as u32, TCP_TABLE_OWNER_PID_LISTENER, 0) };
        let mut buf = vec![0u8; size as usize + 4096];
        size = buf.len() as u32;
        let rc = unsafe {
            GetExtendedTcpTable(Some(buf.as_mut_ptr() as *mut _), &mut size, false, AF_INET.0 as u32, TCP_TABLE_OWNER_PID_LISTENER, 0)
        };
        let mut out = BTreeMap::new();
        if rc != 0 {
            return out;
        }
        let table = unsafe { &*(buf.as_ptr() as *const MIB_TCPTABLE_OWNER_PID) };
        let rows = unsafe { std::slice::from_raw_parts(table.table.as_ptr() as *const MIB_TCPROW_OWNER_PID, table.dwNumEntries as usize) };
        for r in rows {
            out.insert(u16::from_be((r.dwLocalPort & 0xFFFF) as u16), r.dwOwningPid);
        }
        out
    }

    /// Stop one process, after re-checking it is still the process that was verified (same pid,
    /// same creation time). Never a tree kill: descendants are verified on their own.
    pub fn terminate(pid: u32, created: Option<f64>) -> Result<(), String> {
        let (_, now_created, _) = details(pid);
        if now_created != created {
            return Err(format!("pid {pid} is no longer the verified process"));
        }
        let h = unsafe { OpenProcess(PROCESS_TERMINATE, false, pid) }.map_err(|e| e.to_string())?;
        let h = Owned(h);
        unsafe { TerminateProcess(h.0, 1) }.map_err(|e| e.to_string())
    }

    pub use listeners as tcp_listeners;
}

#[cfg(windows)]
pub use win::tcp_listeners;

#[cfg(test)]
mod tests {
    use super::*;

    const VENV: &str = r"C:\Users\u\AppData\Roaming\uv\tools\flowpad";
    const LAUNCHER: &str = r"C:\Users\u\AppData\Roaming\uv\tools\flowpad\Scripts\python.exe";
    const BASE: &str = r"C:\Users\u\AppData\Local\Flowpad\runtime\python-3.11.9\python.exe";
    const APP: &str = r"C:\Users\u\AppData\Local\Programs\Flowpad\Flowpad.exe";

    fn p(pid: u32, ppid: u32, image: &str, created: f64, cmd: &str) -> Proc {
        Proc { pid, ppid, image: Some(image.into()), created: Some(created), cmdline: Some(cmd.into()) }
    }

    fn info(launched_by: Option<Option<&str>>) -> ServerInfo {
        ServerInfo {
            port: Some(9007),
            server_pid: Some(200),
            server_create_time: Some(1000.0),
            monitor_pid: Some(100),
            monitor_create_time: Some(990.0),
            launched_by: launched_by.map(|o| o.map(String::from)),
        }
    }

    fn ctx(info: ServerInfo) -> Context {
        Context {
            app_exe: APP.into(),
            engine_interpreters: vec![LAUNCHER.into(), BASE.into()],
            owned_venv: None,
            servers: vec![InstanceServer { instance: "prod".into(), info }],
            listeners: BTreeMap::from([(9007, 200)]),
        }
    }

    /// The app, a desktop-launched monitor → server (base interpreter via the venv launcher),
    /// a worker, a node child of the server, and bystanders.
    fn world() -> Vec<Proc> {
        vec![
            p(10, 1, APP, 900.0, "Flowpad.exe"),
            p(100, 10, BASE, 990.0, "python -m flow_sdk.server.launch 9007"),
            p(150, 100, LAUNCHER, 999.0, r"Scripts\python.exe -m flow_sdk.server.run"),
            p(200, 150, BASE, 1000.0, "python -m flow_sdk.server.run"),
            p(300, 200, BASE, 1010.0, "python -c from flow_sdk.workers import x"),
            p(310, 200, r"C:\Program Files\nodejs\node.exe", 1011.0, "node claude"),
            p(400, 1, BASE, 1020.0, "python my_script.py"),
            p(500, 1, r"C:\Python311\python.exe", 1030.0, "python -m flow_sdk.server.run"),
        ]
    }

    fn roles(s: &Selection) -> Vec<(u32, Role)> {
        s.verified.iter().map(|v| (v.pid, v.role)).collect()
    }

    #[test]
    fn the_desktop_tree_is_verified_and_bystanders_are_not() {
        let s = select(&world(), &ctx(info(Some(Some("desktop")))));
        assert_eq!(roles(&s), vec![(10, Role::App), (100, Role::Monitor), (200, Role::Server), (300, Role::Worker)]);
        assert_eq!(s.orphans, vec![310], "the node child is left running and reported");
        assert!(s.independent_servers.is_empty());
    }

    #[test]
    fn a_process_on_the_shared_interpreter_is_never_matched_without_the_chain() {
        let s = select(&world(), &ctx(info(Some(Some("desktop")))));
        assert!(!s.verified.iter().any(|v| v.pid == 400), "same interpreter, not a descendant");
    }

    #[test]
    fn an_independently_started_server_is_left_running_and_marks_the_engine_shared() {
        for launched_by in [Some(None), None] {
            let s = select(&world(), &ctx(info(launched_by.clone())));
            assert_eq!(s.independent_servers, vec![200], "{launched_by:?}");
            assert!(!s.verified.iter().any(|v| v.pid == 200 || v.pid == 300 || v.pid == 100), "{launched_by:?}");
        }
    }

    #[test]
    fn a_reused_pid_is_rejected() {
        let mut w = world();
        w[3].created = Some(1000.5); // pid 200 now belongs to a process created after the record
        let s = select(&w, &ctx(info(Some(Some("desktop")))));
        assert!(!s.verified.iter().any(|v| v.pid == 200));
        assert!(s.notes.iter().any(|n| n.contains("not the recorded server")));
    }

    #[test]
    fn a_stale_record_for_a_dead_server_touches_nothing() {
        let w: Vec<Proc> = world().into_iter().filter(|p| p.pid != 200 && p.pid != 300 && p.pid != 310).collect();
        let s = select(&w, &ctx(info(Some(Some("desktop")))));
        assert!(s.notes.iter().any(|n| n.contains("not running")));
        assert!(!s.verified.iter().any(|v| v.role == Role::Worker));
    }

    #[test]
    fn the_server_must_hold_its_port_when_the_port_is_held() {
        let mut c = ctx(info(Some(Some("desktop"))));
        c.listeners.insert(9007, 999);
        let s = select(&world(), &c);
        assert!(!s.verified.iter().any(|v| v.pid == 200), "someone else on the recorded port");
        let mut c = ctx(info(Some(Some("desktop"))));
        c.listeners.clear();
        assert!(select(&world(), &c).verified.iter().any(|v| v.pid == 200), "not listening yet is fine");
    }

    #[test]
    fn port_9007_alone_selects_nothing() {
        let mut c = ctx(ServerInfo { server_pid: None, monitor_pid: None, ..info(Some(Some("desktop"))) });
        c.listeners.insert(9007, 500);
        let s = select(&world(), &c);
        assert_eq!(roles(&s), vec![(10, Role::App)]);
    }

    #[test]
    fn a_server_running_another_python_is_not_ours() {
        let mut c = ctx(ServerInfo { server_pid: Some(500), server_create_time: Some(1030.0), ..info(Some(Some("desktop"))) });
        c.listeners.clear();
        assert!(!select(&world(), &c).verified.iter().any(|v| v.pid == 500));
    }

    #[test]
    fn a_legacy_monitor_is_accepted_only_as_the_verified_servers_parent() {
        let mut i = info(Some(Some("desktop")));
        i.monitor_create_time = None;
        let mut w = world();
        w[3].ppid = 100; // server directly under the monitor
        assert!(select(&w, &ctx(i.clone())).verified.iter().any(|v| v.pid == 100 && v.role == Role::Monitor));
        let w = world(); // server's parent is the launcher, not the monitor
        assert!(!select(&w, &ctx(i)).verified.iter().any(|v| v.pid == 100));
    }

    #[test]
    fn venv_executables_only_when_the_venv_is_owned_and_with_a_directory_boundary() {
        let mut w = world();
        w.push(p(600, 1, r"C:\Users\u\AppData\Roaming\uv\tools\flowpad\Scripts\flow.exe", 1040.0, "flow status"));
        w.push(p(601, 1, r"C:\Users\u\AppData\Roaming\uv\tools\flowpad2\Scripts\flow.exe", 1041.0, "flow status"));
        let mut c = ctx(info(Some(Some("desktop"))));
        assert!(!select(&w, &c).verified.iter().any(|v| v.pid == 600), "not owned: not touched");
        c.owned_venv = Some(VENV.into());
        let s = select(&w, &c);
        assert!(s.verified.iter().any(|v| v.pid == 600 && v.role == Role::VenvExecutable));
        assert!(!s.verified.iter().any(|v| v.pid == 601), "flowpad2 is not inside flowpad");
    }

    #[test]
    fn a_child_created_before_its_parent_is_a_reused_ppid_not_a_worker() {
        let mut w = world();
        w[4].created = Some(999.0);
        assert!(!select(&w, &ctx(info(Some(Some("desktop"))))).verified.iter().any(|v| v.pid == 300));
    }

    #[test]
    fn server_json_launched_by_absent_vs_null() {
        let absent = ServerInfo::parse(r#"{"port":9007,"server_pid":1}"#).unwrap();
        let null = ServerInfo::parse(r#"{"port":9007,"server_pid":1,"launched_by":null}"#).unwrap();
        let desk = ServerInfo::parse(r#"{"port":9007,"server_pid":1,"launched_by":"desktop","generation":null}"#).unwrap();
        assert_eq!(absent.launched_by, None);
        assert_eq!(null.launched_by, Some(None));
        assert_eq!(desk.launched_by, Some(Some("desktop".into())));
    }

    #[test]
    fn under_respects_the_directory_boundary() {
        assert!(under(r"C:\a\flowpad\x.exe", r"C:\a\flowpad"));
        assert!(under(r"C:\A\FLOWPAD\x.exe", r"c:\a\flowpad\"));
        assert!(!under(r"C:\a\flowpad2\x.exe", r"C:\a\flowpad"));
        assert!(!under(r"C:\a\flowpad", r"C:\a\flowpad"));
    }
}
