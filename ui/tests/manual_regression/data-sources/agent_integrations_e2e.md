---
id: 9b7e2c1a-4d5f-4a63-8e2b-1c0f7a9d3e21
---

# From nothing to a streaming, specced, annotated source

precondition: an instance is up (`scripts/instance_ctl.sh launch dev-3`) and its
`agentic-assets/data_source/*` manifests are indexed. Run with
`FLOW_INSTANCE=<name> npx playwright test --config tests/manual_regression/data-sources/playwright.config.ts agent_integrations_e2e`.

What this proves: the whole curation loop the data-integrations persona drives,
with the mechanics exercised directly (no live Claude — that is
`tests/long_tests/test_data_integrations_agent_live.py`). Each test is one gate
and stays under the 60 s cap; the suite is serial because each gate builds on
the last. The feed is a loopback `node:http` server whose entries are dated
now, so nothing leaves the machine and nothing falls outside `window_days`.

test 1: From scratch — the screen is empty and offers the agent
- [fixture] a fresh project (temp mount) — the Data Sources screen is global, so the
  source list must be empty for THIS run's provider+name
- [browser] navigate to {APP_URL}/dock/data-sources
- [browser] validate data-testid="data-sources-view" and "add-data-source" are visible
- [browser] when no source exists, validate data-testid="data-sources-ask-agent" is visible

test 2: Connect — an RSS source over the dialog, pointed at the loopback feed
- [fixture] start a loopback feed server serving 3 entries dated now
- [browser] Add data source → provider rss → name + feed URL → Add source
- [browser] validate a card with data-provider="rss" and the name appears
- [api] POST /graph/data_source/{id}/poll_now → {"status": "due"}

test 3: Streaming — items land on the heartbeat
- [api] sample GET /graph/source_item?data_source_id=… until count ≥ 2 (≤55 s;
  the heartbeat is ≤60 s from the poll in test 2, and test 2 took ~10 s)

test 4: The editor — config form + live items, opened as a webapp
- [browser] card menu → "Open editor"
- [browser] validate the URL is /dock/app/micro_app-… and the breadcrumb names the definition
- [browser] inside the app frame: the Feed URLs field holds the loopback URL and
  the items list shows ≥2 items

test 5: Define + annotate — a dataset bound to the source, one labelled example
- [browser] in the frame: shape `sentiment: string` → Define output
- [browser] validate the dataset counts read "0 examples · 0 labelled"
- [browser] Promote the first item → its label form appears → fill sentiment → Save label
- [browser] validate "labelled (1 total)" and counts "1 examples · 1 labelled"
- [api] GET /graph/dataset?filter={"source_id":…} → num_examples 1, num_annotated 1
- [fixture] on disk: examples/0001/{input/item.json, ground_truth/label.json, example.json}

test 6: The agent surface — the persona rides the vibe session and the pane shows the editor
- [api] create a headless vibe process for the project, embed the personas the way
  the launcher does (GET /graph/subagent?include_system=true → kind vibe, scope system)
- [api] GET /graph/agentic_process/{id} → embedded sub-agents name `data-integrations`
- [api] POST /graph/agentic_process/{id}/show {"view": "app/micro_app-<editor id>?source=<id>"}
- [api] validate it RESOLVES to {kind: dock, view_type: app, pointer: micro_app-<editor id>, options.source: <id>}
  — the address the persona presents with; where the workspace paints it is the
  display router's business, and tests 4-5 prove that address renders
- [browser] open the vibe workspace and validate the composer is ready

teardown: delete the source (cascades items), the dataset row, the project; stop the feed server.
