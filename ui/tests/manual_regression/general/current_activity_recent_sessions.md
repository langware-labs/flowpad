---
id: 1ffbf88e-5ed8-50f1-bf4a-80a78785937e
---

Since 2026-10-11 the home is always the tabless Vibe hero (docs/viewmodes.md). The "current activity" strip this spec used to cover is gone from the app: RecentConversationsStrip renders only in HomeLanding's Standard branch, which is never shown, and the use-event-driven-sessions hook behind the 3-hour filter (old tests 3–5) was removed. Recent sessions now live in the Chats list; its recency rules (open/close order, last active OR last opened) are covered by ui/tests/react/chats-open-recency.test.ts. What remains here is the home's current behaviour.

test 1: Home is the Vibe hero and shows no current-activity strip
- [browser] navigate to {APP_URL}/dock/home
- [browser] wait for data-testid="flow-page" to be visible
- [browser] validate <html> has data-view="vibe"
- [browser] validate the hero prompt (placeholder "What would you like to work on, …?") is visible
- [browser] validate no element with data-testid="recent-conversations-strip" is visible

test 2: Home renders without console errors on a fresh load
- [browser] open browser console capture before navigating
- [browser] navigate to {APP_URL}/dock/home
- [browser] wait for the Vibe hero prompt to be visible, then 2 seconds to settle
- [browser] validate no console errors (ignoring favicon, ResizeObserver, 404, ERR_CONNECTION_REFUSED)
