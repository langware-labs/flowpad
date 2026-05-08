const path = require("path");

const base = require("./electron-builder.json");
base.mac = base.mac || {};

// Custom sign function for macOS
base.mac.sign = path.resolve(__dirname, "signing/mac-sign.js");

// Allow CI to override the version without modifying package.json — the
// flowpad-desktop build-desktop.yml workflow takes a `release_tag` input
// (e.g. `v0.9.1`) and creates the GitHub release at that tag, but does not
// bump electron/package.json. Without this override, electron-builder would
// package with the stale package.json version and electron-updater would see
// the same version as installed and skip the update.
//
// Set RELEASE_VERSION (or FLOWPAD_RELEASE_VERSION) in CI to the release tag.
// A leading "v" is stripped so `v0.9.1` → `0.9.1`.
const overrideVersion = process.env.RELEASE_VERSION || process.env.FLOWPAD_RELEASE_VERSION;
if (overrideVersion) {
  const cleaned = overrideVersion.replace(/^v/, "");
  base.extraMetadata = base.extraMetadata || {};
  base.extraMetadata.version = cleaned;
  // eslint-disable-next-line no-console
  console.log(`[electron-builder.config] overriding version → ${cleaned} (from env)`);
}

module.exports = base;
