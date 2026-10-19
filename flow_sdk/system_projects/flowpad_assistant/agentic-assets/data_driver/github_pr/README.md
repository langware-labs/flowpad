# GitHub PRs (`github_pr`)

Each open pull request assigned to you (or waiting on your review) is a **conversation**; what
happens on it is the **messages**:

| On GitHub | The message | Key |
| --- | --- | --- |
| an issue comment | its body | `comment-<id>` |
| a review comment (on a line) | its body, `in_reply_to` its thread's parent | `review-comment-<id>` |
| a submitted review | its body, or `dana approved` / `requested changes` | `review-<id>` |
| an assignment | `dana assigned you` | `event-<id>` |
| a pushed commit | `serans1 pushed 1 commit: <subject>` | `commit-<sha>` |
| a force-push, merge, close, reopen | `dana force-pushed`, `merged`, `closed`, `reopened` | `event-<id>` |
| the head commit's checks, once all finished | `CI passed · 3 checks` / `CI failed · 1 of 3 checks` | `check-<head sha>` |

The conversation's address is `<owner>/<repo>#<n>` and its subject is the PR title. Replying
to a review comment answers in its thread; replying to anything else, or sending, posts an
issue comment on the PR.

## Setup

Connect **GitHub** first (the `github` connection). The driver needs the `repo` and
`read:org` scopes; **Verify** names a missing one, and says "GitHub sign-in is missing or
expired" when there is no token or GitHub refuses it.

## Config

- **Start a conversation when a PR is** — `assigned` (default) or `review_requested`.
- **Repositories** — `owner/repo`, one per line; empty reads every repository you can reach.
- **API base URL** (advanced) — `https://api.github.com` by default; a GitHub Enterprise
  server's `/api/v3`, or a test double.

## How it reads

Polling. A pass searches `is:pr is:open assignee:@me` (or `review-requested:@me`, plus a
`repo:` per configured repository) sorted by `updated`, 30 PRs a search page, and reads each
PR's comments, review comments, reviews, timeline and check runs (one page of 100 each). The
resume cursor is the newest `updated` seen; the next pass narrows to `updated:>=<mark>`, so a
PR is re-read whenever anything on it changes and its messages keep their keys.

A rate-limited 403 (or a 429/5xx) is transient — the next pass retries; a 401 or any other 403
stops the source as an access error.

Webhooks (`pull_request`, `issue_comment`, `pull_request_review`, `check_suite`) are a later
piece of work.

## Tests

`pytest tests/` — the conformance kit and wire cases over a loopback GitHub (`_FakeGithub`);
`tests/matrix.py` is the data source matrix's `Double`.
