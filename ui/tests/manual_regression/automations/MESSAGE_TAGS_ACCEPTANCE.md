# Message tags browser acceptance

Run from the repository root:

```sh
bash scripts/test_message_tags_browser.sh
```

The wrapper reuses `scripts/instance_ctl.sh`, disables its unrelated stale-instance
garbage collection, creates a fresh temporary `FLOW_HOME`, signs a unique test user
into the local hub, and starts the real frontend/backend with only external model
and executor fixtures. It stops only its owned instance and prints retained evidence.
Pass normal Playwright flags after the command for focused debugging. The local hub,
`uv`, installed UI dependencies and Playwright Chromium are prerequisites.

This suite uses the existing automation Playwright configuration and channel doubles.
Run only on a disposable `tags-rig-*` instance, never a personal or production instance.
The backend must run `tests/e2e/mock_worker_backend.py` with
`MOCK_MESSAGE_CLASSIFIER=1`, `MOCK_DECISION=1`, and a free
`MOCK_MESSAGE_TAG_CONTROL_PORT` for correlated external executor release.
Sign that instance into the local test hub using its own test identity before running;
the real login-required overlay must not be hidden by the rig.

From `ui/`, with that instance's frontend and backend already healthy:

```sh
FLOW_INSTANCE=tags-rig-73 VITE_PORT=5073 npx playwright test \
  --config tests/manual_regression/automations/playwright.config.ts \
  message_tags --output /tmp/message-tags-acceptance
```

Use the actual frontend port and instance name from your instance environment.
The shared API helper reads `.env.<instance>.local` for the backend origin.
The suite uses zero retries and the existing 60-second test/15-second assertion caps.
The headless WebGL flag matches the existing tag viewer suite.

`message-tags-manifest.json` preserves all 30 approved mock screens and 124 actions.
`message-tags-coverage.ts` records a screen only after its UI assertion and records
an action only after its specific interaction and destination assertion succeed.
The final coverage gate fails for any unexecuted screen or action. Intermediate
coverage and browser diagnostics are attached after each test; failed journeys retain
Playwright traces. A passing page-load smoke check is not acceptance evidence.
The mock's simulation-only `next` actions map to releasing the external executor
by its exact run ID and asserting real persisted/live queued → running → chained
and completed/once transitions. There are no production simulation buttons.

The classifier fixture replaces only the external LLM completion boundary. Channel
delivery, classification validation, HTTP actions, tag/trigger persistence, WebSocket
updates, and Wizard execution are real. Registered test callbacks use the same
`FlowMessage.add_tag` seam as real automation effects and assert exact queue correlation.
Keep backend safety/race/restart cases in their focused pytest suite; this browser
suite proves the user journeys and exact entity navigation across components.
