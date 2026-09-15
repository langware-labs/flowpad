---
id: 6da42de9-2e3f-4175-b6b3-9a82a53d86f9
version: 49
---
# Secret stores — snippets (draft)

> **Status: proposal.** Nothing below is implemented yet. These snippets pin the
> intended shape of `SecretStore` before any code is written; once it lands they
> move to `docs/snippets/secret-stores.md`, each fence pinned by a test like the
> rest of the shelf.

A **`SecretStore`** is a place secret values live, the way a `DataSource` is a
place records come from. Like a data source, a store is **a type plus its
config**. It exposes two verbs, **`load`** and **`save`**.

## The API in one place

Every snippet below uses only these calls:

| call                                                 | returns                                                                                                             |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `await SecretStore.get(type, config)`                | a store of that type, configured                                                                                    |
| `await store.load(names)`                            | `{ENV_VAR_NAME: SecretStr}` — a missing name is absent                                                              |
| `await store.save(values)`                           | writes `{ENV_VAR_NAME: str}`                                                                                        |
| `await store.names()`                                | the names the store holds — never values                                                                            |
| `await CredentialSpec.get(name, project=None)`       | the credential declared under that name — see [§2](#2-a-credential-uses-its-store-as-is) for how `project` defaults |
| `await spec.secret_store(environment)`               | `SecretStore.get(...)` with the credential's type and resolved config                                               |
| `context.current_project.env_file_path(environment)` | the project's env file for an environment                                                                           |

One verb for lookups — `get` — on both classes, always awaited.

## Store types

Two ship out of the box:

| type       | config                                   | where a value lives                                |
| ---------- | ---------------------------------------- | -------------------------------------------------- |
| `env_file` | `env_file_path` — the file to read/write | that file, one `NAME=value` line per variable      |
| `vault`    | `prefix` — the entry namespace           | the per-instance encrypted store, `<prefix><NAME>` |

The config says **where**; a store never infers anything from a scope or an
environment. Whoever asks for a store — a script, a credential, a deployment —
resolves the path or prefix and hands it over.

**The connecting key is the environment variable name.** Every store is keyed by
`ENV_VAR_NAME`; how a store spells that key internally (a file line, a vault
entry) is its own business. `load` returns a dict of names and `save` takes one,
so **env vars are the common currency**: moving values between stores, or into
a process, is a dict.

A `CredentialSpec` uses the stores **as is**: it declares which names exist,
names a store type per environment (`value_store`), and is the allow-list for
both verbs. Connections stay what they are — accounts. A store can *use* a
connection to reach an external system, exactly like a data source; it never
keeps a connection's token as one of its secrets.

## 1. A store: load and save by name

```python
from flow_sdk import context
from flow_sdk.secrets import SecretStore

project = context.current_project

store = await SecretStore.get("env_file", {"env_file_path": project.env_file_path()})   # <mount>/.env.local
await store.save({"DATABASE_URL": "postgres://localhost:54322/dev"})

values = await store.load(["DATABASE_URL", "SENTRY_DSN"])      # SENTRY_DSN was never saved: absent
values["DATABASE_URL"].get_secret_value()

await store.names()                                            # ["DATABASE_URL"]
```

The other store type, and a named environment — only the config differs:

```python
vault = await SecretStore.get("vault", {"prefix": "credential.user."})                          # credential.user.<NAME>
prod = await SecretStore.get("env_file", {"env_file_path": project.env_file_path("production")})  # <mount>/.env.production.local
```

`save` keeps every rule the stores have today: a value lands in an env file only
once git excludes that file; a vault write needs the vault enabled; empty values
are skipped, never cleared.

## 2. A credential uses its store as is

```python
from flow_sdk.builtin.credential_spec import CredentialSpec

spec = await CredentialSpec.get("database")         # the current project's, else the generally available one
prod = await spec.secret_store("production")         # the credential's store for production

await prod.save({"DATABASE_URL": "postgres://pooler.hosted.example/prod"})   # a name outside spec.var_names() is refused
values = await prod.load(spec.var_names())
```

`CredentialSpec.get(name, project=None)` resolves one credential:

1. **`project`** **given** — that project's credential named `name`; if it has none,
   the generally available one (step 3).
2. **`project`** **omitted** — the current project, `context.current_project` (the
   working directory's project), and the same lookup as step 1.
3. **Generally available** — the user-scope credentials (`~/agentic-assets/credential/`),
   which every project on this machine sees. Exactly one match is returned.

A project credential wins over a generally available one of the same name, the
same precedence a process gets in §3. Shipped templates are never returned.
Two failures, both raised rather than guessed:

```python
from flow_sdk.builtin.credential_spec import CredentialNotFound, CredentialAmbiguous

spec = await CredentialSpec.get("database", project=other_project)   # a specific project instead of the working directory
try:
    spec = await CredentialSpec.get("stripe")
except CredentialAmbiguous as e:     # more than one generally available credential is named "stripe"
    e.candidates                     # their typeids — pick one with CredentialSpec.get_by_id(...)
except CredentialNotFound:           # neither the project nor the user scope declares it
    ...
```

With no current project (a script outside any project folder), only step 3 runs.

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
secrets = await resolve_attached_secrets(project, environment="production")   # each credential → spec.secret_store → load
for name, value in secrets.items():
    env.setdefault(name, value.get_secret_value())                             # an explicitly set variable still wins
```

`resolve_attached_secrets` stays the one entry point for a spawn (worker,
terminal, node command). Inside, it becomes one `load` per store, over the names
the credentials declare.

## 4. Moving values between stores

```python
spec = await CredentialSpec.get("database")
names = spec.var_names()

dev_file = await SecretStore.get("env_file", {"env_file_path": project.env_file_path()})
dev_vault = await SecretStore.get("vault", {"prefix": f"credential.project.{project.id}."})
await dev_vault.save(await dev_file.load(names))    # development values: env file → vault

prod_file = await SecretStore.get("env_file", {"env_file_path": project.env_file_path("production")})
await prod_file.save(await remote.load(names))      # later: fetch secrets → env file (`remote` is any store, see §6)
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
from flow_sdk.ingest.sources import source_type
#this has changed 
source = await DataSource.get("agent_email)
cradential_names = sources.cradentials.names()
SecretStore.get() # by default the current project, env file
kind = source_type(row.provider)
creds = await kind.credentials_for(row)    # Credentials(shape=ENV, values={"AGENTMAIL_API_KEY": SecretStr(...)})
async with await kind.open(row) as source:  # open() resolves the same credentials into the source's binding
    ...
```

Today `credentials_for` (through `ingest/credentials.resolve_credentials`) reads `os.environ["AGENTMAIL_API_KEY"]`. With stores,
the credential that declares `AGENTMAIL_API_KEY` answers first (its store, its
environment), and `os.environ` is the fallback. `auth.secrets` — a named machine
secret — is `await (await SecretStore.get("vault", {"prefix": ""})).load([name])`.
No new auth shape: a data source's variables become credential variables and get
environments, packing and the Connections screen for free.

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
remote = await SecretStore.get("gcp_secret_manager", {"gcp_project": "acme-prod", "prefix": "database-production-"})
values = await remote.load(spec.var_names())   # the account comes from the connection, never from config
```

## What already exists, and what it becomes

| proposed                                              | today                                                                                                    |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `SecretStore.get("env_file", {"env_file_path": ...})` | `env_local_store.read_env_local_values`, `write_env_local`, `list_env_local` (gitignore guard included)  |
| `SecretStore.get("vault", {"prefix": ...})`           | `credential_store._load_vault`, `cli.auth.secrets.write_secret`, `get_secrets`                           |
| `CredentialSpec.get(name, project=None)`              | `credential_resolver.credentials_in_scope(project)` filtered by name — project first, then user scope    |
| `spec.secret_store(environment)`                      | `CredentialScope` + `CredentialSpec.store_for(env)` + `credential_contract.env_file_name` / `vault_name` |
| `project.env_file_path(environment)`                  | `project_scope(project).root` + `env_file_name(environment)`                                             |
| `store.forget(names)`                                 | `credential_store.forget_values` (vault entries go; env file lines stay)                                 |
| data source `auth.env` / `auth.secrets`               | `ingest/credentials.py`, loading through stores                                                          |

Every guarantee carries over: values travel as `SecretStr`, only names are ever
logged, status never reads a value, and a value is never written to a file git
would commit.

## Open questions

1. **Registry or rows.** `SecretStore.get(type, config)` needs no row for the two
   shipped types. A `SecretStore` row (like `DataSource`, with a name, owner and
   saved config) only when a configured external store with an account arrives —
   then `get` also accepts a saved store's name.
2. **`os.environ`** **as a store.** A third, load-only type (`env_vars`, no config)
   for CI and cloud machines, or only the destination and fallback of §3 and §5.
3. **`flow_sdk.context`.** There is no `flow_sdk.context` module today; the
   current project is resolved per call site. Add it as the public way to ask
   "which project am I in" (worker, terminal, script), or pass the project
   explicitly.
4. **Naming.** The glossary's *value store* becomes **SecretStore**; `env_file` is
   the store type's name and `env` its accepted alias in `credential.json`.
5. **Data source migration.** Fold `auth.env` / `auth.secrets` into credential
   variables now, or only route their loads through stores first.

