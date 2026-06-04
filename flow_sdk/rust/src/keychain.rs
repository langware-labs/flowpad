use anyhow::{Context, Result};

use keyring::Entry;

// ----------------------------------------------------------------------------
// macOS — use the legacy `/usr/bin/security` CLI under the hood.
//
// Why not the modern Keychain Services API (which is what the `keyring` Rust
// crate and Python's `keyring` library both use)?
//
// The modern API (SecItemAdd / SecItemCopyMatching) ties each generic-password
// item's access control to the calling binary's code-signing identity. When a
// *different* binary tries to read that item, macOS pops a SecurityAgent
// dialog ("python 3.10 wants to use the keychain"). For unsigned binaries
// (anything `cargo build` produces), there is no API-level way to grant
// cross-binary access without a user prompt.
//
// The legacy SecKeychain API, which the `security` CLI uses, supports the
// `-A` flag — "allow any application to access this item without warning".
// Items created via `security add-generic-password -A` are readable by any
// process via the legacy API without prompts. Modern-API reads of those same
// items still prompt, so we also read via the legacy API on macOS to keep
// the round-trip prompt-free.
//
// Net effect: Rust set_key / get_key are fully prompt-free on macOS, and
// Python's `keyring.get_password` (modern API) reading a Rust-written item
// will NOT prompt either, because Python and the Rust-spawned `security` CLI
// both end up touching items the Keychain considers globally accessible.
// ----------------------------------------------------------------------------

#[cfg(target_os = "macos")]
pub fn set_key(service: &str, name: &str, val: &str) -> Result<()> {
    use std::process::Command;
    // `-A` is honored only on creation; if the item already exists with a
    // restrictive ACL, `add ... -U -A` updates the value but leaves the ACL
    // alone. Delete first to guarantee the new item is created with `-A`.
    let _ = Command::new("/usr/bin/security")
        .args(["delete-generic-password", "-s", service, "-a", name])
        .output();
    let out = Command::new("/usr/bin/security")
        .args([
            "add-generic-password",
            "-s", service,
            "-a", name,
            "-w", val,
            "-A",
        ])
        .output()
        .context("invoke /usr/bin/security add-generic-password")?;
    anyhow::ensure!(
        out.status.success(),
        "security add-generic-password failed: {}",
        String::from_utf8_lossy(&out.stderr),
    );
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn get_key(service: &str, name: &str) -> Result<Option<String>> {
    use std::process::Command;
    let out = Command::new("/usr/bin/security")
        .args([
            "find-generic-password",
            "-s", service,
            "-a", name,
            "-w",
        ])
        .output()
        .context("invoke /usr/bin/security find-generic-password")?;
    if out.status.success() {
        // `-w` prints the password followed by a trailing newline.
        let mut v = String::from_utf8(out.stdout)?;
        if v.ends_with('\n') {
            v.pop();
        }
        Ok(Some(v))
    } else {
        // errSecItemNotFound prints to stderr; treat any non-zero exit as
        // "no entry" for parity with the keyring crate's NoEntry variant.
        let stderr = String::from_utf8_lossy(&out.stderr);
        if stderr.contains("could not be found") || stderr.contains("-25300") {
            Ok(None)
        } else {
            anyhow::bail!("security find-generic-password failed: {stderr}")
        }
    }
}

#[cfg(target_os = "macos")]
pub fn delete_key(service: &str, name: &str) -> Result<()> {
    use std::process::Command;
    let out = Command::new("/usr/bin/security")
        .args(["delete-generic-password", "-s", service, "-a", name])
        .output()
        .context("invoke /usr/bin/security delete-generic-password")?;
    if out.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    if stderr.contains("could not be found") || stderr.contains("-25300") {
        Ok(())
    } else {
        anyhow::bail!("security delete-generic-password failed: {stderr}")
    }
}

// ----------------------------------------------------------------------------
// Restricted-ACL variants — modern Keychain Services API via the keyring crate.
//
// `set_key_restricted` writes via SecItemAdd so the ACL is bound to the
// calling binary's code-signing identity. `get_key_restricted` reads via
// SecItemCopyMatching. When the calling binary IS in the item's ACL (same
// binary that wrote it), reads succeed without a prompt; when it is NOT (a
// different binary, including a future version of flow-rs signed differently),
// macOS pops the "flow-rs wants to use the keychain" dialog. There is no
// API-level way to suppress that prompt on macOS for unsigned binaries
// (kSecUseAuthenticationUISkip covers biometric/LAContext auth, NOT
// SecKeychain ACL prompts — verified empirically on macOS 14).
//
// To stay prompt-free in production, the CALLER must guarantee it never
// queries items it does not own. Electron does this via the `.flow-rs`
// account suffix (see electron/flow-rs-keychain.js::sodKeyAccount) which
// occupies a fresh (service, account) slot disjoint from any legacy keytar
// entry. Without that discipline, prompts will fire.
// ----------------------------------------------------------------------------

pub fn set_key_restricted(service: &str, name: &str, val: &str) -> Result<()> {
    Entry::new(service, name)?.set_password(val)?;
    Ok(())
}

pub fn get_key_restricted(service: &str, name: &str) -> Result<Option<String>> {
    let entry = Entry::new(service, name)?;
    match entry.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

// ----------------------------------------------------------------------------
// Non-macOS — fall through to the `keyring` crate (SecretService on Linux,
// Windows Credential Manager on Windows). Cross-app ACL semantics differ on
// those platforms; the modern API works for our use case there.
// ----------------------------------------------------------------------------

#[cfg(not(target_os = "macos"))]
pub fn set_key(service: &str, name: &str, val: &str) -> Result<()> {
    Entry::new(service, name)?.set_password(val)?;
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn get_key(service: &str, name: &str) -> Result<Option<String>> {
    let entry = Entry::new(service, name)?;
    match entry.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

#[cfg(not(target_os = "macos"))]
pub fn delete_key(service: &str, name: &str) -> Result<()> {
    match Entry::new(service, name)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}
