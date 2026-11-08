//! The uninstaller's process snapshot and termination on a real Windows (FLOWPAD-2250).
#![cfg(windows)]

use std::net::TcpListener;
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;

use flow_rs::uninstall::procs::{scan, tcp_listeners, terminate};

fn spawn_ping(marker: &str) -> std::process::Child {
    // A marker argument ping ignores is harmless as the last host would not be; use the count.
    Command::new(r"C:\Windows\System32\PING.EXE")
        .args(["-n", "30", "-w", "1000", "127.0.0.1"])
        .env("FLOWRS_TEST_MARKER", marker)
        .stdout(Stdio::null())
        .spawn()
        .unwrap()
}

#[test]
fn scan_reads_image_command_line_creation_time_and_parent() {
    let mut child = spawn_ping("scan");
    thread::sleep(Duration::from_millis(300));
    let me = std::process::id();
    let procs = scan();
    let p = procs.iter().find(|p| p.pid == child.id()).expect("the child is in the snapshot");
    assert_eq!(p.ppid, me);
    assert!(p.image.as_deref().is_some_and(|i| i.eq_ignore_ascii_case(r"C:\Windows\System32\PING.EXE")), "{:?}", p.image);
    assert!(p.cmdline.as_deref().is_some_and(|c| c.contains("-n 30")), "{:?}", p.cmdline);
    let created = p.created.expect("creation time");
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs_f64();
    assert!(created <= now && now - created < 30.0, "created {created} vs now {now}");
    let me_proc = procs.iter().find(|p| p.pid == me).unwrap();
    assert!(me_proc.created.unwrap() <= created, "a child is created after its parent");
    let _ = child.kill();
    let _ = child.wait();
}

#[test]
fn terminate_refuses_a_process_that_is_not_the_verified_one() {
    let mut child = spawn_ping("terminate");
    thread::sleep(Duration::from_millis(300));
    let created = scan().into_iter().find(|p| p.pid == child.id()).unwrap().created;
    assert!(terminate(child.id(), created.map(|c| c + 5.0)).is_err(), "a different creation time must be refused");
    assert!(child.try_wait().unwrap().is_none(), "and the process must still be running");
    terminate(child.id(), created).unwrap();
    let status = child.wait().unwrap();
    assert!(!status.success());
}

#[test]
fn listeners_map_a_port_to_its_owner() {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    assert_eq!(tcp_listeners().get(&port), Some(&std::process::id()));
}
