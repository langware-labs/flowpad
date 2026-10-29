import functools
import http.server
import threading

from flow_sdk.builtin.webapp_setup import START_APP, start_app_check, start_app_command

SCRIPT = """import sys, urllib.request
cmd, port = sys.argv[1], sys.argv[2]
if cmd == "check":
    body = urllib.request.urlopen(f"http://127.0.0.1:{port}/").read().decode()
    sys.exit(0 if "ready" in body else 1)
"""


def _serve(folder):
    server = http.server.ThreadingHTTPServer(
        ("127.0.0.1", 0), functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(folder)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def test_no_start_app_means_the_declared_start_and_no_extra_check(tmp_path):
    assert start_app_command(tmp_path, 4100) is None
    assert start_app_check(tmp_path, 4100)


def test_start_app_replaces_the_start_and_its_check_decides(tmp_path):
    (tmp_path / "setup").mkdir()
    (tmp_path / START_APP).write_text(SCRIPT)
    site = tmp_path / "site"
    site.mkdir()
    (site / "index.html").write_text("ready")
    server = _serve(site)
    try:
        port = server.server_address[1]
        assert start_app_command(tmp_path, port) == f"python3 setup/start_app.py start {port}"
        assert start_app_check(tmp_path, port)
        (site / "index.html").write_text("broken")
        assert not start_app_check(tmp_path, port)
    finally:
        server.shutdown()
