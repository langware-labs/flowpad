---
id: 8b2d61f0-4e93-4c17-a5d2-9d1c73f0a26b
---

# The four sources that need a credential — by hand

`backend_served_sources.md` automates `rss`, `hackernews`, `folder` and `git`, which are
every source that can be created with nothing but a form. The other four each need a secret
a test cannot mint, so they are verified here instead:

| Source | What it needs | Where it comes from |
|---|---|---|
| `slack` | a workspace bot token AND the bot invited to each channel | a real Slack workspace |
| `agent` | a worker harness plus an MCP connector for the channel | a logged-in Claude/Codex CLI |
| `agentmail` | an AgentMail API key | the AgentMail dashboard |
| `cloud_email` | a cloud login on this instance | `flow cloud login` |
| `gdrive` | a Google connection, scope `drive.readonly` | a Google Cloud OAuth client |

Automating any of them would mean either mocking the provider — which proves nothing about
the provider — or checking a live secret into the repo. Both are worse than a checklist.

**What is already proven by the automated suite** and does NOT need repeating here: the
dialog renders whatever is installed, the fields come from the manifest, `pattern`
validation blocks a bad value, and a source round-trips to a card. These four add exactly
one question each: does the *credential* path work.

## Before you start

An instance with the assistant project indexed (`scripts/instance_ctl.sh launch dev-1`),
open at `/dock/data-sources`. Confirm the provider grid shows all eight — if `slack` or
`agent` is missing, the manifests did not index and nothing below is meaningful.

## slack

1. Add → **Slack**. The form asks for channel ids, and the account key is deliberately
   EMPTY — the workspace belongs to the connection, not the form.
2. Enter one channel id (`C…`). A value that is not a channel id must be rejected by the
   manifest's `pattern` before the button enables.
3. Save. The card must land in **setup**, not active — Slack has a `verify` step.
4. Press **Verify** with the bot NOT yet invited. Expect a refusal naming the channel, in
   words a person can act on ("invite the Flowpad bot to #eng").
5. Invite the bot, press Verify again. The card moves to **active**.
6. Wait one heartbeat (or force a poll). Messages appear as records; the segment count
   matches the number of channels.

## agent

1. Add → **Agent transport**. Its `connector` field is what names the channel — an agent
   source with `connector: gmail` shows `gmail` on the card while its provider stays `agent`.
2. Save with no harness available. Expect the card to say so rather than polling forever.
3. With a logged-in worker CLI and the connector installed, Verify, then poll.
4. Confirm the card's channel badge reads the CONNECTOR, not `agent`. This is the one
   behaviour no other source exercises.

## agentmail

1. Add → **AgentMail**. The API key does NOT appear in the form — the `inbox` field is
   `account_key: true` and the secret belongs to the connection (same contract as slack).
   A plaintext key field reappearing here is the regression to catch.
2. Save, Verify, poll. Messages land as records.
3. Reopen the source for editing. The key must NOT be echoed back into the form.

## cloud_email

1. On an instance that is NOT cloud-logged-in, add → **Cloud mailbox** and save. Expect a
   config error naming the missing login.
2. `flow cloud login`, then Verify. The card moves to active without re-entering anything —
   the credential belongs to the instance, not to the source.

## gdrive

The only source that needs something this repo does not ship: **a registered Google OAuth
client**. `provider_registry.GOOGLE` deliberately has `client_id_default=None`, so the flow
reports a missing client rather than half-running. Create an OAuth client of type *Desktop
app* in a Google Cloud project, enable the Drive API, and export `GOOGLE_CLIENT_ID` before
starting the backend.

Its UNCREDENTIALED half is automated (`backend_served_sources.md` test 9): the source is
creatable, lands in `setup`, and Verify names Google. Everything below is what only a real
connection can prove.

1. Connections → **Google** → connect. The consent screen must ask for
   `drive.readonly` and nothing more — a broader scope means the registry and the client's
   configured scopes disagree, and a read-only source must never hold write access.
2. Back on the source, press **Verify**. It moves to **active**.
3. Poll. Files appear under the instance's `gdrive/<source-id>/` cache, and in project
   search once the indexer types them.
4. **Rename a file in Drive**, then poll again. The asset must keep its identity — this is
   the whole reason `origin_id` is the Drive `fileId` and not a path or an inode. A second
   asset appearing under the new name is the failure this step exists to catch.
5. **Trash a file in Drive**, then poll. It disappears locally. Drive REPORTS the deletion,
   so this must work without a re-enumeration.
6. Add a **Google Doc**. It arrives as `.md` — Google-native formats have no bytes and are
   exported. Add a Google **Form**; it is skipped, and the skip is logged, not silent.
7. Confirm nothing in the cache carries an identity capsule. `stamps_identity = False`
   because the next download overwrites the file.

## Recording a run

Note the date, the instance, and for each source: created / verified / polled / records
landed. A source that could not be exercised (no workspace, no key) is recorded as
**skipped**, never as passed.
