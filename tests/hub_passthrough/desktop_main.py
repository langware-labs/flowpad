"""One desktop instance for the pass-through harness: signed in as ONE hub user, hub = the given URL.

    python -m tests.hub_passthrough.desktop_main --hub URL --token TOKEN --port PORT --home DIR

Prints ``READY <port>`` once it accepts connections. The desktop's own graph surface (real
middleware, graph router, WS router — ``build_desktop_app``) over a fresh SQLite DB in ``DIR``;
signed in through the production ``login_as`` funnel with the user the hub reports for TOKEN.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path


def _sandbox(home: Path) -> None:
    """Everything this process writes lives under ``home``; no real keychain, no desktop env."""
    for sub in ("home", "records", "flow"):
        (home / sub).mkdir(parents=True, exist_ok=True)
    os.environ.update(
        {
            "HOME": str(home / "home"),
            "USERPROFILE": str(home / "home"),
            "FLOW_HOME": str(home / "flow"),
            "FLOW_INSTANCE": "passthrough",
            "TESTING": "true",
            "SQLITE_DATABASE_PATH": str(home / "desktop.db"),
            "FS_RECORD_PATH": str(home / "records"),
            "FLOWPAD_DISABLE_VENDORED_FLOW_RS": "1",
            "FLOWPAD_DISKIO_BACKEND": "python",
            "FLOWPAD_SKIP_DOTENV": "true",
        }
    )
    for var in ("FLOWPAD_DESKTOP", "SOD_ENC_KEY", "DEPLOY_ENV", "FLOWPAD_HUB_URL"):
        os.environ.pop(var, None)

    import keyring
    from keyring.backend import KeyringBackend

    class _Mem(KeyringBackend):
        priority = 1  # type: ignore[assignment]
        store: dict = {}

        def get_password(self, s, u):
            return self.store.get((s, u))

        def set_password(self, s, u, p):
            self.store[(s, u)] = p

        def delete_password(self, s, u):
            self.store.pop((s, u), None)

    keyring.set_keyring(_Mem())


async def _open_db(home: Path) -> None:
    from flow_sdk.db.db_entity import DBEntity
    from flow_sdk.db.db_relationship import DBRelationship
    from flow_sdk.db.drivers.db_driver import DBConfig, _driver_instances
    from flow_sdk.db.drivers.sqlite import SQLiteDBDriver

    driver = SQLiteDBDriver(DBConfig(database=str(home / "desktop.db"), pooled=False))
    _driver_instances["sqlite"] = driver
    await driver.open()
    DBEntity._db = driver
    DBRelationship._db = driver


async def _sign_in(hub: str, token: str) -> None:
    import httpx

    from flow_sdk.cli.auth.secrets import enable_secrets
    from flow_sdk.config import default_service_config
    from tests.hub_tests._local_login import login_as

    default_service_config.flowpad_hub_url = hub
    enable_secrets()
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.get(f"{hub}/api/v1/current-user", headers={"Authorization": f"Bearer {token}"})
    body = r.json()
    user = body.get("data") if isinstance(body, dict) and "data" in body else body
    if not isinstance(user, dict) or not user.get("id"):
        raise SystemExit(f"cannot resolve the hub user for this token: {r.status_code} {r.text[:300]}")
    login_as({"token": token, "user": user})


async def _after_sign_in(token: str | None, hub: str | None) -> None:
    """Failure modes: the login goes stale (the hub stops accepting its token), or the hub goes away."""
    from flow_sdk.cli.auth.credentials import load_credentials
    from flow_sdk.config import default_service_config
    from tests.hub_tests._local_login import login_as

    if token:
        login_as({"token": token, "user": load_credentials().user})
    if hub:
        default_service_config.flowpad_hub_url = hub


async def _main(args: argparse.Namespace) -> None:
    import uvicorn

    from tests.unit.hub_proxy._servers import build_desktop_app

    home = Path(args.home)
    await _open_db(home)
    await _sign_in(args.hub, args.token)
    if args.then_token or args.then_hub:
        await _after_sign_in(args.then_token, args.then_hub)
    config = uvicorn.Config(build_desktop_app(), host="127.0.0.1", port=args.port, log_level="warning", lifespan="off")
    server = uvicorn.Server(config)
    task = asyncio.create_task(server.serve())
    while not server.started:
        if task.done():
            raise SystemExit(f"desktop failed to start: {task.exception()}")
        await asyncio.sleep(0.02)
    print(f"READY {args.port}", flush=True)
    await task


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--hub", required=True)
    parser.add_argument("--token", required=True)
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--home", required=True)
    parser.add_argument("--then-token", default=None)
    parser.add_argument("--then-hub", default=None)
    args = parser.parse_args()
    _sandbox(Path(args.home))
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    asyncio.run(_main(args))


if __name__ == "__main__":
    main()
