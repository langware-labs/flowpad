---
title: Cloud sharing — what leaves your machine
---
# Cloud sharing — what leaves your machine

**Cloud sharing uploads metadata and coordinates. It never uploads document
bytes, and it never uploads secret values.**

Linking a project to the cloud publishes a *declaration*: this project exists,
it is called this, and its content lives in this git repository at this commit.
A reviewer who opens a shared document is served by the hub cloning that
repository **with their own GitHub token** — so read access is GitHub's ACL,
not Flowpad's. If they cannot clone the repo, they see an error, not your code.

> This page is load-bearing. `tests/unit/test_cloud_share_contract.py` asserts
> that the lists below match what the code actually sends; adding a field to
> `Project` fails that test until it is classified here.

## Three payloads

| Payload | Built by | Carries |
|---|---|---|
| The project row | `Project._hub_body()` + `Project.share()` | identity, display metadata, the git origin |
| Shared secret declarations | `Project._shared_secret_origin_payload()` | names and locations of secrets — never values |
| A git-published asset | `PortableAssetProjection` | type, id, metadata fields, repo coordinates |

## The project row

**Always sent.** Identity and the handful of fields that are always populated:

<!-- pinned:always -->
`artifacts`, `expand`, `id`, `legacy_include_dirs_`, `name`, `semantic_lock`, `shared_context_entities`, `tab_order`, `type`
<!-- pinned:/always -->

**Sent only when set.** The payload excludes empty values, so these travel only
if you have given them one:

<!-- pinned:when-set -->
`created_through`, `env_vars`, `group_id`, `helpdesk`, `hub_published_at`, `key`, `labels`, `last_active_at`, `namespace`, `parent_type_id`, `root_vfs_path`, `schema_version`, `title`, `uname`, `updated_through`
<!-- pinned:/when-set -->

**Never sent.** Two different mechanisms, which fail differently — a
declaration-withheld field stays hidden even if `_hub_body()` is rewritten,
while a popped one is hidden only for as long as that line survives:

<!-- pinned:withheld -->
`asset_occurrences`, `created_by`, `created_date`, `fetched_at`, `fs_storage_mount_path`, `fs_storage_provider`, `git_origin`, `host_member_id`, `last_mode`, `last_session_at`, `members`, `presence`, `private_context_entities_`, `private_context_entity_data`, `project_id`, `remote`, `scope`, `session_code`, `session_count`, `shared_context_entity_data`, `shared_context_origins`, `shared_secret_origins`, `system`, `tags`, `updated_by`, `updated_date`, `visitor_role`
<!-- pinned:/withheld -->

Note what is in that list: `fs_storage_mount_path` and `fs_storage_provider` —
**where the project lives on your disk never leaves your machine.** So do
`presence`, `session_code` and the other local session state.

### The exception worth knowing

`_hub_body()` strips three fields and then `Project.share()` **puts them back**:

<!-- pinned:readded -->
`git_origin`, `shared_context_origins`, `shared_secret_origins`
<!-- pinned:/readded -->

Reading `_hub_body()` alone gives the wrong answer. `git_origin` is the whole
point — it is the repo coordinate a member clones from. The other two are
covered below.

(Three names in that strip list — `include_dirs`, `context_dir_infos`,
`secret_origins` — are computed properties rather than stored fields, so those
`pop()` calls have always been no-ops. They are harmless; do not read them as
evidence that a stored field is being removed.)

## Secrets: declarations travel, values never do

Each shared secret declaration carries exactly:

<!-- pinned:secret-entry -->
`env_var`, `kind`, `locator`, `name`, `project_id`, `sod_store`
<!-- pinned:/secret-entry -->

There is no `value` key, and there never has been. Two deliberate details:

* **Every declaration travels, including `local` ones.** A receiver has to
  *see* a declaration in order to be told they are missing its value. Dropping
  it would silently hide the fact that the project needs it.
* **`sod_name` is stripped from a local locator.** It names an entry in *your*
  keychain and means nothing on anyone else's machine.

If you push a secret's value to the cloud deliberately (`push-secret-to-cloud`),
the hub becomes its system of record — that is a separate, explicit action. See
[[secret_share]].

## Git-published assets

A markdown doc, skill or agent published to the cloud sends a
`PortableAssetProjection`: ``contract_version`, `fields`, `id`, `layout`, `type`` — where
`fields` is the entity's metadata minus every local-path and runtime field, and
`layout` is the position of the asset inside the repo. Plus the git origin:
provider, owner, repo, branch, commit, and the path within the repo.

**No bytes.** The hub stores a reference. When someone opens the document, the
hub clones the repo server-side using that viewer's GitHub credentials and
reads the file at that commit.

## What this means for you

* A private repo stays private. Sharing a project does not grant anyone access
  to your code — GitHub does.
* A teammate without repo access sees the project row and the document's
  title, and gets an error where the content would be.
* Secret values never leave your machine unless you push them deliberately.
* Your local filesystem paths never leave your machine at all.
* Linking a project is not the same as inviting people. Access is granted
  separately, in the project's Members list.

## Proving it end to end

`ui/tests/hub_playwright/tagit_share_real_github.spec.ts` runs the whole chain
unstubbed. It **skips** unless the env below is set, so it stays green on a
machine without credentials.

It needs a real GitHub repo because nothing cheaper reaches the last mile:
`AssetGitWorktree` requires an `https://github.com/...` origin (a `file://`
bare repo gives `ORIGIN_INVALID`), and the hub serves the document by cloning
from GitHub with the *viewer's* token — so "a reviewer can read it" is only
true if a real clone really happens.

```bash
# once: a throwaway private repo seeded with one commit on `main`,
# and a PAT with contents:read+write on it (verify with a manual push).

cd ../test_flowpad/FlowPad && uv run python flowpad/run.py     # hub :8093
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
