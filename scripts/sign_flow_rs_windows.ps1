<#
.SYNOPSIS
  Build + Authenticode-sign a standalone flow-rs.exe for Windows and place it
  at flow_sdk\rust\bin\win32\flow-rs.exe for vendoring into the flowpad wheel.

.DESCRIPTION
  Standalone analogue of the Electron Windows signing path. It signs the bare
  flow-rs.exe with the same Azure Code Signing identity used by
  flowpad-desktop's build-desktop.yml (account "langware-signing", profile
  "langware-public", endpoint https://eus.codesigning.azure.net/), via the
  Microsoft "TrustedSigning" PowerShell module.

  This is only used when scripts/deploy_to_github.sh runs ON Windows. When
  deploy runs on macOS, the Windows binary is produced by the
  sign-flow-rs-windows.yml workflow instead.

.NOTES
  Required env (Azure service principal, same secrets as CI):
    AZURE_CLIENT_ID, AZURE_TENANT_ID, AZURE_CLIENT_SECRET
  Requires: Rust toolchain (cargo, target x86_64-pc-windows-msvc) and the
  TrustedSigning module (Install-Module -Name TrustedSigning).
#>
[CmdletBinding()]
param(
    [string]$Endpoint = "https://eus.codesigning.azure.net/",
    [string]$Account  = "langware-signing",
    [string]$Profile  = "langware-public"
)

$ErrorActionPreference = "Stop"

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir
$RustDir    = Join-Path $ProjectDir "flow_sdk\rust"
$OutDir     = Join-Path $ProjectDir "flow_sdk\rust\bin\win32"
$Dest       = Join-Path $OutDir "flow-rs.exe"

if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    throw "cargo not found. Install the Rust toolchain: https://rustup.rs"
}

Write-Host "[sign-flow-rs-win] ensuring rust target (x86_64-pc-windows-msvc)..."
rustup target add x86_64-pc-windows-msvc | Out-Null

Write-Host "[sign-flow-rs-win] building flow-rs.exe (release)..."
Push-Location $RustDir
try {
    cargo build --release --bin flow-rs --target x86_64-pc-windows-msvc
} finally {
    Pop-Location
}

$Built = Join-Path $RustDir "target\x86_64-pc-windows-msvc\release\flow-rs.exe"
if (-not (Test-Path $Built)) { throw "expected build output missing: $Built" }

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
Copy-Item -Force $Built $Dest

# Azure auth comes from AZURE_CLIENT_ID / AZURE_TENANT_ID / AZURE_CLIENT_SECRET
foreach ($v in @("AZURE_CLIENT_ID","AZURE_TENANT_ID","AZURE_CLIENT_SECRET")) {
    if (-not [Environment]::GetEnvironmentVariable($v)) {
        throw "$v not set — required for Azure Code Signing."
    }
}

if (-not (Get-Module -ListAvailable -Name TrustedSigning)) {
    throw "TrustedSigning module not installed. Run: Install-Module -Name TrustedSigning -Scope CurrentUser"
}
Import-Module TrustedSigning

Write-Host "[sign-flow-rs-win] signing $Dest via Azure Code Signing..."
Invoke-TrustedSigning `
    -Endpoint $Endpoint `
    -CodeSigningAccountName $Account `
    -CertificateProfileName $Profile `
    -Files $Dest `
    -FileDigest "SHA256" `
    -TimestampRfc3161 "http://timestamp.acs.microsoft.com" `
    -TimestampDigest "SHA256"

Write-Host "[sign-flow-rs-win] verifying Authenticode signature..."
$sig = Get-AuthenticodeSignature $Dest
$sig | Format-List Status, StatusMessage, SignerCertificate
if ($sig.Status -ne "Valid") {
    throw "Authenticode signature is not Valid (status: $($sig.Status))"
}

Write-Host "[sign-flow-rs-win] OK -> $Dest (Azure Code Signing, signature Valid)"
