Install Node.js with the platform's own package manager so that `node --version` answers from a fresh shell.

On Windows, Node's installer (winget's `OpenJS.NodeJS.LTS`, the nodejs.org `.msi`) is machine-wide only, so it opens a Windows permission prompt and blocks until someone answers it — a person who does not see the prompt leaves the install waiting until the step times out. So this op's own Windows command already takes the per-user route, which needs no administrator rights and no prompt: it unpacks the official zip under the user's profile and puts that folder on the USER PATH, which is what the check reads. The zip also carries `npm.cmd`, so the npm step passes with it. You run only when that failed — usually because nodejs.org could not be reached; the recipe below is the same steps, to run by hand.

```powershell
$v = (Invoke-RestMethod https://nodejs.org/dist/index.json | ForEach-Object { $_ } | Where-Object { $_.lts } | Select-Object -First 1).version
$zip = Join-Path $env:TEMP "node-$v-win-x64.zip"
Invoke-WebRequest "https://nodejs.org/dist/$v/node-$v-win-x64.zip" -OutFile $zip -UseBasicParsing
Expand-Archive $zip (Join-Path $env:LOCALAPPDATA 'Programs') -Force
$dir = Join-Path $env:LOCALAPPDATA "Programs\node-$v-win-x64"
[Environment]::SetEnvironmentVariable('Path', "$dir;" + [Environment]::GetEnvironmentVariable('Path','User'), 'User')
```

The `ForEach-Object { $_ }` is not decoration: Windows PowerShell 5.1 passes a downloaded JSON array down the pipeline as ONE object, and without it the filter picks every version at once.
