---
id: f9c803e6-90cc-5c3f-9ca6-29f54d45ab12
name: 2dev-users-setup
description: Stand up two Flowpad instances against a cloud hub (dev or staging),
  each in its own Chrome profile, each logged in as a DIFFERENT real user — the
  two-user rig for reproducing sharing, conversation, invitation and
  collaboration bugs. Use when asked for "two users", "two instances", "two
  browsers", a second app instance, a sender/recipient reproduction, or when a
  bug only appears between two accounts.
tags:
- dev
- instances
- multi-user
- browser
- auth0
- collaboration
---

# Two users, two browsers, two instances

The rig: **two isolated Flowpad instances on a cloud hub, each driven from its
own Chrome profile, each signed in as a different real account.** Sender in one
window, recipient in the other, both controllable by Playwright over CDP.

Default target (`HUB=https://dev.flowpad.ai`):

| | Browser A (CDP 9222) | Browser B (CDP 9223) |
|---|---|---|
| Instance | `dev-1` — fe :5002, be :6001 | `dev-2` — fe :5003, be :6002 |
| User | `gadi@langware.ai` | `gadi+20@langware.ai` |
| Window | left, x=0 | right, x=half-screen |

Everything below works the same against `https://staging.flowpad.ai` — set
`--hub` accordingly. The hub only changes which user records exist, not the
mechanics.

## Read this before touching anything

These four facts are the whole reason the setup is fiddly. Getting them wrong
costs an hour.

1. **Against any `*.flowpad.ai` hub, login is browser/Auth0 only.**
   `cloud_login()` routes on `_classify_hub(hub_url)`
   (`flow_sdk/cli/auth/cloud_login.py`): `*.flowpad.ai` → `_login_by_window`,
   `localhost` → `_login_by_api(email, password)`. So
   `FLOWPAD_CLOUD_USER_EMAIL` / `FLOWPAD_CLOUD_USER_PASSWORD` are **ignored**
   for a cloud hub. Passing `--email/--password` to `instance_ctl.sh` does not
   choose the account — it only names the instance's hub user for a *localhost*
   hub. **The browser's Auth0 session decides who logs in**, so control the
   browser, not the env.

2. **`webbrowser.open` hijacks the default browser.** `_login_by_window` calls
   `webbrowser.open(url)`, so `POST /api/v1/cloud/login` hands the login to
   whichever Chrome is default — not the one you meant, and both instances then
   land on the same account. Take the `url` out of the response and navigate the
   *target* browser to it yourself.

3. **Only `@langware.ai` emails can log in.** Dev and staging share one Auth0
   tenant whose rule rejects everything else —
   `error_description=Only Langware emails are allowed to Login`. Gmail is
   refused; `gadi+20@langware.ai` passes, since plus-addressing keeps the
   domain.

4. **Use the real accounts.** Signing up new users writes real records on a
   shared hub, and per fact #1 a freshly-minted account still cannot log in.
   Reuse `gadi@langware.ai` and `gadi+20@langware.ai`; if a third is genuinely
   needed, ask first.

## Phase 1 — two Chrome profile clones

Skip if `~/.pw-profile-a` and `~/.pw-profile-b` exist and their browsers answer
`curl -s localhost:9222/json/version`.

```bash
scripts/clone-profiles.sh          # quits Chrome, clones, verifies cookies
```

The script quits Chrome first because its SQLite files are exclusively locked —
a live `sqlite3 .backup` of `Cookies` fails outright, and a plain copy of a
running profile yields a corrupt cookie DB. It excludes caches (~900MB of
~1.3GB) and hard-fails if the clone lands zero cookies, which is what happens
when the source layout differs from the expected one.

Three things that surprise people:

* Cookies still decrypt in a clone. The key lives in the macOS **Keychain**
  ("Chrome Safe Storage"), scoped per user account rather than per profile
  path. Each clone's first launch raises one Keychain prompt — click **Always
  Allow**. `--use-mock-keychain` silences it but then nothing decrypts.
* **Cloned sessions do not both survive.** Both clones start holding the same
  Google/Auth0 session cookie; those rotate on use and whichever browser
  refreshes first keeps it. Treat the clone as a starting point — each browser
  earns its own login in phase 3.
* Pick the source profile deliberately. Chrome's display names differ from the
  directory names; read `Local State` → `profile.info_cache` to map
  `Profile 1` → account, and prefer the profile with recent activity.

## Phase 2 — launch both browsers

```bash
scripts/launch-browsers.sh 5002 5003      # frontend ports, in A/B order
```

Sizes windows to half the **logical** screen width (`screen.width`), not the
physical Retina resolution — a 3024×1964 panel is 1512 logical. To re-snap a
window later, use CDP `Browser.setWindowBounds` via
`ctx.newCDPSession(page)` → `Browser.getWindowForTarget`.

To tidy a window, navigate the tab you want and leave the others alone. Closing
the last tab in a window exits Chrome and takes the browser down mid-setup, so
any cleanup loop must guarantee one surviving tab.

## Phase 3 — launch both instances, then log each in

```bash
export PATH="$(dirname "$(command -v node || ls -t "$HOME"/.nvm/versions/node/*/bin/node | head -1)"):$PATH"
cd ~/Developer/flowpad
scripts/instance_ctl.sh launch dev-1 --hub https://dev.flowpad.ai
scripts/instance_ctl.sh launch dev-2 --hub https://dev.flowpad.ai
```

`instance_ctl.sh` needs `npm` on PATH and dies with `npm not found` under a
bare shell, hence the nvm line. Port 5001 is reserved (neo4j), so `dev-1` lands
on fe **5002** and `dev-2` on fe **5003** — read the real ports from the
launcher output or `~/.flow/instances/<name>/launcher.json` rather than
assuming.

The launcher auto-triggers a cloud login that lands on the **wrong** account
(facts #1 and #2). For each instance, reset it and drive its login into the
browser you want:

```bash
# 1. clear whatever it logged into; the response carries the hub logout URL
curl -s -X POST http://localhost:6002/api/v1/cloud/logout
# → {"cloud_logout_url": "https://dev.flowpad.ai/api/v1/logout?returnTo=..."}

# 2. navigate the TARGET browser to that cloud_logout_url → kills its Auth0 session
# 3. ask for the login URL (ignore whatever browser this pops open)
curl -s -X POST http://localhost:6002/api/v1/cloud/login
# → {"status":"started","url":"https://dev.flowpad.ai/api/v1/login?target_path=..."}

# 4. navigate the TARGET browser to that url → Auth0 form → sign in
```

Step 1 matters because a stale `~/.flow/instances/<name>/sodot` is reused on
relaunch, so an instance silently keeps its previous account. The callback page
confirms success by printing the `User ID` it logged in as.

Only a human can type the password: fill the email field, then hand off and
wait.

## Phase 4 — validate, in the browser

```bash
node scripts/validate.cjs 6001 6002       # prints both rows, writes screenshots, exits non-zero on FAIL
```

Pass means, for each side: `status: "logged_in"`, `connection: "connected"`,
**different** emails and ids, and the rendered greeting differing —
`Hey Gadi` vs `Hey Gadi20`. Check the rendered UI, not just the API: the
backend can be logged in while the window still shows a login screen.

Confirm which hub you actually reached by user id — the same person has a
different id per hub:

| Account | dev | staging |
|---|---|---|
| `gadi@langware.ai` | `13c8f8ed` | `090ffc4d` |
| `gadi+20@langware.ai` | `077582be` | `dd6b399f` |

## Driving the browsers afterwards

Register one Playwright MCP server per CDP port in `.mcp.json`, copying the
existing entry's explicit `env.PATH` — without it npx cannot find node and the
server dies with `Connection closed`:

```json
"chromeB": {
  "type": "stdio",
  "command": "/Users/Gadi/.nvm/versions/node/v24.13.1/bin/npx",
  "args": ["-y", "@playwright/mcp@0.0.75", "--cdp-endpoint", "http://localhost:9223"],
  "env": { "PATH": "/Users/Gadi/.nvm/versions/node/v24.13.1/bin:/usr/local/bin:/usr/bin:/bin" }
}
```

A new entry needs a session restart plus approval, and these servers hold a
**stale connection after a browser restarts** — until the next session they
fail with `Target page, context or browser has been closed`. The fallback that
always works is a direct CDP connection, which is what `scripts/validate.cjs`
does; copy its two-line connect for ad-hoc driving.

## Teardown

```bash
scripts/instance_ctl.sh kill dev-1
scripts/instance_ctl.sh kill dev-2
pkill -f "user-data-dir=$HOME/.pw-profile-"     # both clone browsers
```

The clone profiles are disposable — delete `~/.pw-profile-{a,b}` to force a
fresh copy of the real profile next time.
