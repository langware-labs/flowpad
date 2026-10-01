"""The leftover-secrets sweep: after a delete, is any secret still stored anywhere? Names only.

Given what was deleted — a project id, an agent id, deployment ids, variable names — every place a
value can live is read for a trace of it:

* the vault: every ``credential.`` entry under the project (any environment); with no project, the
  user scope's entries for a named variable;
* every ``.env*`` file in the project folder (with no project, the user home) and any extra root: a
  named variable;
* each store a data source binds that is not local (e.g. GCP Secret Manager): a named variable;
* the hub's own secret store, through its ``leftovers`` script in a local hub checkout: any key of
  the agent, project or deployments;
* e2b sandboxes labelled with the agent (``source``) -- running AND paused (a paused one is a whole machine
  kept, its disk included) -- read with ``E2B_API_KEY``.

A store that cannot be read is reported ``unchecked`` — never counted as clean. No value is ever
read into the result, printed or logged.

The local legs (:func:`sweep_local`) run wherever the app's data is — the backend's ``audit`` route.
The two outside legs (:func:`sweep_outside`) run only in the caller's own process (``flow
credentials audit``): a backend never runs a program in a folder a request names.
"""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from typing import Iterable, Optional

from flow_sdk.schema.data_spec.credential_contract import SCOPE_PROJECT, SCOPE_USER, VAULT_PREFIX
from flow_sdk.schema.data_spec.credential_status_spec import LeftoverSpec, SweepSpec, UncheckedSpec

E2B_API = "https://api.e2b.app"
#: How the hub leg runs, from the hub checkout: its own config, its own store.
HUB_LEFTOVERS = ["uv", "run", "python", "-m", "flowpad.hub.external_apis.sod.leftovers"]
#: All the hub leg inherits: the hub reads its own ``.env``, and anything of ours (``DEPLOY_ENV``,
#: ``SOD_ENC_KEY``, this app's ``.env.local``) would point it at a foreign config or key.
_HUB_ENV_KEEP = ("PATH", "HOME", "USER", "LANG", "TMPDIR")


class _Sweep:
    def __init__(self) -> None:
        self.found: list[LeftoverSpec] = []
        self.unchecked: list[UncheckedSpec] = []
        self.checked: list[str] = []

    def unreadable(self, store: str, where: str, error: str) -> None:
        self.unchecked.append(UncheckedSpec(store=store, where=where, error=error))

    def result(self) -> SweepSpec:
        return SweepSpec(
            clean=not self.found and not self.unchecked, found=self.found, unchecked=self.unchecked, checked=self.checked
        )


def _error(e: BaseException) -> str:
    return f"{type(e).__name__}: {e}"


def merge(*results: SweepSpec) -> SweepSpec:
    """One answer from several sweeps."""
    out = _Sweep()
    for result in results:
        out.found += result.found
        out.unchecked += result.unchecked
        out.checked += result.checked
    return out.result()


async def sweep_local(
    *, project_id: str = "", names: Iterable[str] = (), roots: Iterable[str | Path] = ()
) -> SweepSpec:
    """This instance's stores: the vault, ``.env*`` files, and the remote stores data sources bind."""
    names = sorted(set(names))
    out = _Sweep()
    await asyncio.gather(_vault(out, project_id, names), _env_files(out, project_id, names, roots), _bound_stores(out, names))
    return out.result()


async def sweep_outside(
    *, ids: Iterable[str] = (), agent_id: str = "", hub_root: Optional[str | Path] = None, e2b: bool = False
) -> SweepSpec:
    """The hub's own store (through a local hub checkout) and live e2b sandboxes."""
    ids = [i for i in ids if i]
    out = _Sweep()
    legs = []
    if hub_root and ids:
        legs.append(_hub(out, Path(hub_root), ids))
    if e2b and agent_id:
        legs.append(_e2b(out, agent_id))
    await asyncio.gather(*legs)
    return out.result()


async def sweep(
    *,
    project_id: str = "",
    agent_id: str = "",
    deployment_ids: Iterable[str] = (),
    names: Iterable[str] = (),
    roots: Iterable[str | Path] = (),
    hub_root: Optional[str | Path] = None,
    e2b: bool = False,
) -> SweepSpec:
    """Every leg, in this process."""
    ids = [project_id, agent_id, *deployment_ids]
    return merge(*await asyncio.gather(
        sweep_local(project_id=project_id, names=names, roots=roots),
        sweep_outside(ids=ids, agent_id=agent_id, hub_root=hub_root, e2b=e2b),
    ))


async def _vault(out: _Sweep, project_id: str, names: list[str]) -> None:
    from flow_sdk.secrets import SecretStore  # noqa: PLC0415

    out.checked.append("vault")
    store = await SecretStore.get("vault", {"prefix": VAULT_PREFIX})
    try:
        entries = await store.names()
    except Exception as e:  # noqa: BLE001
        out.unreadable("vault", "this instance", _error(e))
        return
    # ``[<env>.]project.<pid>.<VAR>`` / ``[<env>.]user.<VAR>`` under the prefix, in any environment.
    scope = f".{SCOPE_PROJECT}.{project_id}." if project_id else f".{SCOPE_USER}."
    for entry in entries:
        if scope in f".{entry}" and (project_id or any(entry.endswith(f".{n}") for n in names)):
            out.found.append(LeftoverSpec(store="vault", where="this instance", name=f"{VAULT_PREFIX}{entry}"))


async def _env_files(out: _Sweep, project_id: str, names: list[str], roots: Iterable[str | Path]) -> None:
    from flow_sdk.builtin.credential_store import project_scope, user_scope  # noqa: PLC0415
    from flow_sdk.builtin.env_local_store import list_env_file  # noqa: PLC0415

    if not names:
        return
    places = [Path(r) for r in roots]
    if project_id:
        from flow_sdk.builtin.project import Project  # noqa: PLC0415

        project = await Project.get_by_id(project_id)
        scope = project_scope(project) if project is not None else None
    else:
        scope = user_scope()
    if scope is not None and scope.root is not None:
        places.append(scope.root)
    out.checked.append("env_file")
    files = [path for place in dict.fromkeys(p for p in places if p.is_dir()) for path in sorted(place.glob(".env*"))]
    # The project's declared env files sit anywhere inside it, not only beside .env.local.
    files += [path for path, declared in (scope.env_files() if scope is not None else []) if declared and path]
    for path in dict.fromkeys(files):
        if not path.is_file():
            continue
        for row in await asyncio.to_thread(list_env_file, path):
            if row["key"] in names:
                out.found.append(LeftoverSpec(store="env_file", where=str(path), name=row["key"]))


async def _bound_stores(out: _Sweep, names: list[str]) -> None:
    """Every non-local store a data source binds (a remote store outlives the machine)."""
    from flow_sdk.builtin.data_source import DataSource  # noqa: PLC0415
    from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter, QueryOp  # noqa: PLC0415
    from flow_sdk.secrets import SecretStore  # noqa: PLC0415

    if not names:
        return
    refs = {}
    bound = QueryFilter(match=ExpressionNode(op=QueryOp.IS_NOT_NULL, operands=["secret_store"]))
    for row in await DataSource.get_all(bound):
        ref = row.secret_store
        if ref is not None and ref.type not in ("env_file", "vault"):
            refs.setdefault(ref.key, ref)
    for ref in refs.values():
        store = SecretStore.from_ref(ref)
        out.checked.append(ref.type)
        try:
            held = set(await store.names())
        except Exception as e:  # noqa: BLE001
            out.unreadable(ref.type, store.where, _error(e))
            continue
        out.found += [LeftoverSpec(store=ref.type, where=store.where, name=n) for n in names if n in held]


async def _hub(out: _Sweep, hub_root: Path, ids: list[str]) -> None:
    out.checked.append("hub")
    env = {k: os.environ[k] for k in _HUB_ENV_KEEP if k in os.environ}
    try:
        proc = await asyncio.create_subprocess_exec(
            *HUB_LEFTOVERS, *ids, cwd=hub_root, env=env,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await proc.communicate()
    except Exception as e:  # noqa: BLE001
        out.unreadable("hub", str(hub_root), _error(e))
        return
    try:
        answer = json.loads(stdout.decode().strip().splitlines()[-1])
    except (IndexError, ValueError):
        # Names only reach stderr (a traceback has no values): its tail says why.
        out.unreadable("hub", str(hub_root), stderr.decode(errors="replace").strip()[-300:] or f"exit {proc.returncode}")
        return
    if "error" in answer:
        out.unreadable("hub", str(hub_root), answer["error"])
        return
    out.found += [LeftoverSpec(store="hub", where=str(hub_root), name=n) for n in answer.get("found", [])]


async def _e2b(out: _Sweep, agent_id: str) -> None:
    import httpx  # noqa: PLC0415

    out.checked.append("e2b")
    key = os.environ.get("E2B_API_KEY", "")
    if not key:
        out.unreadable("e2b", E2B_API, "E2B_API_KEY is not set")
        return
    source = f"agent-{agent_id}"
    boxes: list[dict] = []
    try:
        async with httpx.AsyncClient(base_url=E2B_API, headers={"X-API-KEY": key}) as client:
            params: list[tuple[str, str]] = [("state", "running,paused"), ("limit", "100")]
            while True:
                response = await client.get("/v2/sandboxes", params=params)
                response.raise_for_status()
                boxes += response.json()
                token = response.headers.get("x-next-token")
                if not token:
                    break
                params = [*params[:2], ("nextToken", token)]
    except Exception as e:  # noqa: BLE001 — the key is in a header, never in the message
        out.unreadable("e2b", E2B_API, type(e).__name__)
        return
    for box in boxes:
        if (box.get("metadata") or {}).get("source") == source:
            state = str(box.get("state") or "")
            name = str(box.get("sandboxID") or "")
            out.found.append(LeftoverSpec(store="e2b", where=E2B_API, name=f"{name} ({state})" if state else name))
