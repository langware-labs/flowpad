---
id: 94e1bd96-adda-45d6-ac5e-0356fa4ca5b3
---
# Mode: author — write a NEW source type

> **Ground rules (inline by design):**
> **1. Evidence, never events.** A 200 is not proof; `poll_now` only marks a
> source due, so "I polled" is never "items landed" — `flow source sync` is.
> **2. Read before you poke** — `poll_now` and `sync` clear `health`, `error_code`
> and `error_detail` together.
> **3. Never widen a wait, a timeout, or a retry to make something pass.**
> **4. Never destroy the user's data to fix a symptom.**
> **5. Credentials and invites are the user's step** — name the exact click.

Reached when no installed source can express what the user named. The output is
ONE self-contained folder asset — everything the source needs lives in it, and
nothing is edited in `flow_sdk`, `ts_sdk` or `ui`.

`SC` means `python3 <this skill>/scripts/source_ctl.py`; `flow source …` is the CLI
over the same backend actions.

## What you are writing

```
<project>/agentic-assets/data_driver/<name>/
    data_driver.json          the manifest (DataDriver): presentation, kind, auth, the config form
    source.py                 exactly ONE flow_sdk.sources.Source subclass — the source
    transport.py …            optional helper modules, imported relatively (`from .transport import …`)
    tests/test_<name>_source.py   the conformance kit + wire cases against a loopback double
    tests/matrix.py           its Double (a loopback provider) and its case in the data source matrix
    README.md                 setup, credentials, what a person must click
```

A source that should fetch through a worker is not authored at all: it is the
shipped `agent` transport, configured per `references/mapping.md`. Read
`docs/data-management/data-source-asset.md` (the manifest) and
`docs/data-management/data-sources.md` ("Adding a source") before writing.

## The manifest — the rules that bite

```json
{
  "schema": 1,
  "name": "wiki",
  "title": "Team wiki",
  "description": "Pages from the team wiki.",
  "kind": "datasource.api.wiki",
  "icon_name": "BookOpen",
  "auth": {"secrets": {"api_token": "ingest_api.wiki"}},
  "config": {
    "base_url": {"type": "text", "label": "Wiki URL", "placeholder": "https://wiki.example.com"}
  }
}
```

- `name` is the folder name and the registry key. It must not collide with a
  shipped source — the shipped one wins and your folder reports a `load_error`.
- `icon_name`, never `icon`.
- `auth` is exactly ONE of `{connector, scopes}` (an OAuth connection),
  `{env: [NAMES]}` (the operator's environment), `{secrets: {value_key: machine
  secret name}}` (a store or machine secret) or `{credential: pack, vars: {value_key: VAR}}`
  (a SecretPack). Never a credential value, and never a config field: a config lands in
  `data_source.json`. The source reads what it declares from `self.credentials`.
- No `traits`, no `fetch.py`, no `FETCH.md` — all refused at load. Traits are
  ClassVars on the class.
- `config` holds FORM HINTS only — `type` (the widget: `text` `lines` `csv` `number` `path`),
  `label`, `hint`, `placeholder`, `advanced`, `account_key`, `choices`. The rules (required,
  pattern, default) are the class's `Config`, and the two must name the same fields.

## The class

```python
from typing import Annotated

from pydantic import StringConstraints

from flow_sdk.sources import CollectionSource, FeedItemData, SourceItemSpec
from flow_sdk.sources import http
from flow_sdk.sources.config import SourceConfig


class WikiConfig(SourceConfig):
    base_url: Annotated[str, StringConstraints(pattern=r"^https?://")]   # required: no default


class WikiSource(CollectionSource):
    provider = "wiki"            # = the manifest's name
    Config = WikiConfig          # its fields = the manifest's config keys
    durable_cursor = False       # True only when the provider can resume from your cursor string

    def query(self):             # the ONE stream this source reads, from its config
        return None              # or a DataQuery built from self.config

    async def _scan(self, query):
        token = self.credentials.value("api_token")
        ...                      # list pages → [(key, raw), ...] sorted by key

    async def _lookup(self, key): ...
    def _item(self, key, raw) -> SourceItemSpec: ...
```

One source reads one stream: a config names ONE feed, channel, drive or prefix,
and a person watching three adds three sources. Implement only the protocols the
provider honours — `fetch(cursor)`/`iterate()` to list (the query is `self.query()`,
never an argument),
`send`/`reply` plus `message_for` for a channel, `open` for bytes, `verify` for a
setup step. Everything the application needs to know about THIS source is the
class's own method (`build`, `configure`, `query`, `origin_id_for`,
`permalink`, `webhook_*`) — never a table elsewhere. Import the public SDK
(`flow_sdk.sources`, `flow_sdk.connections`, `token_for`), never another asset.

## The tests, in the folder

- `tests/test_<name>_source.py`: `checks_for(WikiSource)` from
  `flow_sdk.sources.testing` over a `local_http_server` double
  (`flow_sdk.ingest.testing`), plus the wire cases (paging, errors → the right
  health). Import the class with
  `WikiSource = asset_module("wiki").WikiSource` (`flow_sdk.ingest.source_registry`).
  Name the file `test_<name>_source.py` — test module names are global.
- `tests/matrix.py`: a `Double` — the provider over a loopback socket, with `config`
  (including any base-URL seam the driver reads), `secrets` keyed as the manifest's `auth`
  names them, `deliver(text, sender=…)` and `sent()` — and `case(monkeypatch, tmp_path)`, a
  context manager over it yielding `{"config": …, "fields": …, "min_items": …, "send": …,
  "double": …}`. A message driver's `Double` is also what the stream inbox channel matrix
  and the browser doubles process (`tests/e2e/channel_doubles.py`) read through.

## Shipping an editor with the source

A definition's editor is a **webapp asset nested inside the definition** —
nothing more. Put it at `<spec folder>/agentic-assets/webapp/editor/`:

```
<spec folder>/agentic-assets/webapp/editor/webapp.json   {"name":"editor","kind":"application.web.editor","build":"."}
<spec folder>/agentic-assets/webapp/editor/index.html
<spec folder>/agentic-assets/webapp/editor/app.js        import { mountSourceEditor } from '/sdk/flowpad-sdk.js'; mountSourceEditor();
```

`kind: application.web.editor` is what makes the Data Sources menu offer "Open
editor". `mountSourceEditor()` is the shipped editor (config form + items +
dataset pane). A definition with no such folder simply has no editor.

## After writing

1. `flow record index <project> --types data_driver` — point it at the
   PROJECT, not the source folder.
2. `flow source types` — the new name must appear with an empty `load_error`. A
   non-empty one names the problem (no `source.py`, two classes, an import error,
   a taken name); fix it and index again.
3. `flow source create <name> --config k=v …`, then the gates, each with evidence:
   `flow source verify <id>` → `flow source sync <id>` (health `ok`) →
   `flow source items <id>` (the records are there) → for a channel
   `flow source send <id> --to … --text …` and `flow source reply <id> <item> --text …`.
4. Run the folder's own tests (`pytest <folder>/tests`). Never report a source as
   connected when `flow source sync` has not returned `ok` with items.
