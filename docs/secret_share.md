---
id: 5e2949c7-827c-50f9-a25f-0a322d4c42f5
---

# Credentials and secrets

A **credential** (`Credential`) is a named set of environment variables: Gmail is `GMAIL_ADDRESS` + `GMAIL_APP_PASSWORD`, a custom API key
is one variable. It is the **only** way a secret is declared. A declared variable
is injected into agent workers, terminals and compute-node commands; a value
nobody declares is never injected.

## Scope — where the declaration lives

A credential is a REPO folder asset, `agentic-assets/credential/<name>/credential.json`,
in one of the asset scopes Flowpad already has:

| Scope | Folder | Applies to |
|---|---|---|
| `project` | `<project mount>/agentic-assets/credential/<name>/` | processes in that project |
| `user` | `~/agentic-assets/credential/<name>/` | processes in every project on this machine |
| `system` | the shipped assistant project | nothing — a **template**, added to one of the scopes above |

A project credential travels with the project's repository; a teammate who opens
the project sees it as missing and fills in their own values.

Identity is a writable folder capsule (`.flow/capsules/identity.json`, UUID v4).
The shipped templates commit theirs, so every install indexes one row per template.

## Where the values live — a deployment's, never the credential's

A credential says WHAT is needed; each **Deployment** says WHERE its values live
(`Deployment.secrets`, a `DeploymentSecretsSpec`): a `store`, per-variable
`exceptions`, extra `require`d variables and `protected`. The env var NAME is the
key in every store. **This computer** is one Deployment per instance
(`Deployment.this_computer()`, kind `compute.this_computer`, environment = the
instance default): every process with no deployment of its own reads with its
binding — terminals, `flow credentials`, project setup — and an agent's local
deployment with no binding inherits it. Deployment == environment: there is no
separate environment asset.

Both local stores are [`SecretStore`](snippets/secret-stores.md) types; a store
with no config is completed per credential scope and the deployment's
`environment` (`credential_store.secret_store_ref`, the ONE place a scope, a
variable and a deployment become a store config):

| store | `development` | a named environment, e.g. `production` |
|---|---|---|
| `env_file` (default) | `<scope root>/.env.local` | `<scope root>/.env.production.local` |
| `vault` | `credential.project.<pid>.VAR` / `credential.user.VAR` | `credential.production.project.<pid>.VAR` |

A remote store (GCP Secret Manager, the hub store below) is used as configured. A credential that
names an `lm_provider` is one key, always the vault entry `lm_api.<provider>`
that the funding resolver reads, user-scoped, with no per-environment value
(deployments are hub-funded). A project's vault entry never answers for another
project. `credential_store.Placement` is a deployment's binding plus its
environment; `spec.secret_store(deployment)` builds the store a deployment keeps
a credential in.

This computer keeping `DATABASE_URL` in the vault, everything else in env files:

```json
{ "store": { "type": "env_file" }, "exceptions": { "DATABASE_URL": { "type": "vault" } } }
```

A `credential.json` written before 0.2.178 said this itself (`value_store`,
`environments`). It still loads — `CredentialSpec` drops the keys on read — and
the first boot moves them onto the deployments and strips the file
(`migration_2026_09_credential_stores`): `vault` becomes an exception on this
computer, `environments.<E>` becomes the binding of every deployment in `E`, an
`E` no deployment names is reported (its values stay put).

`.env.local` rules (`flow_sdk/builtin/env_local_store.py`): inside a git work
tree the file is excluded by git before a value is written, and a committable
file (tracked, or re-included by a negation) refuses the write with a
`block_code`. Outside a repo — a home folder — nothing is added to any
`.gitignore`. Flowpad removes a line only when the credential that declares it
is deleted, and then only that variable's lines (see [Deleting](#deleting--nothing-left-behind)). The same rules
apply to every environment's file; the ignore line appended is that file's own
name, so a project ignoring only `.env.local` still protects `.env.production.local`.

Where a process reads (`credential_resolver.placement_for`): the Deployment it
was created under, else this computer. A data source reads where the Deployment
that answers it keeps values (`placement_for_source`: its `answer_place`, else
the deployment this process serves, `FLOW_DEPLOYMENT_ID`, else this computer) —
a source syncing on a production box reads production values. A named
environment's env file is read with `dotenv_values`, never loaded into the
backend's own environment.

## A cloud deployment — the hub store, placement, authorization

A cloud deployment keeps its values in the **hub store** (`flow_sdk/secrets/hub.py`,
store type `hub`, config `{deployment_id}`): the confidential env vars of the hub's
Deployment row, values in the hub's SOD (`deployment_<VAR>_<id>`). A laptop writes and
lists them by name and never reads one back (`load` returns nothing). Planning a cloud
placement gives it that store (`Agent.plan_deployment(environment)` →
`POST agent/<id>/plan_deployment`: the hub's row, found or created with no machine yet,
adopted here). Every write, delete, placement and token handed out is audited on the hub
(`SecretEvent`: who, which deployment, which name, when — never a value).

**Use mine** (`credential_service.use_mine`, `POST …/credentials/use-mine`,
`flow credentials use-mine <deployment> [--name VAR]`) copies this computer's values into
a deployment's store — by default what its agent needs and the store lacks (per variable:
a value the store holds, such as the webhook URL the hub stored for the deployment, is never
replaced). Values move
machine → hub and are never shown; the answer is names: `copied`, `not_here` (this
computer has none either) and `hub_funded` (an `lm_provider` key is never copied — a
deployment is hub-funded). A `protected` deployment refuses: its values are entered
directly.

**Placement** — the hub puts the store's values on the deployment's machine
(`hub app/services/deployment_secrets.place_secrets`) with the compute-node tools: the box
hands out a private drop folder (`POST credentials/drop`, 0700), the hub writes one JSON
file there with the provider's file API, and `POST credentials/place` reads it, deletes it
at once and writes the values where that machine's own lookup reads them
(`credential_service.place_values`: one write per store, 0600, git-excluded), then verifies
every source on the machine whose driver reads a placed name — a source that arrived with the
project waits in setup for this machine's own account, and on a deployment's machine that
account IS the placed values (`verified: {source: "ready" | detail}`, reported, never fatal).
A value never rides a box call's body — that is a curl argument. The machine IS the deployment: it places
at its row for the deployment's id, else its own placement, always in the environment the
hub sends, which becomes the instance default; a name nothing on the machine declares is
declared from its shipped template (else a bare credential) under the name the agent's
requirements give it. The hub places on deploy, redeploy, update and resume, and re-places
one name when it is written while the machine runs; it wipes (`credentials/unplace`) before a
user pause and on a store delete. An automatic pause on the provider's idle timeout cannot be
intercepted — its snapshot keeps the file until the machine is destroyed. The agent itself
(a model with a shell) can read what is placed; only what its store holds is placed.

**Authorization** — a cloud machine uses a person's OAuth connection only if its owner
authorized that provider for THAT deployment (`Deployment.authorize(provider, permissions)`,
`revoke(provider)`; hub `DeploymentAuthorization`). The machine then asks the hub for a
fresh token as its node identity (`GET compute_node/<id>/connection-token/<name>`, answered
only for the key bound to that machine and only while authorized; `hub_oauth` does this on
a box); the refresh token never leaves the hub, nothing is cached on the machine, and
deleting the deployment revokes every authorization. `Deployment.secrets_inventory()`
(`GET deployment/<id>/secrets`) lists each stored name with its last write and placement and
the authorizations — names only; the cloud place's **Secrets** tab shows it.

## Resolution — what a process receives

`flow_sdk/builtin/credential_resolver.py`:

1. Credentials in scope: every `user` credential, plus the process's project's.
2. Per variable, a project declaration overrides a user one of the same name
   (status reports the user one as `shadowed_by`). Two credentials in one scope
   may not declare the same variable; saving refuses it.
3. The machine's attachment map (`ComputeNode.attached_secrets`) filters the set.
4. Each value is read from the store the process's deployment keeps it in;
   failures are logged by name and skipped. Nothing declared — the common case —
   returns before any deployment lookup.
5. An explicitly set process variable still wins (`setdefault`).

Call sites: worker spawn (`apply_worker_secret_env`), terminals
(`shell._with_attached_project_secrets`), compute-node connector init
(`resolve_node_secret_env`).

## Operations

`flow_sdk/builtin/credential_service.py`, served as
`/api/v1/graph/compute_node/@local/credentials/...` by
`app/actions/credentials_action.py` and `credentialsService` in the TS SDK:

| Route | Does |
|---|---|
| `GET status?project_id=&deployment_id=` | every credential in user + project scope with per-variable presence and `store` at that deployment (default: this computer), every deployment to pick from, and each scope's env file keys — names only |
| `POST save` | create (in a scope) or update a credential, writing values FIRST so a refused value leaves no empty declaration; `store` (`env` / `vault`) makes the deployment keep its variables there, `deployment_id` names the deployment |
| `POST values` | set or rotate the values a deployment reads; empty values are skipped |
| `POST delete` | delete the credential's values from every store any known deployment keeps them in — vault entries and `.env*` lines — then the folder; the result reports each store (`CredentialDeletedSpec`) |
| `POST audit` | the leftover sweep over this instance's stores (`credential_sweep.sweep_local`) — names only |
| `POST use-mine` | copy this computer's values into a deployment's store (above) — names only |
| `POST drop` / `place` / `unplace` | on a deployment's machine, for the hub only: the drop folder, placing a dropped values file, wiping names |

Every entry point uses `save`: Connections → Add connection (catalogue templates
and **Custom credentials**), packing detected `.env.local` keys into one credential,
and the quick-create **Secret** tile.

## Deleting — nothing left behind

Deleting a credential (`credential_service.delete_credential`, `flow credentials
delete <name>`) forgets its variables in the store of every known environment
(`credential_store.forget_in`): vault entries and the variable's lines in each
`.env*` file — every other line is kept byte for byte. The result names each store
(`type`, `where`, `deleted`, `kept`, `error`). A store that fails or cannot be
read is reported, never skipped, and the credential is removed only when no store
still holds one of its values — otherwise it stays as the handle to retry.

Deleting a place removes what the hub holds for it. A **remote** `Deployment` or
`Agent` (`Entity.owns_hub_delete`) is deleted on the hub first; a hub refusal fails
the local delete (HTTP 502) and keeps the row. A local deployment's serving
process is stopped first. On the hub, `Entity.delete` deletes the stored secret
behind every confidential env var of the entity (an API key under the entity, an
OAuth token under the caller's copy; a ref row is someone's own secret and stays),
so an Agent's delete — its mailbox decommissioned first, its deployments and their
machines through the `is_child` cascade — and a Project's delete leave no stored
secret. A pause keeps the store (and wipes the machine, above). A cloud deployment's store is
reached by a credential's delete like any other: its local row names the hub store, whose
`forget` deletes each env var on the hub. Deleting the deployment revokes its authorizations.

**The leftover sweep** — `flow credentials audit --project … --agent … --deployment …
--name … [--root DIR] [--hub-root HUB_CHECKOUT] [--e2b]` (`builtin/credential_sweep.py`)
reads every place a value can live for what should be gone: the vault (the
project's `credential.` entries in any environment), `.env*` files, remote stores
data sources bind (e.g. GCP Secret Manager), the hub's own store through its
`python -m flowpad.hub.external_apis.sod.leftovers <id>…` script (a local hub
checkout; keys are `{type}_{name}_{id}`), and live e2b sandboxes labelled with the
agent (`source=agent-<id>`, read with `E2B_API_KEY`). Names only. Exit 0 clean, 1
on a leftover, 7 when a store could not be read — unchecked is never clean. The
hub and e2b legs run only in the CLI's own process, never in the backend.

## Permissions, requirements, readiness

A **permission** names what an asset needs to be allowed to do, by capability —
`permission.<provider>.<resource>[.<action>]` (`permission.google.drive.read`) —
declared by the asset that needs it with how it is granted
(`data_driver.json` `permissions`, a store's `permissions` ClassVar):
`oauth` (a connection and its scopes), `iam` (roles) or `api_key` (the variable
whose value grants it). Raw scopes (`auth.scopes`) stay the wire truth.
`flow_sdk/permissions.py` collects them — no provider name in generic code.

An agent's **requirements** (`AgentSpec.requirements`, `builtin/readiness.py`)
are what it needs anywhere: the credentials its data sources read, their
permissions, each MCP server's `${VAR}`, and anything authored — written into
`agent.json` when it is published, so they travel with it. **Readiness**
(`GET agent/<id>/readiness?deployment_id=`) answers per requirement at one
deployment: `verified` (an OAuth grant holding the mapped scopes), `declared` (a
value present — what a key allows cannot be checked) or `missing`, with the one
fix as a sentence and as a `remedy` a screen acts on (`use_mine`, `authorize`). At a cloud
deployment a value counts only in its store, and a connection only when authorized for it.

A cloud deployment also gets one **funding** item, asked of the hub (`Deployment.funding()` →
`GET deployment/<id>/funding`). It names what pays for its model turns: its token allocation (the deploy
dialog's "Token allocation", `TokenAllocationSpec`), else the owner's capped default. A used-up limit makes the
item `missing`, and the fix names the limit. The item is asked at readiness only and never written into the
agent's requirements. A hub that cannot answer blocks nothing.
`flow project setup` folds the same per-source derivation (`--deployment` sets up a
deployment's values).

Readiness **gates a cloud deploy**: `Agent.deploy_to_cloud` publishes, plans the
placement, and raises `NotReady` (HTTP 409, `code: not_ready`, with the readiness and the
planned deployment) before any machine is paid for; the hub checks the same names again
(`require`). The deploy dialog renders that refusal with Use mine / Authorize per item.
`flow agent deploy <agent> [--environment E]` exits 1 on it; `flow credentials check|set|status
--deployment D` and `flow credentials diff <A|here> <B|here>` (which names each holds) work on
one deployment's values.

## Status vocabulary

A credential is `connected` when every required variable (its own, plus what the
deployment requires) has a value in the store the deployment keeps it in,
`partial` when some do, `missing` when none do. A variable's `warning` is
`missing`, `wrong-store` when a value exists in the other local store of the same
scope — a value the process will not receive — or `unreachable` for a remote store
that could not be asked.
