---
id: a6481919-df9f-4cbb-a089-73fc45f6be5d
---
# Browser drivers

A **browser driver** is one way a session drives a browser. It is a folder,
`agentic-assets/browser_driver/<name>/`, shipped with Flowpad:

| File | What it is |
|---|---|
| `browser_driver.json` | the manifest (`BrowserDriverSpec`, `flow_sdk/schema/data_spec/browser_driver_spec.py`) |
| `instructions.md` | what a session using it is told — the `BROWSER` layer of its system prompt |
| `agentic-assets/webapp/editor/` | its editor (three files; the behaviour is the SDK's `mountBrowserEditor`) |

Nothing outside the folder names a driver. The loader (`flow_sdk/core/browser_drivers.py`) reads
the folders; the launch, the footer menu and the editor ask the manifest.

## Shipped drivers

| Name | Title | Workers | How it reaches a session | Window |
|---|---|---|---|---|
| `agent` | Embedded | all | MCP server `agent_browser` | Flowpad's own, a free port |
| `chrome_debug` | Chrome debug | all | MCP server `chrome_debug` | Chrome Canary on port 9222; one already running there is reused |
| `extension` | Chrome extension | claude | the worker's own `--chrome` switch | the user's Chrome |

## The manifest

| Field | Meaning |
|---|---|
| `workers` | the supported workers by vendor key (`claude`, `codex`, `copilot`, `opencode`, `deepagents`); `*` is every other worker. Each entry: `attach` (`mcp_server` or `harness_extension`) and `setup` (what a person does first, for that worker). A worker with no entry is unsupported. |
| `mcp` | the server a session gets: `name`, `command`, `args`. Never name it `browser`: Copilot's model API reserves that namespace and refuses the whole turn. Templates over the config plus `{python}` and `{driver}`; a value fills one argument. |
| `managed` | Flowpad starts and owns the window, on a profile of its own (`flow_sdk/core/agent_browser.py`). |
| `apps` | the browser apps a managed driver may run (`chrome`, `edge`, `brave`, `chromium`, `canary`). |
| `probe` | how availability is read without starting anything: `cdp` or `extension`. |
| `config_fields`, `defaults` | what a person can set: `app`, `profile`, `port`. |
| `tool_prefixes` | the tool names that mean "this session drove this browser". |

## Which driver a session gets

`browser_choice.decide`, most specific first: the person's pick for the project on this computer,
the session's own setting, the project's recommendation, then `agent`. A driver that does not
support the session's worker is replaced by `agent`, and the answer keeps what was asked
(`requested`) so the menu can say why.

## A channel read through a browser

A message channel with no API (LinkedIn) is a connector of the `agent` data driver
(`agentic-assets/data_driver/agent/`, `CONNECTOR_PROFILES` row with `browser=True`). The source's
config names its browser driver (`browser: extension | chrome_debug | agent`); the worker's launch
asks for it as the `session` rung (`context_data["browser"]`).

- The source refuses to run on another browser (`require_browser`, `wrong_browser`): a pick for the
  project, or a worker the driver does not support, would read another account's inbox.
- A page shows no message id and a time to the minute, so `page_batch.py` (run by the worker)
  builds each record's id from the conversation, sender, minute and words, and turns the page's
  local time into UTC. The reader and the sender both use it, so a sent message and its later
  read are one record. An edited message is a new one; a deleted one stays.
- The worker reports `no_browser` or `signed_out` when a person must act; both park the source.

## Settings are this machine's

A driver's config lives in the instance's `preferences.json` (`preferences.browser.config.<name>`),
next to the pick (`preferences.browser.pick`). A profile is a folder of Flowpad's own under
`~/.flow/instances/<instance>/browser/`; a real user profile is never used by a managed driver.
The row's actions are what the editor calls: `describe`, `config`, `window` (`open` / `close`).

## Adding a browser

Add a folder with the three parts above. `tests/unit/test_session_browser.py`
(`test_a_browser_is_a_folder`) proves a driver no code names is listed, picked, attached with its own
server and limited to the workers it declares.
