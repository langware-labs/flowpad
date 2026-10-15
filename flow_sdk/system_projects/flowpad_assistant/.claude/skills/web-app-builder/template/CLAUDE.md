# CLAUDE.md

**This web app is managed by the FlowPad Assistant via the `web-app-builder`
skill. Call that skill for ANY operation on this project** — adding pages,
components, or endpoints, database changes, running servers, deploying. Its
reference docs are the source of truth for how this project works.

Full agent instructions, setup, and the project contracts live in
[AGENTS.md](AGENTS.md) — read it before changing anything.

Quick facts: `python3 setup.py` once (as-is); frontend `npm run dev` :3000;
backend `.venv/bin/uvicorn main:app --reload --port 8080`; DB via
`supabase start`; schema canonical in `supabase/migrations/`.


## FlowCall integration

When integrating Flowpad processing, load the shipped FlowCall guide through the docs-browse skill. A FlowCall block is a ComputeOp with declared input/output and, for Python work, call.py:call. Use the entity SDK call, preserve ReturnedValue outcomes and explicit output presence, and correlate each invocation independently. Standalone app endpoints retain their own contracts.
