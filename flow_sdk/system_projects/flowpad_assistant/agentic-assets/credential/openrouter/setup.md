Get an OpenRouter API key for this machine.
1. Open https://openrouter.ai/settings/keys and sign in (ask the person to sign in if needed — never create an account).
2. Create a key named "Flowpad" and copy it (it starts with `sk-or-`).
3. Store it: pipe the line `OPENROUTER_API_KEY=<key>` into `flow credentials set openrouter --stdin`.
4. Confirm with `flow credentials check openrouter`. Never print or repeat the key.
