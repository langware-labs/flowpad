"""Search asks for the Visual C++ Runtime once, when there is work — and never pays for a pass it
cannot store.

usearch's compiled module links MSVCP140.dll, which a clean Windows does not ship. The machine
without it is played by an import finder that refuses usearch, the way ``DLL load failed`` does;
the person is played by a stand-in for the ``install-vcredist`` wizard, whose own ask/install
steps are covered in ``test_install_vcredist_wizard``. Installing is modelled as its effect: the modules
become importable again.
"""

from __future__ import annotations

import importlib.abc
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
import pytest_asyncio

from flow_sdk.builtin.rag_index import RagIndex, RagStatus
from flow_sdk.builtin.wizard import Wizard
from flow_sdk.rag import reconcile, runtime

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

PROJECT = "11111111-2222-4333-8444-555555555555"


class _NoRuntime(importlib.abc.MetaPathFinder):
    def find_spec(self, name, path=None, target=None):
        if name == "usearch" or name.startswith("usearch."):
            raise ImportError("DLL load failed while importing compiled: The specified module could not be found.")


@pytest.fixture
def windows_without_runtime(monkeypatch):
    """A Windows box on which usearch cannot load. Returns ``install()``, which puts it back."""
    import usearch.index  # noqa: F401 — so there is something to hide and later restore

    saved = {k: v for k, v in sys.modules.items() if k == "usearch" or k.startswith("usearch.")}
    for name in saved:
        monkeypatch.delitem(sys.modules, name)
    finder = _NoRuntime()
    monkeypatch.setattr(sys, "meta_path", [finder, *sys.meta_path])
    monkeypatch.setattr(sys, "platform", "win32")

    def install() -> None:
        sys.meta_path.remove(finder)
        sys.modules.update(saved)

    return install


@pytest.fixture(autouse=True)
def _fresh_answer():
    runtime.forget_answer()
    reconcile._inflight.clear()
    yield
    runtime.forget_answer()
    reconcile._inflight.clear()


@pytest.fixture
def person(monkeypatch):
    """The `install-vcredist` wizard, answered by whoever the test says is at the keyboard."""
    state = SimpleNamespace(asked=0, says="no", install=lambda: None)

    async def run(**_kwargs):
        state.asked += 1
        if state.says == "yes":
            state.install()
        return SimpleNamespace(ok=state.says == "yes", detail=f"person said {state.says}")

    async def get_one(_query):
        return SimpleNamespace(run=run)

    monkeypatch.setattr(Wizard, "get_one", get_one)
    return state


@pytest.fixture
def paid(monkeypatch) -> list[list[str]]:
    """Every batch sent to the embedding provider."""
    calls: list[list[str]] = []

    async def embedder(_index):
        async def _embed(texts):
            calls.append(list(texts))
            return [[1.0, 0.0, 0.0] for _ in texts]

        return _embed, "test-model"

    monkeypatch.setattr(reconcile, "embedder_for", embedder)
    return calls


@pytest_asyncio.fixture(autouse=True)
async def _no_leftover_indexes():
    async def _purge() -> None:
        for row in await RagIndex.get_all({}):
            await row.delete()

    await _purge()
    yield
    await _purge()


async def _active(tmp_path: Path) -> RagIndex:
    root = tmp_path / "docs"
    root.mkdir()
    (root / "a.md").write_text("# A\n\nSomething worth finding.\n")
    index = RagIndex(status=RagStatus.ACTIVE, project_id=PROJECT)
    await index.add_root(str(root))
    index.pending = True
    await index.save(notify=False)
    return index


async def test_not_now_pays_for_nothing_and_says_why(tmp_path, windows_without_runtime, person, paid):
    index = await _active(tmp_path)

    assert await reconcile.run_index(index) == []

    assert person.asked == 1
    assert paid == [], "a pass that cannot store a vector must not pay for one"
    saved = await RagIndex.get_by_id(str(index.id))
    assert saved.last_error == runtime.MISSING_RUNTIME


async def test_not_now_is_not_asked_again_every_tick(tmp_path, windows_without_runtime, person, paid, monkeypatch):
    monkeypatch.setattr(reconcile, "_spawn", lambda index: None)
    index = await _active(tmp_path)
    await reconcile.run_index(index)

    assert await reconcile.dispatch_due_indexes() == []
    assert await runtime.ensure() == runtime.MISSING_RUNTIME
    assert person.asked == 1


async def test_a_person_asking_for_search_is_asked_again(tmp_path, windows_without_runtime, person, paid):
    index = await _active(tmp_path)
    await reconcile.run_index(index)

    runtime.forget_answer()  # what adding a folder or "index now" does
    await reconcile.run_index(index)
    assert person.asked == 2


async def test_install_then_the_same_pass_indexes(tmp_path, windows_without_runtime, person, paid):
    person.says, person.install = "yes", windows_without_runtime
    index = await _active(tmp_path)

    await reconcile.run_index(index)

    assert person.asked == 1
    assert paid, "installed, so the pass went on and embedded"
    saved = await RagIndex.get_by_id(str(index.id))
    assert saved.last_error == "" and saved.chunk_count > 0


async def test_a_machine_that_has_the_runtime_is_never_asked(tmp_path, person, paid):
    index = await _active(tmp_path)

    await reconcile.run_index(index)

    assert person.asked == 0
    assert paid


async def test_off_windows_a_broken_index_is_reported_not_asked(
    tmp_path, windows_without_runtime, person, paid, monkeypatch
):
    monkeypatch.setattr(sys, "platform", "linux")
    index = await _active(tmp_path)

    await reconcile.run_index(index)

    assert person.asked == 0 and paid == []
    saved = await RagIndex.get_by_id(str(index.id))
    assert saved.last_error.startswith("search's vector index could not load")
