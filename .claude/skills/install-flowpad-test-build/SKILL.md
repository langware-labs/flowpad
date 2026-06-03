---

name: install-flowpad-test-build
description: Install and validate a teammate-delivered FlowPad test build. Builds the matching backend from source, installs the provided Electron app, and verifies FlowPad ownership of the SOD key in the OS credential store.
tags:

* setup
* install
* test-build
* flowpad
* keychain
* flow-rs

---

# Install a FlowPad Test Build

Use this skill when a teammate sends:

* a FlowPad desktop installer (.dmg on macOS)
* a branch name to test

The backend and desktop application must come from the same branch.

---

# Parameters

Set these before starting:

```bash
BRANCH_NAME=FLOWPAD-1862
DMG_PATH=~/Downloads/Flowpad-arm64.dmg
WORKDIR=~/Developer/flowpad-$BRANCH_NAME
```

---

# Prerequisites

Verify all prerequisites before proceeding.

```bash
which uv
git --version
```

Verify repository access:

```bash
gh auth status
```

or

```bash
ssh -T git@github.com
```

If any prerequisite fails, stop and report the issue.

---

# Clone And Build

Clone or update the repository:

```bash
if [ ! -d "$WORKDIR" ]; then
  git clone git@github.com:langware-labs/flowpad.git "$WORKDIR"
fi

cd "$WORKDIR"

git fetch origin
git checkout "$BRANCH_NAME"
git pull
```

Build the backend:

```bash
uv sync

source .venv/bin/activate

rm -rf dist build *.egg-info

python build_ui.py
uv build

deactivate
```

---

# Replace Existing FlowPad Installation

```bash
uv tool uninstall flowpad || true
uv cache clean flowpad --force || true

uv tool install \
  --reinstall \
  --force \
  ./dist/flowpad-*.whl
```

---

# Install Desktop Application

```bash
open "$DMG_PATH"
```

In Finder:

1. Drag FlowPad.app into Applications
2. Replace existing installation if prompted
3. Eject the DMG
4. Launch FlowPad.app

---

# Verify Backend Installation

```bash
flow
```

Verify static assets exist:

```bash
STATIC_DIR=~/.local/share/uv/tools/flowpad/lib/python*/site-packages/flow_sdk/server/static/assets

find $STATIC_DIR -name "index-*.js" | head
```

---

# Verify Desktop Installation

Verify application signature:

```bash
codesign -dv --verbose=4 \
  /Applications/Flowpad.app
```

Verify:

* Identifier
* Authority
* TeamIdentifier

---

# Verify flow-rs Binary Exists

```bash
ls -l \
/Applications/Flowpad.app/Contents/Resources/flow-rs/flow-rs
```

Verify binary executes:

```bash
/Applications/Flowpad.app/Contents/Resources/flow-rs/flow-rs --version
```

Verify binary signature:

```bash
codesign -dv --verbose=4 \
  /Applications/Flowpad.app/Contents/Resources/flow-rs/flow-rs
```

Verify:

* Identifier
* Authority
* TeamIdentifier
* Runtime Version

---

# Verify Keychain Migration

Launch FlowPad.

Log in using the normal cloud login flow.

Wait until the application is fully initialized.

Open:

```text
Keychain Access
```

Search for:

```text
Flowpad.ai.sod_key
```

---

# Success Criteria

Open the keychain item.

Navigate to:

```text
Access Control
```

Expected:

```text
flow-rs
```

must appear in the trusted applications list.

Expected:

```text
python3.*
```

must NOT appear.

This is the primary validation that the migration succeeded.

---

# Secondary Validation

Navigate to:

```text
Attributes
```

Expected Account value:

```text
prod.flow-rs
```

If the account still contains the legacy value:

```text
prod
```

the migration likely did not run.

---

# Verify No Python Keychain Prompt

After login:

Expected:

```text
No dialog stating:

python3.12 wants to use your confidential information...
```

If such a prompt appears:

* migration failed
* Python is still directly accessing the keychain
* FlowPad ownership was not established

Capture a screenshot and collect logs.

---

# Verify Application Behavior

Confirm:

* login succeeds
* secrets can be accessed
* SecretApprovalDialog behaves correctly
* application restarts successfully
* no new keychain prompts appear on restart

---

# Collect Diagnostic Logs

```bash
LATEST_MAIN=$(ls -t ~/.flow/logs/main_desktop/*.log | head -1)

LATEST_SERVER=$(ls -t ~/.flow/instances/prod/logs/server/*.log | head -1)

grep -Ei \
"flow-rs|sod_key|keychain|secret|seed|migrate" \
"$LATEST_MAIN" \
"$LATEST_SERVER" | tail -100
```

---

# Failure Conditions

Report immediately if any of the following occur:

* flow-rs binary missing
* flow-rs binary fails to execute
* flow-rs binary not signed
* Keychain Access still shows python3.12 ownership
* python3.12 keychain prompt appears
* login fails
* secrets cannot be decrypted
* application requires repeated approvals after restart

---

# Expected Outcome

Successful migration means:

Electron
↓
flow-rs
↓
OS Keychain

and NOT:

Electron
↓
python3.12
↓
OS Keychain

The user should experience a single trusted FlowPad identity with no Python-attributed keychain prompts.
