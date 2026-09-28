Install Node.js with the platform's own package manager so that `node --version` answers from a fresh shell.

On Windows, Node's installer (winget's `OpenJS.NodeJS.LTS`, the nodejs.org `.msi`) is machine-wide only, so it opens a Windows permission prompt and blocks until someone answers it — a person who does not see the prompt leaves the install waiting until the step times out. Prefer the per-user route, which needs no administrator rights and no prompt: unpack the official zip under the user's profile and put that folder on the USER PATH, which is what the check reads. The zip also carries `npm.cmd`, so the npm step passes with it.

```powershell
$v = (Invoke-RestMethod https://nodejs.org/dist/index.json | ForEach-Object { $_ } | Where-Object { $_.lts } | Select-Object -First 1).version
$zip = Join-Path $env:TEMP "node-$v-win-x64.zip"
Invoke-WebRequest "https://nodejs.org/dist/$v/node-$v-win-x64.zip" -OutFile $zip -UseBasicParsing
Expand-Archive $zip (Join-Path $env:LOCALAPPDATA 'Programs') -Force
$dir = Join-Path $env:LOCALAPPDATA "Programs\node-$v-win-x64"
[Environment]::SetEnvironmentVariable('Path', "$dir;" + [Environment]::GetEnvironmentVariable('Path','User'), 'User')
```

The `ForEach-Object { $_ }` is not decoration: Windows PowerShell 5.1 passes a downloaded JSON array down the pipeline as ONE object, and without it the filter picks every version at once.
