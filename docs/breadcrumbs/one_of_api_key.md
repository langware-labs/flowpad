---
id: 2e0bc8ca-b6eb-4aea-82b8-ed61055c59a6
title: An API-key permission follows its ONE_OF credential's way
tags:
- breadcrumb.test.one_of_api_key.rules
description: A driver's api_key permission that names one member of a ONE_OF credential
  (Slack's SLACK_USER_TOKEN) is granted by whichever way the credential actually uses
  — bot token, user token or sign-in. Requiring the named variable alone refused every
  Slack source on a bot token at the deploy gate.
---
# An API-key permission follows its ONE_OF credential's way

> Ground truth. Proven by RCA on 2026-11-08 (FLOWPAD-2339, PR #786). Do not edit without the user's approval.

```breadcrumb
tag: breadcrumb.test.one_of_api_key.rules
sites:
  - rel_path: "tests/unit/test_credential_asset/test_cloud_deployment_secrets.py"
    line: 289
    note: "FAILING? read this tag's rules before touching readiness() api-key branch or _needed_names"
```

## Expected behavior

A Slack source connected through its **bot token** (or a Slack sign-in) passes the
deploy readiness check, and "use mine" copies the token the source actually runs on
(`SLACK_BOT_TOKEN`) to the cloud deployment. No `SLACK_USER_TOKEN` is asked for.

## Internals

* **The driver names one variable per permission.** In
  `flow_sdk/system_projects/flowpad_assistant/agentic-assets/data_driver/slack/data_driver.json`
  every `permission.slack.*` mapping is `mechanism: api_key`, `api_key: SLACK_USER_TOKEN`.
* **The credential offers three ways.** The `slack_channel` credential
  (`.../slack/agentic-assets/credential/slack_channel/credential.json`) declares
  `SLACK_BOT_TOKEN` (way `bot`), `SLACK_USER_TOKEN` (way `app`) and `SLACK_SIGNIN`
  (way `signin`, OAuth), all `required: ONE_OF`. Any one of them holds the credential.
* **Readiness resolves both kinds of requirement in one place.**
  `readiness()` in `flow_sdk/builtin/readiness.py:348` builds
  `one_of = {env_var: row}` for every ONE_OF member (`readiness.py:381`), and the inner
  `credential_item()` (`readiness.py:385`) turns a credential row plus declared names into
  an item via `_needed_names()` (`readiness.py:308`).
* **The fix.** In the api-key branch of `item()` (`readiness.py:413`), when
  `mapping.api_key` is a ONE_OF member, the permission goes through
  `credential_item(req, row, [mapping.api_key])` — the same path a credential
  requirement takes. `_needed_names()` keeps a declared group member only while it is the
  active way (`active_way()` in `flow_sdk/schema/data_spec/credential_status_spec.py:135`),
  and otherwise substitutes the way in use.
* A variable that is **not** a ONE_OF member still goes straight to `_values_item()` with
  just that variable, as before.

## Invariants

* A permission whose `api_key` is a ONE_OF member is granted exactly when its credential
  would be: the active way's values present, or a sign-in held on this computer
  (`declared`, "signed in on this computer").
* The names a permission item asks for (and "use mine" copies) are the active way's
  values, never a sibling way the user did not choose.
* Credential requirements and api-key permissions over the same ONE_OF group must agree;
  they share `credential_item()` so they cannot drift.

## Failure modes

* **Before the fix:** the api-key branch called
  `_values_item(req, [mapping.api_key], ...)` directly, so a source on its bot token was
  `missing` `SLACK_USER_TOKEN` for every Slack permission and the deploy gate refused it;
  "use mine" copied nothing. Removing the two-line ONE_OF lookup in the api-key branch
  brings this back (the bound test fails on `copied["copied"] == ["SLACK_BOT_TOKEN"]`).
* Changing `_needed_names()` so a declared group member is always kept would reintroduce
  the same refusal through the shared path.
