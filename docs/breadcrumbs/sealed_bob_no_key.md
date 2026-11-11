---
title: "'Bob installs later' needs a Bob with no device key on the hub"
tags: [breadcrumb.test.sealed_bob_no_key.rules]
description: Withdraw removes only THIS install's advert, by design; any other key on Bob's hub user (another instance on a shared hub DB) is correctly sealed for, so the test must run with Bob as the only Flowpad of his user.
---
# 'Bob installs later' needs a Bob with no device key on the hub

> Ground truth. Proven by RCA on 2026-11-11 (QA cycle qa-20261109-230009, i21). Do not edit without the user's approval.

```breadcrumb
tag: breadcrumb.test.sealed_bob_no_key.rules
sites:
  - rel_path: "ui/tests/hub/credential_secure_share_two_client.ui.test.ts"
    line: 89
    note: "FAILING with 'sealed for 1' or 'other device key'? read this tag's rules \u2014 isolate Bob's hub user, do not change withdraw"
```

## Expected behavior
- Bob turns secure receiving off (`preferences.sharing.secure_receiving=false` in `$FLOW_HOME/instances/<Bob>/preferences.json`)
  and publishes. His key leaves the hub, and Alice's share promises ("will get them when they open the message in Flowpad").

## Internals
- `flow_sdk/secrets/sealed_transfer.py` `withdraw_device_key` deletes only the adverts that are this install's:
  its keyring device id, the last published id, or ids starting with this `instance_uid`. Another install's advert
  for the same user is left alone, on purpose: that Flowpad can still receive.
- Alice seals for every trusted advert `member_keys` returns (`GET conversation/<id>/list_members/device_keys`),
  so one foreign key → "Values sealed for 1 recipient(s)."
- The test checks `GET /graph/user/<bob>/device_key` (as Bob) after the withdraw and throws naming any leftover device id.
- `instanceDataDir(name)` in `ui/tests/hub/_instances.ts` resolves `$FLOW_HOME/instances/<name>` (default `~/.flow`).
  A hardcoded `os.homedir()/.flow` made beforeAll throw ENOENT, so both tests skipped silently.

## Invariants
- Withdraw never revokes another install's key.
- The scenario holds only when Bob's hub user has no key after the withdraw.

## Failure modes
- `expected 'Values sealed for 1 recipient(s).' to match /will get them…/` (before the precondition existed),
  or now "Bob's hub user still has N device key(s) from another install": a key left by another instance
  (a shared hub DB, a second Bob instance). Use a fresh hub DB or fresh users; do not change withdraw.
  Lever: a second Bob instance publishing on the same hub fails the test at once; delete that advert and it passes.
- Both tests skipped with ENOENT on preferences.json: an instance under a non-default FLOW_HOME and a path that ignores it.
  Other hub files still hardcode `~/.flow` (e.g. `credential_secure_share_two_client.test.ts`, `credential_secure_share_later_two_client.test.ts`).
