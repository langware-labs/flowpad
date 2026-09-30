"""Find a shipped asset row by name when more than one copy of it is indexed.

A shipped wizard or compute op is looked up by NAME (a wizard step names its op, a stage names
its wizard, first-run setup names ``llm-setup``). Normally one row answers. But a developer who
opens the Flowpad repo as a project gets a second copy of every shipped asset — the checkout's
``flow_sdk/system_projects/...`` — and ``Entity.get_one`` refuses a name with two matches, so
"Run setup again" failed with a 500. The running install's copy is the one to use: it is the code
this backend is, and a project can never shadow it.
"""

from __future__ import annotations

from typing import Any, Optional

from flow_sdk.config import is_running_install_path


async def by_name_preferring_this_install(cls: Any, name: str) -> Optional[Any]:
    """The ``cls`` row called *name*; this install's copy when several share the name.

    Raises ``ValueError`` — as ``get_one`` does — only when several match and none of them is
    this install's, because then no copy is more right than another.
    """
    rows = await cls.get_all({"name": name})
    if len(rows) <= 1:
        return rows[0] if rows else None
    ours = [row for row in rows if getattr(row, "asset_ref", "") and is_running_install_path(row.asset_ref)]
    if len(ours) == 1:
        return ours[0]
    where = ", ".join(sorted(str(getattr(row, "asset_ref", "") or row.id) for row in rows))
    raise ValueError(f"{len(rows)} {cls.__name__} rows are named {name!r} and none is this install's: {where}")


__all__ = ["by_name_preferring_this_install"]
