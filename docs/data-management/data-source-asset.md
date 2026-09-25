---
id: f2a0bbff-0654-4416-b5c6-be1415a08f4d
---

# Data source assets

A data source is a **folder asset**. `data_driver.json` is the manifest (the
`DataDriver`); `source.py` is the source itself; everything else in the folder
is discovered by convention. The loader reads the folder — nothing is registered in
`flow_sdk` per source, and a shipped source is laid out exactly like an authored one.

```
agentic-assets/data_driver/my-source/
  data_driver.json # the folder's main document: the manifest
  source.py        # REQUIRED — exactly one flow_sdk.sources.Source subclass
  transport.py     # optional helper modules, imported relatively
  tests/           # its own tests and its matrix case
  README.md        # optional — human docs, never read by the runtime
  references/      # optional — read by the wizard, never by the runtime
```

That folder is the **driver**. Each configured instance of it is a `DataSource`, and it is an
asset too — an entity document in the project it was created in (the user scope outside one):

```
agentic-assets/data_source/work_gmail/
  data_source.json # {"type": "data_source", "id": ..., "name": "work gmail",
                   #  "data_driver_name": "gmail", "data_driver_config": {...}, "owner": ...}
```

The file (`DataSourceSpec`) is what a person authors and nothing the engine writes: status,
health, the cursor, the next poll, discovered identities and the allowlist (`allowed_senders`,
PRIVATE: who may drive the source is this machine's business) are row-only (`Persist.FALSE`), and the
engine saves them with `save_runtime()`, which never touches the file — a re-read of the file leaves
them as they are. The config is value-free —
a secret is a credential the driver declares. A folder that arrives by copy, clone or share
indexes in `setup` ("Received — connect your own account, then press Verify."), and one owner
watches one account once: `save()` of a new source for an account its owner already watches adopts
that row (`find_for_account` on the driver's `identity_config_key`) — the authored fields and the
config merged onto it, its cursor kept — instead of minting a twin. `owner=` takes the entity itself
(an `Agent`) or its `TypeId`; a source an Agent owns is that agent's channel, the one way to give it one. Deleting the source removes its folder with the items it ingested; a
row with no folder (one written before sources were files) is removed at boot.

`agentic-assets/<family>/` is where a native asset lives (glossary), and the main
file is named for its type — the same rule the bundle format follows with
`flow_message.json` and `conversation.jsonl`. JSON rather than frontmatter: the
manifest is data the runtime parses, and a wizard writing it should not have to
get YAML indentation right.

## Self-contained

Everything one source needs lives in its folder, shipped or authored alike — the rule in
`CLAUDE.md` ("Data sources are self-contained assets"):

```
agentic-assets/data_driver/<name>/
  data_driver.json          # the DataDriver
  source.py                 # exactly one flow_sdk.sources.Source subclass — the source
  transport.py …            # optional helper modules, imported relatively (`from .transport import …`)
  tests/test_<name>_source.py   # conformance kit + wire cases, against flow_sdk.sources.testing doubles
  tests/matrix.py           # its Double (loopback provider) and its case in the data source matrix
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

* **The class is authoritative for what it is.** Its family is the base it extends
  (`ObjectSource` / `RecordSource` / `MessageSource`), and traits (`durable_cursor`,
  `stamps_identity`, `open_inbound`, …) are ClassVars on the source class or its family; a manifest copy would be "authoritative-looking, owned by nobody, and
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

The shape is `DataDriverSpec` (`flow_sdk/schema/data_spec/data_driver_spec.py`),
a `DataSpec` with `extra="forbid"`: an unknown top-level key, an unknown `config` field
key or an unknown `auth` key is a **load error**, and a rejected manifest yields no
record at all (`spec_extractor` logs the rule and emits `[]`). The row is
`DataDriver`; the file says `schema`, the row says `manifest_schema` (the base
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
description: One feed URL. No credentials.
icon_name: Rss
config:
  feed_url: { type: text, label: Feed URL }
```

and its `source.py` declares the rules for that field:

```python
class RssConfig(SourceConfig):
    feed_url: Annotated[str, StringConstraints(pattern=r"^https?://")]

class RssSource(RecordSource, CollectionSource):
    Config = RssConfig
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
folder whose name collides with one still indexes as a `data_driver` row, but the
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
auth: { secrets: { api_key: ingest_api.agentmail } }
auth: { credential: whatsapp, vars: { access_token: FLOW_WHATSAPP_TOKEN, app_secret: FLOW_WHATSAPP_SECRET } }
```

`credential` names a SecretPack and `vars` maps each value key to one of its variables. It
is resolved for the row's OWNER the way a worker process resolves its secrets — the owning
agent's project scope over the user scope, read from that scope's `.env.local` or vault — so
an agent's channel is configured by declaring the credential in the agent's project, never by
pasting a token into the source. The SecretPack itself is declared in the project
(`credentials/save`) or shipped as a template (`agentic-assets/secret_pack/telegram/`), not beside
the source.

One resolver reads all four (`flow_sdk/ingest/credentials.py`) and hands the result to
the source as `self.credentials` — a source never reads the environment, the secret
store or the connection store itself. `connector` is this machine's connection to that
OAuth provider, its app token first when the provider issues one (Slack's bot). `env`
names are read from the operator's environment, each keyed by its own name. `secrets`
maps a value key to a name in the bound (or default) store, then to a machine secret. No
shape ever reads the row's `config`: a config is value-free, and the loader refuses a `Config`
field that is a secret or a key `auth` names.

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
the graph as a record or on disk as an asset; asking for both gets neither. The modes are the
family's: an `ObjectSource` lists filesystem modes, a `RecordSource` / `MessageSource` has
`[record]` — `load_driver` refuses any other pairing.

### `config` — form hints; the rules are the driver's `Config`

Two halves, one per owner. The manifest's `config` says how the form DRAWS each field; the
source's `Config(SourceConfig)` in `source.py` says what a value must BE. The loader refuses a
driver whose two halves name different fields (`derived` fields, which the application fills,
are exempt) or whose `Config` holds a secret.

| Hint (`FieldHints`) | Meaning |
|---|---|
| `type` | the widget: `text` · `lines` · `csv` · `number` · `path` (`FieldType`) |
| `label` · `hint` · `placeholder` | what the form renders |
| `advanced` | collapsed behind "Advanced" |
| `account_key` | `true` on the ONE field whose value names the remote account. Descriptive only |
| `choices` | the source can list this field's legal values (the class is `Choosing`, or defines `choices_for`); a pick is stored as a `ChoiceEntry` (`{id, name}`) |

`required`, `pattern` and `default` are no longer hints (`extra="forbid"` refuses them): they
are the `Config`'s fields, and `DataDriver.config_schema` (its JSON Schema) carries them to the
form. Three readings of one `Config`:

* **create** — `DataSource.save()` validates the whole config, after shaping what was typed
  (`"5"` → `5`, a newline string → a list); a failure is `ValueError: config.<field> is required`
  / `is not valid: <value>`, which the create route maps to a 400;
* **a form in progress** — `Config.draft(raw)` keeps the known keys that validate;
* **a stored row** — `Config.best_match(raw)`, what the binding hands the source: every key that
  still validates, the default for one that does not. `Config.lift` adopts renamed keys;
  `Config.retired_list` names a list key that became one field, which boot splits into one
  source per entry (`migrate_list_configs`).

### `setup_wiki` and `channel_icon_names`

`setup_wiki` names the wiki page explaining the setup step a provider cannot do
for you (Slack: inviting the bot). It is display only: the source class decides
whether it has a setup step (it is `Verifiable`).

`channel_icon_names` is a per-CHANNEL glyph map for a transport that serves
several channels (`agent`: `gmail → Mail`, `slack → Slack`). The stream inbox chip
resolves a record's channel to the channel-named spec's `icon_name` first, then
to this map on the transport's spec — so a channel's icon stays an asset fact,
never a frontend table.

## What is deliberately absent

| Not a field | Because |
|---|---|
| `provider` | `name` is the registry key |
| `runtime` | the folder answers it (below) |
| `traits` | ClassVars on the source class |
| `payload` / `family` | the base the class extends (`ObjectSource` / `RecordSource` / `MessageSource`); the row computes `family` |
| `sends` | the class is a `MessageSource` implementing `Messaging` and `message_for`; the row computes it |
| `needs_setup` | the class is `Verifiable` |
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
`DataDriver` row.

The extractor (`derive_data_driver`) stamps `runtime: source` on the row. A folder
still carrying the retired `fetch.py` or `FETCH.md` is reported by the scan (never indexed) with
the upgrade — write a `source.py`. See "Porting a retired runtime" below.

### Porting a retired runtime

A `fetch.py` driver moves into `agentic-assets/data_driver/<name>/` by hand: rename its manifest to
`data_driver.json` and rewrite the code as a `source.py`. The port is mechanical:

| `fetch.py` (retired) | `source.py` (current) |
|---|---|
| `verb == "segments"` → `{"segments": [...]}` | gone: a source reads one stream; `def query()` builds it from `self.config` |
| `req["source"]["config"]` | `self.config` |
| the printed `items` list | `_scan(query)` → sorted `[(key, raw), ...]`, and `_item(key, raw)` → `SourceItemSpec` |
| `external_id` | the key; `self.origin(key)` builds the identity |
| `state` / `high_water` cursor | nothing, for a listing: re-seeing an unchanged item is free |
| `traits` in the manifest | ClassVars on the class (`traits` is refused in the manifest) |

A minimal `CollectionSource` also implements `_lookup(key)` (`dict(await self._scan(None)).get(key)`),
and sets `provider` to the manifest's `name`.

A definition's **editor** is not declared in the manifest either: a webapp asset
at `<name>/agentic-assets/webapp/editor/` is found by the same walker and becomes
the definition's child.

## Still open

* **The source runs in the backend process.** The sandboxed source host is a later
  step; an asset needs no change when it lands.
* **`requires` is not read.** Recorded on the row, enforced nowhere.
* **`auth.connector` does not derive `required_capabilities`.** The capability gate
  still comes from the source class's `connection` trait.
