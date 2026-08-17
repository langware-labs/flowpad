---
id: d0adf7f1-c472-466d-8ac1-b05272da8e02
title: Project secrets
---

# Project secrets

A **secret binding** attaches one of your saved secrets to a project under an
**environment variable name**. When an agent session, a terminal, or a git
command runs in that project, the value is injected into the process
environment — so it can be used without the key ever appearing in a prompt, a
file, or your project's history.

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

By default, on this machine only — in an encrypted file inside this Flowpad
instance's own directory, with the key in your OS keychain. Nothing reads a
value back out over the network, and the value is resolved only at the moment a
process that needs it is launched.

A project may also keep values in a `.env.local` at its root, which is what most
projects already use. Flowpad reads it, never writes over your entries, and
never removes one. Because that file is plain text, Flowpad refuses to store a
value there unless git is genuinely excluding it — including the case people
miss, where the file is already **tracked**, so adding it to `.gitignore` no
longer helps.

You can also choose to put a value **in the cloud**, where it belongs to the
project rather than to your machine. That is always something you do
deliberately, per secret, and "delete from cloud" removes it from there and
nowhere else — your local copy stays.

## Good to know

- **Sharing carries the list, never the values.** A shared project brings its
  secret *names* with it, so the other person can see what the project needs and
  is told which ones they are missing. No value ever travels.
- **The env var name is the secret's identity.** Declaring the same name again
  edits the existing entry rather than making a second one — which is what lets
  a value move between `.env.local`, your keychain, and the cloud without the
  binding breaking.
- **Removing a binding keeps the secret.** Unbinding detaches it from the
  project; the saved secret and its value stay.
- **An explicitly-set variable wins.** If a session already has that env var
  set, the binding doesn't overwrite it.
- **A machine sees only what you attach.** On the machine's Secrets tab you can
  narrow which of the project's secrets that machine can use. Until you narrow
  it, it can use all of them.
