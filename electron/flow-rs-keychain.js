// Thin wrapper around the bundled `flow-rs` binary. Replaces `keytar` as the
// OS-credential-store interface from the Electron main process.
//
// Architecture (per FLOWPAD-1862 design):
//
//   Electron main process
//      └─ execFile(flow-rs set_key_restricted | get_key_restricted)
//             └─ flow-rs binary (signed Mach-O, Langware Developer ID)
//                   └─ modern Keychain Services API
//                         └─ OS credential store
//
// The whole point of routing through flow-rs is that flow-rs is a signed
// binary — when it calls SecItemAdd to create the sod-key entry, that
// entry's ACL trust list shows `flow-rs` (Langware-signed), not the
// unsigned uv-bundled `python3.x`. Reads from the same flow-rs binary
// are silent (ACL match); reads from any OTHER binary trigger the
// "X wants to use the keychain" prompt.
//
// Binary location:
//   * Packaged app: process.resourcesPath/flow-rs/flow-rs[.exe]
//                   (declared via electron-builder `extraResources`;
//                   auto-signed by signing/mac-sign.js because the file is
//                   under Contents/Resources/ of the .app bundle).
//   * Dev:          ../flow_sdk/rust/target/release/flow-rs[.exe]
//                   (built by `node scripts/build-flow-rs.js`).
//
// Error semantics — `flow-rs get_key_restricted`:
//   * exit 0 + stdout → return the value
//   * exit 1          → key absent, return null
//   * other non-zero  → throw
// `set_key_restricted`: any non-zero throws.

'use strict';

const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const log = require('electron-log');

const IS_WIN = process.platform === 'win32';
const BIN_NAME = IS_WIN ? 'flow-rs.exe' : 'flow-rs';

let _cachedBinPath = null;

/**
 * Resolve the flow-rs binary path. Cached after first successful resolution.
 *
 * Packaged: <Resources>/flow-rs/flow-rs   (electron-builder extraResources)
 * Dev:      <repo>/flow_sdk/rust/target/release/flow-rs
 */
function flowRsBinaryPath() {
  if (_cachedBinPath) return _cachedBinPath;

  const candidates = [];
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'flow-rs', BIN_NAME));
  }
  candidates.push(
    path.resolve(__dirname, '..', 'flow_sdk', 'rust', 'target', 'release', BIN_NAME)
  );

  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      _cachedBinPath = candidate;
      log.info(`[flow-rs] binary resolved: ${candidate}`);
      return candidate;
    } catch {
      // try the next candidate
    }
  }

  throw new Error(
    `flow-rs binary not found. Looked in: ${candidates.join(', ')}. ` +
    `In dev, run \`node electron/scripts/build-flow-rs.js\` first; ` +
    `in production, the binary should be bundled via electron-builder extraResources.`
  );
}

/**
 * Run flow-rs with the given args, returning { stdout, stderr, code }.
 * Non-zero exit codes do NOT throw here — the caller distinguishes
 * "absent" (exit 1) from "error" (other non-zero).
 */
function runFlowRs(args) {
  const bin = flowRsBinaryPath();
  return new Promise((resolve, reject) => {
    execFile(bin, args, { encoding: 'utf-8' }, (err, stdout, stderr) => {
      if (err) {
        if (typeof err.code === 'number') {
          resolve({ stdout, stderr, code: err.code });
          return;
        }
        reject(err);
        return;
      }
      resolve({ stdout, stderr, code: 0 });
    });
  });
}

async function getKeyRestricted(service, account) {
  const { stdout, stderr, code } = await runFlowRs(['get_key_restricted', service, account]);
  if (code === 0) return stdout;
  if (code === 1) return null;
  throw new Error(`flow-rs get_key_restricted exit ${code}: ${stderr || stdout}`);
}

async function setKeyRestricted(service, account, value) {
  const { stderr, code } = await runFlowRs(['set_key_restricted', service, account, value]);
  if (code !== 0) {
    throw new Error(`flow-rs set_key_restricted exit ${code}: ${stderr}`);
  }
}

/**
 * Build the keychain account name Electron uses for the per-instance
 * sod-key. We deliberately suffix the FLOW_INSTANCE name with `.flow-rs`
 * so the flow-rs-owned entry occupies a different `(service, account)`
 * slot than any pre-existing entry at the bare-`<instance>` account
 * (which could be a stale keytar entry from older Flowpad versions, or
 * a python3.x-owned entry from a CLI-only path).
 *
 * Why the suffix is required for a prompt-free flow:
 *   * The flow-rs binary signs its sod-key entry with its own code-signing
 *     identity. If a pre-existing entry sits at the same (service, account),
 *     SecItemAdd returns errSecDuplicateItem, the keyring crate falls
 *     through to SecItemUpdate, and SecItemUpdate would pop a
 *     "flow-rs wants to use the keychain" prompt (ACL mismatch with the
 *     prior owner).
 *   * By writing to a fresh account slot, SecItemAdd succeeds outright
 *     and there is no ACL conflict to resolve.
 *
 * Trade-off: if a stale entry exists at the bare-`<instance>` slot, it
 * stays orphaned (harmless — never read by Electron-driven launches).
 */
function sodKeyAccount() {
  return `${process.env.FLOW_INSTANCE || 'prod'}.flow-rs`;
}

module.exports = {
  sodKeyAccount,
  getKeyRestricted,
  setKeyRestricted,
};
