import asyncio
import functools
import http.server
import threading

import httpx

from flow_sdk.server.reporter_relay import REPORTER_PATH, inject, relay_port


def _serve(folder):
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(folder))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def test_inject_puts_script_first_in_head():
    out = inject(b"<html><head><title>x</title></head></html>")
    assert out.startswith(b'<html><head><script src="/__flowpad/reporter.js?load="></script><title>')


def test_inject_without_head_goes_on_top():
    assert inject(b"<p>hi</p>").startswith(b"<script")


async def test_relay_adds_reporter_to_html_and_passes_the_rest(tmp_path):
    (tmp_path / "index.html").write_text("<!doctype html><html><head></head><body>app</body></html>")
    (tmp_path / "main.js").write_text("console.log(1)")
    server = _serve(tmp_path)
    try:
        port = await relay_port(server.server_address[1])
        async with httpx.AsyncClient() as client:
            page = await client.get(f"http://127.0.0.1:{port}/")
            script = await client.get(f"http://127.0.0.1:{port}/main.js")
            reporter = await client.get(f"http://127.0.0.1:{port}{REPORTER_PATH}")
        assert page.status_code == 200 and REPORTER_PATH in page.text and "app" in page.text
        assert int(page.headers["content-length"]) == len(page.content)
        assert script.text == "console.log(1)"
        assert "flowpad:page-report" in reporter.text
        # the same upstream gets the same relay
        assert await relay_port(server.server_address[1]) == port
    finally:
        await asyncio.to_thread(server.shutdown)
