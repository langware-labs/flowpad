"""A disposable place to run git.

Git cannot safely be run against a repository you do not control. Cloning one is
a documented remote-code-execution surface: a submodule plus a case-collision
writes a hook into ``.git/`` that runs *during* the clone (CVE-2024-32002), a
symlink plus a clean/smudge filter executes a checked-out script
(CVE-2021-21300), and an embedded bare repo runs code whenever any git command
later touches it. None of that is exotic — it is what "clone this URL" means.

``GitBox`` is the answer to **where that execution happens**. It is not a new
git implementation and not a wrapper around git commands — :class:`GitFolder`
already owns how git is invoked. GitBox owns *which machine runs it*, and
disposes of that machine's scratch afterwards.

The bargain it offers a caller::

    async with GitBox.open(node=sandbox) as box:
        receipt = await box.capture(origin, token=token)   # bytes, not a path

Everything dangerous — the clone, the checkout, git itself — happens on the
box's node. What crosses back is a zip built by ``git archive`` from the object
database, which cannot carry ``.git/``, hooks, or a symlink's target content.
So the host receives bytes it never has to trust.

Two things it deliberately does NOT do:

* **It is not durable.** The checkout is a cache; the origin and the stored
  artifact are the truth. Nothing should read a GitBox path after the box closes.
* **It does not choose the node.** A caller that passes nothing gets ``@local``,
  which is honest — that is what the desktop publish path wants, and it means
  "runs on this machine" is stated rather than defaulted into silently.
"""

from __future__ import annotations

import posixpath
from contextlib import asynccontextmanager
from typing import TYPE_CHECKING, AsyncIterator

from flow_sdk.utils.git_folder import CaptureReceipt, GitFolder

if TYPE_CHECKING:
    from flow_sdk.assets.git_origin import PortableGitOrigin
    from flow_sdk.builtin.faas.compute_node import ComputeNode

#: Where scratch checkouts live on the node. Absolute on purpose: a compute node
#: ignores the per-node working directory and resolves relative paths against
#: its own home, so anything relative would land somewhere the caller did not
#: name — and then be deleted from there.
_FALLBACK_TEMP = "/tmp"
_SCRATCH_DIR = "flowpad-gitbox"


class GitBox:
    """One repository's worth of git work, on one node, for one operation."""

    def __init__(self, node: "ComputeNode", root: str) -> None:
        self.node = node
        self.root = root

    @classmethod
    @asynccontextmanager
    async def open(
        cls,
        origin: "PortableGitOrigin",
        *,
        node: "ComputeNode | None" = None,
    ) -> AsyncIterator["GitBox"]:
        """A box for ``origin``, cleaned up on the way out.

        ``node=None`` means ``@local`` — git runs on this machine. That is
        correct for publishing, where the repository IS the user's own working
        copy, and it is the exposure a sandbox node closes for materialization,
        where the repository is someone else's.

        The scratch is removed on exit whether or not the body raised: a failed
        clone leaves a partial checkout, and the next attempt must not adopt it.
        """
        from flow_sdk.builtin.faas.compute_node import ComputeNode  # noqa: PLC0415

        node = node or await ComputeNode.get_local()
        box = cls(node, cls._scratch_root(node, origin))
        try:
            yield box
        finally:
            await box.close()

    @staticmethod
    def _scratch_root(node: "ComputeNode", origin: "PortableGitOrigin") -> str:
        """An absolute, per-origin scratch path on ``node``.

        Keyed on ``origin.key()`` — the canonical repo+path identity — so two
        assets from one repository do not fight over a single
        ``sparse-checkout`` config, and so a retry reuses the clone it already
        paid for.

        ``get_temp_folder`` exists only on the local provider; a sandbox has no
        such concept and answers with its own POSIX ``/tmp``. Asking and falling
        back keeps this working on both rather than assuming either.
        """
        provider = node.compute_provider
        base = getattr(provider, "get_temp_folder", None)
        temp = base() if callable(base) else _FALLBACK_TEMP
        return posixpath.join(str(temp).replace("\\", "/"), _SCRATCH_DIR, str(origin.key()))

    def folder(
        self,
        origin: "PortableGitOrigin",
        *,
        token: str | None = None,
        branch: str | None = None,
    ) -> GitFolder:
        """This box's checkout, as a :class:`GitFolder` bound to its node.

        The single place an executor enters a git operation, which is what makes
        "where does this run" answerable from the call site instead of a
        default buried three layers down.
        """
        return GitFolder(
            self.root,
            executor=self.node.get_command_executor(),
            remote_url=origin.clone_url(),
            branch=branch or origin.branch,
            token=token,
        )

    async def capture(
        self,
        origin: "PortableGitOrigin",
        *,
        rel_path: str | None = None,
        token: str | None = None,
        branch: str | None = None,
    ) -> CaptureReceipt:
        """Fetch ``origin``'s subtree on this box and return inert bytes.

        Defaults to the origin's own ``rel_path``, because that is what the
        origin is *for* — it already records which subtree of the repository the
        asset occupies, and restating it at the call site is how the two drift.
        """
        folder = self.folder(origin, token=token, branch=branch)
        async with folder.lock():
            return await folder.capture(rel_path or origin.rel_path or "", branch=branch)

    async def close(self) -> None:
        """Discard the scratch checkout.

        Best-effort by design: the box is a cache, and a node that has already
        gone away (a sandbox torn down under us) has by definition no scratch
        left to clean. Failing here would turn successful work into an error
        after the bytes are safely home.
        """
        try:
            await self.node.get_command_executor().remove(self.root)
        except Exception:  # noqa: BLE001 - see docstring
            pass
