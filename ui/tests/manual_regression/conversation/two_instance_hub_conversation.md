# Two-instance cloud-login isolation + real conversation through local hub

Verifies that two flow-cli desktop instances on the same machine can hold
**independent** cloud logins as two different users at the same time, and that
those two users can carry on a real conversation through the local hub via
`start_guest_conversation` + `add_message`. Exercises the keyring slot,
`config.json` key, and per-instance `flow_home` partitioning introduced by the
"Per-instance keyring slot + user record key" change (commit `04043fe`).

This scenario does **not** rely on real email — addressing is by hub `user.id`.

## Prereqs

- Two checked-out repos on the same machine, on the same branch
  (`v0.2.9-fixes` or later — must contain `_api_key_name()` in
  `flow_sdk/cli/auth/hub_login.py` and `_user_key()` in
  `flow_sdk/cli/app_config.py`):
  - **Instance A (dev)** — `flowpad-oss` checkout. Backend on
    `$LOCAL_SERVER_PORT_A` (e.g. 9008), Vite on `$VITE_PORT_A` (e.g. 4098).
  - **Instance B (prod)** — `flowpad-app` (sister) checkout. Backend on
    `$LOCAL_SERVER_PORT_B` (e.g. 9007), Vite on `$VITE_PORT_B` (e.g. 4097).
- Each repo's `.env.local` has `FLOWPAD_HUB_URL=http://localhost:8093` and
  the env-mode auto-login pair `CLOUD_USER_EMAIL` + `CLOUD_USER_PASS`
  (alice@local.test/alice-pw-1234 in A; bob@local.test/bob-pw-1234 in B).
- Local hub running at `http://localhost:8093` with policies & WIP code
  containing `start_guest_conversation` (project.py) and the `flow_message`
  entity policy granting `member` role read+watch.
- Workstation keychain accessible to the test runner (no prompt-on-read
  blocking).
- Clean slate is preferable — start with no `~/Library/Application Support/flow-cli/config.json`
  user records and empty `flowpad_api_key` / `flowpad_api_key:dev` keyring
  slots. The scenario will succeed with stale state but the assertions in
  Step 5 are sharper from a clean start.

## Setup

```bash
HUB=http://localhost:8093
A=http://localhost:$LOCAL_SERVER_PORT_A    # alice / dev / 9008
B=http://localhost:$LOCAL_SERVER_PORT_B    # bob   / prod / 9007
APP_A=http://localhost:$VITE_PORT_A        # 4098
APP_B=http://localhost:$VITE_PORT_B        # 4097
```

Hub liveness:

```bash
curl -sf "$HUB/api/v1/login/test"
```

PASS when the response is `{"message":"Login test successful"}`.

If alice/bob don't yet exist on the hub, create them (idempotent — pre-existing
users return `EmailAlreadyExists`):

```bash
curl -s -X POST "$HUB/api/v1/signup" -H 'Content-Type: application/json' \
  -d '{"email":"alice@local.test","password":"alice-pw-1234","first_name":"Alice","last_name":"Local"}'
curl -s -X POST "$HUB/api/v1/signup" -H 'Content-Type: application/json' \
  -d '{"email":"bob@local.test","password":"bob-pw-1234","first_name":"Bob","last_name":"Local"}'
```

PASS when both calls return `status=SUCCESS` (or `EmailAlreadyExists` failure
that nevertheless leaves the user usable on `/api/v1/login`). Record both user
ids — `ALICE_ID`, `BOB_ID`.

## Steps

### 1. Boot both stacks

In two terminals:

```bash
# Terminal A — alice / dev
cd <flowpad-oss>
FLOWPAD_DEV=true uv run -m flow_sdk.server.run &     # backend on 9008
(cd ui && npm run dev) &                              # vite on 4098

# Terminal B — bob / prod
cd <flowpad-app>
uv run -m flow_sdk.server.run &                       # backend on 9007
(cd ui && npm run dev) &                              # vite on 4097
```

PASS when:
- `curl -sf $A/api/v1/cloud/status` and `curl -sf $B/api/v1/cloud/status` both
  return 200 with `data.logged_in == false`, `data.cloud_url == "http://localhost:8093/api/v1"`.
- A's `~/.flow/dev_server.json` exists with `"port": <A backend port>`.
- B's `~/.flow/server.json` exists with `"port": <B backend port>`.
- Per-instance flow_home partitioning is visible: `~/.flow/db` (prod, B) and
  `~/.flow/dev_db` (dev, A) are distinct directories.

### 2. Drive instance A login (alice) — Playwright/Chromium

Navigate to `$APP_A`, click the user-avatar element (`[data-testid="agent-page-user-avatar"]`),
then click the `Login` menu item. Env-mode auto-login fires; no popup.

PASS when:
- The dropdown changes from `Login` to `Logout` (matches DOM at
  `ui/src/pages/flow-page/content-panel/user-dropdown/user-dropdown.tsx:321-327`).
- `curl -sS $A/api/v1/cloud/status` returns `data.logged_in == true`,
  `data.user.email == "alice@local.test"`, `data.user.id == ALICE_ID`.

### 3. Drive instance B login (bob) — real Chrome / claude-in-chrome

Navigate the second browser to `$APP_B`. If the dropdown shows `Logout`
(stale from a prior session) reload the page once — bootstrap will validate
the keyring token against the hub and clear it if invalid (per
`flow_sdk/server/routes/bootstrap.py:512-554`). Then click avatar → `Login`.

PASS when:
- `curl -sS $B/api/v1/cloud/status` returns `data.logged_in == true`,
  `data.user.email == "bob@local.test"`, `data.user.id == BOB_ID`.

### 4. The proof — both instances logged in simultaneously as distinct users

```bash
curl -sS $A/api/v1/cloud/status | python3 -c "import sys,json; d=json.load(sys.stdin)['data']; print('A:', d['logged_in'], d['user']['email'])"
curl -sS $B/api/v1/cloud/status | python3 -c "import sys,json; d=json.load(sys.stdin)['data']; print('B:', d['logged_in'], d['user']['email'])"
```

PASS when:
```
A: True alice@local.test
B: True bob@local.test
```

A FAIL on this assertion (both reporting the same user) means Fix B
(`_user_key()` per-instance partitioning in `app_config.py`) regressed.

### 5. Independence assertions — sharpened (token round-trip + config keys)

Keyring tokens must round-trip to **distinct** users on the hub:

```bash
uv run python3 -c "
import keyring, base64, json
def jwt_payload(t):
    pad = '=' * (-len(t.split('.')[1]) % 4)
    return json.loads(base64.urlsafe_b64decode(t.split('.')[1] + pad).decode())
for slot in ('flowpad_api_key', 'flowpad_api_key:dev'):
    tok = keyring.get_password('Flowpad.ai.app_secrets', slot)
    if not tok: print(slot, '→ EMPTY'); continue
    p = jwt_payload(tok)
    print(slot, '→', p.get('email'))
"
```

PASS when:
- `flowpad_api_key → bob@local.test`
- `flowpad_api_key:dev → alice@local.test`

`config.json` must hold both records side-by-side without overwrite (path is
macOS-specific — `platformdirs.user_config_dir("flow-cli")`):

```bash
python3 -c "
import json, os
p = os.path.expanduser('~/Library/Application Support/flow-cli/config.json')
d = json.load(open(p))
print('user.email:    ', (d.get('user') or {}).get('email'))
print('user:dev.email:', (d.get('user:dev') or {}).get('email'))
"
```

PASS when:
- `user.email == bob@local.test`
- `user:dev.email == alice@local.test`

A FAIL where one of these is `None` or both are the same email means Fix B
regressed (`_user_key()` not actually consulted by `set_user`/`get_user`).

### 6. Real conversation through the local hub — alice ↔ bob

Each user holds their own JWT; alice creates a hub-side Project and starts a
guest conversation addressed to bob by id. Recipient is auto-added as
participant + granted `member` role on the conversation entity (see
`test_flowpad/FlowPad/flowpad/hub/builtin/project.py:188-211`).

```bash
ALICE_TOK=$(uv run python3 -c "import keyring; print(keyring.get_password('Flowpad.ai.app_secrets','flowpad_api_key:dev'))")
BOB_TOK=$(uv run python3 -c "import keyring; print(keyring.get_password('Flowpad.ai.app_secrets','flowpad_api_key'))")

# alice creates a project on the hub
PROJ=$(curl -s -X POST "$HUB/api/v1/graph/project" \
  -H "Content-Type: application/json" -H "Authorization: Bearer $ALICE_TOK" \
  -d '{"name":"alice-bob-chat"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['id'])")

# alice starts the conversation addressed to bob by id, first message "hi"
CONV=$(curl -s -X POST "$HUB/api/v1/graph/project/$PROJ/start_guest_conversation" \
  -H "Content-Type: application/json" -H "Authorization: Bearer $ALICE_TOK" \
  -d "{\"text\":\"hi\",\"receiver_address\":\"$BOB_ID\",\"receiver_address_type\":\"id\"}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['id'])")
```

PASS when both calls return `status=SUCCESS` and yield non-empty UUIDs.

Bob discovers and reads the conversation:

```bash
curl -s -H "Authorization: Bearer $BOB_TOK" "$HUB/api/v1/graph/conversation"
curl -s -H "Authorization: Bearer $BOB_TOK" "$HUB/api/v1/graph/conversation/$CONV/flow_message"
```

PASS when:
- The list response's `data` array contains the conversation `$CONV`.
- The flow_message response includes one entry with `text == "hi"` and
  `sender_id == ALICE_ID`.

A FAIL where the list returns `[]` or the GET returns 401 means either:
- The running hub binary predates the WIP `start_guest_conversation`
  receiver-address branch — restart the hub and retry.
- The `flow_message` policy's `member` role is missing `read`/`watch`.

Bob replies:

```bash
curl -s -X POST "$HUB/api/v1/graph/conversation/$CONV/add_message" \
  -H "Content-Type: application/json" -H "Authorization: Bearer $BOB_TOK" \
  -d '{"text":"whats app"}'
```

PASS when `status=SUCCESS` and the returned `data.text == "whats app"`.

Alice reads back the full transcript:

```bash
curl -s -H "Authorization: Bearer $ALICE_TOK" "$HUB/api/v1/graph/conversation/$CONV/flow_message" \
  | python3 -c "
import sys,json
msgs = sorted(json.load(sys.stdin)['data'] or [], key=lambda m: m.get('created_date') or '')
for m in msgs:
    sid = (m.get('sender_id') or '')[:8]
    role = 'alice' if sid.startswith('${ALICE_ID:0:8}') else ('bob' if sid.startswith('${BOB_ID:0:8}') else sid)
    print(role, ':', repr(m.get('text')))
"
```

PASS when the transcript shows exactly:
```
alice : 'hi'
bob : 'whats app'
```

Repeat one more round-trip (alice sends `"all good?"`, bob replies, alice
sends a final message). PASS when each subsequent
`/conversation/$CONV/flow_message` GET — issued by either user — returns the
same chronologically-ordered transcript.

### 7. Live rendering inside both browsers (optional but recommended)

Inject a polling panel into each browser tab to confirm both UIs surface
the same hub-side conversation in near real time. Each tab fetches the
conversation directly from the hub with its user's JWT (extracted via
`keyring` to avoid baking secrets into source). Suggested polling interval:
2 s.

PASS when both panels show the identical message list within one polling
cycle of any new `add_message` call.

This step is optional because the OSS UI does not yet natively render
hub-side conversations — the polling panel is a visibility scaffold, not a
shipped feature. The HTTP assertions in step 6 are the binding pass criterion.

### 8. Logout independence — A first

```bash
curl -s -X POST $A/api/v1/cloud/logout
sleep 1
curl -s $A/api/v1/cloud/status | python3 -c "import sys,json; d=json.load(sys.stdin)['data']; print('A logged_in:', d['logged_in'])"
curl -s $B/api/v1/cloud/status | python3 -c "import sys,json; d=json.load(sys.stdin)['data']; print('B email:', (d.get('user') or {}).get('email'))"
```

PASS when:
- A reports `logged_in: false`.
- B reports `email: bob@local.test` (untouched).
- Keyring slot `flowpad_api_key:dev` is now empty; `flowpad_api_key` still
  holds bob's JWT.
- `config.json` lost its `user:dev` record (or its value is `{}`); the
  `user` record still resolves to bob.

### 9. Logout independence — B second

```bash
curl -s -X POST $B/api/v1/cloud/logout
sleep 1
curl -s $A/api/v1/cloud/status | python3 -c "import sys,json; d=json.load(sys.stdin)['data']; print('A logged_in:', d['logged_in'])"
curl -s $B/api/v1/cloud/status | python3 -c "import sys,json; d=json.load(sys.stdin)['data']; print('B logged_in:', d['logged_in'])"
```

PASS when:
- B reports `logged_in: false`.
- A still reports `logged_in: false` (no flip back to alice — Fix A would
  regress if A's status flips to alice after B's logout, indicating shared
  keyring slot).
- Both keyring slots are now empty.

## Failure modes & first-pass debugging

| Symptom | Likely cause | First check |
|---|---|---|
| Step 4: both `/cloud/status` return same user | Fix B regression — `app_config.py` ignoring `_user_key()` | grep `'user'` literal in `flow_sdk/cli/app_config.py` get_user/set_user/clear_user |
| Step 9: A flips back to alice after B logout | Fix A regression — same keyring slot | confirm `_api_key_name()` returns `flowpad_api_key:dev` for dev instance |
| Step 6: bob's `GET /conversation` returns `[]` | Running hub predates WIP code | restart hub: kill PID on `:8093`, re-run `flowpad/run.py` |
| Step 6: bob gets 401 on `/conversation/$CONV` | `flow_message` entity policy missing `member.read` | inspect `flowpad/hub/app/policies.json` |
| Step 2/3: avatar click does not open dropdown | Synthetic click vs Radix UI | use `dispatchEvent(new MouseEvent('click', …))` rather than HTMLElement.click() |
| Step 1: backend exits with "Server already running" | Stale singleton lock | kill PID in `~/.flow/dev_server.json` (or `~/.flow/server.json`) and retry |
| Step 4: Step works but step 5 sees `EMPTY` keyring slot | macOS Keychain not unlocked / not approved for the test process | manually unlock Keychain Access; re-run after the prompt |
| `cloud_url` shows `https://staging.flowpad.ai/api/v1` instead of `:8093` | parent shell exported `FLOWPAD_HUB_URL=https://...` overriding `.env.local` | `printenv FLOWPAD_HUB_URL` in the terminal that launched the backend |

## Teardown

The hub project + conversation are scratch data — leave them in place between
runs (they're scoped per-user and don't pollute other tests). If a clean run
is required:

```bash
curl -s -X DELETE -H "Authorization: Bearer $ALICE_TOK" "$HUB/api/v1/graph/project/$PROJ"
```

Local instances retain their cloud-login state in `config.json` + keyring;
re-run step 8/9 to clear, or wipe manually:

```bash
keyring del Flowpad.ai.app_secrets flowpad_api_key
keyring del Flowpad.ai.app_secrets flowpad_api_key:dev
python3 -c "
import json, os
p = os.path.expanduser('~/Library/Application Support/flow-cli/config.json')
d = json.load(open(p)); d.pop('user', None); d.pop('user:dev', None)
json.dump(d, open(p,'w'), indent=2)
"
```
