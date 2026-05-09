precondition: prime localStorage so sniffer reconciles to ENABLED at boot
- before navigation, in a fresh tab, run:
  `localStorage.setItem('flowpad.snifferEnabled', 'true')`
- # Default for an unprimed browser is OFF; the reconciliation effect in
- #   ui/src/hooks/use-hooks-sniffer.ts:161 will disable an unprimed browser
- #   even though bootstrap returned a sniffer_hook. Priming reflects an
- #   already-opted-in user and is the realistic state for these scenarios.

test 1: sniffer state preserved when navigating home → /dock/hooks via SPA
- open browser to {APP_URL}
- wait for window.appReady === true
- verify sniffer is enabled: green dot in EventSnifferChip, timespan buttons visible
- open browser DevTools → Network tab; clear log
- navigate to hooks page via SPA (simulates clicking sidebar link):
  `history.pushState({}, '', '/dock/hooks'); dispatchEvent(new PopStateEvent('popstate'))`
- verify URL changes to `http://localhost:4097/dock/hooks` without full page reload
- verify HooksManager page renders: heading "Hooks Manager" visible
- verify Power button tooltip reads "Disable sniffer" (not "Enable sniffer") — state was preserved
- verify zero POST requests to `hooks-sniffer` in Network tab (no re-fetch needed)

test 2: sniffer state preserved when navigating /dock/hooks → /dock/triggers → home
- with sniffer enabled, navigate to `/dock/hooks` (test 1)
- SPA-navigate to `/dock/triggers`:
  `history.pushState({}, '', '/dock/triggers'); dispatchEvent(new PopStateEvent('popstate'))`
- verify Triggers page loads
- SPA-navigate back to home:
  `history.pushState({}, '', '/'); dispatchEvent(new PopStateEvent('popstate'))`
- verify home page loads
- verify EventSnifferChip still shows green dot and timespan buttons (state was not lost across multiple navigations)
- verify browser console has no errors

test 3: full-page reload re-enables sniffer from bootstrap (not session state)
- with sniffer enabled, navigate to `/dock/hooks`
- hard-reload: Ctrl+Shift+R (full page reload)
- verify app loads at `/dock/hooks` URL
- verify HooksManager Power button tooltip reads "Disable sniffer"
- this confirms bootstrap (not browser session storage) is the source of enabled state
- verify `window.context.snifferEnabled` is `true` in console

test 4: disabling sniffer and navigating does not re-enable
- disable sniffer from home chip (Power button click)
- verify grey dot in chip
- SPA-navigate to `/dock/hooks`
- verify HooksManager Power button tooltip reads "Enable sniffer" (disabled state preserved)
- SPA-navigate back to home
- verify chip still shows grey dot (no accidental re-enable on navigation)
