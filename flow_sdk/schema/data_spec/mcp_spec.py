"""``McpSpec`` — one MCP server, in the ONE shape every harness projects from.

This is deliberately **not** the ``MCP_SERVER`` entity. That row records a
*definition site* (``source_file`` / ``json_path`` / ``format`` / ``scope``) —
the handle a control phase would need to edit a vendor's own config file, and
meaningless to a worker. ``McpSpec`` carries only what a worker needs in order
to launch or dial the server, so it can be attached to a process and rendered
into whichever channel that process's harness accepts.

Attaching takes a SPEC, never a definition site: nothing here ever writes into
Claude's or Codex's config files, and the indexer stays read-only.

``extra="forbid"`` is inherited from ``DataSpec`` and is the point — a
misspelled key must fail loudly rather than boot a worker that silently lacks
its tools. The corollary is that ``from_record`` PROJECTS field by field: a
real-world config entry may carry ``timeout`` / ``disabled`` / ``alwaysAllow``,
and this type is FlowPad's normalized subset, not a passthrough.

Stdlib + pydantic only, like the rest of ``data_spec`` — ``spec.py`` must stay
importable from ``flow_sdk/builtin/*`` with no cycle.
"""

from __future__ import annotations

from typing import Annotated, Any, ClassVar

from pydantic import StringConstraints

from flow_sdk.schema.data_spec.spec import DataSpec

#: A server's name is its key in every vendor's config dict — a blank one would
#: collapse two servers onto one entry, so blankness is refused by the type.
NonBlank = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]

#: ``stdio`` launches ``command``+``args``; ``http``/``sse`` dial ``url``.
STDIO = "stdio"
REMOTE_TRANSPORTS = ("http", "sse")


class McpSpec(DataSpec):
    """The launch payload for one MCP server. Frozen: it is a value."""

    spec_kind: ClassVar[str] = "mcp.server"

    name: NonBlank
    transport: str = STDIO
    command: str = ""
    args: list[str] = []
    env: dict[str, str] = {}
    url: str = ""
    #: A server whose CODE ships inside this asset — a path RELATIVE to the asset
    #: folder (``server.py``). Relative is the whole point: the folder travels
    #: with its agent over git, so an absolute path would be wrong on arrival.
    #: ``Mcp.to_spec`` is what resolves it, because only the row knows
    #: ``asset_ref``. Empty ⇒ this server is a command or a url, not bundled.
    entrypoint: str = ""

    @property
    def is_bundled(self) -> bool:
        """True when the server's code lives in the asset folder."""
        return bool(self.entrypoint)

    @property
    def is_remote(self) -> bool:
        return self.transport in REMOTE_TRANSPORTS or (bool(self.url) and not self.command)

    @classmethod
    def from_record(cls, rec: Any) -> "McpSpec | None":
        """Project an indexed ``MCP_SERVER`` row, or ``None`` if unprojectable.

        Two deliberate choices:

        * **No ``worker_type`` filter.** That field records which config file
          the row was READ from, not which worker may use it — a server defined
          in ``.cursor/mcp.json`` launches perfectly well under Claude. Only
          projectability is checked here.
        * **A claude.ai cloud connector is unprojectable.** Its on-disk form is
          a name in ``claudeAiMcpEverConnected`` with no command and no url (the
          credentials live in the cloud), so there is nothing to hand a worker.
        """
        name = (getattr(rec, "name", "") or "").strip()
        if not name:
            return None
        command = (getattr(rec, "command", "") or "").strip()
        url = (getattr(rec, "url", "") or "").strip()
        if not command and not url:
            return None
        raw_args = getattr(rec, "args", None) or []
        raw_env = getattr(rec, "env", None) or {}
        transport = (getattr(rec, "transport", "") or "").strip()
        if not transport:
            transport = "http" if url and not command else STDIO
        return cls(
            name=name,
            transport=transport,
            command=command,
            args=[str(a) for a in raw_args],
            env={str(k): str(v) for k, v in dict(raw_env).items()},
            url=url,
        )
