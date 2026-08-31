# Mapping a request onto a source

> **Ground rules (inline by design):** evidence never events · read before you
> poke · never widen a wait · never destroy the user's data · credentials are
> the user's step.

## The decision, as one falsifiable question

> **Is there an installed spec whose `name` resolves to a driver AND whose
> `config` can express the thing the user named, as a segment?**

Yes → reuse it. No → `modes/author.md`. "Close enough" is not reuse.

## Aliases a name match misses

| The user says | Source |
| --- | --- |
| blog, newsletter, podcast, feed, any URL ending `feed`/`rss`/`atom`/`.xml` | `rss` |
| repo, this project's commits, a branch | `git` |
| a folder, this directory, files on my disk | `folder` |
| my email, mailbox, gmail, my inbox | `agent` — see below. Only ask when no harness can run |
| a Slack channel (`C…`) | `agent` with `connector: slack` — see below. The API driver `slack` is the fallback when no harness can run (it needs its own OAuth + bot invite) |

A local git checkout is `git` if they care about commits and `folder` if they
care about files. Ask only when the answer changes the config.

## Mail: pick the transport, do not put it to the user

Three sources can read a mailbox, and they differ by **who holds the credential**
— which is a fact you can check, not a preference to poll the user about.

`agent` is the answer whenever a harness can run. Its fetch is a worker, so it
reads the mailbox through a connector the person **already authorised** in their
harness: nothing to paste, nothing to configure, no OAuth round trip. Confirm the
harness rather than assume it — `ensure_launchable(<harness>)` is the same cheap
pre-flight the driver itself runs, and a missing or logged-out harness is exactly
the case where the three-way question becomes real.

```json
{"provider": "agent", "config": {"connector": "gmail", "harness": "claude",
                                 "segments": ["INBOX"]}}
```

Slack rides the same transport with a different connector — the worker reads
the channels through the Slack connector the person already authorised in
their harness, so there is no OAuth round trip and no bot to invite:

```json
{"provider": "agent", "config": {"connector": "slack", "harness": "claude",
                                 "segments": ["C0123ABCD"]}}
```

* `segments` are channel **IDs** (`C…`), never names, and for slack they are
  **required** — a channel id cannot be guessed the way mail assumes `INBOX`.
  In Slack: click the channel name; the ID is at the bottom of the panel.

* **`connector` is the channel AND half of every thread key.** Leaving it empty
  forks every thread in the mailbox, permanently — there is no repair pass.
* **`harness`** is the worker CLI that runs the fetch. Without a launchable one
  the source parks on `config_error`, which reads like a broken mailbox and is
  not one.
* `segments` defaults to `INBOX`; `max_items` (advanced) caps a single run.

Reach for `cloud_email` or `agentmail` only when the person names a mailbox the
hub allocates, or when no harness is available. `references/process-sdk.md` has
what else is true of a source whose fetch is a process — in particular why its
sync result reports zero created rows on success.

## Filling `config` without interrogating the user

Walk `config` in declaration order — that is the form order.

- **Ask only** for fields that are `required: true` **and** not derivable from
  what the user already said. Never ask about `advanced: true` fields.
- **Omit empty values.** Every optional key has a real driver default, and an
  empty string OVERRIDES it.
- **Type by `type`**: `lines` splits on newlines, `csv` on commas, `number`
  becomes a number, `text`/`path` pass through. Trim; drop blanks.
- **Check `pattern` before sending**, per value for multi-value fields, and name
  the exact offending entries. The pattern exists so a bad value fails at the
  form rather than at verify.
- **`account_key`** = the first value of the first field flagged
  `account_key: true`. Blank when no field carries it (Slack — the workspace
  belongs to the connection).
- **Never set `kind` or `channel`.** The sync loop stamps both from the driver on
  the first poll; a value set here looks authoritative, is owned by nobody, and
  is silently corrected later.
- **Files vs records**: if the spec offers `reflect` modes, pick one (the head is
  the default) and for `copy`/`symlink` set `reflect_into` to an absolute project
  directory — without it nothing is placed and the source still reads healthy.

## Name it, don't ask about it

Derive a human name from the request ("Hacker News — top stories") and confirm it
in the same breath as the one field you genuinely need. A separate turn to ask
for a display name is a turn wasted.

<!-- flowpad:capsule identity
version: 1
data:
  id: ab90dccb-3576-434c-8e47-3b8004724abc
flowpad:endcapsule identity -->
