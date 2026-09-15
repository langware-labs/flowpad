---
id: f2a0bbff-0654-4416-b5c6-be1415a08f4d
---

# Data source assets

A data source is a **folder asset**. `data_source.json` is the manifest (the
`DataSourceSpec`); `source.py` is the source itself; everything else in the folder
is discovered by convention. The loader reads the folder — nothing is registered in
`flow_sdk` per source, and a shipped source is laid out exactly like an authored one.

```
agentic-assets/data_source/my-source/
  data_source.json # the folder's main document: the manifest
  source.py        # REQUIRED — exactly one flow_sdk.sources.Source subclass
  transport.py     # optional helper modules, imported relatively
  tests/           # its own tests and its matrix case
  README.md        # optional — human docs, never read by the runtime
  references/      # optional — read by the wizard, never by the runtime
```

`agentic-assets/<family>/` is where a native asset lives (glossary), and the main
file is named for its type — the same rule the bundle format follows with
`flow_message.json` and `conversation.jsonl`. JSON rather than frontmatter: the
manifest is data the runtime parses, and a wizard writing it should not have to
get YAML indentation right.

## Self-contained

Everything one source needs lives in its folder, shipped or authored alike — the rule in
`CLAUDE.md` ("Data sources are self-contained assets"):

```
agentic-assets/data_source/<name>/
  data_source.json          # the DataSourceSpec
  source.py                 # exactly one flow_sdk.sources.Source subclass — the source
  transport.py …            # optional helper modules, imported relatively (`from .transport import …`)
  tests/test_<name>_source.py   # conformance kit + wire cases, against flow_sdk.sources.testing doubles
  tests/matrix.py           # its case in the data source matrix
  tests/fixtures/…          # the responder packs those tests serve
  agentic-assets/webapp/editor/   # optional editor
  README.md                 # setup, credentials, live-validation notes
```

Outside asset folders only generic machinery exists: the contract, the loader, the sync engine,
reflection, projection, generic routes and UI. None of it names a provider. What machinery needs
to know about a source, the source declares — a manifest field, or a classmethod on its class.
Asset code may import the public SDK; it never imports another asset. An exception is the user's
call, recorded with its date and reason in `EXCEPTIONS` in
`tests/unit/test_data_sources_are_self_contained.py`, which fails on any unlisted trace.

**Declare the minimum, discover the rest.** Every manifest key below is something the
runtime cannot work out for itself. Two rules keep it that way:

* **The class is authoritative for what it is.** Traits (`durable_cursor`,
  `reflects`, `stamps_identity`, `echoes_sends`, …) are ClassVars on the source
  class; a manifest copy would be "authoritative-looking, owned by nobody, and
  silently corrected later". A `traits` key in a manifest is a **load error**.
* **Presence beats declaration.** A capability is a protocol the class implements,
  discovered by `isinstance` — `DataSource.save()` decides SETUP vs ACTIVE from
  whether the class is `Verifiable`. Presence of a verb cannot lie; a boolean can,
  and a wrong one parks a source no button releases.

## The manifest

```yaml
schema: 1                         # REQUIRED — the only value this build reads
name: gdrive                      # folder name, registry key, the class's `provider`
title: Google Drive               # defaults to `name`
description: Files from Drive, downloaded and indexed.
kind: datasource.fs.gdrive        # the record kind a source row carries; datasource.<name> when omitted
icon_name: HardDrive
channel_icon_names: { gmail: Mail, slack: Slack }   # optional — a multi-channel transport only
setup_wiki: Slack channels        # optional — a human setup step; see below
requires: { flow_sdk: ">=0.3" }   # optional — recorded, not yet enforced

auth:
  connector: google
  scopes: ["https://www.googleapis.com/auth/drive.readonly"]

reflect: [none, copy]             # supported modes; the head is the default

config:
  drives:
    type: lines
    label: Shared drive IDs
```

The shape is `ManifestSpec` (`flow_sdk/schema/data_spec/data_source_manifest_spec.py`),
a `DataSpec` with `extra="forbid"`: an unknown top-level key, an unknown `config` field
key or an unknown `auth` key is a **load error**, and a rejected manifest yields no
record at all (`spec_extractor` logs the rule and emits `[]`). The row is
`DataSourceSpec`; the file says `schema`, the row says `manifest_schema` (the base
entity already owns `schema_version`). The row also carries two computed facts from
the loaded class: `sends` and `load_error`.

> **`icon_name`, not `icon`.** `APIEntity.icon` is a getter with no setter that returns the
> TYPE's registry glyph — the one every spec shares. A row carrying an `icon` key is
> assigned onto the entity during hydration and throws there, inside the query, so the
> result comes back empty instead of raising. This is a per-SOURCE glyph and needs a
> different name.

The simplest manifest is six keys:

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
else is a load error, never a best-effort parse. `requires` is **recorded, not
enforced** — nothing reads it yet.

### `name`

The folder name, the source-type registry key, and the source class's `provider` —
one noun, not three. The loader refuses a class whose `provider` names another source.

**A folder cannot shadow a shipped source.** The shipped folders load first; an authored
folder whose name collides with one still indexes as a `data_source_spec` row, but the
shipped class runs and the authored one reports a `load_error`. Overriding ours would
mean no bug report could ever say which source ran.

### `kind`

The record kind a `DataSource` row of this source carries (`datasource.api.slack`).
Omitted, it is `datasource.<name>`.

### `auth`

Omitted when a source needs no credential — absent means none. Exactly one shape,
because a source has one credential lifetime:

```yaml
auth: { connector: slack, scopes: [channels:history] }
auth: { env: [GMAIL_ADDRESS, GMAIL_APP_PASSWORD] }
auth: { secrets: { api_key: ingest_api.agentmail, bot_token: "" } }
```

One resolver reads all three (`flow_sdk/ingest/credentials.py`) and hands the result to
the source as `self.credentials` — a source never reads the environment, the secret
store or the connection store itself. `connector` is this machine's connection to that
OAuth provider, its app token first when the provider issues one (Slack's bot). `env`
names are read from the operator's environment, each keyed by its own name. `secrets`
maps a value key to a machine secret name: the named machine secret wins, and the row's
own `config[value key]` is read otherwise (`""` names no machine secret). A value lifted
into the credentials never also rides in the source's `config`.

`scopes` is not decoration. `drive.readonly` and `drive` differ by a write grant,
and two sources sharing a connector consent once — whoever authorises first wins,
and the second gets 403s at fetch while verification reports ready.

None of the shapes ever contains a value.

### `reflect`

Supported modes, head first as the default. The values are `ReflectMode`: `record`
· `none` · `copy` · `symlink`; an unknown one is a load error. Omitted, the list is
`[record]` — the `ingest_items` path every record source takes. A list rather than
a single value because the picker must not offer a mode that silently fails: a
symlinked folder-layout asset is invisible to a walk that never descends symlinked
directories. Folder supports three modes (`none, copy, symlink`) and git and gdrive
two (`none, copy`).

**`record` may not appear in a multi-element list.** A source lands its payload in
the graph as a record or on disk as an asset; asking for both gets neither.

### `config`

The user-facing form, and the single source of truth for it — the frontend holds no
provider catalog.

| Key | Meaning |
|---|---|
| `type` | `text` · `lines` · `csv` · `number` · `path` (`FieldType`; anything else is a load error) |
| `required` | blocks save when empty |
| `label` · `hint` · `placeholder` | what the form renders |
| `default` | applied when omitted; a real default, never `""` — a `csv`/`lines` default is a list (`["story"]`) |
| `advanced` | collapsed behind "Advanced" |
| `pattern` | regex, so a bad value fails at the form and not at Verify |
| `account_key` | `true` on the ONE field whose value names the remote account. Descriptive only — ids are uuid4 and nothing dedupes on it |
| `choices` | the source can list this field's legal values (the class is `Choosing`, or defines `choices_for`) |

Each field is a `ConfigFieldSpec`, and its `type` is also a **coercion rule**:
`DataSource.save()` runs `ConfigFieldSpec.coerce` over any string-valued config
(`lines` splits on newlines, `csv` on commas, `number` parses), so a URL an agent
sent as a string where `lines` is declared becomes a one-element list. On create,
`required` and `pattern` are enforced by `DataSource.save()` too, so the CLI, the API
and an agent meet the same rules as the form.

### `setup_wiki` and `channel_icon_names`

`setup_wiki` names the wiki page explaining the setup step a provider cannot do
for you (Slack: inviting the bot). It is display only: the source class decides
whether it has a setup step (it is `Verifiable`).

`channel_icon_names` is a per-CHANNEL glyph map for a transport that serves
several channels (`agent`: `gmail → Mail`, `slack → Slack`). The inbox chip
resolves a record's channel to the channel-named spec's `icon_name` first, then
to this map on the transport's spec — so a channel's icon stays an asset fact,
never a frontend table.

## What is deliberately absent

| Not a field | Because |
|---|---|
| `provider` | `name` is the registry key |
| `runtime` | the folder answers it (below) |
| `traits` | ClassVars on the source class |
| `payload` | `reflect: record` means record; anything else means bytes |
| `sends` | the class implements `Messaging` and `message_for`; the row computes it |
| `needs_setup` | the class is `Verifiable` |
| `segment_budget` | a consequence of the fetch code, not a preference |
| `account_key` VALUE | lives on the `DataSource` row; the manifest only marks WHICH form field supplies it |
| `id` | carried by the asset's identity carrier, never written into the manifest |
| poll cadence | per-instance on `DataSource` — a big site wants six hours, a small one five minutes |
| cursor shape | `cursor` is the source's opaque string, and a test greps the engine for leaks |

## Runtime

There is one runtime, `source`: the folder's `source.py`, loaded in the backend process by
`flow_sdk/ingest/source_registry.py`. The folder is imported as a package named for its
content (`flowpad_source_<name>_<sha8>`), so helper modules import relatively and a
changed folder loads as a new module. The loader refuses, as a `load_error` shown on the
spec row: a folder with no `source.py`, a module defining other than exactly one `Source`
subclass, a class whose `provider` is not the manifest's `name`, an import error, and a
name a shipped source owns.

The shipped folders load on the registry's first lookup. An authored folder in a
project loads on first use — its `DataSource` is saved or synced — through its
`DataSourceSpec` row.

The extractor (`derive_data_source_spec`) stamps `runtime: source` on the row. A folder
still carrying the retired `fetch.py` or `FETCH.md` is refused with the upgrade — write a
`source.py`.

A definition's **editor** is not declared in the manifest either: a webapp asset
at `<name>/agentic-assets/webapp/editor/` is found by the same walker and becomes
the definition's child.

## Still open

* **The source runs in the backend process.** The sandboxed source host is a later
  step; an asset needs no change when it lands.
* **`requires` is not read.** Recorded on the row, enforced nowhere.
* **`auth.connector` does not derive `required_capabilities`.** The capability gate
  still comes from the source class's `connection` trait.
