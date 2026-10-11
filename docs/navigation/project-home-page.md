---
id: 8dba77ac-09bd-4356-8944-25bd5e3018ca
---
# Project home page — what a project opens on

A project may name the asset its **Home** opens: `home_page` in
`agentic-assets/project_manifest/project_manifest.json` (`ProjectManifestSpec`; the file
is described in `docs/ontology.md`). The declaration can be an asset TypeId or a
project-relative asset path beginning with `./`. For path-derived read-only assets,
use a path so every clone resolves its own local identity:

```json
{"home_page": "./agentic-assets/webapp/admin"}
```

The resolver uses the existing asset registry without stamping IDs. It rejects paths
that escape the project, including symlinks, and the resulting asset must belong to the
project. Existing TypeId declarations remain supported. A home can be one of two kinds:

* an **agent** — Home resumes its last chat in this project (`lastVibeChatQuery`), else
  opens a new session the way the agent launcher does;
* a **web app** (`micro_app`) — the project opens app-first, on
  `/dock/app/micro_app-<uuid>` pinned to the project (`projectScope`; the address is
  described in `docs/tabs/display.md`, *Every app is an address*). `Project.open_home_page`
  invokes Load; its presentation step verifies the entry and repairs a missing local
  endpoint in the shared background run.

Unset (`null`) is the default home.

## Setting it

* the project page's **Home** card (`HomeCustomizationCard`), which lists agents and web apps;
* `POST /api/v1/graph/project/<id>/set-home-page {typeid}` — accepts either reference form;
  an empty `typeid` clears it;
* the TS SDK: `project.setHomePage(typeid | null)`.

`GET /api/v1/graph/project/<id>/home-page` returns `{asset, type, lifecycle, load_run}` for the loader;
`asset` is always the resolved local TypeId, never the relative declaration. A resolution failure
comes back as a success envelope carrying `error`, so the loader never reads it as "no home".
Opening invokes the provider's [Load lifecycle](../dependency-lifecycle.md): missing setup
returns `setup_required`; approval runs setup and then operational `on_load`. The home
remains addressable while setup is pending. Long setup work runs in the background.

A dependency's Open uses its provider's home, with provider and consumer project identities
carried separately in the tab URL. Reload retains the consuming project used to configure
connections and agent bindings; opening the provider's admin does not change asset ownership.

## When it opens

The redirect (`ui/src/project-home-page/project-home-page-redirect.ts`) is one of the
registered load redirects, after agent auto-launch — first redirect wins, so a once-only
auto-launch takes the very first open (the full order: `docs/navigation/dock-loading.md`,
step 3). It acts only on a load that asks for it, `?homePage=open`: launching a project
(opening a folder or clone, picking, setting up or switching to one) and the Home button.
The project page, its tab and the fallback after closing a tab do not ask, so the page
where the home is configured stays reachable. On the home page, Home toggles between it
and the default home (the resolved place is remembered per browser tab).
