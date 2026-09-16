# Staging OAuth validation — 2026-09-12

Validated with Chrome profile langware.ai / eran@langware.ai against
https://staging.flowpad.ai. The hub checkout is the sibling
`test_flowpad/FlowPad`, not the OSS repository's minimal hub stub.

## Deployed result

Hub 0.29.111 serves app/UI 0.2.165. Authenticated bootstrap reports
`supported_pages: ["hub"]`. Deployment and smoke tests passed:
https://github.com/langware-labs/flowpad-hub/actions/runs/34717614684.

| Provider | Local app | Staging hub | Verified identity |
| --- | --- | --- | --- |
| GitHub | Pass | Pass | serans1 |
| Slack | Pass | Pass | eran |
| GitLab | Pass | Pass | eran@langware.ai |
| Atlassian | Pass | Pass | eran@langware.ai |
| Linear | Pass | Pass | eran@langware.ai |
| Notion | Pass | Pass | eran@langware.ai |
| Anthropic | Pass | Local OAuth flow | eran@langware.ai |
| FlowPad OAuth | Pass | Local OAuth flow | eran@langware.ai |

All six hub-backed grants have actual encrypted local token copies, equal to
hub values and bound to the cloud account and staging API origin. Credential
reads resolve through the hub refresh authority and persist rotated values.

Existing approved grants were adopted locally with one provider click.
Connected status updated without refresh. Local Linear and deployed GitHub
also updated already-open observer tabs. The deployed GitHub reconnect reused
approved scopes and granted no additional organization access.

## Release evidence

- App OAuth PR #450 and version PR #451 merged; wheel and sdist 0.2.165 published,
  tagged, and verified through a clean install.
- App CI passed frontend checks, four unit shards, API and E2E suites.
- Hub PR #1137 contains the app pin, three E2B ledger entries and the compatible
  asset-projection import. Hub CI 34717145890 and security scan passed.
- All three E2B 0-2-165 template sizes passed version-specific validation.
- A fresh staging-created sandbox ran 0.2.165, auto-signed in as
  eran@langware.ai, and opened in Chrome. The disposable sandbox was deleted.

## Sandbox limitation

A sandbox's delegated auto-login key resolves to `owner_by_api`. Hub policy
intentionally forbids personal `env-var` and `oauth` operations for that role.
GitHub adoption in that sandbox was refused 401, after which the frontend
misleadingly displayed Login Required. Personal OAuth within delegated
sandboxes is therefore **not a passing scenario**. Security restrictions were
preserved; the passing cloud results above refer to the staging hub UI.

## Simplify review — 2026-09-13

Reviewed the OAuth commits for reuse, simplification, efficiency and placement.
The popup callback driver now derives provider, request and target from its
flow instead of accepting duplicate arguments. Bot-token adoption resolves
its hub credential name once. Removed obsolete comments describing uncopied
tokens. No protocol, access-policy, timeout or retry behavior changed.

## Permission-denial feedback fix — 2026-09-13 (source only)

The SDK auth interceptor no longer clears the signed-in user merely because an
entity action returns 401 or 403. Explicit token rejection still expires the
session. OAuth connection errors explain access refusal and preserve backend
messages for other failures. Sandbox authorization policy is unchanged.
Regression coverage checks both refusal statuses, real token rejection and
connection-error feedback. This follow-up has not been released to staging.
