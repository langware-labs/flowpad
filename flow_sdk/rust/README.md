# flow_rs

OS-keychain helper, self-contained Rust crate under `flow_sdk/rust/`. Backed by
the [`keyring`](https://crates.io/crates/keyring) crate, which uses the same
underlying OS credential stores as Python's `keyring` library — so entries are
**interchangeable** between Python and Rust.

Three surfaces over one implementation (`src/keychain.rs`):

| Surface | Used as |
|---|---|
| Rust library `flow_rs` | `flow_rs::rust_get_key(service, name)` / `rust_set_key(service, name, val)` |
| `flow-rs` CLI binary  | `flow-rs get_key <service> <name>` / `flow-rs set_key <service> <name> <val>` |
| Python module (pyo3)  | `import flow_rs; flow_rs.get_key(service, name); flow_rs.set_key(service, name, val)` |

Each surface offers two ACL modes — `*_key` (permissive, written with the
legacy `security -A` flag so any local app can read without a prompt) and
`*_key_restricted` (modern Keychain Services API, ACL bound to the calling
binary's code-signing identity, matching keytar's posture). See the
[macOS implementation note](#macos-implementation-note) for which to use.

## Local dev

```bash
cd flow_sdk/rust

# build lib + CLI
cargo build --release

# Rust unit tests (round-trip against the real OS keychain)
cargo test

# build the Python extension into the active venv
uv run maturin develop --features python

# 3x3 interchange matrix (writers x readers) — requires the binary AND the
# pyo3 module to be built first. Deliberately run from this directory so the
# repo-root tests/conftest.py (which installs an in-memory keyring backend) is
# not loaded.
uv run pytest tests/interchange.py -v
```

## API

```rust
// Rust
flow_rs::rust_get_key(service: &str, name: &str) -> anyhow::Result<Option<String>>;
flow_rs::rust_set_key(service: &str, name: &str, val: &str) -> anyhow::Result<()>;
flow_rs::rust_get_key_restricted(service: &str, name: &str) -> anyhow::Result<Option<String>>;
flow_rs::rust_set_key_restricted(service: &str, name: &str, val: &str) -> anyhow::Result<()>;
flow_rs::rust_delete_key(service: &str, name: &str) -> anyhow::Result<()>;
```

```python
# Python
flow_rs.get_key(service: str, name: str) -> str | None
flow_rs.set_key(service: str, name: str, val: str) -> None
flow_rs.get_key_restricted(service: str, name: str) -> str | None
flow_rs.set_key_restricted(service: str, name: str, val: str) -> None
flow_rs.delete_key(service: str, name: str) -> None
```

```
# CLI
flow-rs get_key             <service> <name>          # permissive read;  exit 1 if absent
flow-rs set_key             <service> <name> <val>    # permissive write (-A)
flow-rs get_key_restricted  <service> <name>          # restrictive read; exit 1 if absent
flow-rs set_key_restricted  <service> <name> <val>    # restrictive write (modern API)
flow-rs delete_key          <service> <name>          # no-op if absent
```

Service+name semantics match `keyring.get_password(service, name)` /
`set_password(service, name, val)` exactly.

## macOS implementation note

On macOS, `keychain.rs` carries two independent code paths, one per ACL mode:

**Permissive (`set_key` / `get_key` / `delete_key`)** shells out to
`/usr/bin/security` (the legacy SecKeychain CLI) with `-A` on writes. The
resulting items have an open access control list — any binary can read them
via the legacy API without a Keychain prompt. The 3×3 interchange matrix
uses this path on all three surfaces to stay prompt-free in tests and CI.

**Restrictive (`set_key_restricted` / `get_key_restricted`)** goes through
the `keyring` crate's modern Keychain Services API (`SecItemAdd` /
`SecItemCopyMatching`). The resulting items have ACL bound to the writing
binary's code-signing identity, matching keytar's posture — only the same
binary can read without a `SecurityAgent` prompt. Electron uses this path
for the sod-key.

There is no API-level way for two unsigned binaries to share modern-API
keychain items on macOS without a prompt (`kSecUseAuthenticationUISkip`
covers biometric/LAContext auth only — verified empirically). The
restrictive path therefore requires the caller to never query items it
does not own. Electron enforces this via a `.flow-rs` account suffix
(`electron/flow-rs-keychain.js::sodKeyAccount`) so the flow-rs entry lives
in a slot disjoint from any pre-FLOWPAD-1862 keytar entry.

Linux (Secret Service) and Windows (Credential Manager) don't have the
same unsigned-binary prompt issue; the non-macOS paths use the `keyring`
crate's native backends for both modes.
