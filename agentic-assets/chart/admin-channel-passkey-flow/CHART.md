---
id: 7aaaac99-6e39-4e74-9e4a-8e6b0229de52
name: admin-channel-passkey-flow
description: How a passkey lets a user into a protected machine through the admin
  channel. The machine is connected to the hub over a websocket it opened itself,
  holds the user's passkey public key, and checks every approval itself; the hub only
  relays. An approval opens access for 1 hour. Planned design, not built yet.
format: sequence
session: fe74e9fd-4b8a-4224-bc93-33031fbdbd76
---
The passkey part of the admin-channel plan. The private key stays on the remote user's device; the protected machine pins the public key when admin channel is turned on there, issues its own challenge, verifies the signed answer and keeps the 1-hour window itself. Nothing calls into the machine over HTTP.
