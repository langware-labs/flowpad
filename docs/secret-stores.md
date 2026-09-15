---
id: 6da42de9-2e3f-4175-b6b3-9a82a53d86f9
version: 64
---
# Secret stores — snippets (draft)

> **Status: proposal.** Nothing below is implemented yet. These snippets pin the
> intended shape of `SecretStore` before any code is written; once it lands they
> move to `docs/snippets/secret-stores.md`, each fence pinned by a test like the
> rest of the shelf.

A **`SecretStore`** is a place secret values live, the way a `DataSource` is a
place records come from. Like a data source, a store is **a type plus its
config**. It exposes **`load`** and **`save`**, and it can prove it holds what a
consumer needs (**`validate_keys`**).

## The pattern

Everything that needs access — a data source, a credential, a spawned process, an
external store — follows the same three steps, for **both** kinds of access:

| step                                       | secrets (named values)                                                 | connections (accounts)                                                             |
| ------------------------------------------ | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 1. **The consumer declares what it needs** | `source.credentials.names()` → `["AGENTMAIL_API_KEY"]`                 | `source.connections.names()` → `["google"]`                                        |
| 2. **The provider is got and checked**     | `store = await SecretStore.get()` · `await store.validate_keys(names)` | `google = await Connection.get("google")` · `await google.validate_scopes(scopes)` |
| 3. **It is bound to the consumer**         | `source.set_secret_store(store)`                                       | `source.set_connection(google)`                                                    |

When the consumer opens, it loads its names from the bound store and its token
from the bound connection. Nothing reads `os.environ`, a file or the connection
table behind the consumer's back: what is bound is what it uses.

A connection is an account, not a store: it holds one grant and hands out a
token; a store holds named values. They never mix — a store never keeps a
connection's token as one of its secrets.

## The API in one place

Every snippet below uses only these calls:

| call                                                 | returns / does                                                      |
| ---------------------------------------------------- | ------------------------------------------------------------------- |
| `await SecretStore.get()`                            | the default store: `env_file` on the current project's `.env.local` |
| `await SecretStore.get(type, config)`                | a store of that type, configured                                    |
| `await store.load(names)`                            | `{ENV_VAR_NAME: SecretStr}` — a missing name is absent              |
| `await store.save(values)`                           | writes `{ENV_VAR_NAME: str}`                                        |
| `await store.names()`                                | the names the store holds — never values                            |
| `await store.validate_keys(names)`                   | nothing; raises `MissingSecrets` naming what the store lacks        |
| `await DataSource.get(name, project=None)`           | the data source with that name                                      |
| `await CredentialSpec.get(name, project=None)`       | the credential with that name                                       |
| `consumer.credentials.names()`                       | the names a data source or credential needs                         |
| `consumer.set_secret_store(store)`                   | binds the store the consumer loads from                             |
| `await Connection.get(provider)`                     | the held connection; raises `NotConnected` when there is none       |
| `await connection.validate_scopes(scopes)`           | nothing; raises `MissingScopes` naming the scopes the grant lacks   |
| `consumer.connections.names()`                       | the providers a data source or store needs                          |
| `consumer.connections.scopes(provider)`              | the scopes it needs from that provider                              |
| `consumer.set_connection(connection)`                | binds the account the consumer acts as                              |
| `context.current_project.env_file_path(environment)` | the project's env file for an environment                           |

One verb for lookups — `get` — on every class, always awaited, and resolved the
same way (see [§2](#2-a-credential-uses-its-store-as-is)).

## Store types

Two ship out of the box:

| type       | config                                   | where a value lives                                |
| ---------- | ---------------------------------------- | -------------------------------------------------- |
| `env_file` | `env_file_path` — the file to read/write | that file, one `NAME=value` line per variable      |
| `vault`    | `prefix` — the entry namespace           | the per-instance encrypted store, `<prefix><NAME>` |

`SecretStore.get()` with no arguments is `env_file` on
`context.current_project.env_file_path()` — the `.env.local` of the working
directory's project. With no current project it raises: there is no default
file to guess.

The config says **where**; a store never infers anything from a scope or an
environment. Whoever asks for a store resolves the path or prefix and hands it
over — or takes the default.

**The connecting key is the environment variable name.** Every store is keyed by
`ENV_VAR_NAME`; how a store spells that key internally (a file line, a vault
entry) is its own business. `load` returns a dict of names and `save` takes one,
so **env vars are the common currency**: moving values between stores, or into
a process, is a dict.

## 1. A store: load, save, validate

```python
from flow_sdk import context
from flow_sdk.secrets import MissingSecrets, SecretStore

store = await SecretStore.get()                                # current project's .env.local
await store.save({"DATABASE_URL": "postgres://localhost:54322/dev"})

values = await store.load(["DATABASE_URL", "SENTRY_DSN"])      # SENTRY_DSN was never saved: absent
values["DATABASE_URL"].get_secret_value()

await store.names()                                            # ["DATABASE_URL"]

try:
    await store.validate_keys(["DATABASE_URL", "SENTRY_DSN"])
except MissingSecrets as e:
    e.missing                                                  # ["SENTRY_DSN"] — names only
```

The other store type, and a named environment — only the config differs:

```python
project = context.current_project

vault = await SecretStore.get("vault", {"prefix": "credential.user."})                           # credential.user.<NAME>
prod = await SecretStore.get("env_file", {"env_file_path": project.env_file_path("production")})  # <mount>/.env.production.local
```

`save` keeps every rule the stores have today: a value lands in an env file only
once git excludes that file; a vault write needs the vault enabled; empty values
are skipped, never cleared.

## 2. A credential uses its store as is

```python
from flow_sdk.builtin.credential_spec import CredentialSpec

spec = await CredentialSpec.get("database")                    # the current project's, else the generally available one
names = spec.credentials.names()                               # ["DATABASE_URL"]

prod = await spec.secret_store("production")                   # the store credential.json names for production
await prod.validate_keys(names)
await prod.save({"DATABASE_URL": "postgres://pooler.hosted.example/prod"})   # a name outside `names` is refused
```

A credential is the one consumer that already knows its store:
`spec.secret_store(environment)` builds it from `credential.json`. Binding a
different one works like any consumer — `spec.set_secret_store(store)`.

### How `get` resolves a name

`DataSource.get(name, project=None)` and `CredentialSpec.get(name, project=None)`
resolve the same way:

1. **`project`** **given** — that project's row named `name`; if it has none, the
   generally available one (step 3).
2. **`project`** **omitted** — the current project, `context.current_project` (the
   working directory's project), and the same lookup as step 1.
3. **Generally available** — the user-scope rows (for credentials,
   `~/agentic-assets/credential/`), which every project on this machine sees.
   Exactly one match is returned.

A project row wins over a generally available one of the same name. Shipped
templates are never returned. Two failures, both raised rather than guessed:

```python
from flow_sdk.builtin.credential_spec import CredentialAmbiguous, CredentialNotFound

spec = await CredentialSpec.get("database", project=other_project)   # a specific project instead of the working directory
try:
    spec = await CredentialSpec.get("stripe")
except CredentialAmbiguous as e:     # more than one generally available credential is named "stripe"
    e.candidates                     # their typeids — pick one with CredentialSpec.get_by_id(...)
except CredentialNotFound:           # neither the project nor the user scope declares it
    ...
```

With no current project (a script outside any project folder), only step 3 runs.

### Where a credential's store points

`spec.secret_store(environment)` is the only place a credential's scope and
environment become a config:

| `value_store` | config it passes to `SecretStore.get`                                                                                 |
| ------------- | --------------------------------------------------------------------------------------------------------------------- |
| `env_file`    | `env_file_path`: the scope root's `.env.local` (`development`) or `.env.<env>.local`                                  |
| `vault`       | `prefix`: `credential.project.<pid>.` / `credential.user.`, with `<env>.` after `credential.` for a named environment |

`value_store` names a store type, and `environments.<env>.value_store` overrides
it for one environment:

```json
{ "name": "database", "schema": 2, "value_store": "env_file",
  "vars": { "DATABASE_URL": {} },
  "environments": { "production": { "value_store": "vault" } } }
```

Today's files spell the env file store `env`; that spelling stays accepted as an
alias of `env_file`, so no existing `credential.json` changes.

## 3. Env vars — what a process receives

```python
import os

from flow_sdk.builtin.credential_resolver import resolve_attached_secrets

env = dict(os.environ)
secrets = await resolve_attached_secrets(project, environment="production")   # each credential → its store → load
for name, value in secrets.items():
    env.setdefault(name, value.get_secret_value())                             # an explicitly set variable still wins
```

`resolve_attached_secrets` stays the one entry point for a spawn (worker,
terminal, node command). Inside it is the same pattern per credential:
`spec.credentials.names()` → `spec.secret_store(environment)` → `load`.

## 4. Moving values between stores

```python
spec = await CredentialSpec.get("database")
names = spec.credentials.names()

dev_file = await SecretStore.get()                                                    # current project's .env.local
dev_vault = await SecretStore.get("vault", {"prefix": f"credential.project.{project.id}."})
await dev_file.validate_keys(names)
await dev_vault.save(await dev_file.load(names))                                      # development: env file → vault

prod_file = await SecretStore.get("env_file", {"env_file_path": project.env_file_path("production")})
await prod_file.save(await remote.load(names))                                        # later: fetch → env file (`remote`: §6)
```

The last line is the planned "fetch secrets → env file → load env" flow: a named
environment's env file is exactly what a fetch writes, and a spawn reads it with
`dotenv_values` — never `load_dotenv` into the backend's own environment.

## 5. Data sources — the same key

A data source names the variables it needs in its manifest:

```json
{ "name": "agentmail", "auth": { "env": ["AGENTMAIL_API_KEY"] } }
```

```python
from flow_sdk.builtin.data_source import DataSource
from flow_sdk.secrets import SecretStore

source = await DataSource.get("agent_email")      # resolved like CredentialSpec.get
names = source.credentials.names()               # ["AGENTMAIL_API_KEY"] — from the manifest's auth

store = await SecretStore.get()                  # default: the current project's .env.local
await store.validate_keys(names)                 # MissingSecrets if the file lacks any
source.set_secret_store(store)

async with await source.open() as connection:    # open() loads `names` from the bound store into the binding
    ...
```

The bound store replaces today's hidden lookup: `credentials_for` (through
`ingest/credentials.resolve_credentials`) reads `os.environ["AGENTMAIL_API_KEY"]`
for `auth.env` and a named vault entry for `auth.secrets`. With the pattern:

* `auth.env` names become `source.credentials.names()`, loaded from the bound store.

* `auth.secrets` is a source bound to a vault store:
  `source.set_secret_store(await SecretStore.get("vault", {"prefix": ""}))`.

* A source with no bound store uses `SecretStore.get()` — the same default as
  everywhere else.

No new auth shape: a data source's names are the same `ENV_VAR_NAME`s a
credential declares, so one store serves both.

## 6. Connections — the same pattern, for accounts

A data source that acts as an account declares it in its manifest instead of
variable names:

```json
{ "name": "gdrive", "auth": { "connector": "google", "scopes": ["https://www.googleapis.com/auth/drive.readonly"] } }
```

```python
from flow_sdk.builtin.data_source import DataSource
from flow_sdk.connections import Connection, MissingScopes, NotConnected

source = await DataSource.get("drive tester")
providers = source.connections.names()             # ["google"] — from the manifest's auth.connector

try:
    google = await Connection.get("google")         # the held grant for this user
    await google.validate_scopes(source.connections.scopes("google"))
except NotConnected as e:
    google = await e.connection.connect()           # the unconnected row rides on the error; browser or device flow
except MissingScopes as e:
    google = await google.connect(reauthorize=True) # e.missing names the scopes; re-consent asks for them

source.set_connection(google)

async with await source.open() as live:            # open() asks the bound connection for a fresh token
    ...
```

`Connection.get` resolves a provider name the way `SecretStore.get()` takes a
default: there is one grant per provider per user, so the name is enough.

An external store is a consumer of both kinds — it acts as an account and holds
named values:

```json
{ "name": "gcp_secret_manager", "auth": { "connector": "google", "scopes": ["https://www.googleapis.com/auth/cloud-platform"] } }
```

```python
agentmail = await DataSource.get("agent_email")

remote = await SecretStore.get("gcp_secret_manager", {"gcp_project": "acme-prod", "prefix": "agentmail-production-"})
remote.set_connection(await Connection.get("google"))    # the account comes from the connection, never from config

await remote.validate_keys(agentmail.credentials.names())
agentmail.set_secret_store(remote)                        # the agentmail source now loads its key from GCP
```

## What already exists, and what it becomes

| proposed                                                                    | today                                                                                                    |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `SecretStore.get()` / `SecretStore.get("env_file", {"env_file_path": ...})` | `env_local_store.read_env_local_values`, `write_env_local`, `list_env_local` (gitignore guard included)  |
| `SecretStore.get("vault", {"prefix": ...})`                                 | `credential_store._load_vault`, `cli.auth.secrets.write_secret`, `get_secrets`                           |
| `store.validate_keys(names)`                                                | new; today status computes presence per variable (`credential_status.py`)                                |
| `CredentialSpec.get(name, project=None)`                                    | `credential_resolver.credentials_in_scope(project)` filtered by name — project first, then user scope    |
| `DataSource.get(name, project=None)`                                        | new; today `DataSource.find_for_account(provider, key, value)`                                           |
| `consumer.credentials.names()`                                              | `CredentialSpec.var_names()`; a data source's manifest `auth.env` / `auth.secrets`                       |
| `spec.secret_store(environment)`                                            | `CredentialScope` + `CredentialSpec.store_for(env)` + `credential_contract.env_file_name` / `vault_name` |
| `consumer.set_secret_store(store)` + `open()`                               | `SourceType.credentials_for(row)` → `ingest/credentials.resolve_credentials`                             |
| `project.env_file_path(environment)`                                        | `project_scope(project).root` + `env_file_name(environment)`                                             |
| `Connection.get(provider)`                                                  | `flow_sdk.connections.require(provider)` / `get_connection(provider)`                                    |
| `connection.validate_scopes(scopes)`                                        | new; today `Connection.scopes` compared by hand, a missing scope fails at the provider call              |
| `consumer.connections.names()` + `set_connection(...)`                      | a data source's manifest `auth.connector`; `token_for(provider)` inside `resolve_credentials`            |
| `store.forget(names)`                                                       | `credential_store.forget_values` (vault entries go; env file lines stay)                                 |

Every guarantee carries over: values travel as `SecretStr`, only names are ever
logged (`MissingSecrets` carries names), status never reads a value, and a value
is never written to a file git would commit.

## Open questions

1. **Registry or rows.** `SecretStore.get(type, config)` needs no row for the two
   shipped types. A `SecretStore` row (like `DataSource`, with a name, owner and
   saved config) only when a configured external store with an account arrives —
   then `get` also accepts a saved store's name.
2. **Is the binding saved?** `source.set_secret_store(store)` binds for this
   process. Persist it on the `DataSource` row (so the heartbeat's sync uses the
   same store), or bind at every open.
3. **`os.environ`** **as a store.** A third, load-only type (`env_vars`, no config)
   for CI and cloud machines — then a machine with no env file binds that instead
   of relying on a hidden fallback.
4. **`flow_sdk.context`.** There is no `flow_sdk.context` module today; the
   current project is resolved per call site. Add it as the public way to ask
   "which project am I in" (worker, terminal, script), or pass the project
   explicitly.
5. **`require`** **and** **`get_connections`.** `Connection.get(provider)` replaces
   `require` (same `NotConnected`); `get_connections()` stays as the listing of every provider. Keep `require` as an alias, or remove it.
6. **Naming.** The glossary's *value store* becomes **SecretStore**; `env_file` is
   the store type's name and `env` its accepted alias in `credential.json`.
   `spec.var_names()` becomes `spec.credentials.names()` so both consumers read
   the same.

