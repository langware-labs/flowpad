---
id: 760b2d18-4fb9-49ec-afbd-f91bffec8ed3
title: An agent Identity counts as signed in
tags:
- breadcrumb.test.agent_identity_login.rules
description: A box signed in as an agent Identity has no cloudUser by design, so a
  login gate must read the principal, not cloudUser, or it asks a signed-in box to
  log in.
---
# An agent Identity counts as signed in

> Ground truth. Proven by RCA on 2026-11-15 (FLOWPAD-2368). Do not edit without the user's approval.

```breadcrumb
tag: breadcrumb.test.agent_identity_login.rules
sites:
  - rel_path: "ui/tests/unit/stream-inbox-agent-identity-login.test.tsx"
    line: 29
    note: "FAILING? read this tag's rules before editing — an agent Identity is signed in although cloudUser is null"
```

## Expected behavior

A machine the hub signed in as an agent's `Identity` (a deployed agent's VM) is signed in. A data
source page's stream inbox (`StreamInboxView` with `sourceId`, `embedded`) must not show the
"Login required" overlay there. The overlay shows only when nobody is signed in to the hub.

## Internals

- The box learns who it is from the `{status, user, principal, reason}` login block in its bootstrap
  seed (or `GET /cloud/status`). `CloudManager._applyLoginBlock`
  (`ts_sdk/src/services/cloud_login.ts:348`) takes `principal ?? user` (`:358`) — on an agent's box
  `user` is null and `principal` is the Identity.
- `CloudManager._setLoggedIn` (`cloud_login.ts:836`) stores the principal in `CloudPrincipalTypeId`
  and, on purpose, leaves `CloudUserTypeId` null for an Identity (`:851`): the cloud USER slot holds
  a person only. It still sets `setCloudLoggedIn(true)`.
- So on that box: `dataContext.cloudUser` (`ts_sdk/src/FlowSync/context.ts:785`) is null,
  `currentPrincipal` (`:806`) is the `Identity`, `signedInAsIdentity` (`:815`) is true, and
  `cloudLoginStatus` is `logged_in`.
- `StreamInboxView` (`ui/src/components/stream-inbox-view/StreamInboxView.tsx:789`) takes
  `signedIn = useCloudAuthed()` and renders `LoginRequiredOverlay` on `!signedIn` (`:1495`).
  `useCloudAuthed` (`ui/src/hooks/use-cloud-authed.ts:10`) is the shared login-gate predicate: in
  the app it is `cloudLoginAvailable || cloudUser`, and `cloudLoginAvailable` (`context.ts:187`)
  is the `setCloudLoggedIn(true)` above — true for an Identity too.

## Invariants

- "Signed in" means a cloud principal exists — a person OR an Identity. `cloudUser` alone answers
  "is a PERSON signed in", never "is anyone signed in".
- `cloudUser` stays null on an Identity box. Do not "fix" a gate by stuffing the Identity into
  `CloudUserTypeId`: everything that reads `cloudUser` / `currentUser` as a person (email, "me",
  profile) would then treat the agent as a human.
- `currentPrincipal` falls back to the local user, so `!currentPrincipal` is never a logged-out test;
  gate on `useCloudAuthed()`.

## Failure modes

- **Gate on `!cloudUser`** → a signed-in agent box shows "Login required — Sign in to your Flowpad
  Cloud account to view your stream inbox and conversations." Proven on the live VM
  (v0.2.266): setting `CloudUserTypeId` to the Identity removed the overlay; setting it back to
  null brought it back. The test fails with that exact overlay text when the gate reads `cloudUser`.
- The same `!cloudUser` gate exists in `ui/src/components/conversation/ConversationRoute.tsx:325`
  (opening a conversation on an agent box) — not fixed by FLOWPAD-2368.
