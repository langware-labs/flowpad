// Thin wrapper around the bundled `flow-rs` binary. Replaces `keytar` as the
// OS-credential-store interface from the Electron main process.
//
// Architecture (per FLOWPAD-1862 design):
//
//   Electron main process
//      └─ execFile(flow-rs set_key_restricted | get_key_restricted)
//             └─ flow-rs binary
//                   └─ modern Keychain Services API
//                         └─ OS credential store
//
// Only the restrictive-ACL surface is wrapped here — that is what the sod-key
// flow uses and what keytar's security posture required. The flow-rs CLI also
// supports a permissive `-A` legacy path (`set_key` / `get_key`), but no
// Electron code path needs it, so we don't expose it on this wrapper.
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
 *
 * Throws if neither location has the binary so the caller can fail fast with
 * a clear message instead of getting an opaque ENOENT later.
 */
function flowRsBinaryPath() {
  if (_cachedBinPath) return _cachedBinPath;

  const candidates = [];
  // process.resourcesPath is defined when running inside a packaged Electron
  // app. In `npm run dev:electron` it points at the electron framework's
  // own resources/ dir, so we still try the repo dev path as a fallback.
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
 * Run flow-rs with the given args, returning { stdout, code }. Non-zero exit
 * codes do NOT throw here — the caller distinguishes "absent" (exit 1) from
 * "error" (other non-zero).
 */
function runFlowRs(args) {
  const bin = flowRsBinaryPath();
  return new Promise((resolve, reject) => {
    execFile(bin, args, { encoding: 'utf-8' }, (err, stdout, stderr) => {
      if (err) {
        // err.code is the exit code; err.signal is the signal if killed.
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
 * sod-key. Matches the account convention in
 * flow_sdk/instance_settings/base_settings.py:_fetch_or_create_sod_key
 * (account = instance name, no suffix) so Electron's flow-rs path and
 * Python's keyring path address the exact same `(service, account)` slot.
 */
function sodKeyAccount() {
  return process.env.FLOW_INSTANCE || 'prod';
}

module.exports = {
  sodKeyAccount,
  getKeyRestricted,
  setKeyRestricted,
};
