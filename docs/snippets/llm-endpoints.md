# LLM endpoints — snippets

An `LLMEndpoint` is one answer to "who pays for these tokens". There are three kinds
(`LLMEndpointKind`) and they differ only in where the credential lives:

| `kind` | Credential | Stored here? | Callable in-process? |
| --- | --- | --- | --- |
| `api_key` | a provider key in this machine's sod store, or the environment | yes, one row per key | yes |
| `hub` | this box's hub login; the hub swaps in the real provider key | no — a projection of a hub row | yes |
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
reply = await endpoint.create_completion(
    "You answer with a single digit.",
    "What is four minus one?",
    model=endpoint.models["sm"],
)

data = await endpoint.create_completion(sys, user, json_reply=True)   # parsed, fences stripped
async for chunk in await endpoint.create_completion(sys, user, stream=True):
    print(chunk, end="")
```

## 6. Embeddings, catalogs and probes

```python
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
