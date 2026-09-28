"""The ``jira`` source's case in the data source matrix, and the ``Double`` it is built on: a Jira
Cloud search API over a loopback socket, seeded with issues updated just now."""
from __future__ import annotations

from contextlib import contextmanager

from flow_sdk.builtin.data_driver import DataDriver
from flow_sdk.ingest.testing import local_http_server

from .test_jira_source import JQL, _Jira, secrets, seed


class Double:
    """jira as a test double: ``count`` issues of project PROJ behind a loopback site. ``config`` is
    what a source pointing at it is created with; ``credentials`` stands in for
    ``DataDriver.credentials_for``."""

    provider = "jira"

    def __init__(self, count: int = 3, *, jql: str = JQL):
        self.jira = _Jira(seed(count))
        self.jql = jql
        self.config: dict = {}
        self._server = None

    @property
    def issues(self) -> list[dict]:
        return self.jira.issues

    def __enter__(self) -> "Double":
        self._server = local_http_server(self.jira)
        self.config = {"site": self._server.__enter__(), "jql": self.jql}
        return self

    def __exit__(self, *exc):
        server, self._server = self._server, None
        if server is not None:
            server.__exit__(*exc)

    async def credentials(self, _row):
        """The manifest's ``email`` / ``api_token`` vars, as the ``jira`` credential resolves them."""
        return secrets()


@contextmanager
def case(monkeypatch, tmp_path):
    with Double() as double:
        monkeypatch.setattr(DataDriver.loaded("jira"), "credentials_for", double.credentials)
        yield {"config": double.config, "min_items": 3, "double": double}
