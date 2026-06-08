// electron-builder `afterPack` hook — sign the bundled flow-rs sidecar on Windows.
//
// electron-builder's `azureSignOptions` signs the app exe, the NSIS installer,
// the uninstaller and elevate.exe — but NOT files brought in via `extraResources`.
// The flow-rs keychain helper (`resources/flow-rs/flow-rs.exe`) is an extraResource,
// so it would otherwise ship UNSIGNED inside an otherwise-signed installer. We sign
// it here, in the freshly-packed win-unpacked tree, before NSIS packages it.
//
// Uses the same Azure Trusted Signing identity (endpoint / account / profile) that
// the CI patches into signing/metadata.json, and the same AZURE_* service-principal
// credentials the Windows job already exports. Auth is via DefaultAzureCredential
// (EnvironmentCredential) inside Invoke-TrustedSigning.
//
// Skips cleanly (no error) when: not Windows, the sidecar is absent, the signing
// identity is unconfigured (empty metadata — local/dev builds), or Azure creds are
// missing — mirroring the workflow's "build unsigned rather than fail" stance.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

exports.default = async function signFlowRsWin(context) {
  if (context.electronPlatformName !== "win32") return;

  const exe = path.join(context.appOutDir, "resources", "flow-rs", "flow-rs.exe");
  if (!fs.existsSync(exe)) {
    console.log(`[sign-flow-rs] sidecar not found, skipping: ${exe}`);
    return;
  }

  // Read the Trusted Signing identity from the same metadata file CI patches.
  const metaPath = path.join(__dirname, "metadata.json");
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  const { Endpoint: endpoint, CodeSigningAccountName: account, CertificateProfileName: profile } = meta;

  if (!account || !profile) {
    console.log("[sign-flow-rs] signing identity not configured (empty account/profile) — leaving flow-rs.exe unsigned");
    return;
  }
  if (!process.env.AZURE_CLIENT_ID || !process.env.AZURE_TENANT_ID || !process.env.AZURE_CLIENT_SECRET) {
    console.log("[sign-flow-rs] AZURE_* credentials not set — leaving flow-rs.exe unsigned");
    return;
  }

  console.log(`[sign-flow-rs] signing ${exe} via Azure Trusted Signing (${account}/${profile})`);

  // Single-quote PS string literals; doubling any embedded apostrophe is enough
  // escaping (electron-builder paths won't contain them, but stay safe).
  const ps = (s) => `'${String(s).replace(/'/g, "''")}'`;
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
      `-Files ${ps(exe)}`,
      "-FileDigest SHA256",
      "-TimestampRfc3161 'http://timestamp.acs.microsoft.com'",
      "-TimestampDigest SHA256",
    ].join(" "),
  ].join("\n");

  execFileSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: "inherit" });
  console.log("[sign-flow-rs] flow-rs.exe signed");
};
