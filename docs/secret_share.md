---
id: 5e2949c7-827c-50f9-a25f-0a322d4c42f5
---

# Credentials and secrets

A **credential** (`CredentialSpec`) is a named set of environment variables — a
"secret pack": Gmail is `GMAIL_ADDRESS` + `GMAIL_APP_PASSWORD`, a custom API key
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

## Store — where the values live

`credential.json` names its store in `value_store`:

| `value_store` | Location of a value |
|---|---|
| `env` (default) | the `.env.local` at the scope root — the project mount, or the home folder — under the variable's own name |
| `vault` | the per-instance encrypted store (`flow_sdk/cli/auth/secrets.py`) under `vault_name(...)` |

`vault_name` (`flow_sdk/schema/data_spec/credential_contract.py`):

```
project scope → credential.project.<project_id>.<VAR>
user scope    → credential.user.<VAR>
lm_provider   → lm_api.<provider>          (what the LLM funding resolver reads)
```

A project's vault entry never answers for another project, so deleting one
credential never empties another's. A credential that names an `lm_provider` is
one key, always in the vault, and user-scoped — it funds every project.

`.env.local` rules (`flow_sdk/builtin/env_local_store.py`): inside a git work
tree the file is excluded by git before a value is written, and a committable
file (tracked, or re-included by a negation) refuses the write with a
`block_code`. Outside a repo — a home folder — nothing is added to any
`.gitignore`. Flowpad never removes a line from a `.env.local`.

## Resolution — what a process receives

`flow_sdk/builtin/credential_resolver.py`:

1. Credentials in scope: every `user` credential, plus the process's project's.
2. Per variable, a project declaration overrides a user one of the same name
   (status reports the user one as `shadowed_by`). Two credentials in one scope
   may not declare the same variable; saving refuses it.
3. The machine's attachment map (`ComputeNode.attached_secrets`) filters the set.
4. Each value is read from its credential's store; failures are logged by name
   and skipped.
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
| `POST delete` | delete vault values and the folder; `.env.local` lines stay |

Every entry point uses `save`: Connections → Add connection (catalogue templates
and **Custom credentials**), packing detected `.env.local` keys into one credential,
and the quick-create **Secret** tile.

## Status vocabulary

A credential is `connected` when every required variable has a value in its own
store, `partial` when some do, `missing` when none do. A variable's `warning` is
`missing`, or `wrong-store` when a value exists in the other store of the same
scope — a value the process will not receive.
