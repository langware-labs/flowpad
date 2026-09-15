const path = require("path");

const base = require("./electron-builder.json");
base.mac = base.mac || {};

// Custom sign function for macOS
base.mac.sign = path.resolve(__dirname, "signing/mac-sign.js");

// ---------------------------------------------------------------------------
// Windows signing. electron-builder's native Azure Artifact Signing integration
// (win.azureSignOptions, identity patched in by CI) signs every .exe/.dll/.node it
// packages, including extraResources such as the flow-rs.exe sidecar, elevate.exe,
// the NSIS uninstaller and the installer. signing/win-verify.js only VERIFIES.
//
// Two modes, chosen explicitly:
//   FLOWPAD_SIGNING=required  (set by CI)  — credentials and identity must be present,
//                                            signing + verification are mandatory, any
//                                            problem fails the build.
//   otherwise (local `npm run pack:win`)    — if credentials + identity happen to be
//                                            present, sign and verify exactly like CI;
//                                            if not, build UNSIGNED and say so loudly.
// ---------------------------------------------------------------------------
const winVerify = require("./signing/win-verify.js");
base.win = base.win || {};
if (process.env.FLOWPAD_STORE_BUILD === "1") {
  // -------------------------------------------------------------------------
  // Microsoft Store variant: an UNSIGNED .appx carrying the Partner Center
  // identity. The Store re-signs the package on ingestion, so Artifact Signing
  // and the verification gates are deliberately OFF here — signing it with our
  // certificate would stamp the wrong publisher and Partner Center would reject
  // it. Store users get desktop updates from the Store (electron-updater is
  // skipped in main.js when process.windowsStore is set); the PyPI package
  // update path is unchanged. Identity values come from CI repo variables;
  // a missing value fails the build, like the signing identity does.
  // -------------------------------------------------------------------------
  const missing = ["STORE_IDENTITY_NAME", "STORE_PUBLISHER"].filter(k => !process.env[k]);
  if (missing.length) {
    throw new Error(`[electron-builder.config] FLOWPAD_STORE_BUILD=1 but ${missing.join(", ")} not set (Partner Center → Product identity)`);
  }
  if (!/^CN=/.test(process.env.STORE_PUBLISHER)) {
    throw new Error('[electron-builder.config] STORE_PUBLISHER must be the Partner Center "Package/Identity/Publisher" value, e.g. CN=<GUID>');
  }
  base.win.target = [{ target: "appx", arch: ["x64"] }];
  delete base.win.azureSignOptions;
  base.appx = {
    identityName: process.env.STORE_IDENTITY_NAME,                                   // Package/Identity/Name
    publisher: process.env.STORE_PUBLISHER,                                          // Package/Identity/Publisher
    publisherDisplayName: process.env.STORE_PUBLISHER_DISPLAY_NAME || "Langware INC.",
    applicationId: "Flowpad",
    displayName: "Flowpad",
    backgroundColor: "#1b1b1f",
    showNameOnTiles: true,
    electronUpdaterAware: false,
    artifactName: "${productName}-${version}-store.${ext}",
  };
  // eslint-disable-next-line no-console
  console.log(`[electron-builder.config] Microsoft Store build: unsigned .appx, identity ${base.appx.identityName} / ${base.appx.publisher}`);
} else {
    const azure = base.win.azureSignOptions || {};
    const identityMissing = ["endpoint", "codeSigningAccountName", "certificateProfileName", "publisherName"].filter(k => !azure[k]);
    const credsMissing = ["AZURE_TENANT_ID", "AZURE_CLIENT_ID"].filter(k => !process.env[k]);
    if (!process.env.AZURE_CLIENT_SECRET && !process.env.AZURE_CLIENT_CERTIFICATE_PATH) credsMissing.push("AZURE_CLIENT_SECRET");
    const required = process.env.FLOWPAD_SIGNING === "required";

    if (required && (identityMissing.length || credsMissing.length)) {
      throw new Error(
        `[electron-builder.config] FLOWPAD_SIGNING=required but Windows signing is not configured: ` +
          [...identityMissing.map(k => `win.azureSignOptions.${k}`), ...credsMissing].join(", ")
      );
    }
    if (identityMissing.length || credsMissing.length) {
      // eslint-disable-next-line no-console
      console.warn(`[electron-builder.config] Windows build will be UNSIGNED (missing: ${[...identityMissing, ...credsMissing].join(", ")}). Set FLOWPAD_SIGNING=required to make this fatal.`);
      delete base.win.azureSignOptions;
    } else {
      base.afterPack = signSingleFileExtraResources;                 // flow-rs.exe (see below)
      base.afterSign = winVerify.afterSign;                          // win-unpacked, before NSIS
      base.artifactBuildCompleted = winVerify.artifactBuildCompleted; // Flowpad-Setup.exe + win-unpacked, report
    }
}

// electron-builder signs extraResources only when `from` is a DIRECTORY (the signing
// transformer is passed to copyDir; a single-file `from` goes through copyOrLinkFile with
// no transformer — app-builder-lib/out/fileMatcher.js, copyFiles). Our flow-rs.exe entry
// is a single file, so it arrives unsigned (confirmed on a real Windows build, 2026-09-07).
// Hand those files to electron-builder's OWN signer (WinPackager.signIf → the same Azure
// Artifact Signing manager NSIS uses for elevate.exe and the installer). afterPack runs
// before signApp, so each file is signed exactly once and the afterSign gate sees it.
async function signSingleFileExtraResources(context) {
  if (context.electronPlatformName !== "win32") return;
  const entries = (base.win.extraResources || []).filter(e => typeof e.to === "string" && /\.(exe|dll|node)$/i.test(e.to));
  for (const entry of entries) {
    const file = path.join(context.appOutDir, "resources", entry.to);
    // eslint-disable-next-line no-console
    console.log(`[electron-builder.config] signing single-file extraResource ${entry.to}`);
    const signed = await context.packager.signIf(file);
    if (!signed) throw new Error(`[electron-builder.config] electron-builder did not sign ${file}`);
  }
}

// Allow CI to override the version without modifying package.json — the
// flowpad-desktop build-desktop.yml workflow takes a `release_tag` input
// (e.g. `v0.9.1`) and creates the GitHub release at that tag, but does not
// bump electron/package.json. Without this override, electron-builder would
// package with the stale package.json version and electron-updater would see
// the same version as installed and skip the update.
//
// Set RELEASE_VERSION (or FLOWPAD_RELEASE_VERSION) in CI to the release tag.
// A leading "v" is stripped so `v0.9.1` → `0.9.1`.
// Launcher mode. CI sets FLOWPAD_LAUNCHER=1 once the pinned launcher exists (repo
// variable LAUNCHER_SHA256): the versioned NSIS installer then takes a versioned file
// name so that `Flowpad-Setup.exe` — the name the website links to — is free for the
// launcher, which every release re-attaches byte-identical (electron/signing/LAUNCHER.md).
// electron-updater reads the installer name from latest.yml, so existing installs keep
// updating unchanged. Without the flag nothing changes: the installer stays
// `Flowpad-Setup.exe` exactly as today.
if (process.env.FLOWPAD_LAUNCHER === "1") {
  base.nsis = base.nsis || {};
  base.nsis.artifactName = "${productName}-${version}-Setup.${ext}";
  // eslint-disable-next-line no-console
  console.log("[electron-builder.config] launcher mode: installer artifact is ${productName}-${version}-Setup.exe");
}

const overrideVersion = process.env.RELEASE_VERSION || process.env.FLOWPAD_RELEASE_VERSION;
if (overrideVersion) {
  const cleaned = overrideVersion.replace(/^v/, "");
  base.extraMetadata = base.extraMetadata || {};
  base.extraMetadata.version = cleaned;
  // eslint-disable-next-line no-console
  console.log(`[electron-builder.config] overriding version → ${cleaned} (from env)`);
}

module.exports = base;
