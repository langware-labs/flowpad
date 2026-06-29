---
id: 138434a2-60d8-58f9-af18-2add8d4d8188
---

test 1: Markdown editor header has no "Wiki" back button
- navigate to {APP_URL}/dock/assets/list/markdown
- click any markdown row to open it in the editor
- wait for the editor header to render (the 52px-tall bar above the Properties block)
- validate the header contains: filename text, the mode toggle group (View / Review / Editor / Markdown), and the copy-path button (ExternalLink icon)
- validate there is NO button containing the text "Wiki" in the header
- validate there is NO ArrowLeft icon used as a back button on the LEFT edge of the header
- check console for errors
- validate no errors appeared
