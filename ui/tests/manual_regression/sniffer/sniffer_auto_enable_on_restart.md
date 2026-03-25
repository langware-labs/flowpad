test 1: sniffer is auto-enabled after server restart (no user action required)
- start backend: `uv run -m flow_sdk.server.run` (port 9007)
- start frontend: `cd ui && npm run dev` (port 4097)
- open browser to `http://localhost:4097`
- validate homepage loads without console errors
- locate the EventSnifferChip at the bottom of the home page
- verify sniffer is already enabled: green dot visible, timespan buttons (10s 1M 10 60 1D) visible, Power button glows green
- no user click should be required — sniffer must be enabled purely from bootstrap

test 2: sniffer stays enabled after disable → restart cycle
- with the app running and sniffer enabled (test 1)
- click the Power button in the EventSnifferChip to disable the sniffer
- verify chip shows: grey dot, no timespan buttons, Power button no longer green
- verify one DELETE request was made to `/api/v1/graph/hooks-sniffer` (check network tab)
- stop the backend server (Ctrl+C or `pkill -f flow_sdk.server.run`)
- restart the backend: `uv run -m flow_sdk.server.run`
- refresh the browser page
- wait for the app to load (bootstrap completes)
- verify sniffer is re-enabled automatically: green dot, timespan buttons visible
- verify NO POST to `/api/v1/graph/hooks-sniffer` was made during this load (bootstrap alone re-enables it)
- verify `GET /api/v1/graph/bootstrap` response contains `sniffer_hook` field with a non-null object having `id`, `type`, `uname`

test 3: settings.json has sniffer hook after auto-enable
- after test 2 confirms auto-enable
- check `~/.claude/settings.json`
- verify it contains hook entries with `flow_metadata.name` = `"flowpad_sniffer"` for all hook events (PreToolUse, PostToolUse, UserPromptSubmit, Notification, Stop, SubagentStop)
- each entry command should contain `flow hooks report` and target `http://localhost:9007/api/v1/webhook/listen`
