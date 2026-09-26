---
id: 5e2949c7-827c-50f9-a25f-0a322d4c42f5
---

# Credentials and secrets

A **credential** (`SecretPack`) is a named set of environment variables — a
"secret pack": Gmail is `GMAIL_ADDRESS` + `GMAIL_APP_PASSWORD`, a custom API key
is one variable. It is the **only** way a secret is declared. A declared variable
is injected into agent workers, terminals and compute-node commands; a value
nobody declares is never injected.

## Scope — where the declaration lives

A credential is a REPO folder asset, `agentic-assets/secret_pack/<name>/secret_pack.json`,
in one of the asset scopes Flowpad already has:

| Scope | Folder | Applies to |
|---|---|---|
| `project` | `<project mount>/agentic-assets/secret_pack/<name>/` | processes in that project |
| `user` | `~/agentic-assets/secret_pack/<name>/` | processes in every project on this machine |
| `system` | the shipped assistant project | nothing — a **template**, added to one of the scopes above |

A project credential travels with the project's repository; a teammate who opens
the project sees it as missing and fills in their own values.

Identity is a writable folder capsule (`.flow/capsules/identity.json`, UUID v4).
The shipped templates commit theirs, so every install indexes one row per template.

## Store — where the values live

`secret_pack.json` names its store in `value_store`. Both are
[`SecretStore`](snippets/secret-stores.md) types — `env` is the `env_file` store
(`env_file` is accepted too), and `spec.secret_store(environment)` builds the
configured store — so the same `load` / `save` / `validate_keys` serve a
credential, a data source and a spawn:

| `value_store` | Location of a value |
|---|---|
| `env` (default) | the `.env.local` at the scope root — the project mount, or the home folder — under the variable's own name |
| `vault` | the per-instance encrypted store (`flow_sdk/cli/auth/secrets.py`) under `vault_name(...)` |

`vault_name` (`flow_sdk/schema/data_spec/credential_contract.py`):

```
project scope → credential.project.<project_id>.<VAR>
user scope    → credential.user.<VAR>
lm_provider   → lm_api.<provider>          (what the LLM funding resolver reads)
named env     → credential.<env>.project.<project_id>.<VAR> / credential.<env>.user.<VAR>
```

A project's vault entry never answers for another project, so deleting one
credential never empties another's. A credential that names an `lm_provider` is
one key, always in the vault, and user-scoped — it funds every project, and it
has no per-environment value (deployments are hub-funded).

`.env.local` rules (`flow_sdk/builtin/env_local_store.py`): inside a git work
tree the file is excluded by git before a value is written, and a committable
file (tracked, or re-included by a negation) refuses the write with a
`block_code`. Outside a repo — a home folder — nothing is added to any
`.gitignore`. Flowpad removes a line only when the credential that declares it
is deleted, and then only that variable's lines (see [Deleting](#deleting--nothing-left-behind)). The same rules
apply to every environment's file; the ignore line appended is that file's own
name, so a project ignoring only `.env.local` still protects `.env.production.local`.

## Environments — one declaration, a value per environment

An environment is a `Deployment`'s `environment`. `development` is this
computer and always exists; the set of environments is `development` plus every
Deployment's `environment` (`credential_resolver.known_environments`). A cloud
deploy that names none reads `production`.

Declarations never differ by environment — `DATABASE_URL` is one variable. Only
where its value is read does:

| store | `development` | a named environment, e.g. `production` |
|---|---|---|
| `env` | `<scope root>/.env.local` (unchanged) | `<scope root>/.env.production.local` |
| `vault` | `credential.project.<pid>.VAR` (unchanged) | `credential.production.project.<pid>.VAR` |

`secret_pack.json` may override the store or the required set per environment;
the list of environments itself is never declared there:

```json
{ "name": "database", "schema": 2, "value_store": "env",
  "vars": { "DATABASE_URL": {}, "SENTRY_DSN": { "required": false } },
  "environments": { "production": { "value_store": "vault", "required": ["DATABASE_URL", "SENTRY_DSN"] } } }
```

A process's environment (`credential_resolver.environment_for`): the
`environment` of the Deployment it was created under; else this instance's
default (`instance_settings/environment.py`, set when a cloud machine adopts its
placement); else `development`. A data source whose driver reads a credential
(`auth.credential`) reads the environment of the Deployment that answers it
(`credential_resolver.environment_for_source`: its `answer_place`, else the
deployment this process serves, `FLOW_DEPLOYMENT_ID`, else the same default) — a
source syncing on a production box reads production values. A named environment's `env` store is exactly the
file a future "fetch secrets → write env file" step produces; it is read with
`dotenv_values`, never loaded into the backend's own environment.

## Resolution — what a process receives

`flow_sdk/builtin/credential_resolver.py`:

1. Credentials in scope: every `user` credential, plus the process's project's.
2. Per variable, a project declaration overrides a user one of the same name
   (status reports the user one as `shadowed_by`). Two credentials in one scope
   may not declare the same variable; saving refuses it.
3. The machine's attachment map (`ComputeNode.attached_secrets`) filters the set.
4. Each value is read from its credential's store in the process's environment;
   failures are logged by name and skipped.
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
| `GET status?project_id=` | every credential in user + project scope with per-variable presence, and each scope's `.env.local` keys (`declared_by`) — names only |
| `POST save` | create (in a scope) or update a credential, writing values FIRST so a refused value leaves no empty declaration |
| `POST values` | set or rotate values; empty values are skipped |
| `POST delete` | delete the credential's values from every environment's store — vault entries and `.env*` lines — then the folder; the result reports each store (`CredentialDeletedSpec`) |
| `POST audit` | the leftover sweep over this instance's stores (`credential_sweep.sweep_local`) — names only |

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
secret. A pause keeps everything.

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

## Status vocabulary

A credential is `connected` when every required variable has a value in its own
store, `partial` when some do, `missing` when none do. A variable's `warning` is
`missing`, or `wrong-store` when a value exists in the other store of the same
scope — a value the process will not receive.
