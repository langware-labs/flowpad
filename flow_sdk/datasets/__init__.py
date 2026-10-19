"""Typed rows in datasets -- the one import home for a script or a service that keeps data in Flowpad.

    from flow_sdk.datasets import Dataset, load_root, single_run, three_way, kind_form

``Dataset`` is the folder that keeps the rows of one kind (``flow_sdk.builtin.dataset``);
``load_root`` registers a project's schemas in a process that is not the server; ``single_run`` gives
a script the whole run to itself; ``three_way`` decides a field kept in step with an outside copy;
``kind_form`` is a kind's fields, owners and rules. Names resolve on first use, so importing this
package stays as light as the modules beside it (links, query, rules, score).
"""

from __future__ import annotations

from typing import Any

_HOME = {
    "Dataset": "flow_sdk.builtin.dataset", "ConflictError": "flow_sdk.builtin.dataset",
    "LinkError": "flow_sdk.builtin.dataset", "RowRefused": "flow_sdk.builtin.dataset",
    "load_root": "flow_sdk.schema.data_spec.declared", "kind_in": "flow_sdk.schema.data_spec.declared",
    "kind_form": "flow_sdk.schema.data_spec.kind_form",
    "single_run": "flow_sdk.datasets.run", "RunBusy": "flow_sdk.datasets.run",
    "three_way": "flow_sdk.datasets.merge",
}


def __getattr__(name: str) -> Any:
    home = _HOME.get(name)
    if home is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    import importlib  # noqa: PLC0415

    return getattr(importlib.import_module(home), name)


__all__ = sorted(_HOME)
