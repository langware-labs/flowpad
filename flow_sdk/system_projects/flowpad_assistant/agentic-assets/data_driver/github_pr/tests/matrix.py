"""The ``github_pr`` source's case in the data source matrix, and the ``Double`` it is built on: a stateful
GitHub over a loopback socket, read and commented on with a doubled connector token."""
from __future__ import annotations

from contextlib import contextmanager

from pydantic import SecretStr

from flow_sdk.builtin.data_driver import DataDriver
from flow_sdk.ingest.testing import local_http_server
from flow_sdk.sources.credentials import AuthShape, ResolvedSecrets

from .test_github_pr_source import _FakeGithub

#: The PR every delivery lands on unless told otherwise — the conversation's address.
PR = "octo/matrix#1"


class Double:
    """github_pr as a test double: a loopback REST API, an inbound comment you can inject, the comments it saw."""

    provider = "github_pr"

    #: The reviewer who writes in: a login.
    sender = "dana"

    def __init__(self, *, pr: str = PR):
        self.pr = pr
        self.github = _FakeGithub()
        self.github.pr(pr, title="Matrix PR")
        self.config: dict = {}
        self.fields: dict = {"account_key": self.github.me}
        self.secrets: dict = {"token": "gho_test"}
        self._server = None

    def __enter__(self) -> "Double":
        self._server = local_http_server(self.github)
        self.config["base_url"] = self._server.__enter__()
        return self

    def __exit__(self, *exc) -> None:
        server, self._server = self._server, None
        if server is not None:
            server.__exit__(*exc)

    async def credentials(self, _row) -> ResolvedSecrets:
        """The in-process stand-in for ``DataDriver.credentials_for``: the connector token."""
        return ResolvedSecrets(shape=AuthShape.CONNECTOR, token=SecretStr(self.secrets["token"]))

    def deliver(self, text: str, *, sender: str, thread: str | None = None, files=(), reactions: dict | None = None) -> dict:
        """An issue comment ``sender`` writes on PR ``thread`` (the double's PR by default) now; the PR's
        ``updated_at`` moves with it, so the next search finds it. Files and reactions are not modelled."""
        key = thread or self.pr
        comment = self.github.comment(key, text, user=sender)
        return {"external_id": f"comment-{comment['id']}", "thread": key, "files": []}

    def sent(self) -> list[dict]:
        """Every comment the double accepted from the source, oldest first."""
        return list(self.github.posts)


@contextmanager
def case(monkeypatch, tmp_path):
    with Double() as double:
        monkeypatch.setattr(DataDriver.loaded("github_pr"), "credentials_for", double.credentials)
        double.deliver("first", sender="dana")
        double.deliver("second", sender="dana")
        double.deliver("third", sender="lee")
        yield {
            "config": double.config,
            "fields": double.fields,
            "min_items": 3,
            "send": {"to": PR, "text": "matrix send"},
            "double": double,
        }
