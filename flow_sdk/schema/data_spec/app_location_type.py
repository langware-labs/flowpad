"""Filesystem contracts independent of application entities."""
from flow_sdk._compat import StrEnum


class AppLocationType(StrEnum):
    Folder = "Folder"
    Builtin = "Builtin"
    GCPBucket = "GCPBucket"
    # Built output of an Artifact. ``location_root`` still carries the concrete
    # absolute directory (resolved once, at registration) so serving stays a
    # synchronous path join — resolving a GitOrigin per request would put a
    # checkout lookup in front of every asset fetch.
    Artifact = "Artifact"
    # A webapp REPO ASSET on disk: ``asset_ref`` is the app folder, ``build``
    # names the served subdir inside it. We start the app folder, we serve the
    # build — so the row needs both, and neither is ``location_root``.
    Asset = "Asset"
