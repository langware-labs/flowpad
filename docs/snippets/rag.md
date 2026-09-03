---
id: aa2bc808-fb80-4d04-b8e4-f658b61ea0c1
---

# RAG — snippets

A `RagIndex` covers folders and answers questions about what is in them. It walks the roots you
add, chunks the markdown it finds, embeds only the chunks it has not seen, and keeps the vectors
under the instance's records-data directory — never inside a project tree.

Two things are worth knowing before the code:

* **`embedded` is the number that costs money.** Chunk ids key on their own text, so a re-index
  of an untouched tree embeds nothing, and moving a section around a file embeds nothing either.
* **Marking is free, embedding is not.** The indexer only ever sets `pending` on a covering
  index; a heartbeat pass does the paid work. So a scan of a thousand documents makes no network
  call, and a provider being down delays an index rather than stalling a walk.

Every snippet below is run verbatim by `tests/unit/test_rag_snippets.py`; the behaviour they
lean on is pinned by `tests/unit/test_rag_indexing.py` and its neighbours.

## 1. Make a folder searchable

One verb, addressed by PATH. It finds the box's index or creates it, so the first folder anybody
marks needs no setup first. This is exactly what the brain button in the file tree calls.

```python
from flow_sdk.builtin.rag_index import RagIndex

index, covered = await RagIndex.toggle_root("/Users/me/notes")   # covered → True
index, covered = await RagIndex.toggle_root("/Users/me/notes")   # again → False
```

Everything beneath a root is covered. The marker in the UI goes on the root only, because that
is where the choice was made.

To be explicit about which index, or to add without toggling:

```python
index = await RagIndex.ensure_default()      # find-or-create, answers the OLDEST row
await index.add_root("/Users/me/notes")
await index.remove_root("/Users/me/notes")   # also drops that root's chunks from the store
print(index.roots)
```

## 2. Run a pass and read what it cost

```python
from flow_sdk.rag import reconcile

# A new index is SETUP until something funds embeddings. `settle_status` looks for a local key
# and promotes it; while it finds none, `run_index` is a no-op and the reason is the sentence.
refusal = await index.settle_status()          # "" when it can run
reports = await reconcile.run_index(index)
for r in reports:
    print(r.root, r.documents_changed, "changed;", r.embedded, "embedded")

reports = await reconcile.run_index(index)   # nothing changed
assert reports[0].fresh and reports[0].embedded == 0
```

`run_index` never raises: a pass that fails leaves the reason on the row (`index.last_error`) for
a person to read, and the next tick tries again. It resolves funding itself — the bound
`LLMEndpoint`, else any local key that resolves — and returns `[]` without doing anything when
`index_refusal()` has something to say ("this index covers no folders yet", "no embedding
endpoint is bound yet", "this index is disabled").

Normally you do not call it at all: `dispatch_due_indexes` runs on the heartbeat and picks up an
index that is `pending`, or one with a root the store has no hash for.

## 3. Ask it something

```python
embed, model = await reconcile.embedder_for(index)
vectors = await embed(["how does the gitignore walk decide what to skip"])

async with index.open_store() as store:
    for hit in store.search(vectors[0], top_k=5):
        print(f"{hit.score:.3f}  {hit.doc_ref}  {' / '.join(hit.heading_path)}")
```

Embed the question with the SAME model the chunks were embedded with. A vector from another
model is not merely worse in this space, it is meaningless — which is why `model` and
`dimensions` are pinned on the row at the first embed, and why changing either is a rebuild
rather than a top-up.

`open_store()` is an async context manager and it is the only door: usearch is a native index
over files, and two live handles on one index do not race politely, they take the process down.

## 4. Chunk or store something without an index

The two halves are usable on their own — a chunker over markdown, and a vector store that skips
ids it already holds.

```python
from flow_sdk.rag.chunking import chunk_markdown
from flow_sdk.rag.store import RagStore

chunks = chunk_markdown(open("doc.md").read(), doc_ref="doc.md")
print(chunks[0].heading_path, chunks[0].text[:60])

with RagStore("/tmp/my-store") as store:
    fresh = store.unknown(chunks)                 # only what it has never seen
    if fresh:
        store.add(fresh, await embed([c.text for c in fresh]), model=model)
```

`RagStore` flushes on close — a save is a whole-file rewrite, so callers batch a build and flush
once rather than paying for it per document.

## 5. Over HTTP

The same four verbs the UI uses. Everything but the toggle is addressed by index id.

```bash
curl -X POST $API/api/v1/graph/rag-toggle-root -d '{"path":"/Users/me/notes"}'
curl -X POST $API/api/v1/graph/rag_index/$ID/index -d '{}'          # schedules; returns a refusal if it cannot
curl -X POST $API/api/v1/graph/rag_index/$ID/query -d '{"q":"...","top_k":5}'
curl      $API/api/v1/graph/rag_index/$ID                            # status IS a GET of the row
```

`index` returns as soon as the pass is scheduled. Embedding a folder is paid, network-bound and
minutes long; a request that waited for it would time out on the first real corpus.
