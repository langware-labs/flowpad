---
id: ec5faa3d-6490-480a-9710-bac8ca680a52
name: passkey-infrastructure
description: "The generic access-key piece every protected feature reuses, shown for its first kind, a passkey. Part 1 registers a passkey once - the device makes a key pair and the hub saves only the public key as an AccessKey. Part 2 is one confirmation - any verifier (a hub action or a machine) issues a challenge, the device signs it after a fingerprint, and the verifier checks the signature with the public key. Planned design, not built yet."
  a passkey once - the device makes a key pair and only the public key is stored.
  Part 2 is one confirmation - any verifier (a hub action or a machine) issues a challenge,
  the device signs it after a fingerprint, and the verifier checks the signature with
  the public key. Planned design, not built yet.
format: sequence
session: fe74e9fd-4b8a-4224-bc93-33031fbdbd76
---
Piece 1 of the admin-channel breakdown (`.flow/skills/dev/feature_plans/20261120-passkey-infrastructure.md`). It knows nothing about machines or admin access: it registers passkeys, hands out public keys, and gives one confirm call in the browser and one verify function for whoever needs to check it.
