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
    }
}
