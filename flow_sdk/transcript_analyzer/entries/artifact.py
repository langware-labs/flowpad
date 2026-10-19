"""``ArtifactEntry`` — the agent registering a deliverable, as a semantic entry.

A **derived** entry, one level above :class:`FlowCommandEntry`: the physical
line is a shell command, the first refinement recognises it as a ``flow`` CLI
call, and this one recognises *which* call it was. Same shape as
:class:`SkillCallEntry`, which refines a ``Skill`` tool-use into "an agent
invoked a skill".

Deriving rather than synthesizing is what makes reload work for free. The
alternative — having the server emit a frame when registration resolves — would
put the artifact in the LIVE stream only, because the frame would exist nowhere
in the vendor transcript a reload replays from. ``derive_entries`` runs on every
refold (`transcript.py`), worker-agnostically, so an artifact chip rebuilt from
the same JSONL is the same chip.

What this entry deliberately does NOT carry is the artifact's minted id. That
identity is created server-side after the command ran and is not in the
transcript; the CLI does print it on stdout, but reconstructing ids by parsing
stdout is exactly the fragility this design avoids. The entry carries the
ADDRESS the agent used — which is what a chip needs to open the thing — and the
artifacts list (``proc.artifacts``) carries the identities. Same division as
``SkillCallEntry``, which carries a skill *name* and resolves the entity at
click time.
"""

from __future__ import annotations

from ..entry import EntryKind
from .flow_command import FlowCommandEntry


class ArtifactEntry(FlowCommandEntry):
    kind = EntryKind.ARTIFACT
