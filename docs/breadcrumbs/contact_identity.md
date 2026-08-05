---
title: Contact identity — email OR user_id, never a duplicate
tags:
- breadcrumb.test.contact_identity.rules
description: upsert_contact matches on email or user_id, backfills the missing half, and must never leave two rows for one person.
---
# Contact identity — email OR user_id, never a duplicate

> Ground truth. Proven on 2026-08-05. Do not edit without the user's approval.

```breadcrumb
tag: breadcrumb.test.contact_identity.rules
sites:
  - rel_path: "tests/unit/test_address_book_upsert.py"
    line: 14
    note: "FAILING? one person is one row \u2014 read this tag's rules before editing"
```

## Expected behavior

A contact is identified by an email, a `user_id`, or both. `User.upsert_contact`
resolves an existing row from whichever half it is given, backfills the half it
was missing, and returns the SAME row — one person is always one row.

## Internals

* `User.upsert_contact(email=..., user_id=..., name=...)` is the only sanctioned
  writer for a contact. It matches by email first, then by `user_id`.
* The local id is a minted v4/v5 UUID (`is_valid_entity_id`), never the remote
  user id — a contact known only by email has no remote id yet, and adopting one
  later must not change its identity.
* A second call with more information (a name, the other identifier) is an
  UPDATE of the matched row, not an insert.

## Invariants

* `len(User.get_all({"email": e})) == 1` for any email ever upserted.
* Adopting a `user_id` onto an email-only contact keeps the original row id.

## Failure modes

The on/off lever: make `upsert_contact` insert instead of matching, and the
final `assert len(everyone) == 1` in the bound test fails with 2 — one row per
call. Restore the match-then-backfill and it passes. The symptom in the app is
a contact appearing twice in the address book after they first send a message.

<!-- flowpad:capsule identity
version: 1
data:
  id: 53e9eb02-145f-487c-96ca-cd931ef58532
flowpad:endcapsule identity -->
