#!/usr/bin/env node
/**
 * Build the `flow-rs` binary (release profile) for the current host
 * platform. Invoked as a prebuild step by `pack:mac` / `pack:win` /
 * `pack:linux` so electron-builder's extraResources entry has a binary
 * to bundle.
 *
 * macOS is the one place we cross-build: the Electron app ships as a single
 * universal (x64 + arm64) bundle, and @electron/universal only lipo-merges the
 * Mach-O files INSIDE the two per-arch app bundles. An extraResources sidecar
 * is copied in as-is, so `flow-rs` must already be a fat binary or one half of
 * the audience gets the wrong-arch executable. We build both apple-darwin
 * targets and `lipo -create` them into the same `target/release/flow-rs` path
 * the electron-builder config points at — mirroring
 * scripts/sign_flow_rs_macos.sh, which produces the vendored wheel copy.
 *
 * Windows/Linux stay a plain host-arch `cargo build --release`.
 *
 * Requires a rustup-installed Rust toolchain: `cargo` everywhere, plus
 * `rustup` on macOS to add the two apple-darwin targets.
 */
/* eslint-disable no-console */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const RUST_DIR = path.resolve(__dirname, '..', '..', 'flow_sdk', 'rust');
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const BIN_NAME = IS_WIN ? 'flow-rs.exe' : 'flow-rs';
const OUTPUT_BIN = path.join(RUST_DIR, 'target', 'release', BIN_NAME);

// Both halves of the macOS universal binary. Must match the targets used by
// scripts/sign_flow_rs_macos.sh so the desktop sidecar and the vendored wheel
// binary are built the same way.
const MAC_TARGETS = ['x86_64-apple-darwin', 'aarch64-apple-darwin'];

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
console.log(`[build-flow-rs] ${IS_MAC ? 'universal (x64 + arm64)' : 'host-arch'} release build  (cwd=${RUST_DIR})`);

// Prepend ~/.cargo/bin to PATH so the spawned cargo can find rustc/rustup
// even when this script's shell didn't inherit them.
const env = { ...process.env };
const cargoBinDir = path.join(os.homedir(), '.cargo', 'bin');
if (fs.existsSync(cargoBinDir) && !(env.PATH || '').includes(cargoBinDir)) {
  env.PATH = `${cargoBinDir}${path.delimiter}${env.PATH || ''}`;
}

function cargo(args) {
  execFileSync(cargoBin, args, { cwd: RUST_DIR, stdio: 'inherit', env });
}

function buildHostArch() {
  cargo(['build', '--release']);
}

function buildMacUniversal() {
  // rustup lives next to cargo in ~/.cargo/bin; the PATH prep above makes it
  // reachable. `target add` is idempotent, so always run it — a fresh CI
  // runner has only the host target installed.
  const rustupBin = path.join(path.dirname(cargoBin), 'rustup');
  const rustup = fs.existsSync(rustupBin) ? rustupBin : 'rustup';
  console.log(`[build-flow-rs] rustup target add ${MAC_TARGETS.join(' ')}`);
  execFileSync(rustup, ['target', 'add', ...MAC_TARGETS], { stdio: 'inherit', env });

  const slices = [];
  for (const target of MAC_TARGETS) {
    console.log(`[build-flow-rs] cargo build --release --bin flow-rs --target ${target}`);
    cargo(['build', '--release', '--bin', 'flow-rs', '--target', target]);
    const slice = path.join(RUST_DIR, 'target', target, 'release', BIN_NAME);
    if (!fs.existsSync(slice)) {
      throw new Error(`expected ${target} slice missing at ${slice}`);
    }
    slices.push(slice);
  }

  fs.mkdirSync(path.dirname(OUTPUT_BIN), { recursive: true });
  console.log(`[build-flow-rs] lipo -create -> ${OUTPUT_BIN}`);
  execFileSync('lipo', ['-create', '-output', OUTPUT_BIN, ...slices], { stdio: 'inherit' });
  execFileSync('lipo', ['-info', OUTPUT_BIN], { stdio: 'inherit' });
}

try {
  if (IS_MAC) {
    buildMacUniversal();
  } else {
    buildHostArch();
  }
} catch (err) {
  console.error(`[build-flow-rs] build failed: ${err.message}`);
  process.exit(1);
}

if (!fs.existsSync(OUTPUT_BIN)) {
  console.error(`[build-flow-rs] expected binary missing at ${OUTPUT_BIN}`);
  process.exit(1);
}

const sizeKB = (fs.statSync(OUTPUT_BIN).size / 1024).toFixed(1);
console.log(`[build-flow-rs] OK — ${OUTPUT_BIN} (${sizeKB} KB)`);
