#!/usr/bin/env node
/**
 * Build the `flow-rs` binary (release profile) for the current host
 * platform. Invoked as a prebuild step by `pack:mac` / `pack:win` /
 * `pack:linux` so electron-builder's extraResources entry has a binary
 * to bundle.
 *
 * Cross-compilation is intentionally out of scope here — see
 * flow_sdk/rust/README.md. A dedicated Rust release workflow is the
 * follow-up once we have multi-platform builds.
 *
 * Requires `cargo` on PATH (rustup-installed Rust toolchain).
 */
/* eslint-disable no-console */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const RUST_DIR = path.resolve(__dirname, '..', '..', 'flow_sdk', 'rust');
const IS_WIN = process.platform === 'win32';
const BIN_NAME = IS_WIN ? 'flow-rs.exe' : 'flow-rs';
const OUTPUT_BIN = path.join(RUST_DIR, 'target', 'release', BIN_NAME);

if (!fs.existsSync(path.join(RUST_DIR, 'Cargo.toml'))) {
  console.error(`[build-flow-rs] Cargo.toml not found at ${RUST_DIR}`);
  process.exit(1);
}

/**
 * Resolve a usable `cargo` binary. npm-spawned scripts don't always inherit
 * the interactive shell's PATH, so a bare `cargo` lookup via PATH often hits
 * ENOENT even when rustup has cargo installed. Probe the standard rustup
 * location (~/.cargo/bin) as a fallback, and allow an explicit override via
 * the CARGO env var.
 */
function resolveCargo() {
  const cargoExe = IS_WIN ? 'cargo.exe' : 'cargo';
  const candidates = [];
  if (process.env.CARGO) candidates.push(process.env.CARGO);
  candidates.push(cargoExe); // bare name → relies on PATH
  candidates.push(path.join(os.homedir(), '.cargo', 'bin', cargoExe));
  if (!IS_WIN) {
    candidates.push('/usr/local/cargo/bin/cargo'); // some CI installs
    candidates.push('/opt/homebrew/bin/cargo');    // brew on Apple Silicon
    candidates.push('/usr/local/bin/cargo');       // brew on Intel macOS / Linux
  }

  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore' });
      return candidate;
    } catch {
      // try the next one
    }
  }
  return null;
}

const cargoBin = resolveCargo();
if (!cargoBin) {
  console.error('[build-flow-rs] cargo not found on PATH or in ~/.cargo/bin.');
  console.error(
    '[build-flow-rs] Install the Rust toolchain: ' +
    'curl --proto \'=https\' --tlsv1.2 -sSf https://sh.rustup.rs | sh ' +
    '(then open a new shell so ~/.cargo/bin is on PATH, ' +
    'or set CARGO=/full/path/to/cargo and re-run).'
  );
  process.exit(1);
}

console.log(`[build-flow-rs] using ${cargoBin}`);
console.log(`[build-flow-rs] cargo build --release  (cwd=${RUST_DIR})`);

// Prepend ~/.cargo/bin to PATH so the spawned cargo can find rustc/rustup
// even when this script's shell didn't inherit them.
const env = { ...process.env };
const cargoBinDir = path.join(os.homedir(), '.cargo', 'bin');
if (fs.existsSync(cargoBinDir) && !(env.PATH || '').includes(cargoBinDir)) {
  env.PATH = `${cargoBinDir}${path.delimiter}${env.PATH || ''}`;
}

try {
  execFileSync(cargoBin, ['build', '--release'], {
    cwd: RUST_DIR,
    stdio: 'inherit',
    env,
  });
} catch (err) {
  console.error(`[build-flow-rs] cargo build failed: ${err.message}`);
  process.exit(1);
}

if (!fs.existsSync(OUTPUT_BIN)) {
  console.error(`[build-flow-rs] expected binary missing at ${OUTPUT_BIN}`);
  process.exit(1);
}

const sizeKB = (fs.statSync(OUTPUT_BIN).size / 1024).toFixed(1);
console.log(`[build-flow-rs] OK — ${OUTPUT_BIN} (${sizeKB} KB)`);
