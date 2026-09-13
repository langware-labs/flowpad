# Staging OAuth validation — 2026-09-13

Validated using Chrome profile `langware.ai` / `eran@langware.ai` against
`https://staging.flowpad.ai`, with hub 0.29.113 and Flowpad 0.2.166.
The hub repository is `langware-labs/flowpad-hub` in sibling
`test_flowpad/FlowPad`, not the OSS hub stub.

## Result

All eight OAuth providers passed live credential probes locally and from a
fresh staging cloud sandbox. All eight browser rows became Connected without
refresh. Reopening the sandbox through the hub preserved its standard user
JWT, refresh token, and all eight working connections; the repeated live
probes also passed. The hub card updated to the signed-in account without refresh.

| Provider | Local probe | Fresh sandbox probe | After reopen | Identity |
| --- | --- | --- | --- | --- |
| Anthropic | Pass | Pass | Pass | eran@langware.ai |
| Atlassian | Pass | Pass | Pass | eran@langware.ai |
| Flowpad OAuth | Pass | Pass | Pass | eran@langware.ai |
| GitHub | Pass | Pass | Pass | serans1 |
| GitLab | Pass | Pass | Pass | eran@langware.ai |
| Linear | Pass | Pass | Pass | eran@langware.ai |
| Notion | Pass | Pass | Pass | eran@langware.ai |
| Slack | Pass | Pass | Pass | eran |

The six hub-backed providers adopted existing approved grants with one click.
Flowpad OAuth completed its remote PKCE callback with one click. Anthropic
completed its provider-hosted authorization-code handoff; its initial sandbox
connection requires pasting the returned code. It is working, but that initial
handoff is not literally one click. CLI logins for Claude/Codex/Copilot are
separate credentials and are not covered by this OAuth matrix.

## Standard sandbox login

Created `OAuth 0.29.113 standard login validation` with auto-login disabled.
Verified it started logged out, clicked FlowPad Connect, and observed Connected
and the Eran profile without refreshing. The stored credential is a JWT with a
refresh token. Owner-validated PKCE callbacks target the actual sandbox host.
Reopening does not replace the explicit user login with a delegated node key.

- Hub entity: `70d5f38d-8f0b-43fc-93c8-67fef9ce7624`
- E2B sandbox: `ier6a24xyd08p24i6nsrv` (same before and after reopen)
- App: `0.2.166`; staging hub: `0.29.113`
- Open: https://staging.flowpad.ai/api/v1/graph/compute_node/70d5f38d-8f0b-43fc-93c8-67fef9ce7624/open-service/workspace

Delegated auto-login keys retain their existing restrictions on personal OAuth.
Authenticated policy refusals now return 403; invalid credentials still return
401. The SDK preserves login on permission refusal and displays connection
access denial. Regression tests cover both statuses and actual token rejection.
The old restricted test sandbox was already logged out at the final revisit,
so that revisit does not constitute a new live permission-denial test.

## Release and verification

- Published app 0.2.166 wheel and sdist; verified hashes and a clean PyPI install.
- App CI: https://github.com/langware-labs/flowpad/actions/runs/34725318664
- Hub CI: https://github.com/langware-labs/flowpad-hub/actions/runs/34726659107
- Staging deployment and post-deploy checks: https://github.com/langware-labs/flowpad-hub/actions/runs/34726681973
- All three 0.2.166 E2B template sizes built and passed validation.
- Small template: `ybri8yxkn7p18wxptcng`; medium: `8hlg3q21zu22ilkvgho4`;
  large: `fm7b7h40kay6m8r8i00p`.
- Focused app backend tests: 51 passed; SDK tests: 10 passed; typecheck passed.
- Focused hub denial tests: 151 passed, 1 skipped; identity tests: 7 passed;
  root-write denial regression: 1 passed. Full hub CI passed.

An initial launch during load-balancer deployment cutover returned 502. Once
the deployment completed, launch and the complete validation succeeded. The
orphan sandbox from that failed launch was removed. No timeout or retry budgets
were increased. Production was not deployed.

Probe evidence is committed alongside this report. Probes establish accepted
credentials and expected identities; they do not exercise every provider API
operation or guarantee future provider availability/token revocation behavior.
