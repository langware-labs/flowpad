---
title: Secured transfer cards update live in an open conversation
tags: [breadcrumb.test.sealed_live_refresh.rules]
description: The receiver's ack is a hub-only message pushed as an UNCHANGED conversation update; SealedValuesPanel must re-read on app.entity.updated (serialized), and the receiver keeps its answered card in answered.json.
---
# Secured transfer cards update live in an open conversation

> Ground truth. Proven by RCA on 2026-11-11 (QA cycle qa-20261109-230009, i21). Do not edit without the user's approval.

```breadcrumb
tag: breadcrumb.test.sealed_live_refresh.rules
sites:
  - rel_path: "ui/tests/hub/credential_secure_share_two_client.ui.test.ts"
    line: 89
    note: "FAILING at 'Alice sees Delivered'? read this tag's rules \u2014 the open card must update live, never reload to pass"
```

## Expected behavior
- Alice has the conversation open. Bob fills (or declines). Without a reload, Alice's card line turns **Delivered**
  (`data-stage="filled"`) and then shows the test state (`data-test`) once Bob's `validated` ack lands.
- Bob's own card stays "Filled in" / "Declined" after Alice's Flowpad has cleared the envelope.

## Internals
- Acks (`sealed_ack`) are hub-only kinds (`FlowMessageKind.hub_only`, `flow_sdk/builtin/flow_message.py`): never a local row.
  On a live arrival `flow_sdk/cloud_client/hub_bridge.py` calls `sealed_transfer.on_sealed_arrival`, which calls
  `conv.notify_updated()`: a push with the conversation **unchanged** (no save, `updated_date` stays put).
- `ui/src/components/conversation/SealedValuesPanel.tsx` got `version = conversation.updated_date` from
  `ConversationView.tsx`. That alone never moves for an ack. The panel now also re-reads on
  `useOnTag('app.entity.updated', …, { target: 'conversation:<id>' })` (the store re-emits every data op,
  `ts_sdk/src/FlowSync/entity.onTag.ts`).
- Reads are serialized in the panel: a push that lands while a read is in flight sets `again` and is read after it.
  Two acks arrive ~0.3 s apart (`filled`, then `validated`), and only one GET was observed for the two pushes;
  answers are applied in order.
- Once every recipient answered, the **sender's** `_sent` read deletes the envelope from the hub
  (`flow_sdk/secrets/sealed_transfer.py` `_sent` → `_remove`). The receiver's `_incoming` built cards only from
  envelopes, so its answered card vanished on the next read. Now `fill`/`decline` → `_answer(..., card=_card_of(...))`
  keep the card (names only) in the state dir's `answered.json`; `_incoming` shows it from that record plus the hub's ack.

## Invariants
- An open card never needs a reload to reflect an answer.
- No value is ever stored in `answered.json` or sent to the page: names, ids, sender and state only.
- The sender still removes the envelope once everyone answered.

## Failure modes
- `pollUntil(Alice sees Delivered)` with Alice's backend already at `filled`
  (`GET /credentials/sealed/state` shows `recipients: {bob: filled}`): the panel is not re-reading on pushes.
  Lever: revert only SealedValuesPanel.tsx and the e2e fails here again; with it, it passes. Seen: 90 s pending on an open page.
- Delivered shows but `data-test` never does: a push folded into an in-flight read (unit test
  `ui/tests/unit/sealed-values-panel-receivers.test.tsx`, "a push that lands while a read is in flight").
- Bob's card disappears right after Fill: the receiver lost its answered card (pytest
  `test_the_receivers_answered_card_stays_after_the_sender_clears_the_envelope`).
- Never "fix" this by reloading in the test: a page on the dev frontend takes ~20 s to show the panel, and a
  person watching the conversation does not reload.
