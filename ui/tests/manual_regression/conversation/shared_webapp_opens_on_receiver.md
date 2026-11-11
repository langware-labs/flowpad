# A shared webapp opens on the receiver

Bob shares a webapp (a mock is one) with Alice, who runs Flowpad on another machine.
Alice installs it from the message and presses **Open**: the app's page opens.

It used to end on "Missing asset": a webapp's id comes from its folder path, so Alice's
copy has a different id from the one the message carries, and Open asked for Bob's. An install
now adopts the id of the copy it put on this machine.

## Prereqs

- A local hub, and two instances signed in to it as two users. The receiver should be on
  another machine or in a container, so its paths differ from the sender's:
  `scripts/instance_ctl.sh launch bob-21` for the sender, a `flowpad-backend` container
  (`docker/Dockerfile.flow-backend`) plus a Vite frontend for the receiver.
- The sender's backend runs on this machine (the spec writes the app into its project).

## Steps

| # | Who | Do | Expect |
|---|---|---|---|
| 1 | Bob | Open a webapp of your project | The app's page |
| 2 | Bob | Share (top bar) → Alice's email → Enter → **Share** | "Shared" |
| 3 | Alice | Stream Inbox → "bob has shared …" | The message with the app's chip |
| 4 | Alice | Click the chip → **Install in project** | "Installed in project", an **Open** button |
| 5 | Alice | **Open** | The app's page — never "Missing asset" |

## Run

```bash
cd ui && SENDER_URL=http://localhost:5021 SENDER_API=http://localhost:6021 \
  RECEIVER_URL=http://localhost:5121 RECEIVER_EMAIL=alice-21@local.test \
  npx playwright test --config tests/manual_regression/conversation/playwright.config.ts \
  tests/manual_regression/conversation/shared_webapp_opens_on_receiver.md.ts
```
