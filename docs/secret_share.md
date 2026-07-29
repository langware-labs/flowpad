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
  The `sod_name` is machine-specific, so it is stripped on share; the
  declaration itself still travels.
- **`env-local`** — a key in the project's git-ignored `.env.local`. Shareable as
  a value-free pointer; each machine supplies its own value (full driver).
- **`gcp`** / **`1password`** — external-provider slots (`ProviderStubDriver`):
  the pointer travels and materializes, but resolution routes to the setup wizard
  until a real integration lands.
- **`flowpad-hub`** — a secret held by the hub, named by `(project_id, name)`.
  `HubSecretDriver` resolves it through the hub's consent-gated
  `env-var/<NAME>/value` route with the caller's own hub credentials.

The pointer / driver core below is shared by every kind; the
non-`local` kinds, the two SOD stores, and the setup wizard are detailed under
[Extensions](#extensions-asset-backed-refs--two-stores--providers--setup-wizard).

Backend:
- Value objects: `flow_sdk/builtin/secret_origin_locator.py`,
  `local_secret_ref.py`, `env_local_secret_ref.py`, `hub_secret_ref.py`,
  `secret_origin_field.py`
- Identity: `flow_sdk/builtin/secret_origin_identity.py`
- Entity: `flow_sdk/builtin/secret_origin.py`
- Driver registry: `flow_sdk/builtin/secret_origin_driver.py`,
  `drivers/local_secret_driver.py`, `drivers/env_local_secret_driver.py`,
  `drivers/hub_secret_driver.py`
- Value stores: `flow_sdk/builtin/env_local_store.py`,
  `flow_sdk/cli/auth/secrets.py`; drift baselines in `secret_origin_digest.py`
- Resolution: `flow_sdk/builtin/secret_origin_resolver.py`
- Project actions + share payload: `flow_sdk/builtin/project.py`
- Receive/materialize: `flow_sdk/app/actions/membership_sync.py`
- Injection adapters: `flow_sdk/builtin/agentic_process/cli_drivers/cli_worker_base_driver.py`
  (workers), `flow_sdk/core/flow/models/execution/env_context.py` (compute node),
  `flow_sdk/builtin/shell.py` (PTY)
- Node attachment: `flow_sdk/builtin/faas/compute_node.py`
- TS SDK: `ts_sdk/src/entities/project.ts`,
  `ts_sdk/src/entities/compute-node/compute-node.ts`

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

**A locator is not an identity.** It deliberately has no `key()` — see below.

## Identity — `(project_id, ENV_VAR_NAME)`

A secret belongs to a project and is named by the environment variable it
arrives as. **That pair is the whole identity**, minted in one place
(`flow_sdk/builtin/secret_origin_identity.py`):

```
stable_key(project_id, env_var) = f"secret-origin:{project_id}:{env_var}"
secret_origin_id(...)           = uuid5(NAMESPACE_URL, stable_key(...))
```

Why not the locator, which is what this used to hash: a secret must be able to
**move between stores** — `.env.local` → the encrypted `sodot` → the hub vault —
without becoming a different secret. Under locator-derived ids every such move
minted a new entity and orphaned the project links, the sidecar, and any
receiver's converged id.

Consequences worth stating:

- **Uniqueness is structural, not a check.** Re-declaring an env var mints the
  same id and updates the row in place: pointing it at a different provider is
  an edit, not a second secret.
- **Still convergent across machines**, because `project_id` is the shared hub
  identity — a shared project keeps its id, so sender and receiver compute the
  same secret id.
- `env_var` is used **verbatim and case-sensitively**. POSIX environments are
  case-sensitive; folding here would make the id lie about what gets injected.
  (The UI upper-cases input — an affordance, not identity.)
- `kind` / `locator` / `sod_store` demote to **declaration detail**: where to
  fetch, where to cache. They may change freely.
- The sidecar is `assets/sodot/<ENV_VAR>.json` — the filename *is* the identity.

**No migration.** Rows and sidecars minted under the old locator-derived scheme
are never matched again; they linger inert and are left on disk untouched. A
sidecar without `project_id` is skipped by the indexer with a log line.

## Entity + driver

`SecretOrigin(Entity)` (`EntityType.SECRET_ORIGIN`) holds `name`, `project_id`,
`env_var`, and `locator: SecretOriginField`. `env_var` is validated against
`^[A-Za-z_][A-Za-z0-9_]*$`. Identity is `id_for(project_id, env_var)`;
`mint_for(project_id=, env_var=, locator=, name=, sod_store=, remote=)` is the
idempotent get-or-create keyed by that id (updates name/locator/sod_store/remote
in place on re-mint).

`get_secret_origin_driver(kind)` resolves the behavior driver
(`hub`/`flowpad_hub` alias-fold onto `flowpad-hub`; unknown kind → `KeyError`):

- **`LocalSecretDriver.resolve`** reads the app-secret store by name via
  `flow_sdk.cli.auth.secrets.read_secret(sod_name)` (off-thread) → `SecretStr` or
  `None`. This is the **one store, two front-ends** reconciliation: the account
  Secrets UI *writes* the sodot entry; a local `SecretOrigin` *points* at it by
  name. (It does **not** use `get_entity_credentials`, whose composed key is a
  different namespace nothing populates.)
- **`HubSecretDriver.resolve`** (`builtin/drivers/hub_secret_driver.py`) fetches
  the value from the hub's `env-var/<NAME>/value` route with the caller's own
  hub credentials. It caches **nothing** — every launch re-asks, so a revoked
  grant stops working immediately — and its `can_resolve` answers from the
  project's env-var table (masked metadata) rather than the gated route, since
  the Secrets card probes it per secret on every render.

## Project linking (actions)

Secret pointers attach to a project through the base-Entity context buckets
(`private_context_entities_` / `shared_context_entities`), exactly like context
folders. The per-entry sidecar stores **value-free** metadata only —
`{name, env_var, kind, locator, scope, typeid}` (`SecretOrigin.context_data`).

- **`add-secret-pointer`** (`name`, `env_var`, `scope`, `kind`, and
  `sod_name`/`secret_id`/`locator`): validates `env_var`, mints the
  `SecretOrigin` and links it into the private or shared bucket. Returns the
  project `model_dump`. There is **no** uniqueness check to perform — the id is
  `(project_id, env_var)`, so re-declaring an env var mints the same row and
  updates it in place. Pointing a declaration at a different provider is an
  edit, not a second secret.
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

- keyed by `SecretOrigin` typeid, each entry `{name, project_id, env_var, kind,
  locator, sod_store}`;
- **every kind travels, `local` included.** A receiver has to *see* a
  declaration in order to be told its value is missing here; dropping it would
  silently hide a secret the project needs. What does not travel is the
  machine-specific *coordinate* — a `sod_name` names an entry in the sender's
  keychain, so it is stripped from the wire locator;
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
2. validates each entry via `_shared_secret_origin_payload` — **every kind is
   accepted** (`flowpad-hub` additionally requires `secret_id`), `env_var`
   re-validated, and duplicate `env_var`s deduped first-wins with a warning;
3. `SecretOrigin.mint_for(project_id=, env_var=, ...)` — because a shared
   project keeps its id, the receiver mints the **same** secret id as the sender;
4. links the ref into the receiver's **shared** bucket and reflects
   `shared_secret_origins` onto the local mirror — the mirror, not the sidecar, is
   the receiver's authoritative read (see `Project.secret_origins` above);
5. prunes stale shared links no longer in the payload (idempotent re-accept).

The received pointer is inert at runtime until its kind's driver can resolve a
value **with the receiver's own credentials** — `env-local` resolves once the
receiver runs the setup wizard; `flowpad-hub` resolves against the hub if the
receiver is allowed to use it. Until then the receiver sees the declaration
flagged `missing-value`, which is why every kind travels: a receiver has to see
a declaration in order to be told they are missing its value.

## Runtime injection

`resolve_project_secrets(project, only=)` in `builtin/secret_origin_resolver.py`
is the **one** place declarations become values. It walks the project's
`secret_origin` links (private + shared), reads the locator from the context
sidecar (falling back to the entity row for receiver mirrors, which have none),
and `asyncio.gather`s the driver resolves. Per-secret errors are swallowed and
logged **by name** — a missing or unresolvable secret never crashes a spawn, and
a value never reaches a log line.

Two thin adapters carry the result to the two transports, so a change to how a
secret resolves cannot apply to one and miss the other:

- **`apply_worker_secret_env(env, process)`** — a process env dict for a worker
  on this machine, called on every spawn path (`agentic_process.py` PTY restart
  and inline print-mode turn, plus the `claude`/`codex`/`copilot` headless
  drivers) right after the sync `apply_worker_env`.
- **`resolve_node_secret_env(project)`** — a `list[FlowEnv]` for a compute node,
  unioned into `Project.initialize`'s env list and prefixed onto commands by the
  provider (`compute/providers/env_prefix.py`).

`secret_env_dict(project, base)` owns the precedence rule — **an
explicitly-set env var always wins** — and `Shell.start_pty` uses it so a plain
terminal on the node sees the same set a worker does.

The unwrapped value lands **only** in a transient spawn env dict or a
single-command shell prefix. It never touches the persisted CLI options, the
rendered command, `FLOWPAD_EXECUTION_SCOPE`, or the node's filesystem —
`set_env`/`~/.bashrc` is reserved for the `FLOWPAD_*` proxy config.

### Which secrets a node may see

`ComputeNode.attached_secrets` is a value-free `{project_id: [ENV_VAR]}` map:
the token *is* the env var name and the project is the namespace, so nothing
secret is stored and the map travels with a shared node. That is the intent —
secrets are on the node, so whoever gets the node gets them, and resolution
still happens on the receiver's machine from their own store.

**An absent project key means every secret that project declares.** A node
nobody has curated is unrestricted, which is what lets attachment ship without
changing existing behaviour. The rule is decoded in
`ComputeNode.effective_attached` and nowhere else. `attach-all-secrets` writes
today's names explicitly rather than a standing `*`, which would silently widen
what a shared node exposes each time a secret was declared.

## Shareability, by kind

| | `local` | `env-local` | `flowpad-hub` |
|---|---|---|---|
| Shareable | Yes (the declaration travels; the `sod_name` does not) | Yes (pointer travels) | Yes (pointer travels) |
| What travels | `env_var` + `name` + `kind` + `sod_store` | the locator (`env_key`) + `sod_store` | the locator (`project_id`, `name`) + `sod_store` |
| Who resolves the value | the owner's machine, from SOD | the receiver's machine, from its own `.env.local` (via the wizard) | the hub, for a caller its ACL allows |
| Runtime resolve today | live (`read_secret`) | live (`.env.local`) | live (`env-var/<NAME>/value`) |

`gcp` / `1password` share exactly like `env-local` (locator travels, receiver
supplies its own value) but resolve via the setup wizard until a real integration
lands. A shared declaration is a *reference*: the value stays in its store and is
fetched by the receiver, never shipped by the sender. What varies by kind is not
*whether* it travels but *which coordinate* is portable — a `sod_name` names an
entry in one machine's keychain and is dropped on the wire.

## Tests

`tests/unit/test_project_secret_origins.py` covers: a local pointer is private +
value-free; a shared hub pointer's share payload is metadata-only; receive
materializes shared pointers (converged id) and rejects malformed ones; the
**receiver-mirror read** (a shared pointer with an empty sidecar resolves full
metadata from `shared_secret_origins`); stale shared pointers are pruned; share
sends an empty map after removal; and `apply_worker_secret_env` resolves from SOD
into the spawn env **without mutating persisted CLI options**.
Value-object/driver/union coverage mirrors `tests/unit/test_fs_origin.py`.

`tests/unit/test_secret_origin_identity.py` pins the identity recipe, including
that it is independent of where the value lives — the property the re-key
exists for.

`tests/unit/test_env_local_store.py` covers the git verdict, including the two
cases a line-match gets wrong: a `*.local` wildcard, and a `.env.local` git
already tracks. `tests/unit/test_secret_warnings.py` covers both warnings and
sweeps every response surface for the value **and the digest**.

`tests/unit/test_compute_node_secrets.py` and `test_node_secret_load.py` cover
attachment, including that an uncurated node is unrestricted;
`test_node_secret_resume.py` pins that loading writes nothing to the node's rc
file.

`ui/tests/hub/secret_share_two_client.test.ts` is the cross-instance acceptance
test over a live hub: a value-free reference travels, the id converges, no
plaintext crosses, and the receiver goes `missing → provide → available` with the
value landing only in a git-ignored `.env.local`. Run it via the launched pair
(see `ui/tests/hub/CLAUDE.md`).

Run: `uv run pytest tests/unit -q -k "secret_origin or local_secret or worker_secret"`.

## Extensions (asset-backed refs · two stores · providers · setup wizard)

The pointer / driver core is unchanged; these extend its documented seams:

- **Asset-backed reference.** A `SecretOrigin` is a value-free file asset at
  `<project>/assets/sodot/<ENV_VAR>.json`, indexed like any other asset
  (`schema/type_info/secret_origin_type_info.py`, `fs_store/indexer/functions/secret_origin.py`).
  The filename **is** the identity, and the file carries the same convergent id
  (never path-derived), so a file-indexed row and a DB-minted row collide on
  one id. `assert_value_free` guards the writer **and** the indexer extractor
  (two trust boundaries: never emit a value; never ingest a git-arrived file
  that carries one) — and it rejects digest keys as well as plaintext ones.
- **Two SOD stores.** `local` (`sodot`, encrypted) and `env-local` (the project's
  git-ignored `.env.local`, `builtin/env_local_store.py`). `sod_store` records
  which store the wizard caches a provided value into; the sender picks it.
- **Pluggable providers.** The driver registry gains `can_resolve()`,
  `setup_hint()`, and `store()` (symmetric with `resolve()` — the driver owns its
  store). `local`, `env-local` and `flowpad-hub` are full drivers;
  `gcp`/`1password` are one parametrized `ProviderStubDriver` that routes to the
  wizard. `HubSecretDriver.store()` deliberately refuses and points at
  `push-secret-to-cloud`, which owns the publication gate — caching locally
  instead would create a second copy the hub never sees.
- **Setup wizard.** `Project.secret-resolve-status` reports available/missing
  (value-free) and, with it, `found_in` and a `missing-value` warning.
  Availability is a **union** across both local stores and the declared
  provider: the local stores exist for usage, so a value in `.env.local` under
  the right env var satisfies a `gcp` declaration on this machine.
  `Project.provide-secret` writes a user value into the secret's store via
  `driver.store()`. The Secrets card
  (`ui/src/components/project-home/SecretsCard.tsx`) surfaces the whole model.
- **`.env.local` inventory and hard block.** `Project.env-local-status` lists
  the keys detected in the file — **names and line numbers only** — alongside a
  git verdict. Writing a value is refused outright when the file is
  committable: `gitignore_status` asks git (`check-ignore` plus `ls-files`,
  because ignore rules do not apply to a file git already **tracks**), and
  `ensure_gitignored` appends and then re-verifies rather than assuming.
  `EnvLocalCard` renders the list and opens the file at a key's line; declaring
  a key is additive and never edits `.env.local`.
- **Value-change warning.** `Project.secret-drift-status` reports
  `value-changed` when a value no longer matches the one that was provided. The
  baseline is a **salted** digest in the per-instance `sodot`
  (`builtin/secret_origin_digest.py`) — unsalted, a short secret's digest is
  brute-forceable and would be a slow copy of the secret. It is a separate,
  opt-in action because answering it requires *fetching* values, which would
  violate `can_resolve`'s no-fetch contract.
- **Cloud round-trip.** `Project.push-secret-to-cloud` stores a value on the hub
  through the hub's own `env-var` action, gated on `hub_published_at` (a marker
  distinct from `remote`, which is also set when a project is shared *to* us).
  `Project.delete-secret-from-cloud` deletes from the hub **and only the hub** —
  the declaration, the `sodot` entry and `.env.local` are all left untouched.

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
2. **Hub OAuth providers cannot be attached.** A provider defined by the hub
   renders in the Connections tab, but `attach_action` / `detach_action` /
   `disconnect_oauth_provider` resolve the credential name through
   `core/oauth/provider_registry.py`, which knows only the locally-flowable
   providers — so any hub provider returns `NO_SOD_FOUND`. The union in
   `core/oauth/hub_providers.py::union_providers` happens at the `EnvVar` level,
   after the provider→credential-name mapping has been flattened away. The fix
   is to union at the provider-spec level with a source registry.
3. **Sharing consent** — the hub `EnvVar.allowed_to_use` ACL exists but has no
   grant/revoke route.
4. **Other providers** — `gcp`/`1password` (and `azure`/`github`) are registered
   `ProviderStubDriver` slots; each real integration is added behind
   `get_secret_origin_driver` + a `store()`/`resolve()` body.
