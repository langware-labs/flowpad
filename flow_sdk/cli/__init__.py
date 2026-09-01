"""Flow CLI package."""

# `cli_main` is exposed lazily. Importing it here instead pulled the whole CLI —
# flow_cli -> journey -> graph_workflow_manager -> capabilities, ~210ms — into
# EVERY importer of anything under `flow_sdk.cli`, including `server/app.py`
# reading two config values and three `instance_settings` modules reading
# `app_config`. The console-script entry point (`flow = "flow_sdk.cli:cli_main"`)
# resolves the attribute at call time, so it is unaffected; only the people who
# never wanted the CLI stop paying for it.
#
# INTERIM, not the fix: the real problem is that `flow_sdk.cli` is also the
# app's config/auth store (`config_manager`, `app_config`, `auth/`), so ~60
# non-CLI runtime sites import through this package and several already carry
# hand-written `# noqa: PLC0415` cycle-dodges. Moving that content to a neutral
# leaf would let this shim be eager again.
#
# Same `_LAZY_MAP` shape as `flow_sdk/server/__init__.py` and the three
# `cloud_client` packages — including the `globals()` write-back, so a repeated
# access does not re-enter `__getattr__`.
_LAZY_MAP: dict[str, tuple[str, str]] = {
    "cli_main": (".flow_cli", "cli_main"),
}

__all__ = ["cli_main"]


def __getattr__(name: str):
    if name in _LAZY_MAP:
        module_path, attr = _LAZY_MAP[name]
        import importlib

        mod = importlib.import_module(module_path, __name__)
        value = getattr(mod, attr)
        # Cache on the module so __getattr__ is not called again
        globals()[name] = value
        return value
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
