---
id: 6da42de9-2e3f-4175-b6b3-9a82a53d86f9
version: 67
---
# Secret stores

Every fence on this page runs in `tests/unit/test_secrets/test_secret_stores_snippets.py`; the
verbs underneath are pinned in `tests/unit/test_secrets/` and `tests/unit/test_connection_access.py`.

A **`SecretStore`** is a place secret values live, the way a `DataSource` is a
place records come from. Like a data source, a store is **a type plus its
config**. It exposes **`load`** and **`save`**, and it can prove it holds what a
consumer needs (**`validate_keys`**).

## The pattern

Everything that needs access — a data source, a credential, a spawned process, an
external store — follows the same three steps, for **both** kinds of access:

| step                                       | secrets (named values)                                                 | connections (accounts)                                                                                          |
| ------------------------------------------ | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 1. **The consumer declares what it needs** | `source.credentials.names()` → `["GMAIL_ADDRESS", …]`                  | `source.connections.names()` → `["google"]`                                                                     |
| 2. **The provider is got and checked**     | `store = await SecretStore.get()` · `await store.validate_keys(names)` | `google = await Connection.get("google")` · `await google.validate_scopes(source.connections.scopes("google"))` |
| 3. **It is bound to the consumer**         | `await source.set_secret_store(store)`                                 | `await source.set_connection(google)`                                                                           |

When the consumer opens, it loads its names from the bound store and its token
from the bound connection. A binding is **saved on the data source row**, so the
heartbeat's sync, a webhook and an outbound send — which receive only the row —
read with what was bound.

A connection is an account, not a store: it holds one grant and hands out a
token; a store holds named values. They never mix — a store never keeps a
connection's token as one of its secrets.

## The API in one place

| call                                           | returns / does                                                           |
| ---------------------------------------------- | ------------------------------------------------------------------------ |
| `await context.current_project()`              | the project of the working directory (nearest folder up), or `None`      |
| `project.env_file_path(environment)`           | that project's env file for an environment                               |
| `await SecretStore.get()`                      | the default store: `env_file` on the current project's `.env.local`      |
| `await SecretStore.get(type, config)`          | a store of that type, configured                                         |
| `await store.load(names)`                      | `{ENV_VAR_NAME: SecretStr}` — a missing name is absent                   |
| `await store.save(values)`                     | writes `{ENV_VAR_NAME: str or SecretStr}`; an empty value is skipped     |
| `await store.names()`                          | the names the store holds — never values                                 |
| `await store.validate_keys(names)`             | nothing; raises `MissingSecrets` naming what the store lacks             |
| `await store.forget(names)`                    | `(deleted, kept)` — vault entries go, env file lines stay                |
| `store.ref`                                    | the store as a value (`{type, config}`) — what a binding saves           |
| `await CredentialSpec.get(name, project=None)` | the credential with that name                                            |
| `await spec.secret_store(environment)`         | the store `credential.json` names for that environment                   |
| `await DataSource.get(name)`                   | the one data source instance with that name                              |
| `consumer.credentials.names()`                 | the names a data source or credential needs                              |
| `await source.set_secret_store(store)`         | binds the store the source loads from, and saves it                      |
| `await Connection.get(provider)`               | the held connection; raises `NotConnected` when there is none            |
| `await connection.validate_scopes(scopes)`     | nothing; raises `MissingScopes` naming the scopes the grant lacks        |
| `await connection.connect(reauthorize=False)`  | runs the provider's flow; `reauthorize=True` consents again over a grant |
| `consumer.connections.names()`                 | the providers a data source or store needs                               |
| `consumer.connections.scopes(provider)`        | the scopes it needs from that provider                                   |
| `await source.set_connection(connection)`      | binds the account the source acts as, and saves it                       |
| `await source.open()`                          | the configured source, with what is bound loaded in                      |

One verb for lookups — `get` — on every class, always awaited. A credential is
resolved by project, then the user scope ([§2](#how-get-resolves-a-name)); a data
source by its name across the instance; a connection by provider for the current
user ([§6](#6-connections--the-same-pattern-for-accounts)); a store by type and
config, or the default.

## Store types

Three ship out of the box:

| type                 | config                                   | where a value lives                                                                       |
| -------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------- |
| `env_file`           | `env_file_path` — the file to read/write | that file, one `NAME=value` line per variable                                             |
| `vault`              | `prefix`, `entries` — the entry names    | the per-instance encrypted store, `<prefix><NAME>` or `entries`                           |
| `gcp_secret_manager` | `gcp_project`, `prefix`                  | the secret `<prefix><NAME>` in that GCP project, latest version — read with a bound `google` connection ([§6](#6-connections--the-same-pattern-for-accounts)) |

`SecretStore.get()` with no arguments is `env_file` on
`project.env_file_path()` for `await context.current_project()` — the
`.env.local` of the working directory's project. With no current project it
raises `NoCurrentProject`: there is no default file to guess.

The config says **where**; a store never infers anything from a scope or an
environment. Whoever asks for a store resolves the path or prefix and hands it
over — or takes the default. A misspelled config key is refused, and another
type registers with `register_store(cls)`.

**The connecting key is the environment variable name.** Every store is keyed by
`ENV_VAR_NAME`; how a store spells that key internally (a file line, a vault
entry) is its own business. `load` returns a dict of names and `save` takes one,
so **env vars are the common currency**: moving values between stores, or into
a process, is a dict.

## 1. A store: load, save, validate

```python
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
from flow_sdk import context
from flow_sdk.secrets import SecretStore

project = await context.current_project()

vault = await SecretStore.get("vault", {"prefix": "credential.user."})                                   # credential.user.<NAME>
prod = await SecretStore.get("env_file", {"env_file_path": str(project.env_file_path("production"))})    # <mount>/.env.production.local
```

`save` keeps every rule the stores had before: a value lands in an env file only
once git excludes that file (a tracked file is refused); a vault write needs the
vault enabled; empty values are skipped, never cleared.

## 2. A credential uses its store as is

```python
from flow_sdk.builtin.credential_spec import CredentialSpec

spec = await CredentialSpec.get("database")                    # the current project's, else the user scope's
names = spec.credentials.names()                               # ["DATABASE_URL"]

prod = await spec.secret_store("production")                   # the store credential.json names for production
await prod.save({"DATABASE_URL": "postgres://pooler.hosted.example/prod"})
await prod.validate_keys(names)
```

A credential is the one consumer that already knows its store:
`spec.secret_store(environment)` builds it from `credential.json`, so there is
nothing to bind.

### How `get` resolves a name

`CredentialSpec.get(name, project=None)`:

1. **`project`** **given** — that project's credential named `name`; if it has
   none, the user scope's (step 3).
2. **`project`** **omitted** — the current project, `await context.current_project()`,
   and the same lookup as step 1.
3. **User scope** — `~/agentic-assets/credential/`, which every project on this
   machine sees.

A project credential wins over a user one of the same name. Shipped templates
are never returned. Two failures, both raised rather than guessed:

```python
from flow_sdk.builtin.credential_spec import CredentialAmbiguous, CredentialNotFound, CredentialSpec

spec = await CredentialSpec.get("database", project=other_project)   # a specific project instead of the working directory
try:
    spec = await CredentialSpec.get("stripe")
except CredentialAmbiguous as e:     # more than one credential named "stripe" in the scope that answered
    e.candidates                     # their typeids — pick one with CredentialSpec.get_by_id(...)
except CredentialNotFound:           # neither the project nor the user scope declares it
    ...
```

With no current project (a script outside any project folder), only step 3 runs.

`DataSource.get(name)` is simpler: a data source is not project-scoped, so the
name is looked up across the instance — `DataSourceNotFound` when no instance has
it, `DataSourceAmbiguous` (with `candidates`) when several do.

### Where a credential's store points

`spec.secret_store(environment)` is the only place a credential's scope and
environment become a config:

| `value_store`           | config it passes to `SecretStore.get`                                                                                 |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `env` / `env_file`      | `env_file_path`: the scope root's `.env.local` (`development`) or `.env.<env>.local`                                  |
| `vault`                 | `prefix`: `credential.project.<pid>.` / `credential.user.`, with `<env>.` after `credential.` for a named environment |
| `vault` + `lm_provider` | `entries`: the one `lm_api.<provider>` entry, whatever the variable is called                                         |

`value_store` names a store type, and `environments.<env>.value_store` overrides
it for one environment:

```json
{ "name": "database", "schema": 2, "value_store": "env",
  "vars": { "DATABASE_URL": {} },
  "environments": { "production": { "value_store": "vault" } } }
```

Files spell the env file store `env`; `env_file` is accepted as the same store,
so no existing `credential.json` changes.

## 3. Env vars — what a process receives

```python
import os

from flow_sdk import context
from flow_sdk.builtin.credential_resolver import resolve_attached_secrets

project = await context.current_project()
env = dict(os.environ)
secrets = await resolve_attached_secrets(project, environment="production")   # each credential → its store → load
for name, value in secrets.items():
    env.setdefault(name, value.get_secret_value())                             # an explicitly set variable still wins
```

`resolve_attached_secrets` stays the one entry point for a spawn (worker,
terminal, node command). Inside it is the same pattern per credential:
`spec.credentials.names()` → its store → `load`, with every store read once
(the vault is decrypted once, however many credentials use it).

## 4. Moving values between stores

```python
from flow_sdk import context
from flow_sdk.builtin.credential_spec import CredentialSpec
from flow_sdk.secrets import SecretStore

project = await context.current_project()
spec = await CredentialSpec.get("database")
names = spec.credentials.names()

dev_file = await SecretStore.get()                                                    # current project's .env.local
dev_vault = await SecretStore.get("vault", {"prefix": f"credential.project.{project.id}."})
await dev_file.validate_keys(names)
await dev_vault.save(await dev_file.load(names))                                      # development: env file → vault

prod_file = await SecretStore.get("env_file", {"env_file_path": str(project.env_file_path("production"))})
await prod_file.save(await remote.load(names))                                        # later: fetch → env file (`remote`: §6)
```

`save` takes what `load` returns — `SecretStr` values are unwrapped, never
written masked. The last line is the planned "fetch secrets → env file → load
env" flow: a named environment's env file is exactly what a fetch writes, and a
spawn reads it with `dotenv_values` — never `load_dotenv` into the backend's own
environment.

## 5. Data sources — the same key

A data source names the variables it needs in its manifest:

```json
{ "name": "gmail", "auth": { "env": ["GMAIL_ADDRESS", "GMAIL_APP_PASSWORD"] } }
```

```python
from flow_sdk.builtin.data_source import DataSource
from flow_sdk.secrets import SecretStore

source = await DataSource.get("work gmail")      # the one instance with that name
names = source.credentials.names()               # ["GMAIL_ADDRESS", "GMAIL_APP_PASSWORD"] — from the manifest's auth

store = await SecretStore.get()                  # default: the current project's .env.local
await store.validate_keys(names)                 # MissingSecrets if the file lacks any
await source.set_secret_store(store)             # saved on the row: every sync reads this store

async with await source.open() as live:          # open() loads `names` from the bound store into the binding
    ...
```

What a source reads, per manifest `auth` shape (`ingest/credentials.resolve_credentials`):

* **`env`** — the names, from the bound store. Unbound: the default store
  (`SecretStore.get()`, when there is a current project), then the process
  environment for any name still missing.

* **`secrets`** — `{value key: machine secret name}`: the value key from the
  bound (or default) store, else the named machine secret, else the row's own
  `config[value key]`.

* **`connector`** — the bound connection's provider, else the manifest's
  ([§6](#6-connections--the-same-pattern-for-accounts)).

No new auth shape: a data source's names are the same `ENV_VAR_NAME`s a
credential declares, so one store serves both.

### Two instances of one source

A data source row is an **instance**: a source type, its config, and its
bindings. Two Gmail inboxes — or two Drives with different folders — are two rows,
and each keeps its own:

```python
from flow_sdk.builtin.data_source import DataSource
from flow_sdk.secrets import SecretStore

work = await DataSource.get("work gmail")
home = await DataSource.get("home gmail")                                      # same source type, its own config
await work.set_secret_store(await SecretStore.get("vault", {"prefix": "gmail.work."}))
await home.set_secret_store(await SecretStore.get("vault", {"prefix": "gmail.home."}))
```

## 6. Connections — the same pattern, for accounts

A data source that acts as an account declares it in its manifest instead of
variable names:

```json
{ "name": "gdrive", "auth": { "connector": "google", "scopes": ["https://www.googleapis.com/auth/drive.readonly"] } }
```

```python
from flow_sdk.builtin.data_source import DataSource
from flow_sdk.connections import Connection, MissingScopes, NotConnected

source = await DataSource.get("work drive")
providers = source.connections.names()             # ["google"] — from the manifest's auth.connector

try:
    google = await Connection.get("google")         # the held grant for this user
    await google.validate_scopes(source.connections.scopes("google"))
except NotConnected as e:
    google = await e.connection.connect()           # the unconnected row rides on the error; browser or device flow
except MissingScopes as e:
    google = await google.connect(reauthorize=True) # e.missing names the scopes; consent runs again

await source.set_connection(google)

async with await source.open() as live:            # open() asks the bound connection for a token
    ...
```

`Connection.get` resolves a provider name the way `SecretStore.get()` takes a
default: there is one grant per provider per user, so the name is enough.
`validate_scopes` compares with the scopes the provider's grant is configured to
request — what a connect consents to. `require(provider)` is the older name for
`Connection.get` and stays.

An external store is a consumer of both kinds — it acts as an account and holds
named values. `gcp_secret_manager` ships as one; another registers with `register_store`:

```python
from flow_sdk.builtin.data_source import DataSource
from flow_sdk.connections import Connection
from flow_sdk.secrets import SecretStore

agentmail = await DataSource.get("agent inbox")
remote = await SecretStore.get("gcp_secret_manager", {"gcp_project": "acme-prod", "prefix": "agentmail-production-"})

google = await Connection.get("google")                                 # remote.connections.names() → ["google"]
await google.validate_scopes(remote.connections.scopes("google"))
await remote.set_connection(google)                                     # the account comes from the connection, never from config

await remote.validate_keys(agentmail.credentials.names())
await agentmail.set_secret_store(remote)                                # the agentmail source now loads its key from GCP
```

## What each call replaced

| call                                                  | before                                                                                                   |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `SecretStore.get("env_file", …)`                      | `env_local_store.read_env_local_values`, `write_env_local`, `list_env_local` (gitignore guard kept)      |
| `SecretStore.get("vault", …)`                         | `credential_store._load_vault`, `cli.auth.secrets.write_secret`, `get_secrets`                           |
| `CredentialSpec.get(name, project=None)`              | `credential_resolver.credentials_in_scope(project)` filtered by hand                                     |
| `spec.secret_store(environment)`                      | `credential_store.location_name` + `CredentialSpec.store_for(env)` spread over read, write and forget    |
| `DataSource.get(name)`                                | `DataSource.get_all({"name": ...})`                                                                      |
| `source.set_secret_store` / `set_connection` + `open` | `resolve_credentials` reading `os.environ`, a named vault entry and `token_for(auth.connector)` directly |
| `Connection.get(provider)`                            | `flow_sdk.connections.require(provider)` (kept)                                                          |
| `connection.validate_scopes(scopes)`                  | comparing `Connection.scopes` by hand; a missing scope failed at the provider call                       |
| `connection.connect(reauthorize=True)`                | the Connections screen's Reconnect only                                                                  |
| `context.current_project()`                           | `Project.find_by_cwd` at each call site, exact folder only                                               |

Every guarantee carries over: values and tokens travel as `SecretStr`, only
names are ever logged (`MissingSecrets` carries variable names, `MissingScopes`
scope names), status never reads a value, and a value is never written to a file
git would commit.

## Still open

1. **Registry or rows.** `SecretStore.get(type, config)` needs no row for the two
   shipped types. A `SecretStore` row (with a name, owner and saved config) only
   when a configured external store with an account arrives — then `get` also
   accepts a saved store's name, and a binding can name it instead of a config.
2. **`os.environ`** **as a store.** A third, load-only type (`env_vars`, no config)
   for CI and cloud machines — then a machine with no env file binds that instead
   of relying on the unbound fallback.

