---
id: 693faf6d-36b9-4acd-ba2b-1e94b946141a
name: cred-scan
description: >-
  The credentials scanner — finds every credential and must-have setting a
  development project needs and declares them as Credential assets. Scans env
  templates and env files (keys only), code that reads env vars in any language,
  settings schemas, SDK dependencies that read keys on their own, docker-compose,
  Dockerfiles, Terraform, CI workflows, tests, scripts and credential files; flags
  hardcoded secrets; classifies each variable MUST (the app will not work without
  it), USEFUL (important optional) or EXTRA (expert tuning); then bundles MUST and
  USEFUL into CredentialSpec folders and indexes them. Use for "what credentials /
  env vars / API keys does this project need", "scan this repo for secrets",
  "declare this project's credentials", "set up the .env for this repo", "which
  keys do I need to run this", or `cred-scan`. NOT for filling in values (`flow
  credentials set`, the project setup wizard), connecting a data source
  (connect-data-source), or Flowpad itself being broken (flow-diagnose).
tags: ''
version: 1
---

# cred-scan

A project's credentials are scattered across a dozen kinds of file. This skill
collects them into one reviewed list and turns the part a person must supply into
Credential assets — `agentic-assets/credential/<name>/credential.json` + `setup.md`
— that Flowpad's Credentials screen and setup wizard already know how to fill.

> **Ground rules (inline by design, repeated in every phase file):**
> **1. Names and places, never values.** A value is never printed, quoted, written
> into a manifest or a report. Env files are read for their keys only. A leaked
> secret is reported as file:line and kind.
> **2. Evidence before tier.** Every tier and every bundle cites the file:line that
> earned it; a guess is labelled a guess.
> **3. The user approves before anything is written.** Phase 2 ends at a review
> table; phase 3 starts only on their go.
> **4. Re-running converges.** A credential is found by name and updated in place,
> never declared twice.

## Phases — run in order, each loads its own file

| Phase | Load | Ends with |
| --- | --- | --- |
| 1 · Scan | `phases/1-scan.md` | the inventory JSON + the judgment sweep's additions |
| 2 · Classify | `phases/2-classify.md` | the review table (MUST / USEFUL / EXTRA) and the alerts, then a stop for the user's go |
| 3 · Bundle | `phases/3-bundle.md` | declared, indexed CredentialSpec folders, verified and shown |

A bare `cred-scan` runs all three, stopping at the phase-2 review. `cred-scan
report` stops there for good — nothing is declared.

## Reference

| When you need to… | Load |
| --- | --- |
| run the mechanical inventory, or read what is already declared | `scripts/cred_scan.py` (`scan [root]`, `declared`) |
| know every place a credential can hide and what each one proves | `references/sources.md` |
| know which dependency reads which variable on its own | `references/sdk-implicit.md` |
| know what a CredentialSpec may declare | `flow_sdk/schema/data_spec/credential_spec.py` (repo) |
| show the result to the user | the `flowpad-navigation` skill |
