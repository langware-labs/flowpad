# Frozen-backend entry point (validated). PyInstaller freezes THIS file; the
# resulting flowpad-backend.exe dispatches by first arg so one binary is the
# CLI, the monitor, and the server (a frozen exe has no `python -m ...`).
#
# launch.py is already sys.frozen-aware: start_server_process spawns
# `<exe> serve` and start_monitor_detached spawns `<exe> monitor <port>`, and
# the PID-validation markers switch to "serve"/"monitor" when frozen.
import sys

_cmd = sys.argv[1] if len(sys.argv) > 1 else ""

if _cmd == "serve":
    # The uvicorn server process (spawned by the monitor).
    from flow_sdk.server.run import main
    main()
elif _cmd == "monitor":
    # The supervisor (spawned by `flow start`).
    from flow_sdk.server.launch import launch_monitor
    launch_monitor(int(sys.argv[2]) if len(sys.argv) > 2 else 9007)
elif _cmd == "selftest":
    # CI/dev check that the dynamic imports survive freezing.
    from flow_sdk.schema.type_info import register_all
    register_all()
    import flow_sdk.server.run  # noqa: F401
    print("SELFTEST OK")
else:
    # Everything else is the normal flow CLI (start/stop/status/upgrade/...).
    from flow_sdk.cli.flow_cli import cli_main
    cli_main()
