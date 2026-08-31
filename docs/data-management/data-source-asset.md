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
is the complementary asset, **DataEmitter**, and it has its own spec. The two bind
on `channel`, not by being one object — which is why `channel` is deliberately
separate from the transport: one channel may have several of each.

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
  ACTIVE from `callable(getattr(driver, "verify", None))`. Presence of a verb
  cannot lie; a boolean can, and a wrong one parks a source no button releases.

## The manifest

```yaml
schema: 1
name: gdrive                      # folder name, registry key, asset id
title: Google Drive
description: Files from Drive, downloaded and indexed.
icon_name: HardDrive
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

> **`icon_name`, not `icon`.** `APIEntity.icon` is a getter with no setter that returns the
> TYPE's registry glyph — the one every spec shares. A row carrying an `icon` key is
> assigned onto the entity during hydration and throws there, inside the query, so the
> result comes back empty instead of raising. This is a per-SOURCE glyph and needs a
> different name.

The simplest source is six keys:

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
after the format moves. `requires.flow_sdk` is a minimum for sources that lean on
a **builtin** driver: without it, installing a `confluence` source on an older
build fails as `unknown_provider`, which reads like a broken source rather than an
old host. Omit `requires` when the folder carries its own implementation.

### `name`

The folder name, the driver-registry key, and the asset id — one noun, not three.
`rss` resolves `RssDriver`.

**A name that collides with a registered driver is a hard error.** A folder cannot
shadow a shipped source. Overriding ours would mean no bug report could ever say
which driver ran, and a working source could break silently on install.

### `auth`

Omitted when a source needs no credential — absent means none, and an empty list
reads as "not filled in yet". Exactly one of two shapes, because a source has one
credential lifetime:

```yaml
auth: { connector: slack, scopes: [channels:history] }
auth: { env: [MY_API_TOKEN] }
```

Different resolvers, not a style choice. `connector` reaches SOD or the hub,
refreshes mid-sync, and drives both `capabilities_ready()` and the probe in
`_verify_connection` — so `required_capabilities` is **derived from that one name**,
never authored beside it. `env` names resolve into a spawned process at launch,
which is what `SecretOrigin` was built for.

`scopes` is not decoration. `drive.readonly` and `drive` differ by a write grant,
and two sources sharing a connector consent once — whoever authorises first wins,
and the second gets 403s at fetch while verification reports ready. The probe must
assert granted ⊇ requested.

Neither shape ever contains a value.

### `reflect`

Supported modes, head first as the default. A list rather than a single value
because the picker must not offer a mode that silently fails: a symlinked
folder-layout asset is invisible to a walk that never descends symlinked
directories. Folder supports three modes and git two, so the list is not a
list-of-one dressed up.

**`record` may not appear in a multi-element list.** A source lands its payload in
the graph as a record or on disk as an asset; asking for both gets neither.

### `config`

The user-facing form, and the single source of truth for it — this retires the
hardcoded provider catalog in the frontend.

| Key | Meaning |
|---|---|
| `type` | `text` · `lines` · `csv` · `number` · `path` |
| `required` | blocks save when empty |
| `label` · `hint` · `placeholder` | what the form renders |
| `default` | applied when omitted; a real default, never `""` |
| `advanced` | collapsed behind "Advanced" |
| `pattern` | regex, so a bad value fails at the form and not at Verify |

There is deliberately no `select` type and no driver-supplied option list. It was
designed for Drive — "a user cannot type a folder id" — and then the Drive source
shipped taking shared-drive ids as `lines`, so nothing has ever needed it. The
source that genuinely cannot be typed is the one that should add it, together
with the endpoint that serves the choices.

### Traits — non-builtin sources only

A builtin omits this block; its driver declares the same three facts under its own
names — `record_kind` for `emits`, `channel_for()` for `channel`, and
`stamps_identity` for `owns_bytes` (inverted sense). Declaring them in both places
is a load error.

```yaml
emits: content.message.email      # ontology kind stamped on every item
channel: email                    # the user-facing medium
owns_bytes: false                 # false ⇒ never stamp identity into these bytes
```

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
| `needs_setup` | presence of `verify` |
| `segment_budget` | a consequence of the fetch code, not a preference |
| `kind` | `sync_source` stamps it from the driver on the first poll |
| `account_key` | first value of the first required field; no source needed otherwise |
| poll cadence | per-instance on `DataSource` — a big site wants six hours, a small one five minutes |
| cursor shape | `state` is opaque by contract, and a test greps for leaks |

## Runtime is discovered, not declared

| Folder contains | Runtime |
|---|---|
| `fetch.py` | script |
| `FETCH.md` | agent |
| both | **load error** — no precedence, say which you meant |
| neither | builtin, resolved from `name` |

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
  `required_capabilities` from it, so the capability gate never fires, and
  `channel` — which the credential probe keys on — is only stamped on the first
  poll, so Verify on a fresh credentialed source probes nothing.
* **`FETCH.md` (agent runtime) is reserved, not implemented.** A folder carrying
  one is refused at load with that message, rather than indexing and then failing
  every poll.

