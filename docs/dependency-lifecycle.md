# Dependency setup and Load

Adding or installing a resolved project dependency invokes its provider project's Load.
The dependency's `state: ready` still means its files resolved; `lifecycle.state` reports
whether its setup and service are usable. Listing dependencies does not start work.

Load checks declared prerequisites. If any are unmet it returns `setup_required`, without
executing installation or asking setup questions. The app presents **X requires setup**,
with **Set up** and **Not now**. Not now leaves the requirement intact; it is not a skip.
Explicit approval runs setup and then Load. Later Open calls repeat the checks and restore
a stopped runtime without repeating satisfied installation steps.

## Author a provider

Put an `asset_setup.json` under `agentic-assets/asset_setup/<name>/`, or inside the asset
whose setup it describes. Its fields are:

- `subject`: `project`, an asset TypeId, or the existing driver/source subject form.
- `prepare`: a wizard that runs before its children during approved setup.
- `children`: prerequisite nodes; their setup completes before `run`.
- `run`: the installation/configuration wizard, executed only with setup approval.
- `on_load`: the operational wizard, checked/executed after setup is satisfied. It must not
  ask for setup approval or install missing prerequisites.

Every setup operation, including those in `prepare`, needs a **completion check** for a
durable prerequisite. Check installation/configuration there; check whether a service is
running in `on_load`. A stopped process must not make installation appear incomplete.
Checks should be cheap and must not install or start anything themselves.

Project-level `on_load` declarations are visited before its webapps. Declarations attached
to a home app are included too. Webapp install/build steps are setup; its server start is
Load. A plain static home has no server process to start, but Load still verifies its
entry and local placement. A missing placement is repaired in the background and reports
`running` until that work finishes.
The default webapp Load wizard ends with **Verify display**. When a display session is
supplied, it also repairs that session's saved raw app-entry target through the normal
display writer, then checks it again. Unrelated displayed files are preserved. This
checks entry files, endpoint placement and saved presentation; it does not certify
the app's JavaScript or data requests.

Wizard and ComputeOp names use the existing named registry. Give project-owned operations
unique names. Execution uses the provider project's working directory, even when another
project opened its home. Commands receive `FLOW_INSTANCE` for the current node instance,
`FLOWPAD_FLOW` for its installed CLI when present, and `FLOWPAD_PYTHON` for the Python
interpreter running that SDK. For example, `"$FLOWPAD_PYTHON" -m my_adapter.lifecycle check`
uses the same SDK installation as the node without relying on PATH.

## API and CLI

`POST /api/v1/graph/project/<provider-id>/load` accepts
`{approved: false, asset?: TypeId, display?: TypeId}`.
Only `approved: true` permits required setup to execute. The optional asset must belong to
the provider. Optional `display` names a session belonging to this project whose saved app
presentation is checked and repaired by Load; it is echoed in the result and must not be
confused with the caller project used to configure a dependency. It returns a `project.load` value:

```json
{
  "state": "setup_required",
  "project_id": "<provider UUID>",
  "detail": "...",
  "run": null,
  "asset": null,
  "display": null
}
```

States are `setup_required`, `running`, `ready`, and `failed`.
`GET load-state` observes the latest result without starting work; null means no Load has
been requested in this backend process. Running work uses the existing provider project
setup run: `GET setup-run` with empty `root` reads progress, and the returned `run` claims
its questions. A failed declaration or execution is reported as failed, never ready.

Concurrent callers share the provider's run. Required provider projects execute in their
own working directories before the dependent provider; cyclic provider lifecycle graphs
are refused. Repeated Load checks current conditions rather than trusting an old ready flag.

Dependency responses include `project_id`, `home_page` and `lifecycle`. The home asset is
owned by the provider; the app carries the consuming project separately in its tab URL.
Configuring a connection for a consumer must not silently attach it to the provider.

`flow dep add` and `flow dep install` invoke the same Load contract. Headless callers use
`flow dep load NAME` to check/start normal runtime, or `flow dep load NAME --approve` to
approve setup. Missing approval returns a structured `SETUP_REQUIRED`/NOT_YET response;
there is no implicit consent or hidden interactive prompt.
