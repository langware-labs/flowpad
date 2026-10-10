"""A setup node as the walk sees it, and the seam that finds one.

The walk knows nothing about projects, credentials or web apps: it asks ``resolve_node(id)`` for a node
and gets back its wizards and its children's ids. What a node IS — derived from an entity, declared
in an ``asset_setup`` asset, compiled in memory — is the resolver's business (``derive.py``).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Awaitable, Callable, Optional

from flow_sdk.schema.data_spec.returned_value_spec import WizardResult
from flow_sdk.schema.data_spec.wizard_spec import WizardSpec


@dataclass(frozen=True)
class SetupNode:
    """One asset to set up: what runs before its children, what runs after, and who the children are."""

    id: str
    label: str = ""
    #: Run on the way down, before any child. Its outputs are in scope for every child below it.
    prepare: Optional[WizardSpec] = None
    #: Run on the way up, once every child is done.
    run: Optional[WizardSpec] = None
    #: Run when the asset is LOADED for display here (``core/setup/load``), not by the setup walk. Its check
    #: is what "ready" means for a load; it never asks.
    on_load: Optional[WizardSpec] = None
    #: Child node ids, in the order they are set up.
    children: tuple[str, ...] = ()
    #: Whether this node's wizards may run here without a person's approval (shipped, or derived by us).
    trusted: bool = True
    #: The values this node puts in scope for its own wizards and every node below it (its id, its owner…).
    inputs: tuple[tuple[str, str], ...] = ()
    #: Told what ``run`` answered once it settles — where a node keeps a record of its own (a source's setup
    #: stage writes its wizard's run for the source, which the stage list reads). Best effort.
    record: Optional[Callable[[WizardResult], Awaitable[None]]] = None
    #: Why this node cannot be set up at all (it names a wizard that does not exist): it fails with this, and
    #: nothing of it runs. An author's mistake reported where it is, never a node that quietly counts as done.
    problem: str = ""
    #: Why a person skipped it (its record's ``setup_skipped``): it settles SKIPPED, nothing of it runs, and its
    #: parent is not held up by it.
    skipped: str = ""


#: Find a node by id; ``None`` when nothing by that id exists any more.
NodeResolver = Callable[[str], Awaitable[Optional[SetupNode]]]
