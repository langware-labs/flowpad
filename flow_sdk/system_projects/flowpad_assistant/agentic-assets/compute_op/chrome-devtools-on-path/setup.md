Install the chrome-devtools CLI — the command-line face of Chrome DevTools MCP — with npm so that `chrome-devtools --version` answers from a fresh shell:

```bash
npm install -g chrome-devtools-mcp@1
```

It needs Node.js and npm first (`llm-setup-node`). On Windows npm puts the command in `%APPDATA%\npm`, which the Node.js installer adds to the user's PATH; run it as `chrome-devtools.cmd` from PowerShell, where the default execution policy blocks npm's `.ps1` shims.
