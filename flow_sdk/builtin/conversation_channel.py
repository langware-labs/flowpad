"""The channels a conversation can have, and the one lookup from a name to its ``ChannelSpec``.

``flowpad`` is Flowpad's own chat — the app's transport, declared here beside the conversation it
belongs to rather than as a data driver (there is nothing to poll: native messages arrive live
through the hub mirror). Every other channel is a data source's, and its title and glyph come from
that driver's manifest, so provider facts stay in the provider's asset folder.
"""
from __future__ import annotations

from flow_sdk.schema.data_spec.channel_spec import ChannelSpec, ChannelTransport

FLOWPAD = ChannelSpec(
    name="flowpad",
    title="Flowpad",
    icon_name="MessageSquare",
    chip=False,
    home=True,
    transport=ChannelTransport.FLOWPAD,
    accepts_attachments=True,
    needs_cloud_login=True,
    hosts_sessions=True,
)

#: The channel every conversation is born with.
HOME_CHANNEL = FLOWPAD.name

_BUILTIN = {FLOWPAD.name: FLOWPAD}


def channel_spec(name: str | None) -> ChannelSpec:
    """The spec for channel ``name``: a built-in, else a data source channel described by the
    manifest of the driver registered under that name (``DataDriver.loaded`` is a registry
    lookup — safe on a serialization path), else a bare source channel titled from its name."""
    key = (name or "").strip() or HOME_CHANNEL
    builtin = _BUILTIN.get(key)
    if builtin is not None:
        return builtin
    from flow_sdk.builtin.data_driver import DataDriver  # noqa: PLC0415 — builtin must not import drivers at load

    driver = DataDriver.loaded(key)
    return ChannelSpec(
        name=key,
        title=str(getattr(driver, "title", "") or "") or key.replace("_", " ").title(),
        icon_name=str(getattr(driver, "icon_name", "") or ""),
    )


__all__ = ["FLOWPAD", "HOME_CHANNEL", "channel_spec"]
