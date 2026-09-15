---
id: 6da42de9-2e3f-4175-b6b3-9a82a53d86f9
version: 6
---
# Secret stores — snippets (draft)

> **Status: proposal.** Nothing below is implemented yet. These snippets pin the
> intended shape of `SecretStore` before any code is written; once it lands they
> move to `docs/snippets/secret-stores.md`, each fence pinned by a test like the
> rest of the shelf.

A **`SecretStore`** is a place secret values live, the way a `DataSource` is a
place records come from. It exposes two verbs, **`load`** and **`save`**, bound
to a scope (`user` or `project`) and an environment (`development` by default).

Two store types ship out of the box:

| type       | where a value lives                                                                                            |
| ---------- | -------------------------------------------------------------------------------------------------------------- |
| `env_file` | `<scope root>/.env.local` (`development`) or `.env.<env>.local`                                                |
| `vault`    | the per-instance encrypted store, `credential.[<env>.]project.<pid>.<NAME>` / `credential.[<env>.]user.<NAME>` |

**The connecting key is the environment variable name.** Every store is keyed by
`ENV_VAR_NAME`; how a store spells that key internally (a file line, a vault
entry) is its own business. `load` returns `{ENV_VAR_NAME: SecretStr}` and
`save` takes the same shape, so **env vars are the common currency**: moving
values between stores, or into a process, is a dict.

A `CredentialSpec` uses the stores **as is**: it declares which names exist,
names a store type per environment (`value_store`), and is the allow-list for
both verbs. Connections stay what they are — accounts. A store can *use* a
connection to reach an external system, exactly like a data source; it never
keeps a connection's token as one of its secrets.

## 1. A store: load and save by name

```python
from flow_sdk.secrets import SecretStore

store = SecretStore.for_scope("env_file", project=project)          # <mount>/.env.local
await store.save({"DATABASE_URL": "postgres://localhost:54322/dev"})

values = await store.load(["DATABASE_URL", "SENTRY_DSN"])           # a missing name is simply absent
values["DATABASE_URL"].get_secret_value()

await store.names()                                                 # ["DATABASE_URL"] — names only, never values
```

The same verbs on the other store type, and on a named environment:

```python
vault = SecretStore.for_scope("vault", user=True)                   # credential.user.<NAME>
prod = SecretStore.for_scope("env_file", project=project, environment="production")   # .env.production.local
```

`save` keeps every rule the stores have today: a value lands in an env file only
once git excludes that file; a vault write needs the vault enabled; empty values
are skipped, never cleared.

## 2. A credential uses its store as is

```python
from flow_sdk.builtin.credential_spec import CredentialSpec

spec = await CredentialSpec.get_by_name("database", project=project)
store = await spec.secret_store(environment="production")   # the spec's value_store for that environment

await store.save({"DATABASE_URL": hosted_url})              # a name outside spec.var_names() is refused
values = await store.load(spec.var_names())
```

`credential.json` does not change: `value_store` names a store type, and
`environments.<env>.value_store` overrides it for one environment.

```json
{ "name": "database", "schema": 2, "value_store": "env",
  "vars": { "DATABASE_URL": {} },
  "environments": { "production": { "value_store": "vault" } } }
```

## 3. Env vars — what a process receives

```python
import os

from flow_sdk.builtin.credential_resolver import resolve_attached_secrets

env = dict(os.environ)
secrets = await resolve_attached_secrets(project, environment="production")   # every declared credential → its store → load
for name, value in secrets.items():
    env.setdefault(name, value.get_secret_value())                             # an explicitly set variable still wins
```

`resolve_attached_secrets` stays the one entry point for a spawn (worker,
terminal, node command). Inside, it becomes a `store.load(names)` per credential,
read once per store.

## 4. Moving values between stores

```python
names = spec.var_names()

await vault.save(await store.load(names))          # move development values from the env file into the vault
await prod.save(await remote.load(names))          # later: fetch secrets → env file (remote is any store)
```

The second line is the planned "fetch secrets → env file → load env" flow: a
named environment's env file is exactly what a fetch writes, and a spawn reads it
with `dotenv_values` — never `load_dotenv` into the backend's own environment.

## 5. Data sources — the same key

A data source names the variables it needs in its manifest:

```json
{ "name": "agentmail", "auth": { "env": ["AGENTMAIL_API_KEY"] } }
```

```python
from flow_sdk.ingest.credentials import resolve_credentials
from flow_sdk.sources import SourceBinding, source_type

creds = await resolve_credentials(spec.auth, row)     # Credentials(shape=ENV, values={"AGENTMAIL_API_KEY": SecretStr(...)})
async with source_type(row.provider).build(SourceBinding(config=row.config, credentials=creds)) as source:
    ...
```

Today `resolve_credentials` reads `os.environ["AGENTMAIL_API_KEY"]`. With
stores, the credential that declares `AGENTMAIL_API_KEY` answers first (its store,
its environment), and `os.environ` is the fallback. `auth.secrets` — a named
machine secret — is `vault.load([name])`. No new auth shape: a data source's
variables become credential variables and get environments, packing and the
Connections screen for free.

## 6. Connections — accounts, not stores

```python
from flow_sdk.connections import require

google = await require("google")      # the account a store (or a data source) acts as
```

A future external store is credentialed the way a data source is — its asset
manifest names a connector:

```json
{ "name": "gcp_secret_manager", "auth": { "connector": "google", "scopes": ["https://www.googleapis.com/auth/cloud-platform"] } }
```

```python
remote = SecretStore.for_scope(
    "gcp_secret_manager",
    project=project,
    environment="production",
    config={"gcp_project": "acme-prod"},   # the account comes from the connection, never from config
)
values = await remote.load(spec.var_names())
```

## What already exists, and what it becomes

| `SecretStore`                                     | today                                                                                                            |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `env_file` `load` / `save` / `names`              | `env_local_store.read_env_local_values`, `write_env_local`, `list_env_local` (gitignore guard included)          |
| `vault` `load` / `save` / `names`                 | `credential_store._load_vault`, `cli.auth.secrets.write_secret`, `credential_contract.vault_name`, `get_secrets` |
| `SecretStore.for_scope(type, scope, environment)` | `CredentialScope` + `CredentialSpec.store_for(env)` + `credential_store.location_name`                           |
| `store.forget(names)`                             | `credential_store.forget_values` (vault entries go; env file lines stay)                                         |
| data source `auth.env` / `auth.secrets`           | `ingest/credentials.py`, loading through stores                                                                  |

Every guarantee carries over: values travel as `SecretStr`, only names are ever
logged, status never reads a value, and a value is never written to a file git
would commit.

## Open questions

1. **Registry or rows.** The two shipped stores need no config or account, so
   `SecretStore` starts as a type registry with implicit per-scope instances. A
   `SecretStore` row (like `DataSource`) only when a configured external store with
   an account arrives.
2. **`os.environ`** **as a store.** A third, load-only type (`env_vars`) for CI and
   cloud machines, or only the destination and fallback of §3 and §5.
3. **Naming.** The glossary's *value store* becomes **SecretStore**; `value_store`
   in `credential.json` keeps naming a store type.
4. **Data source migration.** Fold `auth.env` / `auth.secrets` into credential
   variables now, or only route their loads through stores first.

