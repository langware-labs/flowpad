use clap::{Parser, Subcommand};
use flow_rs::{
    rust_delete_key, rust_get_key, rust_get_key_restricted, rust_set_key, rust_set_key_restricted,
};

#[derive(Parser)]
#[command(
    name = "flow-rs",
    about = "OS-keychain helper (interchangeable with Python keyring)"
)]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
#[command(rename_all = "snake_case")]
enum Cmd {
    /// Print the value stored at (service, name) to stdout. Exits 1 if absent.
    /// Reads the permissive-ACL path written by `set_key`.
    GetKey { service: String, name: String },
    /// Print the value stored at (service, name) to stdout. Exits 1 if absent.
    /// Reads the restrictive-ACL path written by `set_key_restricted`.
    GetKeyRestricted { service: String, name: String },
    /// Store `val` at (service, name) with a PERMISSIVE ACL (`-A`) so any
    /// local app can read the value without a Keychain prompt.
    SetKey {
        service: String,
        name: String,
        val: String,
    },
    /// Store `val` at (service, name) with a RESTRICTIVE ACL bound to this
    /// flow-rs binary. Only the same flow-rs binary can later read without a
    /// Keychain prompt. Matches keytar's default security posture.
    SetKeyRestricted {
        service: String,
        name: String,
        val: String,
    },
    /// Remove the entry at (service, name). No-op if absent.
    DeleteKey { service: String, name: String },
    /// The Windows uninstaller's engine (FLOWPAD-2250), called by the NSIS uninstaller. Exits 0
    /// (complete), 10 (the rest is scheduled for the next sign-in), 20 (partial) or 124 (deadline).
    #[cfg(windows)]
    #[command(rename_all = "kebab-case")]
    Uninstall {
        /// $INSTDIR of the installation being removed.
        #[arg(long)]
        install_dir: std::path::PathBuf,
        /// Only classify and write --ini for the uninstaller's page; change nothing.
        #[arg(long)]
        classify_only: bool,
        #[arg(long)]
        ini: Option<std::path::PathBuf>,
        /// Consent to remove an engine that is offered, not removed by default.
        #[arg(long)]
        remove_engine: bool,
        #[arg(long)]
        delete_app_data: bool,
        #[arg(long)]
        delete_instance_data: bool,
        #[arg(long)]
        log: Option<std::path::PathBuf>,
        #[arg(long)]
        result: Option<std::path::PathBuf>,
        #[arg(long, default_value_t = 300)]
        deadline_secs: u64,
    },
    /// Finish an uninstall's pending removals (started by RunOnce, the installer, or by hand).
    #[cfg(windows)]
    #[command(name = "deferred-cleanup", rename_all = "kebab-case")]
    DeferredCleanup {
        #[arg(long, default_value = "logon")]
        trigger: String,
        #[arg(long)]
        log: Option<std::path::PathBuf>,
        #[arg(long, default_value_t = 300)]
        deadline_secs: u64,
    },
    /// Prove this binary can run from where it is (application-control policies).
    #[cfg(windows)]
    #[command(name = "self-test")]
    SelfTest,
}

/// Exit with 124 at the deadline, whatever is in progress: nothing may hang the uninstaller.
#[cfg(windows)]
fn watchdog(secs: u64) {
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(secs));
        std::process::exit(124);
    });
}

fn main() -> anyhow::Result<()> {
    match Cli::parse().cmd {
        Cmd::GetKey { service, name } => match rust_get_key(&service, &name)? {
            Some(v) => {
                print!("{}", v);
                Ok(())
            }
            None => std::process::exit(1),
        },
        Cmd::GetKeyRestricted { service, name } => match rust_get_key_restricted(&service, &name)? {
            Some(v) => {
                print!("{}", v);
                Ok(())
            }
            None => std::process::exit(1),
        },
        Cmd::SetKey {
            service,
            name,
            val,
        } => rust_set_key(&service, &name, &val),
        Cmd::SetKeyRestricted {
            service,
            name,
            val,
        } => rust_set_key_restricted(&service, &name, &val),
        Cmd::DeleteKey { service, name } => rust_delete_key(&service, &name),
        #[cfg(windows)]
        Cmd::Uninstall {
            install_dir,
            classify_only,
            ini,
            remove_engine,
            delete_app_data,
            delete_instance_data,
            log,
            result,
            deadline_secs,
        } => {
            watchdog(deadline_secs);
            let options = flow_rs::uninstall::run::Options {
                install_dir,
                classify_only,
                remove_engine,
                delete_app_data,
                delete_instance_data,
                log,
                result,
                ini,
            };
            std::process::exit(flow_rs::uninstall::run::run(&options))
        }
        #[cfg(windows)]
        Cmd::DeferredCleanup { trigger, log, deadline_secs } => {
            use flow_rs::uninstall::deferred::{self, Trigger};
            watchdog(deadline_secs);
            let trigger = match trigger.as_str() {
                "installer" => Trigger::Installer,
                "manual" => Trigger::Manual,
                _ => Trigger::Logon,
            };
            let layout = match flow_rs::uninstall::win::Layout::resolve(std::path::Path::new("")) {
                Ok(l) => l,
                Err(e) => anyhow::bail!("cannot resolve the user's folders: {e}"),
            };
            let mut log = flow_rs::uninstall::report::Log::open(log.as_deref());
            std::process::exit(deferred::run(&layout, trigger, &mut log))
        }
        #[cfg(windows)]
        Cmd::SelfTest => {
            println!("{}", flow_rs::uninstall::deferred::SELF_TEST_OK);
            Ok(())
        }
    }
}
