# Mapping a request onto a source

> **Ground rules (inline by design):** evidence never events · read before you
> poke · never widen a wait · never destroy the user's data · credentials are
> the user's step.

## The decision, as one falsifiable question

> **Is there an installed spec whose `name` resolves to a driver AND whose
> `config_schema` can express the thing the user named, as a segment?**

Yes → reuse it. No → `modes/author.md`. "Close enough" is not reuse.

## Aliases a name match misses

| The user says | Source |
| --- | --- |
| blog, newsletter, podcast, feed, any URL ending `feed`/`rss`/`atom`/`.xml` | `rss` |
| repo, this project's commits, a branch | `git` |
| a folder, this directory, files on my disk | `folder` |
| my email, mailbox, gmail | three transports differing only in credential — **ask which account**, do not guess |
| a Slack channel (`C…`) | `slack` |

A local git checkout is `git` if they care about commits and `folder` if they
care about files. Ask only when the answer changes the config.

## Filling `config` without interrogating the user

Walk `config_schema` in declaration order — that is the form order.

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
