# Upgrading a design handoff into a real app

A Claude Design handoff bundle (`claude.ai/design`) is a set of HTML/CSS/JS **prototypes**
plus the chat transcripts that produced them. The prototype runs directly (React UMD +
`@babel/standalone` transpiling `.jsx` in the browser), which is why `artifact-setup`
serves it for an instant live preview. But the README's real intent is for a coding agent
to **recreate the designs as a production app**.

Do this **only when the user explicitly asks** to "build it for real" / "implement it" —
it is a large, non-deterministic task, not part of the default setup.

## The path

1. **Read the intent, not just the output.** Open `chats/*.md` first — the transcripts
   show what the user actually wanted and where they landed. Then read `project/index.html`
   in full and follow every import (components, CSS, scripts) so you understand the pieces.

2. **Scaffold with `web-app-builder`.** Bootstrap the standard stack (Next.js 16 +
   Tailwind v4 + shadcn/ui, FastAPI, Supabase) by copying its template as-is and running
   its setup script — never hand-scaffold. See the `web-app-builder` skill.

3. **Recreate the designs pixel-faithfully** in the new stack. Match the visual output;
   don't copy the prototype's internal structure unless it happens to fit. The prototype's
   dimensions, colors, and layout rules are authoritative — read them from the source.

4. **Run + show** the real app the same way `artifact-setup` does: `flow app open` →
   `flow show webapp --port <p>` so it renders in the Vibe display.

5. **Test** with the `web-tester` skill (console errors, broken links, screenshots).

Keep the served prototype available as the reference to diff against while you build.
