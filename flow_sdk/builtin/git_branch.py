"""GitBranch entity — an immutable point-in-time "git location" snapshot.

The share artifact half of the git identity split: branch name + head
commit taken at share time, parented (``parent_type_id``) to the
deterministic ``GitRemote`` registry row. Identity stays the default uuid4 —
two shares of the same repo at different times are genuinely two things.

provider/owner/name ride as PLAIN FIELDS so the snapshot is self-sufficient
on the wire: a receiver re-mints its local GitRemote from them
(``materialize_share_parent``) even when no parent reference arrived. The
TypeMetadata sets ``parent_share_on_default=True`` so sharing a GitBranch
also advertises its parent typeid on the share rail.
"""

import logging
from typing import Optional

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity
from flow_sdk.schema.types import EntityType

logger = logging.getLogger(__name__)


class GitBranch(Entity):
    type: str = APIField(default=EntityType.GIT_BRANCH.value)

    # The shared "location" — point-in-time snapshot.
    branch: str = APIField(default="")
    head_commit: Optional[str] = APIField(default=None)
    taken_at: Optional[str] = APIField(default=None)

    # Repo coordinates as plain fields — the fallback source of truth for
    # re-minting the GitRemote parent on the receiving side.
    provider: str = APIField(default="github")
    owner: str = APIField(default="")
    name: str = APIField(default="")

    @property
    def display_name(self) -> str:
        full = f"{self.owner}/{self.name}" if self.owner and self.name else (self.name or "")
        return f"{full} · {self.branch}" if full and self.branch else (full or self.branch or "")

    @classmethod
    async def materialize_share_parent(cls, payload: dict, someone_typeid=None) -> str | None:
        """Ensure the deterministic GitRemote parent exists locally and return
        its typeid. Reads the plain provider/owner/name fields — works even
        when the bundle carried no parent blob (it never does; GitRemote rows
        are local-only). A payload ``parent_type_id`` that disagrees with the
        deterministic mint is logged and overridden, never trusted.
        """
        from flow_sdk.builtin.git_remote import GitRemote  # noqa: PLC0415

        provider = str(payload.get("provider") or "").strip()
        owner = str(payload.get("owner") or "").strip()
        name = str(payload.get("name") or "").strip()
        if not (provider and owner and name):
            return None
        remote = await GitRemote.ensure(provider, owner, name)
        pid = str(remote.typeid)
        claimed = payload.get("parent_type_id")
        if claimed and claimed != pid:
            logger.warning(
                "[git_branch] payload parent_type_id %s disagrees with deterministic mint %s — using mint",
                claimed, pid,
            )
        return pid
