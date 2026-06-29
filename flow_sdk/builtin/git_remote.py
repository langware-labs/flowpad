"""GitRemote entity — deterministic registry row for one upstream git repo.

Identity object only: provider + owner + name, nothing mutable, nothing
point-in-time (branch/commit snapshots live on ``GitBranch``). The id is
``uuid5(canonical_git_remote_key(...))`` so every instance — and every
machine — mints the SAME row for the same upstream repo.

Field-frozen by convention: the fields are derivable from the id, so two
writers can only ever write identical content. That is what makes the row
safe to reference across share boundaries; rows themselves are minted
locally (``ensure``) and never travel as blobs — receivers re-mint from the
plain provider/owner/name fields carried on a ``GitBranch``.
"""

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity
from flow_sdk.schema.types import EntityType
from flow_sdk.utils.git_identity import mint_git_remote_id


class GitRemote(Entity):
    type: str = APIField(default=EntityType.GIT_REMOTE.value)

    provider: str = APIField(default="github")
    owner: str = APIField(default="")
    name: str = APIField(default="")

    @property
    def full_name(self) -> str:
        return f"{self.owner}/{self.name}" if self.owner and self.name else (self.name or "")

    @property
    def display_name(self) -> str:
        return self.full_name or self.name or ""

    @classmethod
    async def ensure(cls, provider: str, owner: str, name: str) -> "GitRemote":
        """Deterministic get-or-create. Existing row is returned UNTOUCHED
        (field-frozen ⇒ converge, never clobber); otherwise the row is
        constructed with the explicit deterministic id (``Entity.__init__``
        stamps a uuid4 when id is missing, so ``id=`` must be passed here).
        """
        rid = mint_git_remote_id(provider, owner, name)
        existing = await cls.get_one({"id": rid})
        if existing is not None:
            return existing
        remote = cls(id=rid, provider=provider.strip(), owner=owner.strip(), name=name.strip())
        await remote.save()
        return remote
