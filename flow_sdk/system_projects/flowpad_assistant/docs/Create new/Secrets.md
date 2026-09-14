---
id: d0adf7f1-c472-466d-8ac1-b05272da8e02
title: Secrets
---

# Secrets

A **secret** is a named pack of environment variables — an API key, or an
address plus a password. Agents and terminals receive every variable in it;
the values never appear in a prompt or in your project's history.

## Scope

- **This project** (default) — only this project's agents and terminals get it; the pack travels with the project.
- **All my projects** — kept in your home folder; every project on this machine gets it.
- If both declare the same variable, the project's value wins.

## Storage

- **.env.local** (default) — a plain file next to the pack, excluded from git; Flowpad never deletes its lines.
- **Encrypted vault** — the same values, encrypted on this machine instead of written to a file.
- Values never leave your machine either way.

## Adding one

**Connections → Add connection** offers known providers and **Custom API key**;
**Create new → Secret** opens the same form. Keys already in a `.env.local` are
listed under Connections — select them and **Pack** them into one secret.
Only variables in a pack reach agents and terminals.
