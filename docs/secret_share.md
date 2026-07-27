---
id: 5e2949c7-827c-50f9-a25f-0a322d4c42f5
---

# Secret sharing (SecretOrigin)

`SecretOrigin` lets a project declare **where a secret can be found and which env
var should carry it**, without ever storing or transmitting the secret value.
It mirrors the `FSOrigin`/`Folder` pattern (a value-free, kind-tagged locator +
a `kind`-keyed driver registry) but for secrets: the *pointer* is durable and
shareable; the *value* is resolved only transiently, at worker-spawn time, from
the machine's own store.

Five kinds are registered:

- **`local`** — a name in this instance's app-secret store (SOD, `sodot`).
  Machine-local, **never shareable**.
- **`env-local`** — a key in the project's git-ignored `.env.local`. Shareable as
  a value-free pointer; each machine supplies its own value (full driver).
- **`gcp`** / **`1password`** — external-provider slots (`ProviderStubDriver`):
  the pointer travels and materializes, but resolution routes to the setup wizard
  until a real integration lands.
- **`flowpad-hub`** — a hub-hosted secret referenced by id. The pointer travels
  with a shared project; runtime value resolution is a **no-op stub** until the
  hub exposes a scoped value-fetch endpoint (see [Gaps](#gaps-and-follow-ups)).

The pointer / driver / convergent-`key()` core below is shared by every kind; the
non-`local` kinds, the two SOD stores, and the setup wizard are detailed under
[Extensions](#extensions-asset-backed-refs--two-stores--providers--setup-wizard).

Backend:
- Value objects: `flow_sdk/builtin/secret_origin_locator.py`,
  `local_secret_ref.py`, `hub_secret_ref.py`, `secret_origin_field.py`
- Entity: `flow_sdk/builtin/secret_origin.py`
- Driver registry: `flow_sdk/builtin/secret_origin_driver.py`,
  `drivers/local_secret_driver.py`, `drivers/hub_secret_driver.py`
- Project actions + share payload: `flow_sdk/builtin/project.py`
- Receive/materialize: `flow_sdk/app/actions/membership_sync.py`
- Worker injection: `flow_sdk/builtin/agentic_process/cli_drivers/cli_worker_base_driver.py`
- TS SDK: `ts_sdk/src/entities/project.ts`

## The core invariant

**A `SecretOrigin` is value-free.** The locator carries only a pointer
(`sod_name` for local, `secret_id` for hub) plus the target `env_var` — never the
secret. `model_dump` therefore structurally cannot emit a value. The value is
read **only** inside `SecretOriginDriver.resolve(...)` at spawn time, wrapped in
`pydantic.SecretStr`, and unwrapped **only** into the transient worker-process
environment dict — never into persisted `WorkerCLIOptions.env_vars`, the rendered
command, `FLOWPAD_EXECUTION_SCOPE`, or any log line.

## Value objects — the locator

`SecretOriginLocator` (base) carries `kind` and delegates `key()` to the driver.
Concrete kinds are `Literal`-tagged subclasses:

| kind | class | pointer field |
|---|---|---|
| `local` | `LocalSecretRef` | `sod_name` (app-secret store name) |
| `env-local` | `EnvLocalSecretRef` | `env_key` (key in the project `.env.local`) |
| `gcp` | `GcpSecretRef` | `gcp_project` / `secret` / `version` |
| `1password` | `OnePasswordSecretRef` | `vault` / `item` / `field` |
| `flowpad-hub` | `HubSecretRef` | `secret_id` (hub secret id) |

`SecretOriginField` is the pydantic discriminated union
(`Discriminator(resolve_secret_origin_kind)`); a locator dict with no `kind`
defaults to `local`. `SECRET_ORIGIN_ADAPTER` is the cached `TypeAdapter`. **Entity
and payload fields must be typed as `SecretOriginField`, not the bare base**, or
the subclass pointer fields drop on load.

**`key()` is machine-independent and byte-stable** — the shared-identity
requirement. Local = `uuid5("secret-origin:local:<sod_name>")`, hub =
`uuid5("secret-origin:flowpad-hub:<secret_id>")`. Because sender and receiver
compute the same key, a shared secret pointer converges to the **same**
`SecretOrigin` id on both machines, so the project's context ref resolves.

## Entity + driver

`SecretOrigin(Entity)` (`EntityType.SECRET_ORIGIN`) holds `name`, `env_var`, and
`locator: SecretOriginField`. `env_var` is validated against
`^[A-Za-z_][A-Za-z0-9_]*$`. Identity is `id_for_locator(locator) = locator.key()`;
`mint_for(locator, name, env_var, sod_store=, remote=)` is the idempotent
get-or-create keyed by that id (updates name/env_var/locator/sod_store/remote in
place on re-mint).

`get_secret_origin_driver(kind)` resolves the behavior driver
(`hub`/`flowpad_hub` alias-fold onto `flowpad-hub`; unknown kind → `KeyError`):

- **`LocalSecretDriver.resolve`** reads the app-secret store by name via
  `flow_sdk.cli.auth.secrets.read_secret(sod_name)` (off-thread) → `SecretStr` or
  `None`. This is the **one store, two front-ends** reconciliation: the account
  Secrets UI *writes* the sodot entry; a local `SecretOrigin` *points* at it by
  name. (It does **not** use `get_entity_credentials`, whose composed key is a
  different namespace nothing populates.)
- **`HubSecretDriver.resolve` returns `None`** — the deferred seam; the pointer
  can be carried and materialized, but no value is injected until the hub value
  endpoint exists.

## Project linking (actions)

Secret pointers attach to a project through the base-Entity context buckets
(`private_context_entities_` / `shared_context_entities`), exactly like context
folders. The per-entry sidecar stores **value-free** metadata only —
`{name, env_var, kind, locator, scope, typeid}` (`SecretOrigin.context_data`).

- **`add-secret-pointer`** (`name`, `env_var`, `scope`, `kind`, and
  `sod_name`/`secret_id`/`locator`): validates `env_var`; rejects a `local`
  pointer with `scope='shared'`; rejects binding an `env_var` already bound to a
  different pointer; mints the `SecretOrigin` and links it into the private or
  shared bucket. Returns the project `model_dump`.
- **`remove-secret-pointer`** (by `typeid`, `name`, or `env_var`): unlinks from
  both buckets. **The `SecretOrigin` row and the stored secret value are left
  intact** (another project may point at the same secret).
- **`Project.secret_origins`** (computed, sync) is the value-free read surface —
  a list of `{typeid, name, env_var, kind, locator, sod_store, scope}`. On the
  **authoring** machine it derives from the per-entry sidecars; on a **receiver**
  the sidecar is empty (it's only written where the pointer was authored), so a
  shared entry falls back to the mirrored `shared_secret_origins` map — the same
  way context folders read `shared_context_origins`. `secret-resolve-status` and
  `provide-secret` both drive off this one summary, so a shared pointer resolves
  identically on both sides. `secret_origins` and `shared_secret_origins` are
  stripped from `_hub_body`; the share payload is built explicitly (below).

TS SDK mirrors this on `Project`: `addSecretPointer(...)` / `removeSecretPointer`
adopt the server-computed `secret_origins` from the response (never an optimistic
guess), and `secret_origins: ProjectSecretOriginSummary[]` is the value-free view.

## Sharing a project — carry (sender)

`Project.share()` merges a value-free `shared_secret_origins` map into the hub
project body, built by `_shared_secret_origin_payload()`:

- keyed by `SecretOrigin` typeid, each entry `{name, env_var, kind, locator,
  sod_store}`;
- **`local`-kind entries are skipped** (a SOD name is meaningless off-machine);
  every other kind (`env-local` / `gcp` / `1password` / `flowpad-hub`) travels;
- **only the locator + `sod_store` travel — never a value, never credentials.**

The map rides in the hub project body (the hub `Project` model declares
`shared_secret_origins`, so it survives the round-trip).

(Context folders travel the same way via `_shared_context_origin_payload`, which
additionally *refuses* to share a shared folder that lacks a transportable
origin.)

## Accepting a shared project — materialize (receiver)

On invitation-accept, `materialize_remote_membership_entity` calls
`materialize_project_secret_origins(project, data)`:

1. reads `shared_secret_origins` from the hub payload;
2. validates each entry via `_shared_secret_origin_payload` — **every non-`local`
   kind is accepted** (`local` is rejected as machine-specific; `flowpad-hub`
   additionally requires `secret_id`), `env_var` re-validated;
3. `SecretOrigin.mint_for(locator, name, env_var, sod_store=, remote=True)` —
   because `locator.key()` converges, the receiver mints the **same** id as the
   sender;
4. links the ref into the receiver's **shared** bucket and reflects
   `shared_secret_origins` onto the local mirror — the mirror, not the sidecar, is
   the receiver's authoritative read (see `Project.secret_origins` above);
5. prunes stale shared links no longer in the payload (idempotent re-accept).

The received pointer is inert at runtime until its kind's driver can resolve a
value **with the receiver's own credentials** — `env-local` resolves once the
receiver runs the setup wizard; `flowpad-hub` awaits the hub endpoint.

## Runtime injection into workers

`apply_worker_secret_env(env, process)` (async) is called on every worker spawn
path — `agentic_process.py` (PTY restart, inline print-mode turn) and the
`claude`/`codex`/`copilot` headless drivers — immediately after the sync
`apply_worker_env`. It:

1. resolves the owning `Project` (by `project_id`, else ancestor walk);
2. iterates the project's `secret_origin` links (private + shared);
3. skips any `env_var` already present (an explicit env wins — `setdefault`);
4. `get_secret_origin_driver(kind).resolve(locator, project=, process=, secret_origin=)`
   → `SecretStr`, and folds `env.setdefault(env_var, value.get_secret_value())`;
5. swallows per-secret errors (a missing/unresolvable secret **never crashes a
   spawn**), logging names only — never values.

The unwrapped value lands **only** in the transient spawn env dict handed to
`create_subprocess_exec`. It never touches the persisted CLI options, the
rendered command, or `FLOWPAD_EXECUTION_SCOPE`.

## Shareability, by kind

| | `local` | `env-local` | `flowpad-hub` |
|---|---|---|---|
| Shareable | No (blocked at add + skipped in share + rejected on receive) | Yes (pointer travels) | Yes (pointer travels) |
| What travels | nothing | the locator (`env_key`) + `sod_store` | the locator (`secret_id`) + `sod_store` |
| Who resolves the value | the owner's machine, from SOD | the receiver's machine, from its own `.env.local` (via the wizard) | the receiver's machine, with the receiver's own hub creds |
| Runtime resolve today | live (`read_secret`) | live (`.env.local`) | **stub → `None`** (awaits hub endpoint) |

`gcp` / `1password` share exactly like `env-local` (locator travels, receiver
supplies its own value) but resolve via the setup wizard until a real integration
lands. This is the same `kind`-determines-shareability model as `FSOrigin` (local
folder unshareable / git folder shareable): a shared pointer is a *reference*; the
value stays in the provider and is fetched by the receiver, never shipped by the
sender.

## Tests

`tests/unit/test_project_secret_origins.py` covers: a local pointer is private +
value-free; a shared hub pointer's share payload is metadata-only; receive
materializes shared pointers (converged id) and rejects malformed ones; the
**receiver-mirror read** (a shared pointer with an empty sidecar resolves full
metadata from `shared_secret_origins`); stale shared pointers are pruned; share
sends an empty map after removal; and `apply_worker_secret_env` resolves from SOD
into the spawn env **without mutating persisted CLI options**.
Value-object/driver/union coverage mirrors `tests/unit/test_fs_origin.py`.

`ui/tests/hub/secret_share_two_client.test.ts` is the cross-instance acceptance
test over a live hub: a value-free reference travels, the id converges, no
plaintext crosses, and the receiver goes `missing → provide → available` with the
value landing only in a git-ignored `.env.local`. Run it via the launched pair
(see `ui/tests/hub/CLAUDE.md`).

Run: `uv run pytest tests/unit -q -k "secret_origin or local_secret or worker_secret"`.

## Extensions (asset-backed refs · two stores · providers · setup wizard)

The pointer / driver / convergent-`key()` core is unchanged; these extend its
documented seams:

- **Asset-backed reference.** A `SecretOrigin` is now a value-free file asset at
  `<project>/assets/sodot/<name>.json`, indexed like any other asset
  (`schema/type_info/secret_origin_type_info.py`, `fs_store/indexer/functions/secret_origin.py`).
  The file id is the **convergent `key()`** (never path-derived), so a
  file-indexed row and a DB-minted row collide on one id. `assert_value_free`
  guards the writer **and** the indexer extractor (two trust boundaries: never
  emit a value; never ingest a git-arrived file that carries one).
- **Two SOD stores.** `local` (`sodot`, encrypted) and `env-local` (the project's
  git-ignored `.env.local`, `builtin/env_local_store.py`). `sod_store` records
  which store the wizard caches a provided value into; the sender picks it.
- **Pluggable providers.** The driver registry gains `can_resolve()`,
  `setup_hint()`, and `store()` (symmetric with `resolve()` — the driver owns its
  store). `local`/`env-local` are full; `gcp`/`1password`/`flowpad-hub` are one
  parametrized `ProviderStubDriver` that routes to the wizard.
- **Setup wizard.** `Project.secret-resolve-status` reports available/missing per
  driver (value-free); `Project.provide-secret` writes a user value into the
  secret's store via `driver.store()`. The Secrets card
  (`ui/src/components/project-home/SecretsCard.tsx`) surfaces the whole model.

Coverage: `tests/unit/test_secret_asset_and_wizard.py` (asset mint + convergent
id + value-free guard, env-local/sodot resolve-status + provide, and the
value-free share round-trip). Browser-validated end-to-end (add → missing →
wizard → available; value lands in the git-ignored `.env.local`, the asset stays
value-free).

## Gaps and follow-ups

1. **Git-asset transport (durable/offline).** Cross-instance transport over the
   hub now works: the hub `Project` model declares `shared_secret_origins`, so the
   value-free reference survives the round-trip and materializes on the receiver
   with a **convergent id** (end-to-end covered by
   `ui/tests/hub/secret_share_two_client.test.ts`). The still-open durable path is
   the **git-asset representation** (`assets/sodot/*.json` travelling inside a
   git-shared context folder, the `git_folder_share_two_client` mechanism) so a
   secret reference travels with a git-shared project even without a live hub
   share; the asset writer/indexer exist, but the `add-secret-pointer` → shared
   git folder wiring is the remaining work.
2. **Hub value resolution** — `flowpad-hub` resolve is a stub; a hub-hosted secret
   injects nothing until the hub adds an authenticated, `allowed_to_use`-gated,
   audited value-fetch endpoint plus the client resolver.
3. **Sharing consent** — the hub `EnvVar.allowed_to_use` ACL exists but has no
   grant/revoke route.
4. **Other providers** — `gcp`/`1password` (and `azure`/`github`) are registered
   `ProviderStubDriver` slots; each real integration is added behind
   `get_secret_origin_driver` + a `store()`/`resolve()` body.
