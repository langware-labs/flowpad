"""Fixtures for tests that require a real local Flowpad hub."""

from __future__ import annotations

import os
from pathlib import Path
from urllib.parse import urlparse

import httpx
import pytest

LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}
_LOCAL_HUB_STATUS: tuple[bool, str] | None = None


def _configured_hub_base_url() -> str:
    env_url = os.environ.get("FLOWPAD_HUB_URL")
    if env_url:
        return env_url.rstrip("/")

    from flow_sdk.config import default_service_config

    return (default_service_config.flowpad_hub_url or "").rstrip("/")


def _check_local_hub_available(base_url: str) -> tuple[bool, str]:
    if not base_url:
        return False, "FLOWPAD_HUB_URL is not configured"

    parsed = urlparse(base_url)
    if parsed.hostname not in LOCAL_HOSTS:
        return False, f"configured hub is not local: {base_url}"

    health_url = f"{base_url}/api/v1/health/status"
    try:
        response = httpx.get(health_url, timeout=2.0)
    except Exception as e:
        return False, f"local hub is not reachable at {health_url}: {e}"

    if response.status_code < 200 or response.status_code >= 300:
        return False, f"local hub health check failed with HTTP {response.status_code}"

    return True, ""


def _local_hub_status() -> tuple[bool, str]:
    global _LOCAL_HUB_STATUS
    if _LOCAL_HUB_STATUS is None:
        _LOCAL_HUB_STATUS = _check_local_hub_available(_configured_hub_base_url())
    return _LOCAL_HUB_STATUS


def pytest_collection_modifyitems(items):
    ok, reason = _local_hub_status()
    if ok:
        return
    skip_hub = pytest.mark.skip(reason=reason)
    for item in items:
        if "hub_tests" in str(item.path):
            item.add_marker(skip_hub)


@pytest.fixture(scope="session")
def hub_base_url() -> str:
    return _configured_hub_base_url()


@pytest.fixture(scope="session", autouse=True)
def local_hub_available(hub_base_url):
    ok, reason = _local_hub_status()
    if not ok:
        pytest.skip(reason)
    return True


@pytest.fixture(autouse=True)
def configure_desktop_hub(hub_base_url):
    from flow_sdk.config import default_service_config

    old = default_service_config.flowpad_hub_url
    default_service_config.flowpad_hub_url = hub_base_url
    yield
    default_service_config.flowpad_hub_url = old


@pytest.fixture(autouse=True)
async def _reset_shared_hub_client():
    """Close the process-shared hub HTTP client after each test.

    ``hub_http._shared_client`` is a deliberate module global (pooled
    connections + TLS context), correct for the server's single lifelong loop.
    Under ``asyncio_mode = auto`` each test gets its OWN loop, so the pooled
    client outlives the loop that built it and every later hub call raises
    ``RuntimeError: Event loop is closed`` — which ``hub_get``/``hub_post``
    swallow, returning ``None``. The failure is therefore SILENT (a bare
    ``assert (None)`` / "row never arrived"), not an error, and lands on
    whichever test follows the last client rebuild. Closing it here, while its
    loop is still alive, forces each test to build its own.
    """
    from flow_sdk.cloud_client.transport.hub_http import close_hub_client

    yield
    await close_hub_client()


@pytest.fixture(autouse=True)
def _reset_hub_error_reporter():
    """Reset the module-singleton hub-error rate-limiter between tests.

    ``hub_error_reporter`` rate-limits ``hub_client_error_msg`` broadcasts to
    MAX_HUB_ERRORS_PER_WINDOW per WINDOW_SECONDS. Its window state is a global
    singleton — without this reset, hub errors from one test (e.g. an
    intentionally-unreachable-hub case) fill the window and SUPPRESS the
    broadcast a later test asserts on. Isolate it like any other shared state."""
    from flow_sdk.cloud_client.error_reporter import hub_error_reporter

    hub_error_reporter._timestamps.clear()
    hub_error_reporter._suppressed_in_window = 0
    yield
    hub_error_reporter._timestamps.clear()
    hub_error_reporter._suppressed_in_window = 0


@pytest.fixture(autouse=True)
def isolated_hub_keyring(monkeypatch):
    """Per-test in-memory keyring with isolated per-instance sod state.

    Phase C+D: credentials no longer live in keyring directly — they live
    in the per-instance encrypted sodot file, with only the Fernet key in
    keyring. This fixture mirrors the shared ``sod_env`` pattern (see
    tests/conftest.py): unique FLOW_INSTANCE per test, monkeypatched
    keyring, consent gate opened via ``enable_secrets()``.

    The root tests/conftest.py registers a process-wide in-memory keyring
    backend before any flow_sdk import, so even if a test bypassed this
    fixture the real OS keychain would still be unreachable.
    """
    import uuid as _uuid

    import keyring
    import keyring.errors

    instance_name = f"test-{_uuid.uuid4().hex[:8]}"
    monkeypatch.setenv("FLOW_INSTANCE", instance_name)

    from flow_sdk.instance_settings import reset_instance_settings

    reset_instance_settings()

    store: dict[tuple[str, str], str] = {}

    def get_password(service: str, name: str):
        return store.get((service, name))

    def set_password(service: str, name: str, value: str):
        store[(service, name)] = value

    def delete_password(service: str, name: str):
        if (service, name) not in store:
            raise keyring.errors.PasswordDeleteError("missing")
        del store[(service, name)]

    monkeypatch.setattr(keyring, "get_password", get_password)
    monkeypatch.setattr(keyring, "set_password", set_password)
    monkeypatch.setattr(keyring, "delete_password", delete_password)

    from flow_sdk.cli.auth.secrets import enable_secrets

    enable_secrets()

    yield store
    reset_instance_settings()


def _login(hub_base_url: str, *, expires_in_seconds: int | None = None) -> dict:
    email = os.environ.get("FLOWPAD_CLOUD_USER_EMAIL")
    password = os.environ.get("FLOWPAD_CLOUD_USER_PASSWORD")

    with httpx.Client(base_url=f"{hub_base_url}/api/v1", timeout=10.0) as client:
        if email and password:
            payload = {"email": email, "password": password}
            if expires_in_seconds is not None:
                payload["expires_in_seconds"] = expires_in_seconds
            response = client.post("/login", json=payload)
        else:
            params = {}
            if expires_in_seconds is not None:
                params["expires_in_seconds"] = str(expires_in_seconds)
            response = client.post("/login/local", params=params)

    if response.status_code != 200:
        pytest.skip(f"local hub login failed with HTTP {response.status_code}: {response.text[:300]}")

    body = response.json()
    if body.get("status") not in ("SUCCESS", "success"):
        pytest.skip(f"local hub login failed: {body}")
    return body["data"]


def _email_from_env_local(repo: Path) -> str | None:
    env_local = repo / ".env.local"
    if not env_local.exists():
        return None
    for line in env_local.read_text().splitlines():
        line = line.strip()
        if line.startswith("FLOWPAD_CLOUD_USER_EMAIL") and "=" in line:
            return line.partition("=")[2].strip().strip("\"'").lower() or None
    return None


def _resolve_identities() -> tuple[str | None, str | None]:
    """Resolve 'alice' and 'bob' exactly as the two-user tests do.

    Alice is NOT simply ``FLOWPAD_CLOUD_USER_EMAIL``: ``test_two_client_loop``
    reads ``ALICE_EMAIL`` else this repo's ``.env.local`` FILE, so exporting the
    env var alone leaves that test pointed at whatever the file says. Resolving
    both the same way the tests do is the whole point — a guard that checks a
    different source than the code it guards will happily pass while the tests
    it protects are collapsed onto one account.
    """
    oss = Path(__file__).resolve().parents[2]
    app = oss.parent / "flowpad-app"
    alice = (os.environ.get("ALICE_EMAIL") or _email_from_env_local(oss) or "").strip().lower()
    bob = (os.environ.get("BOB_EMAIL") or _email_from_env_local(app) or "").strip().lower()
    return (alice or None, bob or None)


@pytest.fixture(scope="session", autouse=True)
def _two_distinct_identities():
    """Skip the tier when 'alice' and 'bob' resolve to the SAME hub account.

    The two-user tests read alice from this repo's ``.env.local`` (via
    ``FLOWPAD_CLOUD_USER_EMAIL``) and bob from the sibling flowpad-app checkout.
    Point both at one address — easy to do while setting up a two-user rig — and
    every share invites the conversation's own owner, so the roster and the
    pending list are legitimately empty and a dozen tests go red for a reason
    that has nothing to do with the code under test. Announce it as a skip.
    """
    alice, bob = _resolve_identities()
    if alice and bob and alice == bob:
        pytest.skip(
            f"hub tier needs two distinct identities — alice and bob both resolve to {alice}. "
            "Set ALICE_EMAIL/ALICE_PW and BOB_EMAIL/BOB_PW to different accounts "
            "(or fix FLOWPAD_CLOUD_USER_EMAIL in this repo's .env.local)."
        )


@pytest.fixture()
def hub_login_payload(hub_base_url) -> dict:
    return _login(hub_base_url)


@pytest.fixture()
def short_lived_hub_login_payload(hub_base_url) -> dict:
    return _login(hub_base_url, expires_in_seconds=5)


@pytest.fixture(autouse=True)
async def _close_shared_hub_client():
    """Drop the process-shared hub client between tests.

    ``hub_http._shared_client`` is a module global deliberately kept alive across
    calls so the TLS context and connection pool survive (see ``_hub_client``).
    Inside one pytest process that global outlives the test that created it, and
    its internals end up bound to that test's loop — the next test's ``hub_get``
    then dies with ``<asyncio.locks.Event ...> is bound to a different event
    loop``, which ``hub_get`` swallows as a non-fatal warning. The caller sees
    ``hub_reachable=False``, degrades to local-only, and asserts against a hub it
    never actually reached: a green-or-red outcome decided by test ORDER.

    Closing it per test costs one TLS handshake and makes the tier order-
    independent. Same call the backend makes on shutdown (``server/app.py``).
    """
    yield
    from flow_sdk.cloud_client.transport.hub_http import close_hub_client

    await close_hub_client()


# ---------------------------------------------------------------------------
# Hub-side entity cleanup
# ---------------------------------------------------------------------------


def _cleanup_token(email: str | None, password: str | None) -> str | None:
    """Log in for cleanup purposes only — never skips or fails the run."""
    if not email or not password:
        return None
    try:
        with httpx.Client(base_url=f"{_configured_hub_base_url()}/api/v1", timeout=10.0) as client:
            r = client.post("/login", json={"email": email, "password": password})
        if r.status_code != 200:
            return None
        data = r.json().get("data") or {}
        return data.get("api_key") or data.get("token")
    except Exception:  # noqa: BLE001
        return None


def _cleanup_identities() -> list[str]:
    """Tokens for every identity the tier creates hub rows as."""
    alice, bob = _resolve_identities()
    pairs = [
        (
            os.environ.get("FLOWPAD_CLOUD_USER_EMAIL"),
            os.environ.get("FLOWPAD_CLOUD_USER_PASSWORD"),
        ),
        (
            os.environ.get("ALICE_EMAIL") or alice,
            os.environ.get("ALICE_PW") or os.environ.get("FLOWPAD_CLOUD_USER_PASSWORD"),
        ),
        (os.environ.get("BOB_EMAIL") or bob, os.environ.get("BOB_PW")),
    ]
    tokens: list[str] = []
    for token in (_cleanup_token(email, password) for email, password in pairs):
        if token and token not in tokens:
            tokens.append(token)
    return tokens


# Every hub entity type the tier creates and never reclaimed. Measured on a
# real local hub after ~18 runs: 36 organizations (``login-org-*`` +
# ``invite-org-*``, two per run), 18 teams, 17 skills, and the conversations
# that started all this. Left alone they are not inert — see the budget note on
# the fixture below, and ``test_org_login_and_invite`` has already had to weaken
# an assertion ("which org is 'primary' is ambiguous once a user has several —
# a test-only artifact of repeated runs") because of this exact pile.
_CLEANUP_TYPES = ("conversation", "organization", "team", "skill", "task", "markdown", "agent")


def _live_ids(token: str, entity_type: str) -> set[str]:
    """Ids of this user's not-yet-deleted rows of ``entity_type``.

    Returns an empty set on ANY failure — an unknown type, a 403, a hub blip.
    An empty "before" snapshot means the diff finds nothing to delete, so a
    read failure makes cleanup do less, never more.
    """
    try:
        with httpx.Client(base_url=f"{_configured_hub_base_url()}/api/v1", timeout=30.0) as client:
            r = client.get(f"/graph/{entity_type}", headers={"Authorization": f"Bearer {token}"})
        if r.status_code != 200:
            return set()
        rows = r.json().get("data") or []
        return {x["id"] for x in rows if isinstance(x, dict) and x.get("id") and not x.get("deleted_at")}
    except Exception:  # noqa: BLE001
        return set()


def _delete_entity(base: str, entity_type: str, entity_id: str, tokens: list[str]) -> bool:
    """Best-effort delete, trying each identity — the owner may be either."""
    for tok in tokens:
        try:
            with httpx.Client(base_url=f"{base}/api/v1", timeout=15.0) as client:
                r = client.request(
                    "DELETE",
                    f"/graph/{entity_type}/{entity_id}",
                    headers={"Authorization": f"Bearer {tok}", "Content-Type": "application/json"},
                    json={},
                )
            if r.status_code in (200, 404):
                return True
        except Exception:  # noqa: BLE001
            continue
    return False


_LEFTOVER_CACHE_KEY = "hub_tests/leftover_entities"


@pytest.fixture(scope="session", autouse=True)
def _reclaim_hub_entities_the_tier_creates(local_hub_available, request):
    """Delete the PREVIOUS session's hub rows, and record this session's.

    Nothing in the tier ever cleaned up after itself: each test mints a fresh
    uniquely-named row (``f"share-recipients-{int(time.time())}"``,
    ``f"invite-org-{int(time.time())}"``) precisely so runs can't collide, which
    also guarantees nothing is reused or reclaimed. They accumulate forever, and
    they are not inert:

    * ``test_list_returns_local_immediately`` measures a COLD conversation-list
      against a 5s budget, and the reconcile upserts every hub row at ~12ms, so
      the tier breaks its own budget at ~427 accumulated conversations. It
      really did — 417 rows, 4.87s in the upsert loop.
    * ``test_login_returns_organization_and_role`` already gave up asserting
      WHICH organization login returns, because repeated runs left the user
      owning dozens and "primary" stopped being well-defined. A leak that
      quietly erodes an assertion is worse than one that fails loudly.

    **Clean at the START, not the end** — the hub's own suite does exactly this
    (``session_db_driver`` calls ``clean_all_db()`` before its yield and nothing
    after). Deleting in teardown destroys the evidence: a test fails, and the
    rows you would inspect to find out why are gone by the time the summary
    prints. Recording them and reclaiming them on the next run keeps the hub
    bounded without ever racing the debugger — a failed run's wreckage sits
    there for as long as you need it.

    The hub can wipe wholesale because it points at a dedicated test database
    (``DATABASE_DB_NAME_TEST``). This tier has no such isolation — it runs
    against a real local hub holding real accounts and hand-made rows — so it
    reclaims only ids it watched appear. Snapshot-diff rather than per-test
    tracking: the tier creates rows through several paths
    (``Conversation.share``, raw ``POST /graph/<type>``, invitation
    materialization), and a diff catches all of them without every test opting
    in.

    The id list rides pytest's own cross-run cache (``.pytest_cache``), so no
    new state file and no bookkeeping to forget.

    Reclaiming is best-effort by design: a failure here must never turn a green
    tier red. A row owned by an identity we hold no token for legitimately
    survives and stays in the ledger for a later run with the right identity;
    an already-absent row counts as reclaimed.
    """
    tokens = _cleanup_identities()
    base = _configured_hub_base_url()
    cache = request.config.cache

    # Reclaim what the previous session left, before this one adds to it.
    stale = cache.get(_LEFTOVER_CACHE_KEY, None) or []
    reclaimed = 0
    unreclaimed: list[dict[str, str]] = []
    for entry in stale:
        kind, entity_id = (entry.get("type"), entry.get("id")) if isinstance(entry, dict) else (None, None)
        if kind and entity_id and _delete_entity(base, kind, entity_id, tokens):
            reclaimed += 1
        elif kind and entity_id:
            unreclaimed.append({"type": kind, "id": entity_id})
    if stale:
        cache.set(_LEFTOVER_CACHE_KEY, unreclaimed)
        print(f"\n[hub-cleanup] reclaimed {reclaimed}/{len(stale)} row(s) left by the previous run")

    before = {(t, kind): _live_ids(t, kind) for t in tokens for kind in _CLEANUP_TYPES}

    yield

    created: list[dict[str, str]] = []
    for token in tokens:
        for kind in _CLEANUP_TYPES:
            for entity_id in _live_ids(token, kind) - before.get((token, kind), set()):
                if not any(c["id"] == entity_id for c in created):
                    created.append({"type": kind, "id": entity_id})
    tracked = list(unreclaimed)
    for entry in created:
        if entry not in tracked:
            tracked.append(entry)
    if tracked:
        cache.set(_LEFTOVER_CACHE_KEY, tracked)
    if created:
        tally = ", ".join(
            f"{sum(1 for c in created if c['type'] == k)} {k}"
            for k in _CLEANUP_TYPES
            if any(c["type"] == k for c in created)
        )
        print(f"\n[hub-cleanup] recorded {tally} for reclaim on the next run (left on the hub to debug)")
