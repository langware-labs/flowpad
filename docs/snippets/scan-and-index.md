---
id: 8c7cec8d-bb58-4116-b83e-f9006f23a228
---
# Scan and index — snippets

Finding what is on disk is the first half of every index run. `flow_sdk.diskio` holds that
half as a set of small interfaces — walk a tree, find typed assets, read a document, pull the
links out of its text — each with a Python implementation and, for the scan, a Rust one behind
**one switch**:

```bash
FLOWPAD_DISKIO_BACKEND=rust      # or "python", the default — also the preference advanced.diskio_backend
```

Nothing above the interface changes when you flip it: the same values come back, and a missing
or failing Rust binary answers through Python. Interfaces and rules:
[diskio.md](../data-management/diskio.md); numbers:
[diskio-benchmarks.md](../data-management/diskio-benchmarks.md).

Every snippet below is run verbatim by `tests/unit/test_scan_index_snippets.py`; `ROOT` is a
project folder.

## 1. Walk a tree the way the indexer does

`kernel(TreeWalker)` is the one shared walk: `.gitignore` files honoured as they nest, vendor and
build folders skipped, `.claude/` always seen. Every stream ends with one `StreamEnd` that
counts what came before it — a walk that stops early is told apart from one that finished.

```python
from flow_sdk.diskio.contract import StreamEnd, TreeWalker
from flow_sdk.diskio.python.tree_walker import walk_policy
from flow_sdk.diskio.select import kernel

walker = kernel(TreeWalker)
folders, markdown = [], []
for entry in walker.walk(ROOT, walk_policy(file_exts=(".md",))):
    if isinstance(entry, StreamEnd):
        print("directories walked:", entry.counts["diskio.walk_entry"])
        break
    folders.append(entry.dir)
    markdown += [f"{entry.dir}/{name}" for name in entry.files]
```

## 2. Scan a project — the walk and the asset discovery in one request

Stage 1 of a scan is one request: the tree walk plus, for every folder, the search for the
asset types that can live anywhere in a project (a `SKILL.md` folder, a spreadsheet).
`scan_stage1` returns the verified result or re-runs on Python — never a partial list.

```python
from flow_sdk.diskio.contract import ScanCandidate, ScanRequest, ScanRoot, WalkEntry
from flow_sdk.diskio.python.declared_scanner import folder_scan_specs
from flow_sdk.diskio.python.tree_walker import walk_policy
from flow_sdk.diskio.stage1 import scan_stage1

request = ScanRequest(
    roots=(ScanRoot(path=ROOT, kind="real_project_cwd"),),
    policy=walk_policy(file_exts=()),          # folders only: no file lists needed here
    specs=folder_scan_specs(),                  # every type with a folder-rooted walk, as data
)
items = scan_stage1(request)
directories = [item.dir for item in items if isinstance(item, WalkEntry)]
skills = [item.path for item in items if isinstance(item, ScanCandidate) and item.type_name == "skill"]
```

## 3. Read documents: header, body and a revision

One read gives the frontmatter fields, the body, and a `sha256:` revision of the raw bytes. A
file that cannot be read comes back as a value with `error` set — one bad file never ends the
batch.

```python
from flow_sdk.diskio.contract import DocumentReader, StreamEnd
from flow_sdk.diskio.select import kernel

reader = kernel(DocumentReader)
documents = [d for d in reader.read([GUIDE, MISSING]) if not isinstance(d, StreamEnd)]
guide, missing = documents
title = guide.fields.get("title")
revision = guide.revision
unreadable = missing.error.kind
```

## 4. Pull the title and the links out of a body

```python
from flow_sdk.diskio.contract import LinkGrammar, TextExtractor
from flow_sdk.diskio.select import kernel

text = kernel(TextExtractor).extract_text(BODY, LinkGrammar())
heading = text.h1
links = [link.raw for link in text.links]
```

## 5. Which backend is answering

```python
from flow_sdk.diskio.contract import Scanner
from flow_sdk.diskio.select import kernel, selected_backend

asked_for = selected_backend()                  # "python" or "rust" — what the switch says
answering = type(kernel(Scanner)).__name__      # "PyScanner" or "RustScanner" — who answers
```
