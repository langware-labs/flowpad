---
id: 0596af1a-e794-4629-ae91-750960bc5799
title: Analytics never carries a URL secret
tags:
- breadcrumb.test.analytics_url_secrets.rules
description: GTM's tags send GA4 and Reddit the page URL with its query, and the referrer.
  So GTM loads only on the hub home and the agent/project launch page, the root redirect
  forwards only signup/login, and the invite redirect sends no referrer (FLOWPAD-2325).
---
# Analytics never carries a URL secret

> Ground truth. Proven by RCA on 2026-11-10. Do not edit without the user's approval.

```breadcrumb
tag: breadcrumb.test.analytics_url_secrets.rules
sites:
  - rel_path: "ui/tests/unit/google-tag-manager.test.ts"
    line: 19
    note: "FAILING? GTM reports each page's full URL - never allow a page whose URL can carry a secret. Read this tag's rules before editing"
  - rel_path: "ui/tests/unit/home-loader-hub-redirect.test.ts"
    line: 28
    note: "FAILING? forward only the login marker from the root query - GA4 receives the hub home URL. Read this tag's rules before editing"
  - rel_path: "ui/tests/unit/invite-page-referrer.test.tsx"
    line: 16
    note: "FAILING? keep the invite token out of the next page's referrer - GA4 sends it as dr. Read this tag's rules before editing"
```

## Expected behavior

On a hub (`isHubOnly()`), the GTM container `GTM-WHLSBH6Q` loads only on:

* `/dock/hub/home` (`HUB_HOME_PATH`);
* `/launch` when the link is an agent or project launch: `?agent=<id>` or `?project=<id>`, a valid id, and no other target named.

It loads nowhere else: not on `/invite/:token`, not on `/launch?repo=…`, not on any other route, and never on the vite dev server.

The hub home URL that GA4 receives carries no query except `?signup` or `?login`, which App removes on the same load. A page reached through the invite redirect has an empty `document.referrer`.

## Internals

* **GTM reports URLs.** The Google tag (GA4 `G-0CDD5Y5N6K`) sends `dl`, the full page URL with its query, and `dr`, the `document.referrer`, and it sends a same-origin referrer too. Once ad consent is given, the Reddit pixel (`a2_he214rs59maz`) runs on every dataLayer event. GA4's client-side redaction replaced an email address in a query with `(redacted)`, but every other param went through.
* **The allowlist.** `measured(pathname, search)`, `ui/src/utils/google-tag-manager.ts:13`. For `/launch` it asks `parseLaunchParams` (`ui/src/pages/entry/launch-target.ts:22`), the same decision the router makes in `ui/src/pages/entry/LaunchLanding.tsx:78`, which renders `AgentLaunchLanding` only for kind `agent` or `project`. Before the allowlist, that page was the only `/launch` page that loaded GTM (`useLaunchTracker` in `launch-analytics.ts` on `release/v0.2`).
* **Decided on the landed route.** `loadGoogleTagManager(pathname, search)` runs from an `AppContent` effect (`ui/src/App.tsx:153`), not at page start, because the login callback lands on `/` and only then redirects to the hub home.
* **The root redirect.** `loadHomePage` (`ui/src/routes/loaders/home-loader.ts:58-60`) forwards only `config.SIGNUP_QUERY_PARAM` or `config.LOGIN_QUERY_PARAM`. Auth0's email verification link returns to the app root with `?success=true&message=…` and may add the visitor's details. When nothing is stored, as when the link is opened in another browser, `resolveLoginCallbackUrl` (`ts_sdk/src/services/login_callback.ts`) keeps that query as the login `target_path`, and the hub appends `signup` to it.
* **The invite redirect.** `InvitePage` (`ui/src/pages/entry/InvitePage.tsx:68-73`) appends `<meta name="referrer" content="no-referrer">` before `window.location.href = redirect_url`. Without it, the landing page's `document.referrer` is `/invite/<token>`. That value lasts for the whole document, so GTM loaded later through in-app navigation still reads it.
* **A held `sign_up`.** `settleHeldSignUp` (`ui/src/utils/pending-signup.ts:47`) sends only where `measured` is true. App runs it on every route (`ui/src/App.tsx:150`), so a sign-up that landed on a page without GTM goes out when the user reaches one.

## Invariants

* A page joins `measured` only if nothing in its URL (path, query or fragment) can be a token, an email address, a private name or an id the user did not publish, and nothing navigates into it with such a page as the referrer.
* The list is an allowlist. Never turn it into a blocklist.
* A full-page navigation away from a URL that holds a secret goes with `no-referrer`.
* Once loaded, GTM stays for in-app navigation, and its history-change page views report each later in-app URL. This is accepted: no in-app link leads to `/invite/`.

## Failure modes

Measured on the dev hub with the branch build against the build before each fix, GA4 answered locally, on 2026-11-09 and 2026-11-10.

| Removed safeguard | Evidence |
|---|---|
| Allowlist (GTM on every hub page) | `/invite/<token>` loaded GTM, so the token rode in `dl` (read from the code before the allowlist) |
| Root query narrowing | `page_view` `dl=/dock/hub/home?success=true&message=…&email=(redacted)` |
| `no-referrer` on the invite redirect | `page_view` `dr=https://dev.flowpad.ai/invite/probe-token-123` |
| `/launch` limited to agent and project links | GTM loaded on `/launch?repo=<url>`, so private repository URLs rode in `dl` |
