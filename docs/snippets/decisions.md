---
id: bc6e5a32-0014-4361-8de7-2f5d5e992e82
---
# Decisions — snippets

A **decision** is a closed question asked of some state. It generates no text: it answers
each named question from the answers the question lists, with calibrated probabilities, so
code -- not a prompt -- owns the control flow (route a ticket, gate an action, pick the screen
a typed request means).

A `DecisionSpec` is `state` plus 1–6 named questions; a `DecisionResult` is one answer per
question. It is taken through a hub **`APIEndpoint` whose `kinds` include `"decision"`** --
the hub holds the vendor key, the box finds the endpoint by what it IS, never by id.

The words are ours, matched across Jev (the one public contract), OpenAI's announced
Decisions API and plain English. A vendor's own words stop at its dialect
(`flow_sdk/external_apis/decision/`):

| ours | Jev wire | OpenAI (announced) |
| --- | --- | --- |
| `state` | `state` | "context" — taken here (`flow context`, data-context) |
| `choice` + `options` | `choice` + `criteria` | "options" |
| `score` + `levels` | `score` + `criteria` | — |
| `yes_no`, answer `probability` | `noul` | "yes/no" |
| `confidence`, `probabilities`, `usage`, `model` | same | "confidence score" |

Pinned by `tests/unit/test_decision_snippets.py` (runs every Python fence, the hub doubled)
and `ui/tests/unit/decision-snippet.test.ts` (runs every TypeScript fence). The live leg is
`tests/long_tests/test_decision_live.py`: a box signed in as a second user finds a shared
Jev endpoint by kind alone and decides (local hub; skips without `JEV_API_KEY`).

## 1. One decision

```python
from flow_sdk.decision import DecisionSpec, decide

spec = DecisionSpec(
    state={"utterance": "open data sources", "page": "/dock/home"},
    questions={
        "target": {
            "type": "choice",
            "instructions": "Which option opens what `utterance` asks for?",
            "options": {
                "view:data-sources": "Screen 'Data sources' (connectors, integrations)",
                "view:credentials": "Screen 'Credentials' (api keys, secrets)",
                "agentic": "Anything that is not a plain open",
            },
        },
    },
)
result = await decide(spec)
result.answers["target"]   # ChoiceAnswer(choice='view:data-sources', confidence=0.99, probabilities={...})
result.usage               # DecisionUsage(input_tokens=..., output_tokens=...)
result.endpoint            # 'api_endpoint-<id>' -- the one that answered
```

A question refers to fields of `state` by name, in backticks. All questions go in ONE
request: three questions are one round trip, not three. A spec is checked before any call --
a choice needs 2+ options, a score 2–10 levels, names are lower-case identifiers -- and
`extra="forbid"` refuses a vendor's word (`criteria`, `noul`) on our side.

## 2. Which endpoint answers

```python
from flow_sdk.decision import decision_endpoints

deciders = await decision_endpoints()   # [APIEndpointOffer(id, name, kinds=['decision'], host, ...)]
```

Listed the way LLM endpoints are (`instance_settings/api_endpoint.py`): the access-scoped
listing ∪ the `catalog`, because an endpoint opened to every signed-in user carries no role
edge and is in the catalog alone. Cached 30 s; `[]` when signed out, without asking.
`decide(spec)` uses the first enabled one; `decide(spec, endpoint=<id>)` names one.

An operator marks an endpoint once, on the hub (`docs/api-endpoint.md` in the hub repo):

```bash
curl -sX POST $H/api/v1/graph/api_endpoint -H "$T" -d '{"name":"Jev (TypeSafe)","kinds":["decision"],
  "target":{"base_url":"https://api.typesafe.ai","inject":{"header":"Authorization","format":"Bearer {value}"},"probe_path":"v1/models"}}'
```

## 3. The three kinds of question

```python
from flow_sdk.decision import DecisionSpec, decide

result = await decide(DecisionSpec(
    state={"ticket": "I was charged twice for October."},
    questions={
        "route": {"type": "choice", "instructions": "Where should `ticket` go?",
                  "options": {"billing": "payments, refunds, invoices", "bug": "the product is broken"}},
        "urgency": {"type": "score", "instructions": "How urgent is `ticket`?",
                    "levels": ["routine", "today", "urgent", "about to churn"]},
        "escalate": {"type": "yes_no", "instructions": "Should a human see `ticket` now?"},
    },
))
route = result.answers["route"].choice          # 'billing'
urgency = result.answers["urgency"].score       # fractional position, 0 = first level
escalate = result.answers["escalate"].probability   # probability of yes
```

A score's `probabilities` are keyed by the level's own text, not its index.

## 4. Act only when sure

```python
key = result.pick("route", min=0.85)   # the option, or None: missing, unsure, or not a choice
if key is None:
    ...   # take the ordinary path
```

The threshold is measured, not guessed: on the navigator's 50-case benchmark every answer
at ≥ 0.8 confidence was right (99/99) and answers at 0.5–0.8 were right ~58% of the time.
Not being sure is an answer -- the caller falls back, it does not act.

## 5. When it cannot answer

```python
from flow_sdk.decision import DecisionError, decide

try:
    await decide(spec)
except DecisionError as e:
    reason = e.reason   # 'invalid_spec' | 'no_endpoint' | 'rate_limited' | 'unavailable' | 'auth' | 'bad_response'
```

One closed word to branch on, a sentence for a person in `e.message`. A decision is an
optimisation, never a dependency: every reason means "take the ordinary path".

## 6. The same in TypeScript

```ts
import { decide, decisionEndpoints, pick } from '@sdk/decision';

const deciders = await decisionEndpoints();
const result = await decide({
  state: { utterance: 'open data sources', page: '/dock/home' },
  questions: {
    target: {
      type: 'choice',
      instructions: 'Which option opens what `utterance` asks for?',
      options: { 'view:data-sources': "Screen 'Data sources'", agentic: 'Anything that is not a plain open' },
    },
  },
});
const target = pick(result, 'target', { min: 0.85 });   // 'view:data-sources' | null
```

Through the box (`compute_node/@local/decision`), which adds its own hub login: the browser
holds neither a hub key nor the vendor's. A failure throws `DecisionError` with the same
closed `reason`. The types mirror `decision_spec.py` by hand, kept in step by
`tests/unit/test_decision_ts_parity.py`.

## 7. The magic line: open now, or ask

```python
from flow_sdk.core.navigator import route

answer = await route("open data sources", here={"view": "home", "address": "/dock/home"})
answer.route, answer.target   # ('quick', NavigationTarget(kind='view', value='data-sources'))
```

`navigator.route` is the engine of **NavigationDecision** (`flow_sdk/core/navigation_decision.py`),
which the top bar asks before starting an assistant turn (`compute_node/@local/navigation-decision`,
sending only the utterance -- the backend reads where the tab is as `navigation.here`, and answers
a dock to navigate, a UI action or app page for the UI, OR the prompt; see
`docs/navigation/navigation-spec.md`). Rules first (a URL, path, port, "search for X", an exact
screen name or alias or one typo of one, a type's name, "this project's / this session's X"), then
one decision over every place on the map, what is in context here, full-text candidates and the UI
actions, acted on at ≥ 0.85 or on a clear lead -- unless the request carries details, which go to
the assistant. **With no decision API on the hub it answers `agentic`
for everything, rules included**, so the magic line behaves exactly as before. Measured
through this function (50 cases × 3, Jev via the local hub): 100% right when it acts, 92% of
navigation handled, every reasoning request sent to the assistant, P95 329 ms.

## 8. Is a decision API available here?

The LLM sources screen shows it (`/dock/llm-sources`, the **Decision API** row): the endpoint
and its host, or why there is none. The same fact is on the funding status:

```python
from flow_sdk.builtin.agentic_process.cli_drivers.hub_endpoint_binding import funding_status

decision = (await funding_status(refresh=True)).decision
decision.available, decision.name, decision.reason
```

## 9. A decision as a wizard step

The same question as a ComputeOp — subkind `decision`, its `exe_data` the questions and what
each answer must be — so a sequence can branch on it. `input` names the scope value the
questions are about; `bind` puts the plain answer (a choice's option, a score's level, yes/no
as a bool) in scope; `when` runs a later step only while a value matches, and `on_fail: stop`
ends the run quietly when the gate is not met.

```python
from flow_sdk.core.wizard.runner import Resolved, run_wizard
from flow_sdk.schema.data_spec.compute_op_spec import CliOp, ComputeOpSpec, DecisionOp, Require
from flow_sdk.schema.data_spec.spec import DataSpec
from flow_sdk.schema.data_spec.wizard_spec import WizardSpec, WizardStepSpec


class Ticket(DataSpec):
    text: str


which_team = ComputeOpSpec(name="which-team", subkind="decision", exe_data=DecisionOp(
    input="TICKET",
    questions={"team": {"type": "choice", "instructions": "Where should `text` go?",
                        "options": {"billing": "payments, refunds, invoices", "bug": "the product is broken"}}},
    require={"team": Require(choice="billing")},
))
mark = ComputeOpSpec(name="mark", subkind="cli", exe_data=CliOp(commands={"darwin": "echo routed", "linux": "echo routed"}))
ops = {"which-team": which_team, "mark": mark}

async def resolve(name):
    return Resolved(ops[name], trusted=True)

route = WizardSpec(name="route", steps=[
    WizardStepSpec(id="route", ref="which-team", bind="TEAM", on_fail="stop"),
    WizardStepSpec(id="billing", ref="mark", when={"TEAM": "billing"}),
    WizardStepSpec(id="bugs", ref="mark", when={"TEAM": "bug"}),
])
result = await run_wizard(route, trusted=True, platform="darwin", resolve_op=resolve,
                          inputs={"TICKET": Ticket(text="I was charged twice for October.")})
result.steps["route"].met          # True
result.steps["route"].confidence   # 0.97
result.steps["billing"].ran        # True — TEAM was 'billing'
result.steps["bugs"].ran           # False — passed as not applicable
result.stopped_at                  # '' — the gate was met, nothing stopped the run
```

A verdict is never a raise: a Decision API that cannot be reached answers `met=False` with
`unavailable` naming the closed reason, and `on_fail: stop` turns that into a quiet end.

