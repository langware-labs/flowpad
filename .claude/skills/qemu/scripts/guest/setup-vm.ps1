# First-logon setup for the Flowpad test VM (runs once from the unattend CD).
# Installs the vmagent poller (two lanes: "user" = normal token, "admin" = elevated) and
# keeps the VM awake. Deliberately installs nothing Flowpad-related.
$ErrorActionPreference = 'Continue'
$src = Split-Path -Parent $MyInvocation.MyCommand.Path
New-Item -ItemType Directory -Force C:\vmagent | Out-Null
Start-Transcript C:\vmagent\setup.log -Append
Copy-Item "$src\agent.ps1" C:\vmagent\agent.ps1 -Force

powercfg /change standby-timeout-ac 0
powercfg /change monitor-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /hibernate off
reg add HKLM\SOFTWARE\Policies\Microsoft\Windows\Personalization /v NoLockScreen /t REG_DWORD /d 1 /f
reg add "HKCU\Control Panel\Desktop" /v ScreenSaveActive /t REG_SZ /d 0 /f

# Host<->guest clipboard: SPICE vdagent (x64, runs emulated on ARM) over the qemu-vdagent virtserialport
# that windows-11-arm.conf's extra_args add. vioser driver comes from the unattend pnputil step.
$m = "$env:TEMP\spice-vdagent.msi"
Invoke-WebRequest -UseBasicParsing https://www.spice-space.org/download/windows/vdagent/vdagent-win-0.10.0/spice-vdagent-x64-0.10.0.msi -OutFile $m
Start-Process msiexec -ArgumentList "/i `"$m`" /qn /norestart" -Wait

$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
foreach ($lane in @(@{n='user'; lvl='Limited'}, @{n='admin'; lvl='Highest'})) {
  $action = New-ScheduledTaskAction -Execute powershell.exe -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Minimized -File C:\vmagent\agent.ps1 -Lane $($lane.n)"
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User flowpad
  $principal = New-ScheduledTaskPrincipal -UserId flowpad -LogonType Interactive -RunLevel $lane.lvl
  Register-ScheduledTask -TaskName "vmagent-$($lane.n)" -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force
  Start-ScheduledTask -TaskName "vmagent-$($lane.n)"
}
Set-Content C:\vmagent\setup-done.txt (Get-Date -Format o)
Stop-Transcript
