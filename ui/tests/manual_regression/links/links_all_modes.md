---
id: 638cc1a7-ba1c-4f9b-84a3-2b0f39d4e1ab
---
# Links: every kind, every surface, every action

One link layer serves every surface that shows text:

- **detection** — `lib/link-matches.ts` (plain text), `lib/remark-link-refs.ts` (markdown), `lib/link-kind.ts` (what a link is)
- **actions** — `components/links/link-actions.ts`: the click's primary action and the right-click menu, as data
- **handlers** — `components/links/link-handlers.ts` → `NavigationActions` (`openLink`, `showLinkInDisplay`, `openLinkInVibe`, `openLinkInBrowser`, `openLinkInBrowserProfile`)

## Surfaces

| Surface | Mode | Source a relative link resolves against | Click |
|---|---|---|---|
| Terminal | Advanced, Dev | the shell (its live cwd) | opens a tab |
| Chat | Standard | the agentic process (its shell, workdir, project) | opens a tab |
| Chat | Vibe | the agentic process | shows in the process's Display (`flow show` channel, lands in Display history) |
| Floating assistant | any | the assistant's process | opens a tab |
| Conversation message | conversation dock | the message (absolute links only) | opens a tab |

## Link kinds

Web URL, this app's URL, absolute file, relative file, `file:line:col`, `file#L7`, `file://`,
plain folder (opens Files), skill folder (opens the skill), entity id (`project-<id>` opens the
project page), image (lightbox), markdown `[a](rel)` and `[a](/abs)`, backticked `` `file:3` ``,
a path glued to Hebrew prose, and a `` `/dock/...` `` placeholder that must NOT be a link.

## Menu

- Tab surfaces: Copy · Open in Flowpad · Vibe (when there is a process) · Open in browser · Open in ▸ profile
- Vibe chat: Copy · Show in Display · Open in Flowpad · Open in browser · Open in ▸ profile

Every action is exercised on every surface; no click ever opens a browser tab.

## Run

```bash
scripts/instance_ctl.sh launch <name>
cd ui && VITE_PORT=<frontend port> FLOW_INSTANCE=<name> \
  npx playwright test --config tests/manual_regression/links/playwright.config.ts
```

Chats are stopped sessions seeded from a Claude transcript, so no model runs. The conversation
leg needs the instance to be signed in to its hub.
