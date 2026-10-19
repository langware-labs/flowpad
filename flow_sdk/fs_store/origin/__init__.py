"""Where bytes live — the origin models and their discriminated union.

Lives under ``fs_store`` (not ``builtin``) so ``entity_model`` can type its
``origin`` field at class-build time: importing ``flow_sdk.builtin.*`` runs the
builtin package init, which imports ``Entity``. Import the submodules directly.
"""
