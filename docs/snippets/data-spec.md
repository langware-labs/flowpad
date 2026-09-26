---
id: ebc462b0-0bc2-4c18-ba79-3a4a29559ce8
---
# DataSpec

Every fence on this page runs in `tests/unit/test_data_spec_snippets.py`.

A **`DataSpec`** is one shape. The **class is the schema**; an **instance is the
data**. Functions take them as arguments and return them as values — that is the
whole IO model.

## 1. Declare a shape

```python
from flow_sdk.schema.data_spec import DataSpec

class Endpoint(DataSpec):
    host: str = "localhost"
    port: int
```

```python
from pydantic import ValidationError

Endpoint(port=8099)                  # host='localhost' port=8099
Endpoint(port=8099).model_dump()     # {'host': 'localhost', 'port': 8099}
Endpoint(port=1).model_copy(update={"port": 2})   # the way to change one

for wrong in ({"port": "nope"}, {"port": 1, "prot": 2}):
    try:
        Endpoint(**wrong)
    except ValidationError as refused:
        refused.errors()[0]["loc"]   # ('port',) — wrong type; ('prot',) — a typo is not a field

try:
    Endpoint(port=1).port = 2
except ValidationError:
    pass                             # a spec is frozen
```

**`frozen`** — a spec is a value. Nothing edits one in place and hands it on;
the next reader would have no way to tell what it was handed.

**`extra="forbid"`** — a misspelled key fails loudly instead of yielding a row
with an empty field. So a constructor reading a foreign dict projects field by
field rather than splatting it: the hop is deliberately lossy, and that is the
contract.

## 2. A shape written in a document

Assets are JSON. A shape a document declares is text, and `parse` compiles it to
a class.

```python
from flow_sdk.schema.data_spec import DataSpec, to_authoring_form

Endpoint = DataSpec.parse({"host": "string", "port": "int"})
Endpoint(host="h", port=8099).model_dump()   # {'host': 'h', 'port': 8099}
to_authoring_form(Endpoint)                  # {'host': 'string', 'port': 'int'}
```

Three authoring forms, and nothing else:

| form | means |
| --- | --- |
| `"int"` | a reserved primitive — `string`, `int`, `float`, `bool` |
| `"demo.endpoint"` | a registered kind, by name |
| `{"host": "string"}` | an object — fields and their shapes |
| `["int"]` | a list — exactly one element, the shape every element has |

```python
DataSpec.parse("int")        # <class 'int'>
DataSpec.parse(["int"])      # list[int]
DataSpec.parse({"ports": ["int", "int"]})
# ValueError: a list shape carries exactly one element … got 2
```

No keywords: no `required`, no `default`, no `type:` wrapper. A shape says what
the value looks like, never how it behaves.

Two identical forms compile to **one** class, cached by canonical form:

```python
DataSpec.parse({"host": "string", "port": "int"}) is Endpoint   # True
```

Such a class is **anonymous** — `Spec_b297da81`, not a name you wrote. To get
your own class back, give it a kind:

```python
from typing import ClassVar

from flow_sdk.schema.data_spec import DataSpec, to_authoring_form

class Endpoint(DataSpec):
    spec_kind: ClassVar[str] = "demo.endpoint"
    host: str = "localhost"
    port: int
```

```python
DataSpec.parse("demo.endpoint")   # <class 'Endpoint'> — your class
to_authoring_form(Endpoint)       # 'demo.endpoint'
```

A registered **asset** type needs no declaration at all: its kind IS its type
name, derived ([`docs/ontology.md`](../ontology.md) rule 4), which is why
`parse("markdown")` already answers `MarkdownSpec`. The hook is called
`spec_kind` rather than `kind` because a dict is always an object whose keys are
field names — so `{"kind": "int"}` is a one-field object called `kind`, and an
author must stay free to write it.

> ⚠️ An *unregistered* name still resolves to `Any`, **silently** —
> `DataSpec.parse("nope.not.registered")` gives an untyped field and no error
> anywhere. That path is deliberate: eager compilation resolves a forward
> reference to `Any` rather than chasing a cycle. So reachability from
> `register_builtin_kinds()` is what makes a declaration real.
>
> A name that IS a registered entity type but has no asset document is a
> different case and now raises — the author meant a real thing. See
> [`docs/ontology.md`](../ontology.md).

## 3. What a call returns

One answer for every call — a caller reads it without knowing what it called.
Each kind of work answers with its own subclass (`CliResult`, `PromptResult`,
`AskResult`, `WizardResult`); the whole contract, checked fence by fence, is
[call-returns](call-returns.md).

```python
from flow_sdk.schema.data_spec.returned_value_spec import ExitCode, ReturnedValue

async def bind(port: int) -> ReturnedValue:
    return ReturnedValue(exit_code=ExitCode.OK, value=port, detail=f"bound :{port}")

answer: ReturnedValue = await bind(8099)
answer.exit_code     # ExitCode.OK
answer.value         # 8099
answer.detail        # 'bound :8099'
answer.ok            # True
```

| field | says |
| --- | --- |
| `exit_code: ExitCode` | why it ended — the same enum `flow op` exits with |
| `value: Any` | what it produced |
| `detail: str` | one sentence for a person |
| `ran: bool` | whether anything executed (`False`: already held, refused, busy, never started) |
| `timed_out: bool` | the wait ended before the work did |
| `executor: str \| None` | the process or shell that ran it |
| `check: CliResult \| None` | the completion check that decided it |

```python
ExitCode.OK              # 0  done
ExitCode.NOT_YET         # 1  not yet
ExitCode.NOT_APPLICABLE  # 3  not this machine
ExitCode.NOT_FOUND       # 4  no such thing
ExitCode.REFUSED         # 7  not approved here
```

A callee declares the KIND it returns — a registered shape from [§2](#2-a-shape-written-in-a-document),
or a primitive:

```json
{"name": "pick-port", "subkind": "cli", "exe_data": {"commands": {"linux": "./pick-port"}},
 "output_spec_kind": "net.endpoint"}
```

The caller then reads `answer.value` and it is already that shape — no parsing,
no re-validation. A value that does NOT match is a failure, not a warning:

```python
import sys
import tempfile
from pathlib import Path

from flow_sdk.core.compute_op import run_op
from flow_sdk.schema.data_spec.compute_op_spec import ComputeOpSpec

class NetEndpoint(DataSpec):
    spec_kind: ClassVar[str] = "net.endpoint"
    host: str
    port: int

pick_port = ComputeOpSpec.model_validate({
    "name": "pick-port", "subkind": "cli", "output_spec_kind": "net.endpoint",
    "exe_data": {"commands": {sys.platform: """echo '{"host": "h", "port": "nope"}'"""}},
})
answer = await run_op(pick_port, trusted=True, workdir=Path(tempfile.mkdtemp()))
answer.exit_code   # ExitCode.NOT_YET
answer.detail      # "pick-port: returned a value that is not a net.endpoint — …"
```

Otherwise a caller binds a broken value into the next call, and the breakage
surfaces somewhere it cannot be explained. A callee that declares no output
returns `value=None`, and nothing is checked.

## 4. Save and load

A shape knows how to put itself on disk and how to come back. The folder is the
value: nothing else is needed to move it, copy it, or hand it to another machine.

```python
class Endpoint(DataSpec):
    host: str = "localhost"
    port: int

class Step(DataSpec):
    name: str
    setup: str = ""
    endpoint: Endpoint | None = None

class Op(DataSpec):
    name: str
    steps: list[Step] = []
    endpoint: Endpoint | None = None

class Toolchain(DataSpec):
    name: str
    ops: list[Op] = []
    default: Endpoint | None = None
```

```python
chain = Toolchain(
    name="dev",
    default=Endpoint(port=8080),
    ops=[Op(name="pick-port", steps=[Step(name="probe", setup="lsof -i",
                                          endpoint=Endpoint(port=9000))])],
)
root = Path("dev-toolchain")
chain.save(root)
```

```
root/toolchain.json                        {"name": "dev", "default": {"host": "localhost", "port": 8080}}
root/ops/pick-port/op.json                 {"name": "pick-port", "endpoint": null}
root/ops/pick-port/steps/probe/step.json   {"name": "probe", "setup": "lsof -i",
                                            "endpoint": {"host": "localhost", "port": 9000}}
```

Two rules, both read off the type — no annotation anywhere:

| the field is | it becomes |
| --- | --- |
| a shape | an object **inside** the parent's json — it is a value |
| a list of shapes | a **directory** named by the field, one folder per element, named by its `name` |
| a dict of shapes | a **directory** named by the field, one folder per **key** |

So `Endpoint` rides along wherever it appears, at any depth, while `ops` and
`steps` are folders you can open, diff and edit one at a time.

```python
Toolchain.load(root) == chain                       # True
Toolchain.load(root).default.port                   # 8080
Toolchain.load(root).ops[0].steps[0].endpoint.port  # 9000
```

Round trip is identity: what `load` returns equals what `save` was given.

## 5. A field that is a file

Some values are not fields of a document — they ARE one. That is read off the
type, never off an annotation.

```python
from flow_sdk.schema.data_spec import DataSpec
from flow_sdk.schema.data_spec.io import Binary, Text

class Op(DataSpec):
    name: str            # a value    -> op.json
    setup: Text = ""     # a document -> setup.md
    readme: Text = ""    # another    -> readme.md
    icon: Binary = b""   # bytes      -> icon.bin
```

```python
op = Op(name="pick-port", setup="Run `lsof -i` and pick a free one.")
op.setup                 # 'Run `lsof -i` and pick a free one.' — a plain string
op.setup.upper()         # works; a Text IS a str
```

`Text` is a string wherever you use it, and a reader never opens a file to get
it — the only difference is where `save` puts it. Once it has touched disk it
knows where: `op.setup.path` is the file `save` wrote it to, or `load` read it
from (the same `<field>.md` rule both ways); `None` until then. A shape may
carry as many as it likes.

| the field is | it becomes |
| --- | --- |
| `str`, `int`, … | a value in the json |
| `Text` | `<field>.md` |
| `Binary` | `<field>.<ext>` |

A whole nested shape can be a document too, and the same rule decides it: a
shape that carries `Text`, or that subclasses `AssetDocumentSpec`, is a
document and becomes its own file. Everything else is a value and rides inside
its parent's json.

```python
from flow_sdk.schema.data_spec.markdown_spec import MarkdownSpec

class Op(DataSpec):
    endpoint: Endpoint = Endpoint(port=0)   # a value    -> inside op.json
    notes: MarkdownSpec = MarkdownSpec()    # a document -> notes.md
```

So `markdown` needed no new type: `MarkdownSpec` was already the carrier, and
`DataSpec.parse("markdown")` already resolves to it.

## 6. Identity

A shape has no `id` field, and never does:

```python
from pathlib import Path

from flow_sdk.schema.data_spec import DataSpec
from flow_sdk.schema.data_spec.io import Text

class Op(DataSpec):
    name: str
    setup: Text = ""
```

A spec is **pure content** — what the file says. Identity is a **carrier**
written beside it: the `id:` key of a markdown document's frontmatter, or
`.flow/capsules/identity.json` next to a folder's main document.

```python
op = Op(name="pick-port")
root = Path("pick-port")
op.save(root)
# pick-port/op.json                      {"name": "pick-port"}
# pick-port/.flow/capsules/identity.json {"data": {"id": "e3b0c442-…"}, "version": 1}

Op.load(root) == op                 # True — content is equal
```

`save` mints an id the first time and reuses it afterwards, so a folder keeps
its identity across saves. Two shapes with equal content are equal **values**;
they are not the same **entity**.

An id is a **UUID v4**. A file may already carry one — a hand-authored `id:`, a
clone, an import — and it is adopted only if it validates; anything else is
ignored and a stable id is derived instead. An id is a name, never a fact about
the thing: it encodes no type, no path and no account.

## 7. One value, fields and documents

A shape carries structured fields and whole documents side by side; `spec_kind` names it, so a
document can refer to it by name. Pinned by `tests/unit/test_data_spec_snippets.py`.

```python
from pathlib import Path
from typing import ClassVar

from flow_sdk.schema.data_spec import DataSpec
from flow_sdk.schema.data_spec.io import Text

class Note(DataSpec):
    spec_kind: ClassVar[str] = "notes.note"   # flow.kind
    title: str                                # structured
    body: Text = ""                           # unstructured

note = Note(title="Q3 plan", body="# Goals\n- ship it")
folder = Path("q3-plan")
note.save(folder)                             # note.json + body.md
Note.load(folder) == note                     # True
```

## 8. An agent is a DataSpec

An agent's definition is a shape like any other: validated in memory, a folder on disk, the same
`save` and `load`. Pinned by `tests/unit/test_data_spec_snippets.py`.

```python
from pathlib import Path

from flow_sdk.schema.data_spec.agent_spec import AgentSpec

spec = AgentSpec(model="haiku", system_prompt="You answer Acme's phone. Be brief.")
folder = Path("front-desk")
spec.save(folder)                    # agent.json + system_prompt.md, like any DataSpec
AgentSpec.load(folder) == spec       # True
```
