"""The far end of the inbound-routing E2E: the waha-service (Meta's Cloud API in front of a WhatsApp number) on a
real port, its WAHA replaced by the contract tests' fake — so a "person" writes by a control call and every reply the
agents send is recorded instead of reaching a phone.

Run with the waha-service venv:  <waha-service>/.venv/bin/python waha_stack.py <waha-service dir> <port>
Control (JSON):
  POST /ctl/inbound {sender, text, group?}  a person writes (1:1, or in ``group`` — its ``…@g.us``)
  GET  /ctl/sent                            every text the number sent (``chat``, ``text``)
  POST /ctl/group  {chat, people?}         a WhatsApp group the number is in → {chat, group_id (Meta's)}
  GET  /ctl/config                          the number's ids and secrets, as a Cloud API client is given them
"""

import sys
import tempfile
from pathlib import Path

import uvicorn
from fastapi import Request

WAHA_SERVICE, PORT = Path(sys.argv[1]).resolve(), int(sys.argv[2])
#: A number of its own per run (default one no other test claims): the hub refuses an account another user holds.
NUMBER = sys.argv[3] if len(sys.argv) > 3 else "972550000777"
sys.path.insert(0, str(WAHA_SERVICE))

from tests.conftest import (  # noqa: E402
    APP_ID,
    APP_SECRET,
    TOKEN,
    WABA_ID,
    FakeWaha,
    Service,
    save_number,
    settings_for,
    store_at,
)
from waha_service.app import create_app  # noqa: E402

VERIFY = "e2e-verify-token"


def main() -> None:
    data = Path(tempfile.mkdtemp(prefix="waha-e2e-"))
    settings = settings_for(data, PUBLIC_BASE_URL=f"http://127.0.0.1:{PORT}")
    waha = FakeWaha()
    store = store_at(data / "s.sqlite")
    save_number(store, device={"phone": NUMBER}, link={"verify_token": VERIFY})
    waha.me = {"id": f"{NUMBER}@c.us", "pushName": "Bin"}
    app = create_app(settings, store=store, waha_for=lambda device: waha, run_outbox=True)
    # The inbound helper of the contract tests, posting to this same app over ASGI.
    import httpx

    driver = Service(httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=settings.public_base_url),
                     waha, None, store, settings, None)

    @app.post("/ctl/inbound")
    async def inbound(request: Request):
        body = await request.json()
        sent = await driver.inbound_text(body["text"], sender=body["sender"], group=body.get("group", ""))
        return {"id": sent["id"]}

    @app.get("/ctl/sent")
    async def sent():
        return [{"chat": s["chat"], "text": s.get("text", ""), "reply_to": s.get("reply_to", "")} for s in waha.sent]

    @app.get("/ctl/config")
    async def config():
        return {"graph_url": f"http://127.0.0.1:{PORT}/v23.0", "base_url": f"http://127.0.0.1:{PORT}",
                "phone_number_id": NUMBER, "waba_id": WABA_ID, "app_id": APP_ID, "app_secret": APP_SECRET,
                "token": TOKEN, "verify_token": VERIFY}

    @app.post("/ctl/group")
    async def group(request: Request):
        body = await request.json()
        from waha_service.groups import group_id_for

        chat = waha.add_group(body["chat"], body.get("subject", "E2E group"), [f"{p}@c.us" for p in body.get("people", [])])
        return {"chat": chat, "group_id": group_id_for(NUMBER, chat)}

    # The service answers every path as Graph: the control routes go first.
    ctl = [r for r in app.router.routes if getattr(r, "path", "").startswith("/ctl/")]
    app.router.routes[:] = ctl + [r for r in app.router.routes if r not in ctl]
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")


if __name__ == "__main__":
    main()
