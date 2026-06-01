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
const { execFileSync } = require('child_process');

const RUST_DIR = path.resolve(__dirname, '..', '..', 'flow_sdk', 'rust');
const IS_WIN = process.platform === 'win32';
const BIN_NAME = IS_WIN ? 'flow-rs.exe' : 'flow-rs';
const OUTPUT_BIN = path.join(RUST_DIR, 'target', 'release', BIN_NAME);

if (!fs.existsSync(path.join(RUST_DIR, 'Cargo.toml'))) {
  console.error(`[build-flow-rs] Cargo.toml not found at ${RUST_DIR}`);
  process.exit(1);
}

console.log(`[build-flow-rs] cargo build --release  (cwd=${RUST_DIR})`);

try {
  execFileSync('cargo', ['build', '--release'], {
    cwd: RUST_DIR,
    stdio: 'inherit',
  });
} catch (err) {
  console.error(`[build-flow-rs] cargo build failed: ${err.message}`);
  console.error(
    '[build-flow-rs] Ensure the Rust toolchain is installed: ' +
    'curl --proto \'=https\' --tlsv1.2 -sSf https://sh.rustup.rs | sh'
  );
  process.exit(1);
}

if (!fs.existsSync(OUTPUT_BIN)) {
  console.error(`[build-flow-rs] expected binary missing at ${OUTPUT_BIN}`);
  process.exit(1);
}

const sizeKB = (fs.statSync(OUTPUT_BIN).size / 1024).toFixed(1);
console.log(`[build-flow-rs] OK — ${OUTPUT_BIN} (${sizeKB} KB)`);
