---
id: c6dd1677-6502-4d36-95e8-5036b01e58bc
---
# Topic: a typed service agent

> **Ground rules (inline by design, repeated in every mode and topic file):**
> **1. The user decides; you propose.** Ask one short batch of questions, then write
> only what they agreed to — a guessed persona is a rewrite later.
> **2. You write files; the user clicks.** For an in-app step, open the screen with
> `flow show` and give numbered clicks from `references/screens.md`, then report the
> step as done once the user confirms it — only they can see the screen.
> **3. Only enforced fields do work.** A field marked *declared* in
> `references/agent-json.md` is saved but never applied — put every hard limit in the
> prompt and in `permission_mode`.
> **4. Done means a reply the user saw.** An agent is finished after a test round the
> user ran (`references/validation-loop.md`), not when its files exist.
> **5. Deploying, credentials, email and phone reach real people.** Do them only on
> the user's explicit go, after saying who will be reachable.

Code calls this agent like a function: a value in, a value out. The caller passes an
`input`, the agent writes an `output` of a declared shape, and the call returns it.

## Ask

- What goes in? Name each field and its type.
- What must come back? Name each field and its type — this is the contract the
  caller codes against.
- What should it do when the input is valid but it cannot produce an answer?

## Build

1. Declare the shapes in `agent.json` (`references/agent-json.md` → *Shape forms*):
   ```json
   { "input": { "cv_text": "string" }, "output": { "score": "int", "reasons": ["string"] } }
   ```
2. The prompt says what the job is and how to judge the input. It does not need to
   describe the output files — the run tells the agent the exact layout to write.
3. A call with an input that does not match `input` is refused before anything runs;
   a run that writes no output, or the wrong shape, comes back as not-yet with the
   reason, never as a half value.

## The call

Show the user a runnable snippet with `flow show snippet`, run it yourself once with
`flow snippet run <path>`, then let them press Run. The file runs as written, so it is
a whole program:

```bash
flow show snippet --lang py --name call-<name> <<'SNIP'
# %% flowpad:hidden
import asyncio
from flow_sdk.builtin.agent import Agent
from flow_sdk.schema.data_spec import DataSpec
# %% flowpad:snippet
async def main():
    agent = await Agent.by_name("<name>")
    CvIn = DataSpec.parse(agent.input)        # the declared input shape, as a class
    answer = await agent.launch("Score this CV", input=CvIn(cv_text="…"), wait=True)
    print(answer.ok)       # True when the output matched the declared shape
    print(answer.value)    # the output, loaded as the declared shape
    print(answer.text)     # the agent's last message

asyncio.run(main())
SNIP
```

- `input` is a DataSpec instance — today a plain dict fails before the run.
  Build it from the declared shape as above, or pass your own DataSpec class.
- Without `output_spec=`, the agent's declared `output` applies; pass
  `output_spec=` to ask for a different shape on one call.
- The same contract without a saved agent is `AgenticProcess.run(instruction,
  input=..., output_spec=...)`.
- From TypeScript, `Agent.run(prompt)` takes a prompt only — typed input and output
  are Python-side today. Say so if the user's caller is a web page.
- Worked example with a CV shape, in a Flowpad source checkout only:
  `docs/snippets/processes.md`, section *Typed folder in, typed folder out*.

## Test

Have the user press Run three times, changing only the input: a normal input
(expect the value), an input of the wrong shape (expect a refusal before the run), and
an edge case the prompt must handle (expect a sensible value or a clear not-yet).
