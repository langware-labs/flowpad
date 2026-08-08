# Sandbox sharing — hand a box over, share ONLY the link

Two Flowpad instances (Alice, Bob) + the local hub + a real E2B sandbox.

**Goal of the run: the share flow passes, and the LINK IS THE ONLY THING SHARED.**
Bob is given one string — the `open-service` URL — and nothing else: no gated host
url, no cookie-gate secret, no hub session, no invitation click-through. Everything
else (admission, resuming a paused box, waking the app, signing Bob in) has to be
derived by the hub from that one link plus Bob's own login.

This is a MANUAL test on purpose. It burns real E2B minutes, needs a public tunnel,
two browser profiles and two hub identities — none of which belongs in the Playwright
suite. There is no `.md.ts` companion.

---

## Last run — 2026-08-08 (second): GREEN, after the compute-node refactor

Re-run from scratch against a NEW E2B box, with the hub running the refactored
node interface (typed lifecycle, one transport, `login() -> BoxSession`).

| step | result |
|---|---|
| create + `workspace-ready` | **pass** — `healthy:true, logged_in:true, login_detail:"alice@local.test"` |
| — identity **verified**, not assumed | **pass** — the hub read it back from the box (`login()`'s new round trip); no "did not report its identity back" in the log |
| pause (`ops/pause`) | **pass** — the lifecycle contract change against real hardware |
| `ops/status` | **pass** — `PAUSED`, wire keys exactly `['cpu_count','end_at','memory_mb','started_at','status']`, i.e. `NodeStatus.to_wire()` is byte-compatible |
| shared link, browser, not invited | **pass** — readable page, **not** a JSON blob (see below) |
| → login as bob → back to the link | **pass** |
| paused box wakes | **pass** — landed on `https://9007-<id>.e2b.dev` |
| box signed in as bob | **pass** — `/api/v1/cloud/status` in the box reports `bob@local.test` |
| `ops` refused to a shared `admin` | **pass** — `no valid access for role ['admin']`; opening a box and driving its lifecycle are correctly different rights |

### The browser found a defect the API could not

Driving this in a real browser (rather than curl) surfaced something the earlier
HTTP-level run could not: **a browser is never anonymous on this hub.** Local
sign-in is enabled, so the very first navigation is handed a machine-user session —
measured, signed in as `mac.lan@local.machine`, having typed nothing. The
recipient's first click therefore arrives AUTHENTICATED as somebody never invited,
misses the anonymous redirect entirely, and used to be answered with:

```
{"status":"FAIL","message":"Missing request info(Target entity not found(NR1))"}
```

A blob with nothing to click. Now that navigation gets a page naming the account
and linking to the login form (**not** logout — logging out re-mints the machine
user on the next request, so it is a no-op here; and redirecting an already-signed-in
caller to `/login` would bounce back through `target_path` forever).

### Known limit — the identity fix is not in the box yet

The sandbox runs **flowpad 0.2.118 from the E2B template**, not this working tree:
`desktop_info.login` is still absent inside the box (verified in-page). So the
"E2B Local at first paint" fix is proven by tests on both sides and visible on a
local instance running this tree, but the SANDBOX will only show it once a
flow_sdk carrying it ships into the template. Re-run this row after that.

---

## Last run — 2026-08-07: GREEN

Real E2B sandbox, hub `:8093` behind an ngrok tunnel, `alice@local.test` /
`bob@local.test`, driven at the HTTP level (curl standing in for each browser hop).

| Step | Result |
|---|---|
| 1 create + `workspace-ready` | **pass** — `healthy:true, logged_in:true, login_detail:"alice@local.test"`, `started_fallback:true` (the tunnel branch), `auto_login:true` |
| — reopen an ARMED box | **pass** — a second `workspace-ready` returns `healthy:true` (this is the regression below) |
| 2 share to Bob at `admin` | **pass** — auto-accepts; Bob reads the node immediately |
| 3 link shape | **pass** — `…/compute_node/<id>/open-service/workspace`; no gate secret, no provider host |
| 5 pause by script | **pass** — `pause ok / status: PAUSED` |
| 6 signed-out link → login | **pass** — `302 → login.html?target_path=<link>`; an XHR still gets `401` |
| 7 login → back to the link | **pass** — `302 → <the link>`, session cookie set |
| 8 paused box wakes | **pass** — `302 → https://9007-<id>.e2b.dev/auth/gate?cookie-gate=…&next=/` in **14.8s**, and following it lands on the app (`200`, `<title>Flowpad …`) |
| 9 signed in as Bob | **pass** — `logged_in_user` went `alice@local.test` → **`bob@local.test`** |
| 10 no leak | **pass** — stranger `302→login`; signed-in non-member (`carol`) `401`; bare provider host without the gate `403` |

Bob was handed ONE string and nothing else. No invitation was opened, no session
pre-established: the link plus his own login was the whole of it.

### Two things this run settled

**1. "Hand it over" and "the link is the only thing shared" cannot both hold.**
A transfer never auto-accepts (`_maybe_auto_accept` returns early for
`invitation.transfer`: a mistyped address would otherwise hand the box to an
account nobody holds, unrecoverably, since the sender is no longer owner and only
an owner can transfer). Measured with `transfer:true`: Bob held NO role — the node
read back `Target entity not found(NR1)` — and the link took him to login and then
a `401`. **This test therefore asserts the plain Share** (`SANDBOX_SHARE_ROLE`,
`admin`), which auto-accepts and is the only link-only grant. Hand-over is a
separate flow that needs the emailed invitation, and Alice stays owner here.

**2. `open-service` used to 503 on every open after a box's first — fixed.**
Reproduced twice for Bob and once for ALICE THE OWNER, so it was neither about
sharing nor about which principal called it:

```
503  workspace did not start in time.
     Workspace did not become healthy on port 9007 (last HTTP 403).
```

The `403` was the armed cookie-gate. `_workspace_ready_op` probes health BEFORE
logging in, and its own comment says that ordering is only safe while nothing is
armed — true at create time and never again, because `_workspace_login` arms the
gate and the secret survives the app restart. Every reopen (a resume, a second
user, a second click) probed through an armed gate and never saw healthy.

Fixed by having the probe present the secret as `X-Cookie-Gate`, the transport
the gate documents for machine callers; the probe never leaves loopback, so it
reveals the secret to nobody, and it reads through `_stored_cookie_gate()` so a
health check can never MINT a gate. Hub-side: `ComputeNode._service_health_code` /
`_curl_status`, covered by `flowpad/hub/tests/unit/test_workspace_health_probe_gate.py`.

Unrelated wart seen twice: `ops/shutdown` answers `Failed to shutdown compute
node` for a box that is already gone. The teardown below still leaves nothing
running — verified against the E2B API directly (both test sandboxes `404`).

---

## What is under test

| Claim | Where it lives |
|---|---|
| The shared link is `…/api/v1/graph/compute_node/<id>/open-service/workspace` — never the gated host | `ui/src/pages/hub-home/share-sandbox.ts` `sandboxShareLink` → `workspaceServiceUrl` (`ui/src/hooks/use-sandboxes.ts:172`) |
| The link is inert: it carries no secret, and a stranger following it does not get a session | hub `ComputeNode.open_service_url` / `_may_receive_the_gate` |
| A plain Share grants `admin`, which auto-accepts — so the link alone admits the recipient | `SANDBOX_SHARE_ROLE = 'admin'`; hub `_maybe_auto_accept` (which a transfer deliberately skips) |
| `admin` is the admission FLOOR: a signed-in non-member gets no session from the link | `_may_receive_the_gate` requires `PRIVILEGED_FLOOR` |
| Following the link resumes a PAUSED box, waits for the app, and only then redirects | hub `_open_service_op` |
| The box is signed in as **whoever followed the link**, not as its creator | `_open_service_op` → `_workspace_ready_op(principal=None)` → `_workspace_login` falls back to the requesting user |
| An unauthenticated browser following the link is sent to login and returned to it | hub `login_redirect_for_navigation` (`core/auth/authorizer.py`) → `login.html` → `/api/v1/login` → `safe_target_path` |

---

## Setup

### 0. ngrok — non-optional

The E2B sandbox calls the hub back to validate its node-bound API key. A hub on
`localhost:8093` is unreachable from inside E2B, so auto-login fails while
`workspace-ready` still reports healthy — the box comes up NOT signed in and the
test's last assertion silently degrades.

```bash
ngrok http 8093            # note the https://<id>.ngrok-free.app forwarding URL
```

Start the hub with that URL exported:

```bash
cd /Users/shlom/Documents/dev/test_flowpad/FlowPad
SERVICE_URLS_CONFIG__EXTERNAL_HOST=https://<id>.ngrok-free.app python flowpad/run.py
```

`ComputeNode._workspace_hub_url()` reads `service_external_host`, which falls back to
`SERVICE_URLS_CONFIG__EXTERNAL_HOST` exactly when `backend_host` is loopback. Because
that value then differs from `workspace_app_default_hub`, `_workspace_ready_op` takes
the `_restart_workspace_app` branch and repoints the box's app at the tunnel — that
restart is expected and is what makes auto-login work at all.

Sanity check before going further:

```bash
curl -s https://<id>.ngrok-free.app/api/v1/login/test   # {"message":"Login test successful"}
```

Free ngrok endpoints inject a one-time browser warning page; click through it once in
each Chrome profile before running the test.

### 1. Two instances

Sequentially (never in parallel — the launcher races on the hub signup):

```bash
scripts/instance_ctl.sh launch dev-1 --email alice@local.test --hub http://localhost:8093
scripts/instance_ctl.sh launch dev-2 --email bob@local.test   --hub http://localhost:8093
```

### 2. Two hub-mode browser sessions

The sandbox cards live on HUB HOME, which must be served by the HUB — a hub page
rendered against a local backend is a different runtime and proves nothing.

```bash
cd ui && npx vite --mode hubtest       # :4098, API http://localhost:8093
```

Open `http://localhost:4098/dock/hub/home` in **two separate Chrome profiles**
(identity is the hub cookie, so one vite server serves both):

* profile **A** — signed in as `alice@local.test`
* profile **B** — SIGNED OUT, and it must stay signed out until step 6

Confirm the wiring in profile A before trusting anything: `window.__API_URL__` is the
hub, and `GET /api/v1/graph/bootstrap` returns `supported_pages: ["hub"]` with
`sandboxes_enabled: true`. If it returns `["desk","hub"]` you are on the local backend
and looking at the wrong runtime — stop.

---

## Alice

test 1: Create a sandbox, auto-login ON
- in profile A, on `/dock/hub/home`, click **New sandbox**
- name it `share-regression`, leave the project/repo pickers empty (a bare box; the
  hand-over assertions do not need a repo, and a repo only lengthens the boot)
- click **Create** (`data-testid=create-sandbox`) and leave the dialog OPEN
- validate the checklist (`data-testid=sandbox-create-steps`) advances to created and
  the footer switches to **Launch** / **Done** — the dialog must not close on its own
- click **Done**, NOT Launch. Not because the box is un-signed-in — create already
  ran `workspace-ready`, so it is signed in as Alice — but because Launch would make
  Alice the last person to open it through the very route under test
- validate the card for `share-regression` appears in the sandbox list
- validate the card reads **signed in as alice@local.test**, and shows NO "auto login
  off" note — `auto_login` defaults to `true`, and the card renders both from the
  entity without waking the machine. That Alice's name is here now is what makes
  test 9 mean something: the box has an identity, and the link changes it
- validate no console errors

test 2: Share it with Bob, and confirm what the dialog promises
- open the card's share affordance for `share-regression`
- validate the dialog states, in plain words, `Anyone you share with can open, use and delete this sandbox.`
- validate the auto-login checkbox (`data-testid=share-sandbox-auto-login`) is present
  and TICKED — it is owner-only, and it is on
- leave **Hand it over** (`data-testid=share-sandbox-transfer`) UNTICKED. That is
  load-bearing for this test, not a default worth skipping past: a transfer never
  auto-accepts, so a handed-over box admits nobody until the recipient opens the
  emailed invitation — and then the link is not the only thing shared. The plain
  Share grants `SANDBOX_SHARE_ROLE` (`admin`), which auto-accepts
- type `bob@local.test` into the recipient field
- click **Share** (`data-testid=share-sandbox-submit`)
- validate the toast reads `Shared with bob@local.test`
- validate no failure row renders under the recipient field
- validate Bob can now read the node at all — as Bob,
  `GET /api/v1/graph/compute_node/<id>` answers `SUCCESS`. Before the grant it
  answers `Target entity not found(NR1)`, which is what a pending (unaccepted)
  invitation looks like from the recipient's side

test 3: The link — and the fact that it is the only thing that leaves this screen
- re-open the share dialog on the same card
- read `data-testid=share-sandbox-link` and copy it (`data-testid=share-sandbox-copy`)
- validate its shape is exactly
  `<hub>/api/v1/graph/compute_node/<uuid>/open-service/workspace`
- validate it contains NO `cookie-gate` query parameter, no `e2b.dev` / provider host,
  and no token of any kind. This is the single assertion the whole test is named for:
  what is copied here is inert, so the ONLY thing handed to Bob is a name for the box
- record the `<uuid>` — the steps below need it
- **hand this string to Bob's profile by hand** (paste it into profile B's address bar
  yourself). Do not open Bob's invitation email, do not use hub home's shared list,
  do not sign Bob in first. Any of those would make a different flow pass

test 4: The link admits the people it named, and nobody else
- with a THIRD account that holds no role on this box (sign one up if needed),
  request the link:
  ```bash
  curl -s -o /dev/null -w '%{http_code}\n' -b carol-jar.txt \
    -H 'accept: text/html' \
    "<the link from test 3>"
  ```
- validate `401` — being signed in is not admission. This is the assertion that
  makes the link safe to paste: it names a box, it does not confer one
- validate Alice (still owner after a plain Share) and Bob (admin) both get the
  `302`, so the grant is what differs and nothing else

test 5: Pause the box from a script
- run:
  ```bash
  ui/tests/manual_regression/sandbox/pause_sandbox.sh --name share-regression
  ```
  (it logs into the hub as Alice, resolves the node id by name, POSTs `ops/pause`,
  then re-reads `ops/status`)
- validate the script prints `status: PAUSED`
- if it prints `RUNNING`, wait and re-run `--status-only`; E2B reports the transition
  a beat after the pause call returns. Do NOT add a sleep to the script to paper over
  a genuinely stuck pause — a box that will not pause is the finding

---

## Bob

test 6: An unauthenticated visitor is sent to login, not to a dead end
- in profile **B**, still signed out, paste the link into the address bar and go
- validate the browser lands on the hub's login screen
- validate the login URL carries the link as its return target
  (`login.html?target_path=<the open-service url>`) — without it, step 7 cannot exist
- validate the page is the login screen, NOT a `Forbidden access` JSON blob

  > **This step is served by a dedicated seam** — `login_redirect_for_navigation`
  > in the hub's `core/auth/authorizer.py`. Before it existed, the auth middleware
  > answered this navigation with `401 {"status":"FAIL","message":"Forbidden access"}`
  > and the share ended as a raw envelope in a tab. The seam is narrow on purpose:
  > GET + `accept: text/html` + the `open-service` action only, so every other
  > route's 401 stays an error object its caller can parse. If this step yields
  > JSON, check that trigger before anything else.

- as a headless equivalent of this step:
  ```bash
  curl -s -i -H 'accept: text/html' "<the link from test 3>" | head -8
  ```
  validate `302` with a `location` of `…/login.html?target_path=<the link, urlencoded>`
- validate an XHR-shaped request to the same URL still gets the JSON 401:
  ```bash
  curl -s -i -H 'accept: application/json' "<the link from test 3>" | head -3
  ```

test 7: Bob logs in and is returned to the link
- sign in as `bob@local.test`
- validate the browser is sent back to the open-service URL, not to hub home —
  `safe_target_path` must accept the hub's own origin here
- validate Bob is not asked to accept anything: the plain Share in test 2 auto-accepted,
  so the link plus his own login is the whole of his admission

test 8: The paused box wakes and the browser is redirected
- validate the tab sits on the open-service URL for a stretch while the hub works —
  this route is deliberately ready-then-url
- validate it then 302s to a provider host carrying `/auth/gate?cookie-gate=…&next=/`
- validate the final page is the Flowpad workspace app, not a provider 404 (a 404 here
  means the url was handed out before the box was resumed)
- validate the hub log shows, in order: `resume`, `Workspace: restarting app against
  hub https://<id>.ngrok-free.app`, then a successful `login_callback`
- expect this to take roughly 15s end to end (measured 14.8s on a paused box)
- if this returns 503 `workspace did not start in time`, it is safe to retry — but a
  repeatable 503 is a finding, not a retry budget to widen. `(last health check: HTTP
  403)` in particular means the health probe is being refused by the box's own
  cookie-gate; that was a real bug (see the run notes at the top) and its return
  would mean the probe stopped presenting `X-Cookie-Gate`

test 9: The box is signed in AS BOB
- in the loaded workspace app, open the user menu
- validate the signed-in cloud user is `bob@local.test` — NOT `alice@local.test`.
  `_workspace_login` falls back to the requesting principal, so the identity the box
  assumes is decided by who followed the link. Alice created it; Bob opened it; Bob
  owns the session
- validate the app reports runtime `sandbox` (not `agent`)
- back in profile A on hub home, refresh and validate the card for `share-regression`
  now reads **signed in as bob@local.test** — the hub caches this from the work it
  just did, without a probe

test 10: The link did not leak
- validate `document.cookie` on the hub origin in profile B contains no
  `cookie-gate` value, and that the gate secret appears only on the provider origin
- validate the link Alice copied in test 3, opened in a THIRD signed-out profile,
  still lands on login and never on the box — including now, with the box awake
- validate the bare provider host with no gate — `https://9007-<sandbox>.e2b.dev/` —
  answers `403`. The box is publicly addressable; the gate is the only thing in
  front of a session that is signed in as a real person

---

## Teardown

```bash
ui/tests/manual_regression/sandbox/pause_sandbox.sh --name share-regression --shutdown
scripts/instance_ctl.sh kill dev-1
scripts/instance_ctl.sh kill dev-2
```

Kill the ngrok tunnel.

**Then confirm the box is actually gone — do not trust the shutdown's answer.**
`ops/shutdown` reports `Failed to shutdown compute node` for a box that is already
gone, and a sandbox left running bills until it auto-pauses. Ask E2B directly:

```bash
cd ../test_flowpad/FlowPad && .venv/bin/python -c "
from dotenv import load_dotenv, find_dotenv; load_dotenv(find_dotenv('.env.local'))
from flowpad.config import default_service_config as c
import urllib.request, json
for state in ('running','paused'):
    r = urllib.request.Request(f'https://api.e2b.dev/sandboxes?state={state}',
                               headers={'X-API-KEY': c.e2b_api_key})
    print(state, [s['sandboxID'] for s in json.load(urllib.request.urlopen(r, timeout=30))])
"
```

The provider id is what `ops/setup` returned. A `DELETE https://api.e2b.dev/sandboxes/<id>`
with the same key ends it; `404` means it was already gone.
