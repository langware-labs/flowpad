---
id: fb644ccc-ebd7-4af8-adf8-2451e3aa3ed1
name: e2e-qa-on-vm
description: Unattended E2E QA run on the QA VM — verifies credentials, reinstalls a clean release/v0.2 checkout, cuts a dated QA branch, delegates to the e2e-qa skill, then commits, pushes and emails the HTML report. Use for "qa run on vm", "nightly qa", "e2e qa on vm".
tags:
- testing
- e2e
- qa
- ci
allowed-tools: Read, Write, Edit, Bash, Grep, Glob, Skill
---

# E2E QA on the VM

End-to-end QA cycle on the QA VM, from a clean checkout through to an emailed
report. Every phase below is mandatory and ordered; **stop on the first failed
preflight check** rather than continuing into a destructive step.

## Constants

```bash
WORKSPACE_DIR="$HOME/Flowpad workspace"
APP_DIR="$WORKSPACE_DIR/flowpad"
BASE_BRANCH="release/v0.2"
CLONE_URL="git@github-flowpad:langware-labs/flowpad.git"
REPORT_TO="tzahi@langware.ai"
MAIL_ENV="$HOME/.config/flowpad-qa/mail.env"
SOD_DIR="$HOME/sod"
RESULTS_DIR="ui/tests/manual_regression/_results"
```

`github-flowpad` is a `Host` alias in `~/.ssh/config` bound to the repo-scoped
deploy key `~/.ssh/flowpad_deploy_key`. Do not substitute `github.com` — the
default identity has no access.

---

## Phase 0 — Preflight (all four must pass)

Run all four before touching the filesystem. **If any fails, report which one
and stop.** Phase 2 deletes the workspace; never reach it on a VM that cannot
finish the run. Each check proves a capability the run depends on *later* —
write access, a working mail credential, the app, the ports file — because
every one of those failing after Phase 2 costs the whole cycle.

### 0.1 Git write permission

Authentication alone is not enough — a read-only deploy key authenticates fine
and then fails at push time, after the tests have already run.

```bash
ssh -o BatchMode=yes -T github-flowpad 2>&1 | head -1
# expect: Hi langware-labs/flowpad! You've successfully authenticated...

cd "$APP_DIR" && GIT_SSH_COMMAND="ssh -o BatchMode=yes" \
  git push --dry-run "$CLONE_URL" HEAD:refs/heads/qa-write-probe-dryrun 2>&1
# expect: * [new branch] ... -> qa-write-probe-dryrun
```

`--dry-run` reaches `git-receive-pack`, which a read-only key cannot open, so
this proves write access **without creating the ref**. Confirm nothing was left
behind:

```bash
git ls-remote --heads "$CLONE_URL" 'qa-write-probe*'   # must print nothing
```

### 0.2 SendGrid API key present **and valid**

```bash
[[ -f "$MAIL_ENV" ]] || { echo "FAIL: $MAIL_ENV missing"; exit 1; }
set -a; source "$MAIL_ENV"; set +a
[[ -n "${SMTP_PASS:-}" && -n "${SMTP_URL:-}" && -n "${SMTP_FROM:-}" ]] \
  || { echo "FAIL: SMTP_* incomplete in $MAIL_ENV"; exit 1; }
```

A non-empty variable only proves a key was written, not that it still works —
and a rotated or revoked key would then fail in Phase 6, after the whole cycle
has run and the VM is about to stop. Authenticate for real. `-X "NOOP"` does
EHLO + AUTH and disconnects, so this **sends no mail**:

```bash
curl --silent --show-error --ssl-reqd --url "$SMTP_URL" \
  --user "${SMTP_USER}:${SMTP_PASS}" -X "NOOP" --max-time 30 -v 2>&1 \
  | sed "s/${SMTP_PASS}/***/g" | grep -qE '^< 235 ' \
  || { echo "FAIL: SendGrid rejected the key (no 235)"; exit 1; }
```

Same reasoning as the `--dry-run` push probe in 0.1: prove the credential works
now, not after the expensive part.

Never echo `SMTP_PASS`. The file is `0600` and holds a live SendGrid key;
mask it (`sed "s/${SMTP_PASS}/***/g"`) in any command output you surface.

The local exim4 is `dc_eximconfig_configtype='local'` with no smarthost and
cannot deliver off-box, and langware.ai publishes `p=reject` DMARC — so mail
**must** go through SendGrid, which DKIM-signs as `langware.ai`. Do not fall
back to `mail`/`sendmail`.

### 0.3 FlowPad installed

FlowPad runs as a standalone `uv tool install flowpad` — it is **not** built
from the checkout below.

```bash
which flow && flow --help >/dev/null 2>&1 || { echo "FAIL: flow not installed"; exit 1; }
uv tool list | grep -m1 flowpad
```

### 0.4 Preserved `.env.local` is available

Phase 4 restores `~/sod/.env.local` into the fresh clone, and the e2e-qa skill
cannot start without the ports it carries. Check it **here**, before Phase 2
deletes anything — otherwise the run wipes the workspace and only then
discovers it has nothing to restore.

```bash
[[ -f "$SOD_DIR/.env.local" ]] || { echo "FAIL: $SOD_DIR/.env.local missing"; exit 1; }
grep -qE '^LOCAL_SERVER_PORT=' "$SOD_DIR/.env.local" \
  && grep -qE '^VITE_PORT=' "$SOD_DIR/.env.local" \
  || { echo "FAIL: $SOD_DIR/.env.local lacks LOCAL_SERVER_PORT / VITE_PORT"; exit 1; }
```

On a VM built from a fresh image this file will not exist until it is seeded
once — see Phase 4.

---

## Phase 1 — Upgrade FlowPad

```bash
flow upgrade
```

This upgrades the standalone tool install (`~/.local/share/uv/tools/flowpad`).
It touches nothing in the checkout.

---

## Phase 2 — Preserve `.env.local`, then wipe the workspace

`.env.local` is gitignored (`.gitignore:229`), so a fresh clone will **not**
contain it — and the e2e-qa skill sources it for `LOCAL_SERVER_PORT` and
`VITE_PORT`. Keep it outside the workspace, in `~/sod`, so it survives the wipe
and persists between runs.

```bash
mkdir -p "$SOD_DIR"
[[ -f "$APP_DIR/.env.local" ]] && cp -a "$APP_DIR/.env.local" "$SOD_DIR/.env.local"
[[ -f "$SOD_DIR/.env.local" ]] || { echo "FAIL: no .env.local to restore later"; exit 1; }

rm -rf "$WORKSPACE_DIR"/*
```

Note the quoting: the glob must sit **outside** the quotes. `"$WORKSPACE_DIR/*"`
quotes the asterisk and matches nothing, while an unquoted
`~/Flowpad workspace/*` splits on the space and would target `~/Flowpad`.

> **Destructive and irreversible.** This clears the entire workspace, not just
> the checkout — every FlowPad project directory beside `flowpad` goes with it,
> and `rm -rf` takes `.git` too, so uncommitted work, untracked files and
> **git stashes** are unrecoverable. This VM is expected to hold nothing of
> value between runs. Do not run this skill on a machine someone develops on.

`*` does not match dotfiles, so a top-level `.claude/` in the workspace is left
in place. That is intentional; remove it explicitly if a run needs it gone.

---

## Phase 3 — Clone `release/v0.2`

```bash
mkdir -p "$WORKSPACE_DIR"
cd "$WORKSPACE_DIR"
git clone --branch "$BASE_BRANCH" --single-branch "$CLONE_URL"
```

`.env.local` is restored in Phase 4, once the QA branch exists.

### Refresh the user-level copy of this skill

This skill must exist **outside** the workspace, because `flowpad-qa.service`
runs `claude` with `WorkingDirectory=/home/claudeuser` — project-skill
discovery therefore looks in `~/.claude/skills/`, not in the checkout. A copy
that lives only in the repo is invisible to the unit, and Phase 2 deletes the
checkout anyway, so pointing the cwd at it is not an option either.

That leaves a second copy, and a second copy drifts. Re-sync it from the clone
that was *just* fetched, so every run picks up whatever `release/v0.2` now says:

```bash
USER_SKILL="$HOME/.claude/skills/e2e-qa-on-vm"
rm -rf "$USER_SKILL"
mkdir -p "$USER_SKILL"
cp -a "$APP_DIR/.claude/skills/e2e-qa-on-vm/." "$USER_SKILL/"
```

`cp -a` after a `rm -rf`, not `rsync --delete`: the QA image has no `rsync`, and
a plain `cp -a` over an existing directory would leave files behind that the
skill has since deleted.

The refresh lands here, after the clone, rather than at the start: it takes
effect from the **next** run, since the current process already loaded the
version it is executing. That is intentional — a run always finishes under the
skill it started with, and never swaps its own instructions mid-flight.

On a VM built from a fresh image the user-level copy must be seeded once by
hand, or the very first run has no skill to invoke.

---

## Phase 4 — Cut the QA branch

Always branch from the **freshly fetched** `origin/release/v0.2`, never from
whatever the checkout happens to be sitting on.

```bash
cd "$APP_DIR"
git fetch --no-tags origin "+refs/heads/${BASE_BRANCH}:refs/remotes/origin/${BASE_BRANCH}"
BASE_SHA="$(git rev-parse --verify "refs/remotes/origin/${BASE_BRANCH}")"

QA_BRANCH="$(date -u +%Y%m%d-%H%M%S)-qa-e2e-agent"
git switch -c "$QA_BRANCH" "$BASE_SHA"
```

Then restore the preserved env file into the fresh checkout:

```bash
cd "$APP_DIR"
cp "$SOD_DIR/.env.local" .env.local
```

Without this the e2e-qa skill has no `LOCAL_SERVER_PORT` / `VITE_PORT` and the
cycle cannot start. On a first-ever run with no `~/sod/.env.local`, seed it from
`.env.local.example`, fill in the ports, and copy it back to `$SOD_DIR`.

Record `QA_BRANCH`, `BASE_SHA` and the UTC start time — the report needs all
three. If you persist them to a file, **quote the values**: `APP_DIR` contains
a space (`Flowpad workspace`), and an unquoted value breaks `source`.

---

## Phase 5 — Run the QA cycle

Delegate to the sibling skill and let it own the test run. Invoke it as a
nested `claude` run **whose working directory is the checkout**:

```bash
cd "$APP_DIR"
claude -p "/e2e-qa qa cycle" --dangerously-skip-permissions \
  --output-format stream-json --verbose
```

`--output-format stream-json --verbose` is not decoration. Plain `claude -p`
emits the **final result only** — nothing while it works. Under
`flowpad-qa.service` that means an empty journal for the whole cycle, so a run
that wedges gives you `TimeoutStartSec=4h` of silence and then a poweroff, and
the journal tail `qa-finalize.sh` mails you contains nothing about where it
stopped. Streaming puts each step in the journal as it happens, which is the
only forensic record an unattended run leaves behind.

Not `Skill(skill="e2e-qa", …)` from this process. Two reasons, and both bite:

* **Discovery.** `e2e-qa` is a project skill living in
  `$APP_DIR/.claude/skills/`. This process was started by `flowpad-qa.service`
  with `WorkingDirectory=/home/claudeuser`, so it only ever sees
  `~/.claude/skills/` — `e2e-qa` is not in its skill list and the call cannot
  resolve.
* **Relative paths.** `e2e-qa` reads `.env.local`, `ui/tests/manual_regression/`
  and `.claude/skills/e2e-qa/e2e_qa_cleanup.py` as repo-relative. Copying it to
  `~/.claude/skills/` would fix discovery and break every one of those paths.
  It has to run *in* the checkout, which is exactly what the nested run gives
  it.

It writes results to `ui/tests/manual_regression/_results/<timestamp>/`,
including `report.html` built from its `templates/report.html`. Capture that
`<timestamp>` — Phase 6 needs the exact path.

```bash
REPORT_PATH="$(ls -1dt "$APP_DIR/$RESULTS_DIR"/*/report.html | head -1)"
RESULT_ID="$(basename "$(dirname "$REPORT_PATH")")"
```

Do not proceed until the cycle has finished and `report.html` exists.

---

## Phase 6 — Commit, push, email

### 6.1 Commit

The checkout is disposable and freshly cloned, so everything present is either
tracked or was produced by this run:

```bash
cd "$APP_DIR"
git add -A
git -c user.name="flowpad-qa-e2e-agent" \
    -c user.email="qa-e2e-agent@langware.ai" \
    commit -m "QA e2e agent run ${RESULT_ID}"
```

### 6.2 Push

Push **only** the QA branch ref. Never push `release/v0.2`, never `--force`.

```bash
GIT_SSH_COMMAND="ssh -o BatchMode=yes" \
  git push "$CLONE_URL" "refs/heads/${QA_BRANCH}:refs/heads/${QA_BRANCH}"
```

`BatchMode=yes` fails fast instead of blocking on a passphrase prompt when
there is no tty.

### 6.3 Email the branch and the report

Send `report.html` as an attachment so the formatting survives, with the branch
details in the body.

```bash
set -a; source "$MAIL_ENV"; set +a
BOUNDARY="qa-$(date -u +%s)"
MSG="$(mktemp)"
{
  echo "From: FlowPad QA agent <${SMTP_FROM}>"
  echo "To: ${REPORT_TO}"
  echo "Subject: [FlowPad QA] ${QA_BRANCH}"
  echo "Date: $(date -uR)"
  echo "MIME-Version: 1.0"
  echo "Content-Type: multipart/mixed; boundary=\"${BOUNDARY}\""
  echo
  echo "--${BOUNDARY}"
  echo "Content-Type: text/plain; charset=utf-8"
  echo
  echo "Branch     : ${QA_BRANCH}"
  echo "Base       : ${BASE_BRANCH} @ ${BASE_SHA}"
  echo "Result id  : ${RESULT_ID}"
  echo "Branch URL : https://github.com/langware-labs/flowpad/tree/${QA_BRANCH}"
  echo "Host       : $(hostname)"
  echo "FlowPad    : $(uv tool list | grep -m1 flowpad)"
  echo
  git log --oneline "${BASE_SHA}..HEAD"
  echo
  git diff --stat "${BASE_SHA}..HEAD" | tail -30
  echo
  echo "--${BOUNDARY}"
  echo "Content-Type: text/html; charset=utf-8"
  echo "Content-Disposition: attachment; filename=\"report-${RESULT_ID}.html\""
  echo "Content-Transfer-Encoding: base64"
  echo
  base64 "$REPORT_PATH"
  echo "--${BOUNDARY}--"
} > "$MSG"

curl --silent --show-error --ssl-reqd \
  --url "$SMTP_URL" --user "${SMTP_USER}:${SMTP_PASS}" \
  --mail-from "$SMTP_FROM" --mail-rcpt "$REPORT_TO" \
  --upload-file "$MSG" --max-time 180
rm -f "$MSG"
```

A `250 Ok: queued as ...` means SendGrid accepted it. That is acceptance, not
delivery — confirm in the SendGrid Activity Feed if a report goes missing.

---

## Reporting back

Finish with a short summary naming: preflight results, the branch, the commit
SHA, whether the push succeeded, the result id, and whether the mail was
accepted. If any phase failed, say which and what the error was — never report
a run as clean when a phase was skipped.

## Known constraint

This skill lives inside the directory Phase 2 deletes. It survives only if it
is committed to `release/v0.2`, because Phase 3 restores the tree from that
branch. **Commit and push this skill before the first unattended run**, or it
will delete itself and every later run will fail to find it.
