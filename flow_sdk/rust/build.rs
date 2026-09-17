//! Build script: embed the Windows version resource + icon into `flowpad-install.exe`
//! ONLY (not flow-rs.exe, not the Python extension) and only when the TARGET is
//! Windows. Never fatal: without a resource compiler (e.g. `cargo check` for the
//! Windows target from macOS) the resource is skipped with a warning — the launcher
//! still works, it merely lacks version info.
fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=resources/flowpad-install.rc");
    println!("cargo:rerun-if-changed=../../electron/resources/icons/icon.ico");
    if std::env::var("CARGO_CFG_WINDOWS").is_err() {
        return;
    }
    let result = embed_resource::compile_for("resources/flowpad-install.rc", &["flowpad-install"], embed_resource::NONE);
    if let Err(e) = result.manifest_optional() {
        println!("cargo:warning=flowpad-install: version resource not embedded ({e})");
    }
}
