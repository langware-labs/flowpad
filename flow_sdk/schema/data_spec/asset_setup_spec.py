"""``asset_setup.json`` — one node of the setup tree, and the tree's answer.

A project comes up leaf first. Every asset that needs something done before it works (a credential's
values, a source's provider session, a web app's dev server, a container a source talks to) is a NODE;
the project is the root. Per node, in this order::

    prepare   — its wizard, on the way DOWN: decide, ask early, prove the node can run at all
    children  — each child node, depth first, one at a time
    run       — its wizard, on the way UP: only once every child is set up

A node whose child failed does not run: it is ``blocked``, and says which child. Its siblings still run,
so one broken leaf never hides the state of the others.

Two shapes live here:

* ``AssetSetupSpec`` — the DECLARED node, an asset document (``agentic-assets/asset_setup/<name>/``).
  Most nodes are derived (a project's credentials, its sources); a declaration adds children or wizards a
  derivation cannot know — a WAHA source's container, say.
* ``SetupNodeResult`` / ``SetupTreeResult`` — the run's answer, the same tree, each node with its state
  and its two wizards' own ``WizardResult``. Recorded as the run goes, so a screen that missed a push
  reads the whole picture.
"""

from __future__ import annotations

from typing import ClassVar, Optional

from pydantic import ConfigDict

from flow_sdk._compat import StrEnum
from flow_sdk.schema.data_spec.frontmatter import AssetDocumentSpec
from flow_sdk.schema.data_spec.returned_value_spec import WizardResult
from flow_sdk.schema.data_spec.spec import DataSpec


class AssetSetupSpec(AssetDocumentSpec):
    """``asset_setup.json``: what one asset needs set up, and what must be set up first."""

    spec_kind: ClassVar[str] = "asset.setup"
    main_file: ClassVar[str | None] = "asset_setup.json"
    #: An entity document: it carries its own id in its root, the way ``compute_op.json`` does.
    manifest_layout: ClassVar[str | None] = "entity"

    model_config = ConfigDict(extra="ignore")

    #: The node's name AND its folder name.
    name: str = ""
    label: str = ""
    #: The asset this node sets up (a typeid). Empty: the asset whose folder holds this one.
    subject: str = ""
    #: Children beyond the derived ones — typeids, or the names of other ``asset_setup`` nodes.
    children: list[str] = []
    #: The wizard run on the way down, before any child. Empty: none.
    prepare: str = ""
    #: The wizard run on the way up, once every child is set up. Empty: the node is its children.
    run: str = ""
    #: Values this node puts in scope for its own wizards and every node below it (a container's name,
    #: the image it runs, its port) — ``FLOWPAD_WIZARD_INPUT_<NAME>`` to a command.
    inputs: dict[str, str] = {}


class SetupSkipSpec(DataSpec):
    """A person skipped this requirement of a project's setup ON THIS MACHINE (``setup_skipped`` on its record,
    never shared): it is listed under "Skipped", stops counting toward "Setup required", and its setup-tree
    node settles SKIPPED. Undone by un-skipping. Skipping "always" is not a mark: it removes the asset."""

    spec_kind: ClassVar[str] = "setup.skip"
    model_config = ConfigDict(frozen=True)

    #: When (epoch seconds) and by whom (a user id; empty when unknown).
    at: float
    by: str = ""
    note: str = ""


class SetupState(StrEnum):
    #: Not reached yet.
    PENDING = "pending"
    RUNNING = "running"
    #: Its wizards reached their goals and every child is done.
    DONE = "done"
    #: Its own wizard did not reach its goal — or, checking only, the goal does not hold yet.
    FAILED = "failed"
    #: A child failed, so its ``run`` was not attempted.
    BLOCKED = "blocked"
    #: Something refused to run (an untrusted callee, a cycle in the tree). The walk stopped.
    REFUSED = "refused"
    #: Another setup of the same root holds the slot. Nothing ran.
    HELD = "held"
    #: A person skipped it (``setup_skipped`` on its record): settled without running, so its parent goes on.
    SKIPPED = "skipped"


class SetupNodeResult(DataSpec):
    """One node as the run left it."""

    spec_kind: ClassVar[str] = "setup.node"

    id: str
    label: str = ""
    #: How deep it sits under the root (root = 0) — the indent a screen draws.
    level: int = 0
    state: SetupState = SetupState.PENDING
    detail: str = ""
    prepare: Optional[WizardResult] = None
    run: Optional[WizardResult] = None
    children: list["SetupNodeResult"] = []
    #: Reached already under another parent this run: its verdict is reused, its subtree is shown there.
    shared: bool = False

    @property
    def ok(self) -> bool:
        return self.state is SetupState.DONE

    def trimmed(self) -> "SetupNodeResult":
        """This node with each wizard's output kept to its tail (``WizardResult.trimmed``) — for the record."""
        return self.model_copy(update={
            "prepare": self.prepare.trimmed() if self.prepare is not None else None,
            "run": self.run.trimmed() if self.run is not None else None,
            "children": [child.trimmed() for child in self.children],
        })


class SetupTreeResult(DataSpec):
    """The whole setup's answer: the root node, and the run's own verdict."""

    spec_kind: ClassVar[str] = "setup.tree"

    state: SetupState = SetupState.PENDING
    detail: str = ""
    root: Optional[SetupNodeResult] = None
    #: Nodes in the tree, and how many reached ``done`` — the run's progress in one line.
    total: int = 0
    done: int = 0
    #: Whether anything actually ran (a resumed setup that found everything in place did not).
    ran: bool = False

    @property
    def ok(self) -> bool:
        return self.state is SetupState.DONE

    def trimmed(self) -> "SetupTreeResult":
        return self.model_copy(update={"root": self.root.trimmed() if self.root is not None else None})


SetupNodeResult.model_rebuild()
