---
id: a5a16156-13ce-4f32-bc6e-3b496075c942
title: Cloud sharing — what leaves your machine
---

# Cloud sharing — what leaves your machine

**Link creates the project in Flowpad Cloud, using the same action as Link to cloud on Project Home.** It sends the project declaration, not the whole project folder, and requires a cloud login. It does not require a Git checkout or grant GitHub repository access.

Sharing selected assets can publish their content into the project's hub-hosted repository. **Send files to cloud** is a separate action that publishes the project folder. Linking, sharing assets, and sending the whole folder are different operations.

After linking, sharing offers a [project role](./project-roles.md) for each recipient who is not already a member. Guest is the default; None sends without a new membership. Existing roles remain unchanged. Guest does not allow opening the project under the current permissions. Choose Member when the recipient needs to see the project. Membership is added only when you click Share, not Link.

**Don't ask again** skips the link reminder on this instance; it neither links projects automatically nor changes permissions. Reset it in Preferences → Notifications → Cloud link prompt when sharing.

> This page is load-bearing. `tests/unit/test_cloud_share_contract.py` asserts
> that the lists below match what the code actually sends; adding a field to
> `Project` fails that test until it is classified here.

## Two payloads

| Payload | Built by | Carries |
|---|---|---|
| The project row | `Project._hub_body()` + `Project.share()` | identity, display metadata, the git origin |
| A git-published asset | `PortableAssetProjection` | type, id, metadata fields, repo coordinates |

## The project row

**Always sent.** Identity and the handful of fields that are always populated:

<!-- pinned:always -->
`artifacts`, `expand`, `id`, `name`, `semantic_lock`, `shared_context_entities`, `tab_order`, `type`
<!-- pinned:/always -->

**Sent only when set.** The payload excludes empty values, so these travel only
if you have given them one:

<!-- pinned:when-set -->
`created_through`, `env_vars`, `group_id`, `helpdesk`, `hub_published_at`, `key`, `labels`, `last_active_at`, `last_edited_at`, `locale`, `namespace`, `origin`, `parent_type_id`, `root_vfs_path`, `schema_version`, `title`, `uname`, `updated_through`
<!-- pinned:/when-set -->

**Never sent.** Two different mechanisms, which fail differently — a
declaration-withheld field stays hidden even if `_hub_body()` is rewritten,
while a popped one is hidden only for as long as that line survives:

<!-- pinned:withheld -->
`asset_occurrences`, `created_by`, `created_date`, `fetched_at`, `fs_storage_mount_path`, `fs_storage_provider`, `host_member_id`, `last_mode`, `last_session_at`, `llm_endpoint_typeid`, `members`, `origin_id`, `presence`, `private_context_entities_`, `private_context_entity_data`, `project_id`, `published`, `remote`, `scope`, `session_code`, `session_count`, `setup_skipped`, `shared_context_entity_data`, `system`, `tags`, `updated_by`, `updated_date`, `visitor_role`
<!-- pinned:/withheld -->

Note what is in that list: `fs_storage_mount_path` and `fs_storage_provider` —
**where the project lives on your disk never leaves your machine.** So do
`presence`, `session_code` and the other local session state.

`published` is a cache, not a fact about the project. It answers "is this listed
in the manifest file sitting in my checkout" — a file the receiver does not have,
so the answer cannot mean anything on their side. Their own manifest reconciles
their own flag.

`llm_endpoint_typeid` is the non-obvious one, because it names a *hub* entity and
so looks like it ought to travel. It must not. It is the budget THIS user's
workers spend, and a role on that endpoint is a fact about an account rather than
about the work: a recipient either has no role on it (so the id means nothing and
every spawn in the shared project fails against a budget they cannot reach) or —
worse — holds a role on a different endpoint that happens to share the id space.
A recipient's project gets funded by their own ladder.

### Nothing is put back

`Project.share()` sends `_hub_body()` as it is — it re-adds no stripped field:

<!-- pinned:readded -->
(none)
<!-- pinned:/readded -->

A project's context folders do not ride the row at all: they are declared in its
`flow.json`, which travels with the repository. (The project's `origin` is SHARED and
rides in the body itself, under its hub-wire name `git_origin`.)

(Two names in that strip list — `include_dirs` and `context_dir_infos` — are
computed properties rather than stored fields, so those
`pop()` calls have always been no-ops. They are harmless; do not read them as
evidence that a stored field is being removed.)

## Credentials: declarations travel with the repo, values never do

A project's credentials are folder assets at `agentic-assets/credential/<name>/`
inside the project. The declaration — which environment variables the project
needs — travels with the repository like any other asset. Values do not travel
at all: they live in the project's `.env.local` (which Flowpad keeps excluded by
git) or in this machine's encrypted vault. A teammate who opens the project sees
the credential as missing and fills it on their own machine. See
[[secret_share]].

## Git-published assets

A markdown doc, skill or agent published to the cloud sends a
`PortableAssetProjection`: ``contract_version`, `fields`, `id`, `layout`, `type`` — where
`fields` is the entity's metadata minus every local-path and runtime field, and
`layout` is the position of the asset inside the repo. Plus the git origin:
provider, owner, repo, branch, commit, and the path within the repo.

**The projection is metadata.** Content delivery depends on the selected transfer path: a direct GitHub reference requires provider access, while published content in a hub-hosted repository uses Flowpad access controls. The projection alone does not mean no file bytes were uploaded.

## What this means for you

* Linking declares the project; it does not send the whole project folder.
* Sharing selected asset content or sending files to the cloud can upload bytes to a hub-hosted repository. Do not use linking's metadata-only behavior as a guarantee about those separate actions.
* Project membership and direct GitHub repository access are separate permissions. Linking does not grant either one to a recipient.
* A Guest project role does not allow opening the project. Member includes project read access.
* Invitations happen on Share for selected non-members with a role other than None. They can also be managed in the project's Members list.
* The field classification above describes the project declaration and portable metadata, not every possible content-transfer payload.

## Direct GitHub transfer validation

`ui/tests/hub_playwright/tagit_share_real_github.spec.ts` runs the whole chain
unstubbed. It **skips** unless the env below is set, so it stays green on a
machine without credentials.

This test covers the direct GitHub transfer path, not metadata-only linking or hub-hosted repositories. It needs a real GitHub repo:
`AssetGitWorktree` requires an `https://github.com/...` origin (a `file://`
bare repo gives `ORIGIN_INVALID`), and the hub serves the document by cloning
from GitHub with the *viewer's* token — so "a reviewer can read it" is only
true if a real clone really happens.

```bash
# once: a throwaway private repo seeded with one commit on `main`,
# and a PAT with contents:read+write on it (verify with a manual push).

(cd "$HUB_CHECKOUT" && uv run python flowpad/run.py)       # hub :8093, from your hub checkout
scripts/instance_ctl.sh launch tagit-1                          # FE 500X / BE 600X
cd ui && npx vite --mode hubtest --port 4096 --strictPort       # hub UI

TAGIT_E2E_REPO=https://github.com/<you>/flowpad-tagit-e2e.git \
TAGIT_E2E_GITHUB_TOKEN=<pat> \
TAGIT_E2E_BACKEND_URL=http://localhost:6001 \
TAGIT_E2E_UI_URL=http://localhost:5002 \
TAGIT_E2E_HUB_UI_URL=http://localhost:4096 \
TAGIT_E2E_HUB_EMAIL=tagit-1@local.test TAGIT_E2E_HUB_PASSWORD=tagit-1-pw-1234 \
npx playwright test --config=tests/hub_playwright/playwright.config.ts tagit_share_real_github
```

`--port 4096 --strictPort` is load-bearing: `.env.hubtest.local` uses 4098 and
so does the alice UI default, and a silent collision would assert against the
desktop runtime. The spec re-checks `supported_pages === ["hub"]` in the page
rather than trusting the port.

Everything it creates is namespaced by a run id and torn down: the branch
`tagit-e2e/<runId>` is deleted (never `main`), local and hub rows are deleted,
and stale branches older than a day are swept on the next run.
