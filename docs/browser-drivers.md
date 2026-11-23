---
id: a6481919-df9f-4cbb-a089-73fc45f6be5d
tags:
- browser_drivers.kind
- browser_drivers.choice
- browser_drivers.menu
- browser_drivers.cli
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

## Browser kinds

A **browser kind** is one browser a session can be given: a browser app, the way it is driven and
one profile, named `<browser>.<driving>.name.<profile>` (`chrome.extension.name.Profile 2`). The
profile part is the profile's folder id, never its displayed name. `browser_drivers.list_kinds`
builds the list: a managed driver gives its own window; the driver that rides the worker's
extension gives one entry per real browser profile on the machine, with the folder's created time
and the last time the profile browsed. A profile list this process may not read (macOS privacy) is
read off the folders, so its entries are named by folder id.

The footer's browser menu and `flow browser list` show that same list (`kinds` of the project's
`browser-status`); `flow browser show` prints the browser the calling session has.

## Settings are this machine's

A driver's config lives in the instance's `preferences.json` (`preferences.browser.config.<name>`),
next to the pick (`preferences.browser.pick`). A profile is a folder of Flowpad's own under
`~/.flow/instances/<instance>/browser/`; a real user profile is never used by a managed driver.
The row's actions are what the editor calls: `describe`, `config`, `window` (`open` / `close`).

## Adding a browser

Add a folder with the three parts above. `tests/unit/test_session_browser.py`
(`test_a_browser_is_a_folder`) proves a driver no code names is listed, picked, attached with its own
server and limited to the workers it declares.

```statements
tag: browser_drivers.kind
statements:
  - text: Browser kind is <browser name>.<driving type>.name.<profile name>.
    basis: stated
    about:
      - flow_sdk/schema/data_spec/browser_driver_spec.py
      - flow_sdk/core/browser_drivers.py
  - text: The browser driver in Chrome has a name and a profile name; the kind is with the profile name; the name is initialized to the profile name, but the user may edit the name inline.
    basis: stated
    issues:
      - ui/src/components/footer/BrowserChip.tsx shows a kind's name as fixed text; nothing there edits a name.
    about:
      - flow_sdk/schema/data_spec/browser_driver_spec.py
      - ui/src/components/footer/BrowserChip.tsx
  - text: Driving types are extension and cdp.
    basis: stated
    about:
      - flow_sdk/schema/data_spec/browser_driver_spec.py
  - text: The profile part of a kind is the profile's folder id (Default, Profile 2), not the name the browser displays; the displayed name, when readable, is what the editable name starts as.
    basis: stated
    about:
      - flow_sdk/schema/data_spec/browser_driver_spec.py
requirements:
  - text: A kind's name is editable inline in ui/src/components/footer/BrowserChip.tsx and saved for this machine; editing it never changes the kind.
```

```statements
tag: browser_drivers.choice
depends_on:
  - browser_drivers.kind
statements:
  - text: A process stores the default browser driver in its private context once asked.
    basis: stated
    issues:
      - flow_sdk/builtin/agentic_process/browser_choice.py:153 decides the browser again at every launch and writes nothing to the process.
      - flow_sdk/builtin/agentic_process/browser_choice.py:35 keeps the person's pick per project in preferences (preferences.browser.pick), not on the process.
    about:
      - flow_sdk/builtin/agentic_process/browser_choice.py:153
  - text: A message channel or data source may override the process browser.
    basis: stated
    issues:
      - flow_sdk/builtin/agentic_process/browser_choice.py:91 asks the person's project pick before the session's context_data["browser"], so a source's browser does not win over a pick.
      - flow_sdk/system_projects/flowpad_assistant/agentic-assets/data_driver/agent/transport.py:228 refuses the run with wrong_browser instead of overriding.
    about:
      - flow_sdk/builtin/agentic_process/browser_choice.py:91
      - flow_sdk/system_projects/flowpad_assistant/agentic-assets/data_driver/agent/transport.py:228
requirements:
  - text: The first time a process is asked for its browser, the decided driver is saved in the process's private context and later launches read it from there, in flow_sdk/builtin/agentic_process/browser_choice.py.
  - text: A browser named by a message channel or data source is decided ahead of the project pick for that source's worker, in flow_sdk/builtin/agentic_process/browser_choice.py, and the agent transport stops refusing that case.
```

```statements
tag: browser_drivers.menu
depends_on:
  - browser_drivers.kind
statements:
  - text: Clicking the browser icon in the footer shows the scanned driver list.
    basis: stated
    about:
      - ui/src/components/footer/BrowserChip.tsx
      - flow_sdk/builtin/project.py
  - text: The scan lists the machine's real browser profiles, with name, created time and last-used time.
    basis: stated
    about:
      - flow_sdk/core/browser_profiles.py
  - text: The extension is assumed to be per profile for now.
    basis: stated
```

```statements
tag: browser_drivers.cli
depends_on:
  - browser_drivers.menu
  - browser_drivers.choice
statements:
  - text: The agent communicates with the browser status using a new CLI, flow browser list, show and select; this is the same list the user sees.
    basis: stated
    issues:
      - flow_sdk/cli/commands/browser_cmd.py has list and show only; flow browser select does not exist.
    about:
      - flow_sdk/cli/commands/browser_cmd.py
      - flow_sdk/builtin/project.py
  - text: Instructions in the common agent set the rules for setting the browser; the CLI helps further.
    basis: stated
    issues:
      - flow_sdk/system_projects/flowpad_assistant/instructions/common.md has no rule about setting the browser.
      - flow_sdk/builtin/agentic_process/system_prompt.py:164 gives a session only the BROWSER layer, the text of the one driver decided at launch; it says nothing about choosing or changing the browser.
    about:
      - flow_sdk/system_projects/flowpad_assistant/instructions/common.md
      - flow_sdk/builtin/agentic_process/system_prompt.py:164
  - text: If the selected browser, given by flow browser show, is failing, the agent stops, updates the list with the error and asks for guidance.
    basis: stated
    issues:
      - Only flow_sdk/system_projects/flowpad_assistant/agentic-assets/browser_driver/extension/instructions.md tells a session what to do on a failed call (tell the user to reconnect or switch); the agent and chrome_debug drivers' instructions say nothing about a failing browser.
      - flow_sdk/builtin/agentic_process/browser_choice.py:198 learns of a failure only by reading the session's transcript for its last browser call; an agent has no way to write an error onto the list.
    about:
      - flow_sdk/builtin/agentic_process/browser_choice.py:198
      - flow_sdk/system_projects/flowpad_assistant/agentic-assets/browser_driver/extension/instructions.md
  - text: The list error state is reported by flow browser error <kind> <error message>.
    basis: stated
    issues:
      - flow_sdk/cli/commands/browser_cmd.py has no error command.
      - flow_sdk/core/browser_drivers.py knows the states unsupported, not_installed, ready, running, connected and not_connected; it has no error state and no error message.
    about:
      - flow_sdk/core/browser_drivers.py
      - flow_sdk/cli/commands/browser_cmd.py
  - text: Select changes the current process; default sets the project default.
    basis: stated
    issues:
      - flow_sdk/cli/commands/browser_cmd.py has neither select nor default.
      - flow_sdk/builtin/project.py has only set-browser, which sets the person's pick for the project; nothing changes the browser of one running process.
    about:
      - flow_sdk/cli/commands/browser_cmd.py
      - flow_sdk/builtin/project.py
  - text: An error on a row clears when that kind is selected again or its next call succeeds.
    basis: stated
    issues:
      - No error state exists yet, so nothing clears one.
requirements:
  - text: flow browser gains select, which changes the current process's browser, and default, which sets the project default, in flow_sdk/cli/commands/browser_cmd.py.
  - text: flow_sdk/system_projects/flowpad_assistant/instructions/common.md states the rules for setting the browser and points to flow browser, whose help text carries the details.
  - text: flow browser error <kind> <error message> records the error on that browser kind, the state read by the footer menu and by flow browser list gains an error state carrying the message, and the common instructions tell the agent to stop and ask the user for guidance.
```
