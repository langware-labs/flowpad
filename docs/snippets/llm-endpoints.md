---
id: d2bc12cb-44c1-451a-bf3c-89fc71d2d445
---
# LLM endpoints — snippets

An `LLMEndpoint` is one answer to "who pays for these tokens". There are three kinds
(`LLMEndpointKind`) and they differ only in where the credential lives:

| `kind` | Credential | Stored here? | Callable in-process? |
| --- | --- | --- | --- |
| `api_key` | a provider key in this machine's sod store, or the environment | yes, one row per key | yes |
| `hub` | this box's hub login — or nothing at all, for a **public** endpoint (§7); the hub swaps in the real provider key | no — a projection of a hub row | yes |
| `device` | a vendor CLI's own OAuth session, per harness | no — derived from `Capability` | no |

Both callable kinds expose the same four calls: `create_completion`, `create_embeddings`,
`list_models`, `probe`. A device endpoint raises `LLMNotInvocable` instead. Failures raise
(`flow_sdk.external_apis.llm.errors`) rather than answering an empty string, so "your key is
wrong" and "the model said nothing" are different things.

Pinned by `tests/unit/test_llm_endpoint_rows.py` and `tests/unit/test_llm_client.py`; the
live legs are `tests/long_tests/test_llm_endpoint_live.py`, which skip without a key.

## 1. From the environment, with no database

Name a provider and you have something callable. Nothing is saved, nothing is seeded, and
the key comes from `OPENROUTER_API_KEY` (then the process config) when the sod store holds
nothing.

```python
from flow_sdk.builtin.llm_endpoint import LLMEndpoint

llm = LLMEndpoint(provider="openrouter")          # kind=api_key, base_url and models filled in
vectors = await llm.create_embeddings(["a hot day in July", "a cold night in January"])
answer = await llm.create_completion("You answer in one word.", "Capital of France?")
```

The provider's dialect supplies the base URL and the `{sm, md, lg, embedding}` slugs, so
neither has to be spelled out. Pass a key explicitly when you do not want the environment
consulted at all:

```python
llm = LLMEndpoint(provider="openai", api_key="sk-…")   # never stored, never dumped, never shared
```

## 2. Store a key and get its row

The row is the durable half; the key itself stays in the encrypted sod store and the row
only names it. `ensure_for_secret` is find-or-mint, idempotent by lookup on that name.

```python
from flow_sdk.builtin.llm_endpoint import LLMEndpoint
from flow_sdk.lm_api import set_lm_api

set_lm_api("sk-or-…", "openrouter")
endpoint = await LLMEndpoint.ensure_for_secret("openrouter")   # same row on every re-run
assert endpoint.secret_name == "lm_api.openrouter"

same = await LLMEndpoint.find_by_secret("lm_api.openrouter")   # None when nothing is stored yet
```

`find_by_secret` is a query, not an id derived from the name. That is deliberate: a lookup
converges on the row that already exists, including rows minted before any naming rule, and
it keeps the id from encoding a fact about the thing it names.

## 3. List what can fund this box

```python
from flow_sdk.builtin.llm_endpoint import LLMEndpoint
from flow_sdk.instance_settings.llm_endpoint import fetch_hub_llm_endpoints

local = await LLMEndpoint.key_endpoints()    # {secret_name: endpoint}, keys on this machine
hub = await fetch_hub_llm_endpoints()        # budgets the hub offers
```

`fetch_hub_llm_endpoints` answers `[]` when logged out or unreachable, and serves a 30-second
memo — a picker that cannot reach the hub should show nothing, not fail the screen it sits on.
A **public** endpoint (§7) is never in this listing, signed in or not: it is spendable by people
who hold nothing on it, so a box learns of one only from the id it was given.

Both are Python-side reads. `llm_endpoint` is not API-visible yet, so a local key endpoint has
no live entity query behind it; the frontend gets these through the funding status action.

## 4. What a harness will actually use

The resolver ranks every candidate for one harness and explains the ones it ruled out. An
ineligible source carries the sentence saying why, and that sentence is what the picker and
the spawn error both render.

```python
from flow_sdk.builtin.agentic_process.cli_drivers.llm_source import (
    list_llm_candidates,
    resolve_box_llm_endpoint,
)

endpoint, verdict = await resolve_box_llm_endpoint("claude")
for endpoint, verdict in await list_llm_candidates("claude"):
    print(endpoint.kind, endpoint.provider, verdict.eligible, verdict.reason)
```

A candidate is a pair: the endpoint, and this harness's verdict on it. They travel together
because a verdict names an endpoint and mirrors none of its fields, so rendering a row or
funding a spawn needs both. `list_llm_sources` returns the verdicts alone when that is all
you want.

## 5. Completions

`model` defaults to the endpoint's `md` slug; name a tier to pick a cheaper or stronger one.

```python
endpoint = await LLMEndpoint.ensure_for_secret("openrouter")   # the key stored in §2
reply = await endpoint.create_completion(
    "You answer with a single digit.",
    "What is four minus one?",
    model=endpoint.models["sm"],
)

system, user = "Answer as JSON.", 'Give {"answer": 3}.'
data = await endpoint.create_completion(system, user, json_reply=True)   # parsed, fences stripped
async for chunk in await endpoint.create_completion(system, user, stream=True):
    print(chunk, end="")
```

## 6. Embeddings, catalogs and probes

```python
texts = ["a hot day in July", "a cold night in January"]
vectors = await endpoint.create_embeddings(texts)          # one vector per text, in order
models = await endpoint.list_models(embeddings_only=True)  # OpenRouter filters server-side
result = await endpoint.probe()                            # {ok, status, message}; never raises
```

Batching is automatic at 2048 inputs per request. Anthropic has no embeddings API, so it
raises `LLMNotSupported` rather than failing at the transport.

```python
from flow_sdk.external_apis.llm.errors import LLMAuthError, LLMNoCredential, LLMRateLimited

try:
    await endpoint.create_embeddings(texts)
except LLMNoCredential:
    ...   # nothing stored and nothing in the environment
except LLMAuthError:
    ...   # the provider rejected the key
except LLMRateLimited:
    ...   # throttled, or the hub budget is spent
```

## 7. A public endpoint: run on a machine that never logged in

A hub endpoint can be opened to **whoever holds its id**. That is what lets a foreign machine —
a colleague's laptop, a CI box, a container — run agents on your budget with no account, no
key and no login. Two commands, on a box with nothing but `pip install flowpad` and a harness CLI:

```bash
flow llm user use <endpoint-id> --hub https://<your hub>    # --hub defaults to this box's hub
python agentic_process_snippet.py
```

```python
"""Ask a headless agent one question, on a machine that has never logged in to anything.

The whole setup is the command before this one -- ``flow llm user use <public-endpoint-id>`` --
which points the box at a PUBLIC hub ``LLMEndpoint``. Nothing here names a budget, a key or a
hub: the process is funded by whatever the box resolves, exactly as on a signed-in machine.
"""

import asyncio
import tempfile

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.agentic_process.status_predicates import is_turn_busy
from flow_sdk.flowpad_types.enums import WorkerType

PROMPT = 'Reply with exactly the single word "pong" and nothing else.'


async def main() -> None:
    process = await AgenticProcess(
        worker_type=WorkerType.CLAUDE_CODE,
        workdir=tempfile.mkdtemp(),
        cli_config={"model": "sm", "permission_mode": "bypassPermissions"},
        pty_mode=False,  # print mode: one spawn, one turn, then done
        visible=False,
        load_flowpad_assistant=False,
    ).save()
    try:
        await process.prompt(PROMPT)
        # ``prompt()`` returning is the turn STARTING. The answer is in the history once the
        # turn is no longer busy.
        while True:
            fresh = await AgenticProcess.get_by_id(process.id) or process
            if not is_turn_busy(fresh, fresh.fetch_worker_status()):
                history = fresh.driver.load_history(fresh)
                if history:
                    break
            await asyncio.sleep(2.0)
        print(_last_answer(history))
    finally:
        await process.exit()


def _last_answer(history: list) -> str:
    """The last thing the assistant SAID -- its ``chat`` elements, not its reasoning."""
    for item in reversed(history):
        attributes = item.attributes or {}
        if attributes.get("role") == "assistant" and attributes.get("element-type") == "chat":
            return str(item.flow_value).strip()
    return ""


if __name__ == "__main__":
    asyncio.run(main())
```

Every harness is proven the same way: `SCRIPT=worker_matrix.py tests/loginless_e2e/run.sh` runs
claude, codex, copilot and opencode against three cheap open-weight models (Kimi K2.5, GLM 4.7
Flash, Qwen3 Coder 30B) after the same single bind.

Pinned by `tests/long_tests/test_loginless_in_docker.py`, which runs exactly those two commands
in a clean container (`tests/loginless_e2e/`) holding no hub key, no provider key and no
`FLOWPAD_HUB_URL`; the resolver and binding rules are pinned by
`tests/unit/test_llm_source_resolution.py` and `tests/unit/test_hub_llm_endpoint.py`. The script itself
also runs as written on any box with an LLM source of its own — `tests/long_tests/test_llm_endpoints_script.py`.

The admin's half is four hub calls (`tests/loginless_e2e/make_public_endpoint.py`) — create a
root, give it a provider key, **cap it in money**, open it:

```bash
POST /api/v1/graph/llm_endpoint                   {"name": "demo", "provider": "openrouter"}
POST /api/v1/graph/llm_endpoint/<id>/credential   {"key": "sk-or-..."}
PUT  /api/v1/graph/llm_endpoint/<id>              {"limits": {"cost_usd_total": 5.0}}
POST /api/v1/graph/llm_endpoint/<id>/public       {"enabled": true}      # false closes it again
```

What to know before handing an id out:

* **The id is the credential.** Anyone who sees it can spend the budget until its limit trips.
  Treat it like an API key; `{"enabled": false}` revokes every holder at once.
* **The cost limit is the whole defence**, so the hub refuses `public` without one. Spend is
  metered per endpoint, never per caller — there is no caller to meter. Budget for the harness,
  not the prompt: one `pong` from Claude Code is ~60k cache-write tokens (about $0.08 on haiku).
* **An anonymous caller may `invoke` and list `models`, nothing else** — not read the endpoint,
  its usage or its chain, and a public endpoint appears in no listing, so ids cannot be enumerated.
* **Pick the hosts, not just the model.** OpenRouter serves one slug from several hosts, and one
  bad host is an intermittent failure in every harness at once: Novita answered
  `qwen/qwen3-coder-30b-a3b-instruct` with an empty completion for about a third of requests, which
  surfaces as a finished turn with nothing said. `PUT {"filters": {"providers_ignore": ["Novita"]}}`
  routes the budget around it for everyone who spends it; `make_public_endpoint.py` sets it.
* **`public` is an admin action, not a field.** A `PUT {"public": true}` is ignored, and a
  sandbox key is refused: the budget must not be openable by the thing that spends it.
* On the box, a public binding is a hub endpoint that is eligible **without** a hub login
  (`flow llm list` shows it as `public endpoint`); `flow llm test <n>` spends one real token
  through it, and `flow llm user clear` drops it. A box that later signs in keeps it — a public
  endpoint is in nobody's listing, so its absence there is not a reason to drop the binding.

## Gotchas

* **A device endpoint is not callable.** `client()` raises `LLMNotInvocable`. Those are
  credentials for a terminal, not for an API client — the backend can never spend one.
* **Only `api_key` endpoints have rows.** `save()` refuses the other two: a hub endpoint is
  the hub's row and a device login is the CLI's session, so a local copy could only drift.
* **Only `hub` endpoints can be shared.** Sharing hands somebody a budget on the hub; a key
  on this machine is not one.
* **The embedding dimension is part of the model.** Changing `models["embedding"]` on an
  endpoint something already indexed against means a full re-embed, not an incremental one.
* **A hub endpoint carries no slugs of its own.** The hub does not serialize model names, so
  a hub endpoint falls back to its root provider's defaults. Name a model explicitly when the
  budget's root is not OpenRouter.
