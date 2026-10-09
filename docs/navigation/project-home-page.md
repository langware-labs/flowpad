---
id: 8dba77ac-09bd-4356-8944-25bd5e3018ca
---
# Project home page — what a project opens on

A project may name the asset its **Home** opens: `home_page` in
`agentic-assets/project_manifest/project_manifest.json` (`ProjectManifestSpec`; the file
is described in `docs/ontology.md`). It is the TypeId of one of the project's own assets,
so it travels with a clone and never points at another project's asset. It can be one of
two kinds:

* an **agent** — Home resumes its last chat in this project (`lastVibeChatQuery`), else
  opens a new session the way the agent launcher does;
* a **web app** (`micro_app`) — the project opens app-first, on
  `/dock/app/micro_app-<uuid>` pinned to the project (`projectScope`; the address is
  described in `docs/tabs/display.md`, *Every app is an address*). `Project.open_home_page`
  places the app's static endpoint on this machine first (`place_webapp_locally`,
  idempotent), so the view finds something to serve.

Unset (`null`) is the default home.

## Setting it

* the project page's **Home** card (`HomeCustomizationCard`), which lists agents and web apps;
* `POST /api/v1/graph/project/<id>/set-home-page {typeid}` — an empty `typeid` clears it;
* the TS SDK: `project.setHomePage(typeid | null)`.

`GET /api/v1/graph/project/<id>/home-page` returns `{asset, type}` for the loader; a failure
comes back as a success envelope carrying `error`, so the loader never reads it as "no home".

## When it opens

The redirect (`ui/src/project-home-page/project-home-page-redirect.ts`) is one of the
registered load redirects, after agent auto-launch — first redirect wins, so a once-only
auto-launch takes the very first open (the full order: `docs/navigation/dock-loading.md`,
step 3). It acts only on a load that asks for it, `?homePage=open`: launching a project
(opening a folder or clone, picking, setting up or switching to one) and the Home button.
The project page, its tab and the fallback after closing a tab do not ask, so the page
where the home is configured stays reachable. On the home page, Home toggles between it
and the default home (the resolved place is remembered per browser tab).
