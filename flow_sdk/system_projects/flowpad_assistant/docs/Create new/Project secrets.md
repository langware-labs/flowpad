---
id: d0adf7f1-c472-466d-8ac1-b05272da8e02
title: Project secrets
---

# Project secrets

A **secret binding** attaches one of your saved secrets to a project under an
**environment variable name**. When an agent session starts in that project,
the value is injected into the process environment — so an agent can use an API
key without the key ever appearing in a prompt, a file, or your project's
history.

A binding is not a file asset. It lives on the [[Flowpad project]] itself,
which is why the tile is disabled until a project is active — there'd be
nothing to attach it to.

## Binding one

The dialog asks for two things: the **secret** (picked from the secrets saved
on this machine) and the **env var** it should arrive as. The env var is
derived from the secret's name — uppercased, with anything that isn't a letter
or digit turned into `_` — and you can edit it. One env var can only be bound
once per project.

The first time you use secrets, Flowpad asks you to enable them, which prompts
your operating system for keychain access.

## Where values live

**Values never leave your machine.** They're stored in an encrypted file inside
this Flowpad instance's own directory, and the key that decrypts it lives in
your OS keychain. There's no endpoint that reads a secret back out — the value
is resolved only at the moment a worker process is launched.

## Good to know

- **Bindings made here are private.** A binding to a local secret is always
  private and cannot be made shared. Sharing a project never carries the value,
  and never carries the binding either.
- **Removing a binding keeps the secret.** Unbinding detaches it from the
  project; the saved secret and its value stay.
- **An explicitly-set variable wins.** If a session already has that env var
  set, the binding doesn't overwrite it.
