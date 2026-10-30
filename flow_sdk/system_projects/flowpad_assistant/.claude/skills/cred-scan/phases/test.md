# cred-scan test <name> — write a credential's test, proven once

Run when a credential has no `test` (the Test button starts you with this) or
when its test is wrong. Contract and known endpoints: `references/tests.md`.

Pass `--project <id>` to every `flow credentials` command when the prompt names
one — the working folder alone may not resolve the project.

> **Ground rules:** never print, echo or quote a value — not in a command, not in
> chat. Values reach a command only through its environment. Read-only requests
> only. Write nothing unless the test passed against the real provider.

1. **Read the credential**: its folder's `credential.json`
   (`agentic-assets/credential/<name>/`): its variables, `help_url`, `needed_for`, the folder.
2. **Find the endpoint**: `references/tests.md`; else the code that reads the
   variable (`rg <VAR>`), then the provider's API docs. Pick the cheapest
   authenticated GET. Unsure between two, or the account kind matters? Ask the
   person in one short question and wait for the answer.
3. **Has it a value here?** `flow credentials check <name>`. Missing → say so,
   ask the person to set it (Credentials → Set values), stop.
4. **Write the test** as `test.json` in the credential's folder (`{"commands":
   {darwin, linux, win32}}`). Never edit `credential.json` for it. Then run
   `flow credentials test <name>` — it runs the test with the values in the
   environment and records the answer.
   - `state: ok` → done.
   - `state: invalid` → is it the KEY or the TEST? A 401/403 on a documented
     endpoint is the key: keep the test, tell the person the key is rejected and
     where to make a new one (`help_url`). A 404 / wrong host is the test: fix it,
     run again (twice at most), else delete `test.json` and explain.
   - `state: error` → the tool is missing or there is no command for this OS: fix it.
5. **Report** in two lines: the endpoint used and the result. The person sees the
   Test button turn green; the next click runs the test directly, with no agent.
