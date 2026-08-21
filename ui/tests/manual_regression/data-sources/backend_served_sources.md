---
id: 3f1c9a44-7c2e-4a1e-9c6b-2f0d5a8b41e7
---

# Data sources come from the backend, not from the frontend

precondition: an instance is up (`scripts/instance_ctl.sh launch dev-5`) and its
`agentic-assets/data_source/*` manifests are indexed. Run with
`FLOW_INSTANCE=<name> npx playwright test --config tests/manual_regression/data-sources/playwright.config.ts`.

What these tests are actually proving: `provider-catalog.ts` is gone. Every provider
button, every field, every label and placeholder in the Add dialog now comes from a
`data_source_spec` asset the backend indexed off disk. So each test compares the rendered
form against the manifest fetched over the API — not against a list written here, which
would just be the deleted catalog in a new file.

Only the four credential-free sources are created for real. `slack`, `agent`, `agentmail`
and `cloud_email` cannot be created without a workspace token, a harness, an API key and a
cloud login respectively — they are covered by `credentialed_sources.md`, by hand.

test 1: The Data Sources screen renders
- [browser] navigate to {APP_URL}/dock/data-sources
- [browser] validate the element with data-testid="data-sources-view" is visible
- [browser] validate the element with data-testid="add-data-source" is visible

test 2: Every installed spec is offered as a provider
- [api] GET /api/v1/graph/data_source_spec — collect every `name`
- [browser] open the Add dialog
- [browser] for each name, validate a button with data-testid="provider-<name>" is visible
- this is the phase-2 contract: the dialog renders what is INSTALLED

test 3: The RSS form is the RSS manifest
- [api] read the `rss` spec's `config_schema`
- [browser] open the Add dialog and choose the rss provider
- [browser] validate each config key renders an input with id "ds-<key>"
- [browser] validate its label text and placeholder match the manifest verbatim

test 4: An RSS source can be created
- [browser] open the Add dialog, choose rss, name it, paste a feed URL, submit
- [browser] validate a card with data-provider="rss" appears

test 5: A bad feed URL blocks submission
- [browser] fill the feed field with "not-a-url"
- [browser] validate the Add button is disabled (the manifest's `pattern` did this — no
  per-provider validator exists any more)

test 6: Hacker News needs nothing but a name
- [browser] choose hackernews, name it, submit
- [browser] validate a card with data-provider="hackernews" appears

test 7: A local folder can be created
- [fixture] make a temp directory with one markdown file
- [browser] choose folder, name it, enter the path, submit
- [browser] validate a card with data-provider="folder" appears

test 8: A git repository can be created
- [fixture] `git init` a temp repo with one commit
- [browser] choose git, name it, enter the path, submit
- [browser] validate a card with data-provider="git" appears

test 9: A Drive source lands in setup, not active
- [browser] choose gdrive, name it, submit — every field is optional
- [browser] validate the card's data-status is "setup" (its driver has a verify step)
- [browser] press Verify with no Google credential
- [browser] validate the card names Google as what is missing

  Drive's CREDENTIALED half is not automatable — see `credentialed_sources.md`. What is
  automated here is the half that would silently regress: a source that resolved straight
  to `active` would poll against no token forever.

cleanup: every source created above is deleted over the API.
