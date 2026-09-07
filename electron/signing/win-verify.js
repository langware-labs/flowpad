// Windows signature verification gate + signing report. VERIFICATION ONLY — signing is
// electron-builder's job (win.azureSignOptions → Invoke-TrustedSigning).
//
// Three entry points, one policy:
//
//   afterSign(context)              electron-builder hook. Fires after electron-builder has
//                                   signed win-unpacked and before NSIS runs. Verifies the tree.
//                                   Note: resources/elevate.exe does not exist yet at this point
//                                   (NSIS copies + signs it while packing), so the tree is checked
//                                   again below.
//   artifactBuildCompleted(event)   electron-builder hook. Fires per artifact after NSIS has
//                                   built AND signed it. For the Windows .exe installer: verifies
//                                   the installer, re-verifies win-unpacked (now complete), and
//                                   writes the signing report.
//   CLI: node signing/win-verify.js <releaseDir> --publisher "<CN>"
//                                   Independent re-check used by CI after the build: installer(s)
//                                   in <releaseDir> + everything under <releaseDir>/win-unpacked.
//                                   Exit 1 on any failure.
//
// Policy (see WINDOWS-SIGNING.md):
//   every *.exe / *.dll / *.node must carry an Authenticode signature whose status is Valid
//   (chain validates) AND an RFC 3161 timestamp;
//   binaries WE produce (Flowpad.exe, flow-rs.exe, elevate.exe, uninstaller, installer, *.node)
//   must be issued to the expected publisher;
//   any other binary is accepted with a Valid signature from another publisher ("upstream");
//   an unsigned binary is always a failure.
//
// Verification uses Windows' own Get-AuthenticodeSignature (WinVerifyTrust) — no signtool
// discovery, no certificate parsing of our own. Nothing here retries or times out.

"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const TAG = "[win-verify]";
const CHECKED_EXTENSIONS = new Set([".exe", ".dll", ".node"]);
// File names that must be signed by US (case-insensitive). Everything else may carry a valid
// upstream signature instead. `.node` files are always ours (see isOurs).
const OUR_BINARIES = new Set(["flowpad.exe", "flow-rs.exe", "elevate.exe"]);

class VerifyError extends Error {}

const log = m => console.log(`${TAG} ${m}`); // eslint-disable-line no-console

function isOurs(file) {
  const name = path.basename(file).toLowerCase();
  if (OUR_BINARIES.has(name)) return true;
  if (name.endsWith(".node")) return true;
  if (/^uninstall.*\.exe$/.test(name)) return true;
  if (/-setup\.exe$/.test(name) || /setup.*\.exe$/.test(name)) return true; // NSIS installer artifact
  return false;
}

function commonName(subject) {
  const m = /(?:^|,\s*)CN=("([^"]*)"|[^,]*)/.exec(subject || "");
  return m ? (m[2] != null ? m[2] : m[1]).trim() : null;
}

async function walk(dir, out = []) {
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(p, out);
    else if (entry.isFile() && CHECKED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) out.push(p);
  }
  return out;
}

/**
 * Which PowerShell to run. Prefer pwsh.exe (electron-builder's Azure signing already
 * requires it). Fall back to Windows PowerShell 5.1 with a PSModulePath restricted to its
 * own module directories: when node runs under a pwsh 7 parent (GitHub's default `pwsh`
 * shell, SSH sessions) the inherited PSModulePath lists pwsh 7's modules first and 5.1 then
 * fails to load pwsh 7's Microsoft.PowerShell.Security ("command was found in the module
 * ... but the module could not be loaded"), taking Get-AuthenticodeSignature with it.
 */
let powershellPromise = null;
function powershell() {
  if (!powershellPromise) {
    powershellPromise = new Promise(resolve => {
      execFile("pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.Major"], { windowsHide: true }, error => {
        if (!error) return resolve({ exe: "pwsh.exe", env: process.env });
        const systemRoot = process.env.SystemRoot || "C:\\Windows";
        const programFiles = process.env.ProgramFiles || "C:\\Program Files";
        resolve({
          exe: "powershell.exe",
          env: {
            ...process.env,
            PSModulePath: [path.join(programFiles, "WindowsPowerShell", "Modules"), path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "Modules")].join(";"),
          },
        });
      });
    });
  }
  return powershellPromise;
}

/** One PowerShell call for all files → [{path,status,statusMessage,subject,issuer,thumbprint,notBefore,notAfter,tsa,sha256}]. */
async function inspect(files) {
  if (process.platform !== "win32") throw new VerifyError("Authenticode verification needs a Windows host");
  if (!files.length) return [];
  const listFile = path.join(os.tmpdir(), `win-verify-${process.pid}-${Date.now()}.txt`);
  await fsp.writeFile(listFile, files.join("\r\n"), "utf8");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$sha = [System.Security.Cryptography.SHA256]::Create()",
    `$rows = @(Get-Content -LiteralPath '${listFile.replace(/'/g, "''")}' | Where-Object { $_ } | ForEach-Object {`,
    "  $s = Get-AuthenticodeSignature -LiteralPath $_",
    "  $fs = [System.IO.File]::OpenRead($_); try { $hash = ($sha.ComputeHash($fs) | ForEach-Object { $_.ToString('X2') }) -join '' } finally { $fs.Dispose() }",
    "  [pscustomobject]@{",
    "    path = $_",
    "    status = [string]$s.Status",
    "    statusMessage = [string]$s.StatusMessage",
    "    subject = if ($s.SignerCertificate) { $s.SignerCertificate.Subject } else { $null }",
    "    issuer = if ($s.SignerCertificate) { $s.SignerCertificate.Issuer } else { $null }",
    "    thumbprint = if ($s.SignerCertificate) { $s.SignerCertificate.Thumbprint } else { $null }",
    "    notBefore = if ($s.SignerCertificate) { $s.SignerCertificate.NotBefore.ToString('u') } else { $null }",
    "    notAfter = if ($s.SignerCertificate) { $s.SignerCertificate.NotAfter.ToString('u') } else { $null }",
    "    tsa = if ($s.TimeStamperCertificate) { $s.TimeStamperCertificate.Subject } else { $null }",
    "    sha256 = $hash",
    "  }",
    "})",
    "ConvertTo-Json -InputObject $rows -Compress -Depth 3",
  ].join("\n");
  const { exe, env } = await powershell();
  const result = await new Promise(resolve => {
    execFile(
      exe,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true, maxBuffer: 64 * 1024 * 1024, env },
      (error, stdout, stderr) => resolve({ error, stdout: String(stdout || ""), stderr: String(stderr || "") })
    );
  });
  await fsp.unlink(listFile).catch(() => {});
  if (result.error) throw new VerifyError(`Get-AuthenticodeSignature failed: ${result.error.message}\n${result.stderr}`);
  const parsed = JSON.parse(result.stdout.trim() || "[]");
  return Array.isArray(parsed) ? parsed : [parsed];
}

/** Apply the policy to one inspected row → {verdict: "ok"|"upstream"|"FAIL", reason}. */
function judge(row, expectedPublisher) {
  const cn = commonName(row.subject);
  if (row.status === "NotSigned") return { verdict: "FAIL", reason: "UNSIGNED" };
  if (row.status !== "Valid") return { verdict: "FAIL", reason: `status ${row.status}: ${row.statusMessage}` };
  if (!row.tsa) return { verdict: "FAIL", reason: "no RFC 3161 timestamp" };
  if (cn === expectedPublisher) return { verdict: "ok", reason: "" };
  if (isOurs(row.path)) return { verdict: "FAIL", reason: `issued to "${cn}", expected "${expectedPublisher}"` };
  return { verdict: "upstream", reason: `valid signature from "${cn}"` };
}

async function verifyFiles(files, expectedPublisher, root) {
  const rows = await inspect(files);
  const results = rows.map(row => {
    const j = judge(row, expectedPublisher);
    return { ...row, rel: root ? path.relative(root, row.path) : path.basename(row.path), ...j, publisher: commonName(row.subject) };
  });
  for (const r of results) {
    const line = `${r.verdict.padEnd(8)} ${r.rel}  [${r.status}; ${r.publisher || "-"}; ts=${r.tsa ? "yes" : "NO"}]${r.reason ? "  " + r.reason : ""}`;
    r.verdict === "FAIL" ? console.error(`${TAG} ${line}`) : log(line); // eslint-disable-line no-console
  }
  return results;
}

function renderReport(results, meta) {
  const lines = [
    `# Windows signing report`,
    ``,
    `- generated: ${meta.generated}`,
    `- expected publisher: ${meta.expectedPublisher}`,
    `- release dir: ${meta.releaseDir}`,
    `- result: **${meta.failures ? `FAIL (${meta.failures} problem${meta.failures === 1 ? "" : "s"})` : "PASS"}**`,
    ``,
    `| verdict | file | status | publisher | issuer | timestamp | leaf valid until | sha256 |`,
    `| --- | --- | --- | --- | --- | --- | --- | --- |`,
  ];
  for (const r of results) {
    lines.push(
      `| ${r.verdict} | ${r.rel} | ${r.status}${r.reason ? " (" + r.reason + ")" : ""} | ${r.publisher || "-"} | ${commonName(r.issuer) || "-"} | ${r.tsa ? "present (" + commonName(r.tsa) + ")" : "MISSING"} | ${r.notAfter || "-"} | ${r.sha256} |`
    );
  }
  return lines.join("\n") + "\n";
}

async function writeReport(results, releaseDir, expectedPublisher) {
  const failures = results.filter(r => r.verdict === "FAIL").length;
  const meta = { generated: new Date().toISOString(), expectedPublisher, releaseDir, failures };
  await fsp.writeFile(path.join(releaseDir, "signing-report.md"), renderReport(results, meta), "utf8");
  await fsp.writeFile(path.join(releaseDir, "signing-report.json"), JSON.stringify({ ...meta, files: results }, null, 2), "utf8");
  log(`report: ${path.join(releaseDir, "signing-report.md")}`);
  return failures;
}

function failIfNeeded(results, what) {
  const failed = results.filter(r => r.verdict === "FAIL");
  if (failed.length) {
    throw new VerifyError(`${failed.length} of ${results.length} binaries fail the signature gate (${what}):\n` + failed.map(r => ` - ${r.rel}: ${r.reason}`).join("\n"));
  }
  log(`${what}: ${results.length} binaries OK (${results.filter(r => r.verdict === "upstream").length} with upstream signatures)`);
}

function expectedPublisherFrom(packager) {
  const azure = packager && packager.platformSpecificBuildOptions && packager.platformSpecificBuildOptions.azureSignOptions;
  const name = azure && (Array.isArray(azure.publisherName) ? azure.publisherName[0] : azure.publisherName);
  if (!name) throw new VerifyError("win.azureSignOptions.publisherName is not set; cannot verify without an expected publisher");
  return name;
}

// ----------------------------------------------------------------------------- hooks

async function afterSign(context) {
  if (context.electronPlatformName !== "win32") return;
  const expected = expectedPublisherFrom(context.packager);
  const files = await walk(context.appOutDir);
  if (!files.length) throw new VerifyError(`no exe/dll/node under ${context.appOutDir}`);
  failIfNeeded(await verifyFiles(files, expected, context.appOutDir), `win-unpacked before NSIS (${files.length} files)`);
}

async function artifactBuildCompleted(event) {
  const file = event && event.file;
  const packager = event && event.packager;
  if (!file || !packager || packager.platform.nodeName !== "win32" || path.extname(file).toLowerCase() !== ".exe") return;
  const expected = expectedPublisherFrom(packager);
  const releaseDir = path.dirname(file);
  const unpacked = (await fsp.readdir(releaseDir)).filter(n => /^win-.*unpacked$/.test(n)).map(n => path.join(releaseDir, n));
  const treeFiles = (await Promise.all(unpacked.map(d => walk(d)))).flat();
  const results = [
    ...(await verifyFiles([file], expected, releaseDir)),
    ...(await verifyFiles(treeFiles, expected, releaseDir)),
  ];
  await writeReport(results, releaseDir, expected);
  failIfNeeded(results, `installer + win-unpacked (${results.length} files)`);
}

// ----------------------------------------------------------------------------- CLI

async function main(argv) {
  const args = argv.slice();
  let publisher = null;
  const pi = args.indexOf("--publisher");
  if (pi >= 0) { publisher = args[pi + 1]; args.splice(pi, 2); }
  const releaseDir = path.resolve(args[0] || "release");
  if (!publisher) throw new VerifyError('usage: node signing/win-verify.js <releaseDir> --publisher "<CN>"');
  const entries = await fsp.readdir(releaseDir, { withFileTypes: true });
  const installers = entries.filter(e => e.isFile() && e.name.toLowerCase().endsWith(".exe")).map(e => path.join(releaseDir, e.name));
  const unpacked = entries.filter(e => e.isDirectory() && /^win-.*unpacked$/.test(e.name)).map(e => path.join(releaseDir, e.name));
  if (!installers.length) throw new VerifyError(`no installer .exe in ${releaseDir}`);
  if (!unpacked.length) throw new VerifyError(`no win-unpacked directory in ${releaseDir}`);
  const treeFiles = (await Promise.all(unpacked.map(d => walk(d)))).flat();
  const results = [
    ...(await verifyFiles(installers, publisher, releaseDir)),
    ...(await verifyFiles(treeFiles, publisher, releaseDir)),
  ];
  await writeReport(results, releaseDir, publisher);
  failIfNeeded(results, `${installers.length} installer(s) + ${treeFiles.length} unpacked binaries`);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch(e => {
    console.error(`${TAG} ${e.message}`); // eslint-disable-line no-console
    process.exit(1);
  });
}

module.exports = { afterSign, artifactBuildCompleted, judge, isOurs, commonName, VerifyError };
