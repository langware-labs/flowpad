---
id: a3e435c7-6c2c-4ce9-b591-fd550b0c64c0
name: secure-send-credentials
description: Proposed design — how a credential's values travel from one conversation
  member to another without a secret manager. Each device advertises a signed public
  key into the conversation; the sender's backend seals the values to the receiver's
  devices; the receiver's backend decrypts and writes them into its own store. Ends
  with the credential connected on the receiver and the sealed envelope deleted from
  the hub.
format: sequence
session: ''
version: 2
---
Design proposal (not built). The hub only relays opaque ciphertext; private keys stay in each instance's vault.

<!-- BEGIN chart:auto -->
```mermaid
sequenceDiagram
  participant rcv as Receiver backend<br/>Shlomi's Flowpad instance
  Note over rcv: private keys in the instance vault (sodot)
  participant hub as Hub<br/>relay · sees ciphertext only
  Note over hub: must mirror 2 new message kinds
  participant snd as Sender backend<br/>Eran's Flowpad instance
  Note over snd: reads values from its own store
  participant user as Sender<br/>person, in Flowpad UI
  Note over user: send is human-only
  rcv->>rcv: create device keys
  Note right of rcv: Ed25519 sign + X25519 enc, stored in vault
  rcv->>hub: post key advert (signed)
  Note right of hub: kind secrets.device_key, on join
  hub->>snd: fan out advert
  snd->>snd: verify + pin key (TOFU)
  Note right of snd: key change blocks next send
  user->>snd: Send securely → pick member
  Note right of snd: Credential.pre_share offers it
  snd->>snd: read values from own store
  Note right of snd: never shown to the sender
  snd->>snd: seal + sign envelope
  Note right of snd: names inside ciphertext, transfer_id, conversation, expiry authenticated
  snd->>hub: post sealed message
  Note right of hub: kind secrets.sealed_value
  hub->>rcv: fan out opaque blob
  rcv->>rcv: check sig vs pinned sender key
  Note right of rcv: dedupe transfer_id, check expiry
  rcv->>rcv: Fill in → decrypt → _write_values
  Note right of rcv: credential_service.py:120 — declared vars only, @path off
  rcv-->>hub: ack (no value)
  hub->>hub: delete envelope
  hub-->>snd: Filled in ✓
```

_Auto-generated from chart.json — edits inside this block are overwritten on next save._
<!-- END chart:auto -->
