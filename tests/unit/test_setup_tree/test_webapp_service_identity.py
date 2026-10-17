"""A preexisting page must not become a missing service just because its launch command changed."""
import subprocess
import sys

import pytest

from flow_sdk.builtin.faas.micro_app import WebApp
from flow_sdk.builtin.webapp_setup import step
from flow_sdk.core import app_ports, dev_server
from flow_sdk.schema.data_spec.returned_value_spec import ExitCode
from tests.unit.agent._seed import seed_project

pytestmark = pytest.mark.timeout(20)


async def test_old_page_is_not_a_missing_service(tmp_path):
    project = await seed_project(tmp_path / "project")
    folder = tmp_path / "project/agentic-assets/webapp/admin"
    folder.mkdir(parents=True)
    page_port = app_ports.free_port()
    service_port = app_ports.free_port({page_port})
    app = WebApp(name="admin", asset_ref=str(folder), project_id=project.id,
                 mounts=[{"serving": {"type": "proxy", "start_cmd": "bash run-page.sh {port}"}}],
                 services=[{"name": "emulators", "protocol": {"spec_kind": "api.rest"}, "serving": {
                     "type": "proxy", "start_cmd": "bash run-emulators.sh",
                     "ports": {"local": {"port": service_port, "required": True}}}}])
    await app.save()
    with subprocess.Popen([sys.executable, "-m", "http.server", str(page_port), "--bind", "127.0.0.1"],
                          cwd=folder, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) as page:
        try:
            assert dev_server.wait_for_port(page_port, 10)
            answer = await step(str(app.id), "start", check=True)
            assert answer.exit_code == ExitCode.NOT_YET
            assert answer.detail == "admin's emulators service is not running"
        finally:
            page.terminate()
