// electron-builder `afterPack` hook — sign the bundled Windows extraResource
// executables that azureSignOptions does NOT cover: flow-rs.exe and, when a
// PyInstaller-frozen backend blob is bundled, flowpad-backend.exe.
//
// electron-builder's `azureSignOptions` signs the app exe, the NSIS installer,
// the uninstaller and elevate.exe — but NOT files brought in via `extraResources`.
// Those would otherwise ship UNSIGNED inside an otherwise-signed installer. We
// sign them here, in the freshly-packed win-unpacked tree, before NSIS packages it.
//
// Uses the same Azure Trusted Signing identity (endpoint / account / profile) the
// CI patches into signing/metadata.json, and the same AZURE_* service-principal
// credentials the Windows job already exports.
//
// Skips cleanly (no error) when: not Windows, no extraResource exes present, the
// signing identity is unconfigured (empty metadata — local/dev builds), or Azure
// creds are missing — mirroring the workflow's "build unsigned rather than fail".

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

exports.default = async function signWinExtras(context) {
  if (context.electronPlatformName !== "win32") return;

  // extraResource exes that ship unsigned unless signed here. flowpad-backend.exe
  // is present only when the frozen-backend blob is bundled (see blob-manager.js).
  const candidates = [
    path.join(context.appOutDir, "resources", "flow-rs", "flow-rs.exe"),
    path.join(context.appOutDir, "resources", "flowpad-backend", "flowpad-backend.exe"),
  ];
  const files = candidates.filter((f) => fs.existsSync(f));
  if (files.length === 0) {
    console.log("[sign-win-extras] no extraResource exes found, skipping");
    return;
  }

  // Read the Trusted Signing identity from the same metadata file CI patches.
  const meta = JSON.parse(fs.readFileSync(path.join(__dirname, "metadata.json"), "utf8"));
  const { Endpoint: endpoint, CodeSigningAccountName: account, CertificateProfileName: profile } = meta;

  if (!account || !profile) {
    console.log("[sign-win-extras] signing identity not configured (empty account/profile) — leaving unsigned");
    return;
  }
  if (!process.env.AZURE_CLIENT_ID || !process.env.AZURE_TENANT_ID || !process.env.AZURE_CLIENT_SECRET) {
    console.log("[sign-win-extras] AZURE_* credentials not set — leaving unsigned");
    return;
  }

  // Single-quote PS string literals; double any embedded apostrophe.
  const ps = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const fileList = files.map(ps).join(", ");   // Invoke-TrustedSigning -Files takes an array
  const script = [
    "$ErrorActionPreference = 'Stop'",
    // electron-builder installs this module for its own signing, but afterPack runs
    // before that — ensure it's present so we don't depend on call ordering.
    "if (-not (Get-Module -ListAvailable -Name TrustedSigning)) {",
    "  Install-Module -Name TrustedSigning -Force -Scope CurrentUser -AllowClobber | Out-Null",
    "}",
    "Import-Module TrustedSigning",
    [
      "Invoke-TrustedSigning",
      `-Endpoint ${ps(endpoint)}`,
      `-CodeSigningAccountName ${ps(account)}`,
      `-CertificateProfileName ${ps(profile)}`,
      `-Files ${fileList}`,
      "-FileDigest SHA256",
      "-TimestampRfc3161 'http://timestamp.acs.microsoft.com'",
      "-TimestampDigest SHA256",
    ].join(" "),
  ].join("\n");

  console.log(`[sign-win-extras] signing ${files.length} file(s) via Azure Trusted Signing (${account}/${profile})`);
  execFileSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: "inherit" });
  console.log("[sign-win-extras] signed:", files.join(", "));
};
