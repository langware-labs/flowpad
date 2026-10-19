Get an Anthropic API key for this machine.
1. Open https://console.anthropic.com/settings/keys and sign in (ask the person to sign in if a login is needed — never create an account).
2. Create a key named "Flowpad" and copy it (it starts with `sk-ant-`).
3. Store it: pipe the line `ANTHROPIC_API_KEY=<key>` into `flow credentials set anthropic-key --stdin`.
4. Confirm with `flow credentials check anthropic-key`. Never print or repeat the key.
