test 1: bootstrap response includes sniffer_hook on every load
- start backend: `uv run -m flow_sdk.server.run`
- call bootstrap directly:
  `curl -s http://localhost:9007/api/v1/graph/bootstrap | python3 -c "import sys,json; d=json.load(sys.stdin); sh=d.get('data',{}).get('sniffer_hook'); print(json.dumps(sh, indent=2))"`
- verify response is NOT null — must be a JSON object with fields: `id`, `type` (= "agent_hook"), `uname` (= "sniffer"), `name` (= "Hooks Sniffer")
- call bootstrap a second time (it must be idempotent) — verify same `id` is returned

test 2: context.snifferEnabled is true immediately after page load
- open browser to `http://localhost:4097`
- wait for app to fully load (no loading spinners)
- open browser console and run:
  `window.context?.snifferEnabled`
- verify result is `true`
- verify this is the case BEFORE any user interaction — auto-enabled from bootstrap

test 3: no POST to hooks-sniffer during initial page load
- open browser DevTools → Network tab; clear log
- hard-reload the page (Ctrl+Shift+R)
- wait for app to fully load
- filter network log by `hooks-sniffer`
- verify zero POST or DELETE requests to `hooks-sniffer` during load
- verify only `GET /api/v1/graph/bootstrap` was called (sniffer state comes from bootstrap, not a separate fetch)
- verify sniffer chip shows green dot (enabled) without any hooks-sniffer API call

test 4: sniffer hook entity is registered in cache from bootstrap
- after page load (test 3)
- open browser console and run:
  `window.context?.snifferHook?.entity?.id`
- verify it returns a UUID string (not undefined or null)
- run: `window.context?.snifferHook?.entity?.constructor?.name`
- verify it returns `"AgentHook"`
