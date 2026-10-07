---
id: 9b0f3c55-6a2e-4c1d-9f57-2d8e4a7b61c3
---

# Project dependencies — snippets

A project's `flow.json` names the folders it expects in its context. Each one is just a
folder: a git repository (your existing checkout is reused, otherwise it is cloned), a hub
project, or a plain local folder. `dependencies` must be there; `optionalDependencies` may
be. A resolved dependency is in every session's context and in the project's index, so its
agents, skills and docs show up in this project — while they still live, and are edited, in
their own folder.

Every python fence runs, in order, as one session in
`tests/unit/test_project_dependencies_snippets.py` (the worker is the mock worker there);
the TypeScript fence in `ui/tests/unit/project-dependencies-snippet.test.ts`. The corners —
git reuse and clones, hub failures, cycles, the transitive rules — are pinned by
`tests/unit/test_project_dependencies.py`.

## 1. Declare

```json
{
  "dependencies": {
    "langware-os": "git+https://github.com/langware-labs/langware-os#main",
    "legal-docs":  { "source": "git+https://github.com/acme/handbook#main", "path": "legal" }
  },
  "optionalDependencies": {
    "policies": "hub:8c1f0b2e-…",
    "notes": "file:~/notes"
  },
  "autolaunchJourney": "engagement-setup",
  "alwaysUseSkills": ["triage-ticket"]
}
```

| Source | Means | Resolves to |
| --- | --- | --- |
| `git+<url>#<branch>` | a git repository | your checkout of it if one exists, else a clone in the workspace |
| `hub:<project id>` | a hub project | its files, fetched with your hub login |
| `file:<path>` | a folder with no git | that folder, on this machine only |

`{"source": …, "path": …}` uses one folder inside the source. The same file also holds the
project's `autolaunchJourney` and `alwaysUseSkills`.

## 2. Two projects, one depends on the other

`policies` holds a document and an agent; `site` is where the work happens.

```python
import json
import tempfile
import uuid
from pathlib import Path

from flow_sdk.builtin.project import Project

tag = uuid.uuid4().hex[:8]
root = Path(tempfile.mkdtemp(prefix="deps-")).resolve()

b_root = root / f"policies-{tag}"
(b_root / "docs").mkdir(parents=True)
(b_root / "docs" / "guide.md").write_text(f"# Policy guide\n\nThe code word is lantern-{tag}.\n")
agent_dir = b_root / "agentic-assets" / "agent" / f"policy-helper-{tag}"
agent_dir.mkdir(parents=True)
(agent_dir / "agent.json").write_text(json.dumps({"name": f"policy-helper-{tag}", "worker_type": "claude"}))
(agent_dir / "system_prompt.md").write_text("Answer from docs/guide.md.\n")
policies = Project(name=f"policies-{tag}", fs_storage_mount_path=str(b_root))
await policies.save()

a_root = root / f"site-{tag}"
a_root.mkdir()
site = Project(name=f"site-{tag}", fs_storage_mount_path=str(a_root))
await site.save()

dep = await site.add_dependency(str(b_root))
dep.name, dep.source, dep.state          # (f"policies-{tag}", f"file:{b_root}", "ready")
```

`add_dependency` takes a folder, a git URL, or a source string. A folder inside a git
repository is written as its repository (`git+<url>#<branch>`, plus `path` when it is a
folder inside it) — never as its path — so the line means the same thing on a teammate's
machine, and the checkout you added it from is the one used here. `optional=True` writes it
under `optionalDependencies`; `remove_dependency(name)` drops the line and never touches the
folder.

```python
assert json.loads((a_root / "flow.json").read_text()) == {"dependencies": {f"policies-{tag}": f"file:{b_root}"}}
assert str(b_root) in site.include_dirs
```

## 3. What resolved

```python
for d in await site.dependencies():          # no network: a status read
    print(d.name, d.required, d.state, d.local_path)

states = await site.resolve_dependencies()   # fetch what is missing, link it, index it
```

| `state` | Meaning |
| --- | --- |
| `ready` | in context and indexed |
| `missing` | not on this machine (a `file:` folder that is not there, or not fetched yet) |
| `unreachable` | a clone or a hub fetch failed — `reason` says why |
| `not_installed` | optional, not installed |
| `invalid` | the declaration is wrong (`reason` says how), or a dependency's `file:` source, which is never followed |

A required dependency that is not `ready` is a warning when the project opens (`await
site.dependency_warnings()`), counted by the project's setup readiness, and fetched by its
setup wizard. `site.dismiss_dependency_warning(name)` silences it until Flowpad restarts.
`site.install_dependency(name)` brings in an optional one.

## 4. A process in one project opens a document from the other

The process belongs to `site` — `project_id` is the binding, and its working directory
follows from it. It is not told where the document is: the dependency is in its context.

```python
from flow_sdk.builtin.agentic_process import AgenticProcess

result = await AgenticProcess.run(
    "One of your context folders has a file named guide.md. "
    "Show it to me with `flow show file <its absolute path>`, "
    "then reply with only the code word written in it.",
    project_id=site.id,
)
proc = await AgenticProcess.get_by_typeid(result.executor)
await proc.get_project()                       # re-derive its context, as launch does

assert proc.project_id == site.id              # the process belongs to site
assert Path(proc.workdir) == a_root            # and runs in site's folder
assert str(b_root) in proc.resolved_add_dirs   # policies is in its context
assert result.ok and f"lantern-{tag}" in result.text
```

How a process gets its project: an explicit `project_id` first, then the project it was
created under, then the project whose folder holds its `workdir`. So a process started with
`workdir` inside a dependency and no `project_id` belongs to the DEPENDENCY's project, not
yours — pass `project_id` to run in your project's context.

## 5. An agent from a dependency runs in your project

```python
from flow_sdk.builtin.agent import Agent

helper = await Agent.get_one({"name": f"policy-helper-{tag}"})
session = await helper.use(project_id=site.id)   # acts in site's checkout

assert await helper.home() == str(b_root)        # its own files
assert Path(session.workdir) == a_root
assert str(b_root) in session.additional_dirs
assert f"Your own files are in {b_root}" in session.context_data["instructions"]
```

The agent shows on `site`'s home (its tiles list every agent under the project's
`context_roots`), and its prompt's relative paths still mean its own folder.

## 6. Sharing

```python
site.share_warnings()     # [] — every member can resolve this project's dependencies?
```

A required `file:` dependency is a folder on this machine only, so `share()` adds one
warning per such dependency to `last_share_result.warnings`; git and hub sources resolve on
every member's machine.

## 7. The same verbs elsewhere

| | Python `Project` | TypeScript `Project` | HTTP `/api/v1/graph/project/<id>/…` | CLI |
| --- | --- | --- | --- | --- |
| list | `dependencies()` | `dependencies()` | `GET dependencies` | `flow dep list` |
| add | `add_dependency(src, name=, path=, optional=)` | `addDependency(src, {name, path, optional})` | `POST add-dependency` | `flow dep add <folder\|url\|source>` |
| remove | `remove_dependency(name)` | `removeDependency(name)` | `POST remove-dependency` | `flow dep remove <name>` |
| fetch | `resolve_dependencies(update=)` | `resolveDependencies({update})` | `POST resolve-dependencies` | `flow dep sync [--update]` |
| install | `install_dependency(name)` | `installDependency(name)` | `POST install-dependency` | `flow dep install <name>` |
| dismiss | `dismiss_dependency_warning(name)` | `dismissDependencyWarning(name)` | `POST dismiss-dependency-warning` | — |
| is it here | — | — | — | `flow dep check <name>` (exit 0 / NOT_YET) |

```ts
import { Project } from '@sdk/entities/project';

const project = await Project.getById<Project>(projectId);
const { dependencies, warnings } = await project.dependencies();
const added = await project.addDependency('git+https://github.com/langware-labs/langware-os#main');
await project.installDependency('policies');
for (const w of warnings) await project.dismissDependencyWarning(w.name);
```
