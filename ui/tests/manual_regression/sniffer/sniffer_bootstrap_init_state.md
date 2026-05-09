test 1: bootstrap response includes sniffer_hook on every load
- start backend: `uv run -m flow_sdk.server.run`
- call bootstrap directly:
  `curl -s {API_URL}/api/v1/graph/bootstrap | python3 -c "import sys,json; d=json.load(sys.stdin); sh=d.get('data',{}).get('sniffer_hook'); print(json.dumps(sh, indent=2))"`
- verify response is NOT null — must be a JSON object with fields: `id`, `type` (= "agent_hook"), `uname` (= "sniffer"), `name` (= "Hooks Sniffer")
- call bootstrap a second time (it must be idempotent) — verify same `id` is returned

test 2: context.snifferEnabled reflects the user's last preference (default OFF)
- # Note: snifferEnabled is reconciled to the user's localStorage preference after
- #       bootstrap completes, NOT auto-enabled. Default for a fresh browser is false.
- #       To assert true, the harness must prime localStorage first.
- open browser to {APP_URL}
- wait for app to fully load (window.appReady === true)
- open browser console and run:
  `window.dataContext?.snifferEnabled === (localStorage.getItem('flowpad.snifferEnabled') === 'true')`
- verify result is `true` (state matches stored preference)

test 2b: priming the preference enables the sniffer at boot
- in a fresh tab, run before navigation:
  `localStorage.setItem('flowpad.snifferEnabled', 'true')`
- navigate to {APP_URL}
- wait for window.appReady === true
- run `window.dataContext?.snifferEnabled` — verify `true`
- run `window.dataContext?.snifferHook?.entity?.id` — verify it returns a UUID string

test 3: bootstrap.sniffer_hook is always populated regardless of user pref
- open browser DevTools → Network tab; clear log
- hard-reload the page (Ctrl+Shift+R)
- wait for app to fully load
- open console and run:
  `window.dataContext?.bootstrapInfo?.sniffer_hook`
- verify it's an object with `id`, `type === "agent_hook"`, `uname === "sniffer"` — bootstrap-side wiring is stable
- filter network log by `hooks-sniffer` — at most one DELETE may fire (only when reconciling an enabled→disabled transition for an unprimed browser); no spurious enable POST
