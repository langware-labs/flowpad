---
id: 86e4754a-7b28-4bdb-91dd-4c991b316027
---
# Asset dependencies — snippets

Any folder asset may say what it needs: an optional `flow.json` in its own folder, naming
other assets **by id**. Including the asset brings what it names, and what THAT names, or a
state saying which link is missing. A project's root `flow.json` is the same file at the top
of the tree; a project's own assets declare through it too. A single-file asset (a markdown,
a skill `.md`) never has dependencies.

Every python fence runs, in order, as one session in
`tests/unit/test_asset_dependencies_snippets.py` (§7 against the gdrive asset's own loopback Drive, §8 with the mock worker); the corners — cycles, diamonds, the hub,
setup — are pinned by `tests/unit/test_asset_dependencies.py`.

## 1. The file

```json
{
  "dependencies": {
    "team-kb":    "data_source-7c1e2a40-…",
    "company-kb": { "ref": "data_source-0a9d55e1-…", "name": "Company knowledge", "description": "Shared with everyone" }
  },
  "optionalDependencies": { "icp": "gtm.icp.id.5d20c1e8-…" }
}
```

| An entry is | Means |
| --- | --- |
| `<type>-<uuid>` | an asset (a TypeId) — a data source, a skill folder, a project, a folder |
| `<kind>.id.<uuid>` | a kind-id: an asset type's kind is that asset (`data_source.id.<uuid>` ≡ `data_source-<uuid>`); any other kind names a value (a dataset row) |
| `{ "ref": …, "name": …, "description": … }` | the same id, with a human-friendly name and a description |

The key (`team-kb`) is the handle every verb takes. An asset's file takes ids only; a
project's root file may also name a location (`git+…`, `hub:…`, `file:…`).

## 2. Three layers, each in its own project

```python
import tempfile
import uuid
from pathlib import Path

from flow_sdk.builtin.data_driver import DataDriver
from flow_sdk.builtin.project import Project

tag = uuid.uuid4().hex[:8]
root = Path(tempfile.mkdtemp(prefix="layers-")).resolve()
folder = await DataDriver.get("folder")


async def layer(name: str):
    """A project holding one folder source that watches its own tree of notes."""
    (root / name).mkdir()
    project = Project(name=f"{name}-{tag}", fs_storage_mount_path=str(root / name))
    await project.save()
    tree = root / "trees" / name
    tree.mkdir(parents=True)
    (tree / f"{name}.md").write_text(f"# What {name} knows\n")
    source = folder.create_source(
        folder.create_config(root=str(tree)), name=f"{name}-{tag}", reflect="none", project_id=str(project.id),
    )
    await source.save()
    return project, source


company_kb, company = await layer("company")
sales_kb, team = await layer("sales")
dana_kb, personal = await layer("dana")
```

## 3. Each layer names the one under it

`asset=` writes the entry into THAT asset's own `flow.json` (here
`agentic-assets/data_source/<name>/flow.json`), not the project's.

```python
await sales_kb.add_dependency(str(company.typeid), asset=str(team.typeid), name="company-kb", label="Company knowledge")
await dana_kb.add_dependency(str(team.typeid), asset=str(personal.typeid), name="team-kb")

print((Path(personal.asset_ref) / "flow.json").read_text())
```

## 4. Depending on the personal layer brings the other two

```python
site = Project(name=f"site-{tag}", fs_storage_mount_path=str(root / "site"))
(root / "site").mkdir()
await site.save()

await site.add_dependency(str(personal.typeid), name="me")
for s in await site.dependencies():
    print(s.name, s.state, s.via_path)
# me ready []
# team-kb ready ['me']
# company-kb ready ['me', 'team-kb']

assert {personal.files_root, team.files_root, company.files_root} <= set(site.include_dirs)
```

What lands in context is what each asset's type says: a file source's FILES (the folder it
watches, or the one it downloads into), a project's folder, any other folder asset's own folder.

## 5. A missing link says which, and where it was needed

```python
gone = str(company.typeid)
await company.delete()

missing = next(s for s in await site.resolve_dependencies() if s.source == gone)
print(missing.state, missing.via_path, missing.reason)
# not_found ['me', 'team-kb'] nothing on this machine or on the hub has this id
```

## 6. Where an id is looked up

| Step | When |
| --- | --- |
| this machine | always: the row with that id, or the asset the index recorded under it |
| the hub | when fetching (`resolve_dependencies`, `flow dep sync`): the project holding the id that you may read is fetched here, then the id is looked up again |
| `not_found` | neither has it — or `unreachable` when the hub could not answer (signed out, no access) |

A status read (`dependencies()`) never asks the hub: an id that is not here reads `missing`.

## 7. The same three layers on Google Drive

Nothing about the dependencies changes — only the driver. Each layer is one `gdrive` source on one
folder of the drive, all three acting through this machine's one Google connection. What lands in
context is each source's cache: the folder its files are downloaded into, a Google Doc as `.md`.

```python
drive = await DataDriver.get("gdrive")


async def drive_layer(name: str, folder: str):
    """A project holding one Drive source on one folder of My Drive."""
    (root / f"{name}-drive").mkdir()
    project = Project(name=f"{name}-drive-{tag}", fs_storage_mount_path=str(root / f"{name}-drive"))
    await project.save()
    source = drive.create_source(
        drive.create_config(path=folder),   # `drive=...` for a shared drive; empty = My Drive
        name=f"{name}-drive-{tag}", reflect="none", read_only=True, project_id=str(project.id),
    )
    await source.save()
    await source.verify()                   # setup → active once Google answers for that folder
    await source.sync()                     # the folder's files land in this instance's cache
    return project, source


company_drive, company_docs = await drive_layer("company", "Knowledge/Company")
sales_drive, sales_docs = await drive_layer("sales", "Knowledge/Sales")
dana_drive, dana_docs = await drive_layer("dana", "Knowledge/Dana")

await sales_drive.add_dependency(str(company_docs.typeid), asset=str(sales_docs.typeid), name="company-kb")
await dana_drive.add_dependency(str(sales_docs.typeid), asset=str(dana_docs.typeid), name="team-kb")

reader = Project(name=f"reader-{tag}", fs_storage_mount_path=str(root / "reader"))
(root / "reader").mkdir()
await reader.save()
await reader.add_dependency(str(dana_docs.typeid), name="me")

for s in await reader.dependencies():
    print(s.name, s.state, s.via_path, sorted(p.name for p in Path(s.local_path).glob("*.md")))
# me ready [] ['Dana notes.md']
# team-kb ready ['me'] ['Sales playbook.md']
# company-kb ready ['me', 'team-kb'] ['Company handbook.md']
```

`reflect="none"` is what makes a source built in Python keep its files (the default, `record`, is
for sources that produce records, not files). A source that is still in `setup` (no Google
connection yet) resolves all the same — the id is on this machine — but it has no files to put in
context until it is verified and synced.

## 8. A small-model process asks about the root layer

The project names ONLY the personal layer. The process that runs in it reaches the company
handbook — the root of the chain — because personal depends on team and team on company.

```python
from flow_sdk.builtin.agentic_process import AgenticProcess

ask = Project(name=f"ask-{tag}", fs_storage_mount_path=str(root / "ask"))
(root / "ask").mkdir()
await ask.save()
await ask.add_dependency(str(dana_docs.typeid), name="me")

for s in await ask.dependencies():
    print(s.name, s.state, s.via_path)
# me ready []
# team-kb ready ['me']
# company-kb ready ['me', 'team-kb']

result = await AgenticProcess.run(
    "One of your context folders holds the company handbook. "
    "How many vacation days does an employee get? Answer with the number only.",
    project_id=ask.id,
    worker_type="claude_code",
    cli_config={"model": "sm"},     # the portable small size: haiku on the claude worker
)

proc = await AgenticProcess.get_by_typeid(result.executor)
await proc.get_project()            # re-derive its context, as launch does
assert {dana_docs.files_root, sales_docs.files_root, company_docs.files_root} <= set(proc.resolved_add_dirs)

print(result.ok, result.text)
# True 24
```

The process is told a file exists, never where: all three layers' folders are in its context
(`resolved_add_dirs`), though the project named one.

## 9. The same verbs elsewhere

```console
$ flow dep add data_source-7c1e… --name team-kb --label "Team knowledge"
$ flow dep add data_source-0a9d… --asset data_source-7c1e… --name company-kb
$ flow dep list
$ flow dep check data_source-0a9d…        # a dependency reached through another one, by its id
```
