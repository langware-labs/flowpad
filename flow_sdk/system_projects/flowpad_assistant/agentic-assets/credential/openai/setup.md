Get an OpenAI API key for this machine.
1. Open https://platform.openai.com/api-keys and sign in (ask the person to sign in if needed — never create an account).
2. Create a secret key named "Flowpad" and copy it (it starts with `sk-`).
3. Store it: pipe the line `OPENAI_API_KEY=<key>` into `flow credentials set openai --stdin`.
4. Confirm with `flow credentials check openai`. Never print or repeat the key.
