#!/usr/bin/env node
/**
 * Pre-commit gate: every file under electron/ must be accounted for in
 * electron-builder.json's `files` list.
 *
 * `files` is a whitelist (positive globs) with `!` exclusions. A file that
 * matches a positive pattern is packaged; one that matches a `!` pattern was
 * deliberately kept out of the app bundle. A file that matches NEITHER is the
 * bug this hook exists to catch: a new module dropped into electron/ that will
 * silently be missing from the built desktop app (electron-builder does not
 * warn — the packaged main.js just fails to `require` it at runtime).
 *
 * The JSON is the single source of truth. To fix a failure, either add the
 * file to `files` (it ships inside the app) or add a `!` pattern for it (it is
 * build tooling / tests / resources that never ship inside the asar).
 *
 * Matching uses the same `minimatch` package and options as electron-builder's
 * own FileMatcher (app-builder-lib/out/fileMatcher.js): `{ dot: true }`, plus
 * its directory expansion — a pattern with no "." and no glob magic also
 * matches `<pattern>/**\/*` (electron-builder issue #545).
 *
 * Usage:
 *   node scripts/check-electron-builder-files.js [electron/path ...]
 *
 * With paths (what pre-commit passes) only those are checked; with none, every
 * git-tracked file under electron/ is checked — handy for CI or a manual sweep.
 * Paths are repo-relative. Non-electron paths are ignored so the hook is safe
 * to run on a mixed file list. Exit 1 on any unaccounted file.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "..");
const ELECTRON_DIR = path.join(REPO_ROOT, "electron");
const CONFIG = path.join(ELECTRON_DIR, "electron-builder.json");

// Under pre-commit (`language: node`) minimatch comes from the hook's own env
// via additional_dependencies. When run by hand, fall back to the copy
// electron-builder itself depends on in electron/node_modules.
function loadMinimatch() {
  try {
    return require("minimatch");
  } catch {
    return require(path.join(ELECTRON_DIR, "node_modules", "minimatch"));
  }
}
const { Minimatch } = loadMinimatch();

// Same options electron-builder passes to Minimatch.
const MINIMATCH_OPTIONS = { dot: true };

// electron-builder's own implicit rules (app-builder-lib fileMatcher):
// package.json is always packaged, and these names are always ignored,
// regardless of what `files` says. Listed here so nobody has to add
// `!package-lock.json` to the JSON to make the gate pass.
const IMPLICIT_PATTERNS = [
  "package.json",
  "!package-lock.json",
  "!yarn.lock",
  "!.gitignore",
  "!.gitattributes",
  "!.editorconfig",
  "!.npmignore",
  "!node_modules/**",
  "!.idea/**",
  "!.vscode/**",
  "!.DS_Store",
  "!thumbs.db",
];

/** @returns {{ raw: string, matchers: import("minimatch").Minimatch[] }[]} */
function loadPatterns() {
  const files = JSON.parse(fs.readFileSync(CONFIG, "utf8")).files;
  return [...IMPLICIT_PATTERNS, ...files].map((raw) => {
    const body = raw.startsWith("!") ? raw.slice(1) : raw;
    const parsed = new Minimatch(body, MINIMATCH_OPTIONS);
    const matchers = [parsed];
    // Mirror electron-builder's directory expansion (fileMatcher.js).
    if (!body.includes(".") && !parsed.hasMagic()) {
      matchers.push(new Minimatch(`${body}/**/*`, MINIMATCH_OPTIONS));
    }
    return { raw, matchers };
  });
}

/** The raw pattern that accounts for `rel`, or null. */
function classify(rel, patterns) {
  for (const { raw, matchers } of patterns) {
    if (matchers.some((m) => m.match(rel))) return raw;
  }
  return null;
}

function trackedElectronFiles() {
  const out = execFileSync("git", ["ls-files", "--", "electron"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return out.split(/\r?\n/).filter(Boolean);
}

/** Repo-relative (or absolute) path -> POSIX path relative to electron/, or null. */
function toElectronRelative(p) {
  // git and pre-commit emit forward slashes on every OS; tolerate a
  // backslash path typed by hand in a Windows shell.
  const abs = path.resolve(REPO_ROOT, p.replace(/\\/g, "/"));
  const rel = path.relative(ELECTRON_DIR, abs);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}

function main(argv) {
  const candidates = argv.length ? argv : trackedElectronFiles();
  const patterns = loadPatterns();

  const unaccounted = [];
  for (const p of candidates) {
    const rel = toElectronRelative(p);
    if (rel === null) continue;
    if (classify(rel, patterns) === null) unaccounted.push(rel);
  }

  if (unaccounted.length === 0) return 0;

  const lines = [
    "electron-builder.json `files` does not account for these files under electron/:",
    ...unaccounted.map((rel) => `  electron/${rel}`),
    "",
    "Each must match a pattern in electron/electron-builder.json `files`:",
    "  - add the path if it ships inside the app (main-process modules, renderer assets), or",
    "  - add a `!<pattern>` exclusion if it is build tooling, a test, or a resource packaged another way.",
  ];
  process.stderr.write(lines.join("\n") + "\n");
  return 1;
}

process.exitCode = main(process.argv.slice(2));
