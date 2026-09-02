---
id: f2a0bbff-0654-4416-b5c6-be1415a08f4d
---

# Data source assets

A data source is a **folder asset**. `data_source.json` is the manifest; everything
else in the folder is discovered by convention. The SDK loads the folder —
nothing is registered in `flow_sdk` per source.

```
agentic-assets/data_source/my-source/
  data_source.json # main_file: the manifest
  README.md        # optional — human docs, never read by the runtime
  fetch.py         # optional — presence makes this a script source
  FETCH.md         # optional — presence makes this an agent source
  references/      # optional — read by the wizard, never by the runtime
```

`agentic-assets/<family>/` is where a native asset lives (glossary), and the main
file is named for its type — the same rule the bundle format follows with
`flow_message.json` and `conversation.jsonl`. JSON rather than frontmatter: the
manifest is data the runtime parses, and a wizard writing it should not have to
get YAML indentation right.

**Reading only.** A source pulls a remote system into the graph. Pushing back out
is meant to be a complementary asset, **DataEmitter**, with its own spec — it does
not exist yet; today a builtin driver that can send declares `sends = True` and
`inbox/outbound.py` dispatches through it, and an authored (`fetch.py`) source is
always `sends = False`. The two are meant to bind on `channel`, not by being one
object — which is why `channel` is deliberately separate from the transport: one
channel may have several of each.

**Declare the minimum, discover the rest.** Every key below is something the
runtime cannot work out for itself. Two rules keep it that way, both learned the
hard way:

* **The driver class is authoritative for a builtin source.** `sync_source` stamps
  `kind` and `channel` from the driver on the first poll, so a manifest copy is
  "authoritative-looking, owned by nobody, and silently corrected later" — the
  words are the deleted `provider-catalog.ts`'s, which this asset replaced. A
  builtin that declares a trait key is a
  **load error**, not a warning: silently ignoring it recreates that same bug one
  layer up.
* **Presence beats declaration.** `DataSource.save()` already decides SETUP vs
  ACTIVE from `driver.verify is not None`. Presence of a verb cannot lie; a
  boolean can, and a wrong one parks a source no button releases.

## The manifest

```yaml
schema: 1                         # REQUIRED — the only value this build reads
name: gdrive                      # folder name, registry key, asset id
title: Google Drive               # defaults to `name`
description: Files from Drive, downloaded and indexed.
icon_name: HardDrive
channel_icon_names: { gmail: Mail, slack: Slack }   # optional — a multi-channel transport only
setup_wiki: Slack channels        # optional — a human setup step; see below
requires: { flow_sdk: ">=0.3" }   # omit for a source that needs no builtin driver

auth:
  connector: google
  scopes: ["https://www.googleapis.com/auth/drive.readonly"]

reflect: [none, copy]             # supported modes; the head is the default

config:
  drives:
    type: lines
    label: Shared drive IDs
```

The shape is `ManifestSpec` (`flow_sdk/builtin/data_source_spec.py`), a `DataSpec`
with `extra="forbid"`: an unknown top-level key, an unknown `config` field key, an
unknown `auth` key or an unknown trait is a **load error**, and a rejected manifest
yields no record at all (`spec_extractor` logs the rule and emits `[]`). The row
is `DataSourceSpec`; the file says `schema`, the row says `manifest_schema`
(the base entity already owns `schema_version`).

> **`icon_name`, not `icon`.** `APIEntity.icon` is a getter with no setter that returns the
> TYPE's registry glyph — the one every spec shares. A row carrying an `icon` key is
> assigned onto the entity during hydration and throws there, inside the query, so the
> result comes back empty instead of raising. This is a per-SOURCE glyph and needs a
> different name.

The simplest source is six keys (`title` could even be dropped — it defaults to
`name`):

```yaml
schema: 1
name: rss
title: RSS / Atom
description: One segment per feed URL. No credentials.
icon_name: Rss
config:
  feed_urls: { type: lines, pattern: '^https?://', required: true, label: Feed URLs }
```

### `schema` and `requires`

`schema` is the manifest format version — a source published today must still load
after the format moves. It is **required**: `CURRENT_SCHEMA` is `1`, the field
defaults to `0` and is validated, so a manifest that omits it or says anything
else is a load error, never a best-effort parse. `requires.flow_sdk` is a minimum
for sources that lean on a **builtin** driver: without it, installing a
`confluence` source on an older build fails as `unknown_provider`, which reads like
a broken source rather than an old host. Omit `requires` when the folder carries
its own implementation. Today `requires` is **recorded, not enforced** — nothing
reads it yet, so the `unknown_provider` failure it is meant to pre-empt still
happens on an old host.

### `name`

The folder name, the driver-registry key, and the asset id — one noun, not three.
`rss` resolves `RssDriver`.

**A name that collides with a shipped driver is refused at driver registration,
not at load.** The manifest still indexes as a `data_source_spec` row; it is
`refresh_spec_drivers` (`flow_sdk/ingest/spec_registry.py`) that sees the name in
the builtin set, logs "shadows a shipped driver and is ignored — rename the
folder", and never registers the adapter. A folder cannot shadow a shipped source:
overriding ours would mean no bug report could ever say which driver ran, and a
working source could break silently on install. `register_driver` is a bare dict
assignment, which is why the refusal has to live in front of it.

### `auth`

Omitted when a source needs no credential — absent means none, and an empty list
reads as "not filled in yet". Exactly one of two shapes, because a source has one
credential lifetime:

```yaml
auth: { connector: slack, scopes: [channels:history] }
auth: { env: [MY_API_TOKEN] }
```

Different resolvers, not a style choice. `connector` is meant to reach SOD or the
hub, refresh mid-sync, and drive both `capabilities_ready()` and the probe in
`_verify_connection` — so `required_capabilities` would be **derived from that one
name**, never authored beside it. That derivation does not exist yet (see the open
list at the end): a builtin's driver still declares its own capability need, and
the manifest's `auth.connector` is documentation for the picker. `env` names ARE
consumed: `ScriptSource._env` resolves each one from the host environment into the
spawned `fetch.py` process at launch and fails the poll with `missing_env` when one
is unset — a forwarding list and a fail-fast declaration, not confinement.

`scopes` is not decoration. `drive.readonly` and `drive` differ by a write grant,
and two sources sharing a connector consent once — whoever authorises first wins,
and the second gets 403s at fetch while verification reports ready. The probe must
assert granted ⊇ requested.

Neither shape ever contains a value.

### `reflect`

Supported modes, head first as the default. The values are `ReflectMode`
(`flow_sdk/ingest/reflect.py`): `record` · `none` · `copy` · `symlink`; an unknown
one is a load error. Omitted, the list is `[record]` — the `ingest_items` path
every record-emitting driver takes. A list rather than a single value because the
picker must not offer a mode that silently fails: a symlinked folder-layout asset
is invisible to a walk that never descends symlinked directories. Folder supports
three modes (`none, copy, symlink`) and git and gdrive two (`none, copy`), so the
list is not a list-of-one dressed up.

**`record` may not appear in a multi-element list.** A source lands its payload in
the graph as a record or on disk as an asset; asking for both gets neither.

### `config`

The user-facing form, and the single source of truth for it — this retires the
hardcoded provider catalog in the frontend.

| Key | Meaning |
|---|---|
| `type` | `text` · `lines` · `csv` · `number` · `path` (`FieldType`; anything else is a load error) |
| `required` | blocks save when empty |
| `label` · `hint` · `placeholder` | what the form renders |
| `default` | applied when omitted; a real default, never `""` — a `csv`/`lines` default is a list (`["story"]`) |
| `advanced` | collapsed behind "Advanced" |
| `pattern` | regex, so a bad value fails at the form and not at Verify |
| `account_key` | `true` on the ONE field whose value names the remote account (`rss` has none: a feed set has no account; `telegram` deliberately has none, because the only candidate is the secret). The create form derives `DataSource.account_key` from it (`accountKeyFor`). Descriptive only — ids are uuid4 and nothing dedupes on it |

Each field is a `ConfigFieldSpec`, and its `type` is also a **coercion rule**:
`DataSource.save()` runs `ConfigFieldSpec.coerce` over any string-valued config
(`lines` splits on newlines, `csv` on commas, `number` parses), so a URL an agent
sent as a string where `lines` is declared becomes a one-element list instead of a
source that iterates the characters of the URL on its first sync. That is
coercion, not validation — `required` and `pattern` are still form-only (see the
open list).

There is deliberately no `select` type and no driver-supplied option list. It was
designed for Drive — "a user cannot type a folder id" — and then the Drive source
shipped taking shared-drive ids as `lines`, so nothing has ever needed it. The
source that genuinely cannot be typed is the one that should add it, together
with the endpoint that serves the choices.

### `setup_wiki` and `channel_icon_names`

`setup_wiki` names the wiki page explaining the setup step a provider cannot do
for you (Slack: inviting the bot). For a **builtin** it is display only — the
driver class decides whether it has `verify`. For an **authored** source it is
the switch: a non-empty `setup_wiki` is what gives the `ScriptSource` adapter its
`verify` verb, and therefore what parks a new source in SETUP until the module's
`verify` answers `ready`. A `fetch.py` with a `verify` verb and no `setup_wiki`
is never asked.

`channel_icon_names` is a per-CHANNEL glyph map for a transport that serves
several channels (`agent`: `gmail → Mail`, `slack → Slack`). The inbox chip
resolves a record's channel to the channel-named spec's `icon_name` first, then
to this map on the transport's spec — so a channel's icon stays an asset fact,
never a frontend table.

### Traits — non-builtin sources only

A builtin omits this block; its driver declares the same three facts under its own
names — `record_kind` for `emits`, `channel_for()` for `channel`, and
`stamps_identity` for `owns_bytes` (same sense: `owns_bytes: false` ⇒
`stamps_identity = False`). Declaring them on a builtin is a load error.

They are **nested under one `traits` key** (`TraitsSpec`), not top-level — at the
top level `extra="forbid"` rejects them:

```yaml
traits:
  emits: content.message.email    # ontology kind stamped on every item
  channel: email                  # the user-facing medium
  owns_bytes: false               # false ⇒ never stamp identity into these bytes
```

`channel` and `owns_bytes` default (`""`, `true`); **`emits` does not, for a
`fetch.py` source.** `runtime_for_folder` refuses a script folder whose `traits`
block is absent or whose `emits` is blank — a `ManifestError`, so the folder is
not indexed — because a blank kind is stamped on every item unvalidated and lands
outside the inbox projection with nothing raising. The authoring skill's "at
minimum `emits`" is now the loader's rule too.

**`emits`** decides inbox membership — the projection admits `content.message.*`
and nothing else. It is **stamped at `ingest_items`**, not validated: membership
is a property of the source the user configured, not of whatever a worker put in
its JSON.

**`channel`** is the medium; `name` is the transport. Threading keys on the
channel, so a harness Gmail source and an API one resolve to one thread instead of
forking every conversation. It is also what binds a source to its DataEmitter.

**`owns_bytes: false`** says the bytes belong to someone else, so indexing must not
stamp an identity capsule into them: in a git working tree that dirties the repo,
gets committed, and reaches everyone who pulls. Not derivable from `reflect` — a
folder `copy` is ours, a Drive `copy` is a cache the next download clobbers.

## What is deliberately absent

| Not a field | Because |
|---|---|
| `provider` | `name` is the registry key |
| `runtime` | the folder answers it (below) |
| `payload` | `reflect: record` means record; anything else means bytes |
| `reports_deletions` | structural — a driver that can observe absence fills `tombstones` |
| `sends` | outbound is DataEmitter, not a flag here |
| `needs_setup` | presence of `verify` — for an authored source, that is `setup_wiki` |
| `segment_budget` | a consequence of the fetch code, not a preference |
| `kind` | `sync_source` stamps it from the driver on the first poll (an authored source's is `datasource.<name>`) |
| `account_key` VALUE | lives on the `DataSource` row; the manifest only marks WHICH form field supplies it (`account_key: true` above) |
| `id` | derived from the folder path (`identity_carrier=derived_identity()`, a v5), never written into the manifest — stable for a shipped asset, identical on every machine, and a shared source never arrives carrying the sender's id |
| poll cadence | per-instance on `DataSource` — a big site wants six hours, a small one five minutes |
| cursor shape | `state` is opaque by contract, and a test greps for leaks |

## Runtime is discovered, not declared

| Folder contains | Runtime |
|---|---|
| `fetch.py` | script |
| `FETCH.md` | agent — **reserved: refused at load** (see below) |
| both | **load error** — no precedence, say which you meant |
| neither | builtin, resolved from `name` |

The extractor (`derive_data_source_spec`) stats only those two names — it never
lists the folder — and writes the answer to the row's `runtime` field
(`Persist.TRUE`, so the shadow index carries it). `refresh_spec_drivers` queries
`runtime == "script"` on every heartbeat tick and on the create path, builds a
`ScriptSource` adapter per row, and unregisters an adapter whose folder left the
disk. It is deliberately not a post-sync hook: importing the drivers package from
inside the indexer's worker threads deadlocked on the import lock.

A definition's **editor** is not declared in the manifest either: a webapp asset
at `<name>/agentic-assets/webapp/editor/` is found by the same walker and becomes
the definition's child. Nine of the ten shipped definitions carry one;
`telegram` does not.

A script or persona referenced **by name** resolves against the author's machine.
Shared, it arrives broken — and silently, because a failed subagent load is
swallowed and the run proceeds on the addendum alone. Folder-local is the point of
making this a folder asset.

## Resolved, and what is left

The three items this section opened with have been answered:

1. **`external_id_unique_within` is gone.** It promised that a wrong value would
   irreversibly merge records — a guarantee the natural key, always
   `(source_id, segment_key, external_id)`, never provided. Declaring it is now a
   load error rather than a field that changes nothing.
2. **`record_kind` is off the Protocol.** Nothing outside a driver ever read it,
   so three filesystem drivers carried an empty stub to satisfy it. A
   record-emitting driver still carries one and stamps it; `emits` is what feeds
   an authored source's.
3. **i18n is unchanged and honest.** Lingui extracts at build time and will never
   see a user-authored asset. Shipped sources keep translations by extracting
   manifest strings at build; third-party sources ship untranslated.

Still open, and named where it bites:

* **The backend does not validate a source's `config` values against the spec's `config` fields.** `required`
  and `pattern` are enforced only by the create form, so a source made by the
  `flow` CLI, by curl, or by an agent following the authoring skill bypasses every
  rule the manifest declares. That is the one gap where a machine, not a person,
  is filling the fields.
* **`auth.connector` has no backend consumer.** Nothing derives
  `required_capabilities` from it, so the capability gate never fires from the
  manifest; only a builtin driver's own declaration does. (`channel` is no longer
  part of this gap: `DataSource.save()` stamps it from `driver.channel_for()` at
  CREATE, so Verify on a fresh credentialed source probes the right channel.)
* **`requires` is not read.** Recorded on the row, enforced nowhere.
* **`traits.emits` is required for a `fetch.py` source** (closed the way the
  other rules were: a load error in `runtime_for_folder`). A builtin still may
  not declare `traits` at all.
* **`FETCH.md` (agent runtime) is reserved, not implemented.** A folder carrying
  one is refused at load with that message, rather than indexing and then failing
  every poll.

