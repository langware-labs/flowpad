#!/usr/bin/env node
/**
 * Custom macOS sign function for electron-builder.
 *
 * Signs frameworks, helper apps, and Mach-O binaries within the .app bundle.
 * No backend directory to skip — the Python backend is installed at runtime via uv.
 */
/* eslint-disable no-console */
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

function runInherit(cmd, args) {
  execFileSync(cmd, args, { stdio: "inherit" });
}

function isMachO(filePath) {
  try {
    const buf = Buffer.alloc(4);
    const fd = fs.openSync(filePath, "r");
    fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);
    const magic = buf.readUInt32BE(0);
    return (
      magic === 0xfeedface || // MH_MAGIC
      magic === 0xfeedfacf || // MH_MAGIC_64
      magic === 0xcefaedfe || // MH_CIGAM
      magic === 0xcffaedfe || // MH_CIGAM_64
      magic === 0xcafebabe    // FAT_MAGIC (universal)
    );
  } catch {
    return false;
  }
}

/**
 * Walk the .app collecting signable items.
 * Returns arrays sorted deepest-first (required by codesign).
 */
function collectSignables(appPath) {
  const frameworks = [];
  const nestedApps = [];
  const binaries = [];

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);

      // Never follow symlinks during traversal
      if (entry.isSymbolicLink()) continue;

      if (entry.isDirectory()) {
        if (entry.name.endsWith(".framework")) {
          // Recurse to find internal binaries (must be signed before the bundle)
          walk(full);
          frameworks.push(full);
        } else if (entry.name.endsWith(".app")) {
          // Recurse into nested .app first (sign inner items before the bundle)
          walk(full);
          nestedApps.push(full);
        } else if (entry.name === "MacOS") {
          // Skip — main executables are signed with their parent .app bundle.
          continue;
        } else {
          walk(full);
        }
      } else if (entry.isFile() && isMachO(full)) {
        binaries.push(full);
      }
    }
  }

  walk(path.join(appPath, "Contents"));

  // Sort deepest paths first within each category
  const byDepth = (a, b) => b.split(path.sep).length - a.split(path.sep).length;
  binaries.sort(byDepth);
  frameworks.sort(byDepth);
  nestedApps.sort(byDepth);

  return { frameworks, nestedApps, binaries };
}

const MAX_SIGN_RETRIES = 3;

function stripXattrs(filePath) {
  try {
    const flag = fs.statSync(filePath).isDirectory() ? "-cr" : "-c";
    execFileSync("xattr", [flag, filePath], { stdio: "pipe" });
  } catch {
    // No xattrs or xattr unavailable
  }
}

function codesign(identity, entitlements, filePath) {
  const args = [
    "--force",
    "--timestamp",
    "--options", "runtime",
    "--sign", identity
  ];
  if (entitlements) {
    args.push("--entitlements", entitlements);
  }
  args.push(filePath);

  for (let attempt = 1; attempt <= MAX_SIGN_RETRIES; attempt++) {
    stripXattrs(filePath);
    if (attempt > 1) {
      try {
        execFileSync("codesign", ["--remove-signature", filePath], { stdio: "pipe" });
      } catch {
        // May not have a signature to remove
      }
      stripXattrs(filePath);
    }

    try {
      execFileSync("codesign", args, { stdio: ["pipe", "inherit", "pipe"] });
      return;
    } catch (err) {
      const stderr = err.stderr ? err.stderr.toString() : "";
      const retryable = stderr.includes("Operation not permitted") ||
                         stderr.includes("internal error");
      if (attempt < MAX_SIGN_RETRIES && retryable) {
        console.log(
          `[mac-sign] Retry ${attempt}/${MAX_SIGN_RETRIES} for ${path.basename(filePath)}: ` +
          `${stderr.trim().split("\n").pop()}`
        );
        execFileSync("sleep", ["1"], { stdio: "pipe" });
        continue;
      }
      // Final attempt: run with inherited stdio so the error is visible in logs
      try { runInherit("codesign", args); return; } catch { /* fall through */ }
      throw err;
    }
  }
}

/**
 * Resolve the absolute path to an entitlements plist.
 * electron-builder may pass a relative or absolute path.
 */
function resolveEntitlements(value, projectDir) {
  if (!value) return null;
  if (path.isAbsolute(value)) return value;
  const resolved = path.resolve(projectDir, value);
  if (fs.existsSync(resolved)) return resolved;
  return null;
}

/**
 * Try to find a "Developer ID Application" identity in the keychain.
 * Returns the identity string or null.
 */
function detectKeychainIdentity() {
  try {
    const out = execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const match = out.split("\n").find((l) => /"Developer ID Application:/.test(l));
    if (match) {
      const m = match.match(/"([^"]+)"/);
      if (m?.[1]) return m[1];
    }
  } catch {
    // keychain query failed
  }
  return null;
}

exports.default = async function customSign(opts, packager) {
  const appPath = opts.app;

  if (!appPath) {
    console.log("[mac-sign] No app path provided, skipping");
    return;
  }

  // Resolve identity: electron-builder opts -> CSC_NAME env -> keychain auto-detect -> ad-hoc
  let identity = opts.identity || null;
  if (!identity && process.env.CSC_NAME) {
    identity = process.env.CSC_NAME;
    console.log(`[mac-sign] Using identity from CSC_NAME env: ${identity}`);
  }
  if (!identity) {
    identity = detectKeychainIdentity();
    if (identity) {
      console.log(`[mac-sign] Auto-detected identity from keychain: ${identity}`);
    }
  }

  if (!identity) {
    // Ad-hoc sign so electron-builder's post-sign verification passes.
    console.log("[mac-sign] No identity — ad-hoc signing for local dev");
    const { frameworks: fws, nestedApps: apps, binaries: bins } = collectSignables(appPath);
    console.log(`[mac-sign] Ad-hoc: ${bins.length} binaries, ${fws.length} frameworks, ${apps.length} nested apps`);
    for (const f of [...bins, ...fws, ...apps]) {
      runInherit("codesign", ["--force", "--sign", "-", f]);
    }
    runInherit("codesign", ["--force", "--sign", "-", appPath]);
    console.log("[mac-sign] Ad-hoc signing done");
    return;
  }

  const projectDir = packager ? packager.projectDir : process.cwd();

  // Resolve entitlements — try opts first, then packager config
  const platformOpts = packager && packager.platformSpecificBuildOptions
    ? packager.platformSpecificBuildOptions
    : {};
  const entitlements = resolveEntitlements(
    opts.entitlements || platformOpts.entitlements,
    projectDir
  );
  const entitlementsInherit = resolveEntitlements(
    opts.entitlementsInherit || platformOpts.entitlementsInherit || opts.entitlements || platformOpts.entitlements,
    projectDir
  );

  console.log(`[mac-sign] App: ${appPath}`);
  console.log(`[mac-sign] Identity: ${identity}`);
  if (entitlements) console.log(`[mac-sign] Entitlements: ${entitlements}`);
  if (entitlementsInherit) console.log(`[mac-sign] EntitlementsInherit: ${entitlementsInherit}`);

  const { frameworks, nestedApps, binaries } = collectSignables(appPath);

  console.log(
    `[mac-sign] Found: ${binaries.length} binaries, ` +
    `${frameworks.length} frameworks, ${nestedApps.length} nested apps`
  );

  // 1. Sign individual binaries (deepest first)
  for (const bin of binaries) {
    console.log(`[mac-sign] Sign binary: ${path.relative(appPath, bin)}`);
    codesign(identity, entitlementsInherit, bin);
  }

  // 2. Sign framework bundles (deepest first)
  for (const fw of frameworks) {
    console.log(`[mac-sign] Sign framework: ${path.relative(appPath, fw)}`);
    codesign(identity, entitlementsInherit, fw);
  }

  // 3. Sign nested .app bundles (deepest first)
  for (const nested of nestedApps) {
    console.log(`[mac-sign] Sign nested app: ${path.relative(appPath, nested)}`);
    codesign(identity, entitlementsInherit, nested);
  }

  // 4. Sign the outer .app bundle (must be last)
  console.log(`[mac-sign] Sign outer app: ${appPath}`);
  codesign(identity, entitlements, appPath);

  // 5. Verify
  console.log(`[mac-sign] Verifying...`);
  try {
    runInherit("codesign", [
      "--verify", "--deep", "--strict", "--verbose=2", appPath
    ]);
    console.log(`[mac-sign] Verification passed`);
  } catch {
    console.warn(`[mac-sign] Verification reported issues (see output above)`);
  }

  console.log(`[mac-sign] Done`);
};
