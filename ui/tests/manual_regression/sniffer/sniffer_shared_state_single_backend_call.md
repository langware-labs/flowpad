---
id: 247edca2-2207-589f-9cd9-18f52608a1ab
---

test 1: enabling sniffer from HooksManager also updates EventSnifferChip (shared DataContext)
- start backend and frontend; open browser to `http://localhost:4097`
- open browser DevTools → Network tab; filter by `hooks-sniffer`
- if sniffer is currently enabled, disable it first (Power button on home chip) — clear network log
- navigate SPA-style to `/dock/hooks`: open browser console and run:
  `history.pushState({}, '', '/dock/hooks'); dispatchEvent(new PopStateEvent('popstate'))`
- verify HooksManager page loads: heading "Hooks Manager" visible, Power button tooltip shows "Enable sniffer"
- scroll to bottom — verify EventSnifferChip also visible with grey dot (disabled)
- open a second browser tab at `http://localhost:4097`
- in the HooksManager tab: click the Power button to enable the sniffer
- verify in Network tab: exactly 1 POST to `/api/v1/graph/hooks-sniffer` was made
- verify in HooksManager tab: Power button tooltip now reads "Disable sniffer"
- switch to home tab (`http://localhost:4097`) — do NOT reload
- verify EventSnifferChip shows green dot and timespan buttons without any reload or extra API call
- verify no additional POST to `/api/v1/graph/hooks-sniffer` occurred

test 2: disabling sniffer from EventSnifferChip also updates HooksManager
- with sniffer enabled (from test 1)
- navigate to home page: `http://localhost:4097`
- clear Network log
- click Power button on EventSnifferChip to disable
- verify 1 DELETE to `/api/v1/graph/hooks-sniffer` in Network tab
- navigate SPA-style to `/dock/hooks`
- verify HooksManager Power button tooltip shows "Enable sniffer" (no page reload, no extra API call)
- verify no additional network calls to `hooks-sniffer`

test 3: multiple useHooksSniffer consumers share one entity subscription
- open browser console on the home page with sniffer enabled
- run: `window.sniffer` — verify it returns an AgentHook entity object (not undefined)
- navigate to `/dock/hooks` SPA-style
- run: `window.sniffer` again — verify same entity ID as before
- this confirms all consumers read from the same entity and no duplicate subscription was created
