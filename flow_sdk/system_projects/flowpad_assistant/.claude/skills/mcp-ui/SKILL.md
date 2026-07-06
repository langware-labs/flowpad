---
id: 841b4a16-6e72-5d21-99d4-639a9b2be75a
name: mcp-ui
description: Build MCP Apps / MCP UI interactive interfaces inside Flowpad Vibe. Use when the user asks to use MCP UI, MCP Apps, interactive UI in chat, open questions, multi-select questions, forms, approvals, or file-upload requests that should send submitted data back to the agent.
---

# MCP UI

Create a Flowpad-rendered MCP App, not a normal web page.

## Host model

Flowpad hosts MCP UI as a shown file target:

```text
flow show file <path.mcp.html>
  -> Vibe display restores the process last_shown target
  -> host maps the file to ui://flowpad-local/<encoded-path>
  -> @mcp-ui/client reads that resource through Flowpad
  -> backend sandbox proxy renders the app in an iframe
  -> ui/message sends the submitted data back to the same agent
```

Do not ask the user to open `ui://...` resource URIs or sandbox URLs. The only
presentation command is `flow show file <absolute-path-to-file.mcp.html>`. The
browser URL remains the normal Flowpad process dock URL; it is not the MCP UI
file address.

## Output contract

1. Write one self-contained HTML file whose name ends in `.mcp.html`.
2. Include this exact MCP Apps flow:
   - `ui/initialize` request with `appCapabilities`, `appInfo`, and `protocolVersion: "2026-01-26"`.
   - `ui/notifications/initialized` after initialize succeeds.
   - On submit, send `ui/update-model-context` with the structured form data.
   - Then send `ui/message` with role `user` and text beginning with `MCP_UI_SUBMISSION ` followed by JSON.
3. Present the file with:

```bash
flow show file <absolute-path-to-file.mcp.html>
```

Exit `0` means the UI has been shown. Stop generating files after that and wait for the user/app submission.

## Required test IDs

For question/form demos, use these stable attributes:

- Root: `data-testid="mcp-ui-root"`
- Open/free-text answer: `data-testid="mcp-ui-open-question"`
- Multi-select options: `data-testid="mcp-ui-multiselect-<slug>"`
- File input: `data-testid="mcp-ui-file-upload"`
- Submit button: `data-testid="mcp-ui-submit"`
- Submission status: `data-testid="mcp-ui-submission-status"`

## Submission payload

For an open question + multi-select + file upload request, submit:

```json
{
  "openQuestion": "free text answer",
  "selectedOptions": ["option-a", "option-c"],
  "file": {
    "name": "uploaded.txt",
    "type": "text/plain",
    "size": 123,
    "textPreview": "first 2000 characters for text files"
  }
}
```

For this exact demo shape, use these multi-select values unless the user names
different options:

- `planning` with `data-testid="mcp-ui-multiselect-planning"`
- `design` with `data-testid="mcp-ui-multiselect-design"`
- `implementation` with `data-testid="mcp-ui-multiselect-implementation"`

After the host sends the follow-up prompt back to you, reply with the exact marker
`MCP_UI_RECEIVED` and echo every submitted value, including the file name and text
preview.

## Minimal inline bridge

Use this pattern in the HTML when you are not bundling `@modelcontextprotocol/ext-apps`:

```html
<script>
const mcp = (() => {
  let nextId = 1;
  const pending = new Map();
  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || msg.jsonrpc !== '2.0' || !Object.prototype.hasOwnProperty.call(msg, 'id')) return;
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    if (msg.error) waiter.reject(new Error(msg.error.message || 'MCP request failed'));
    else waiter.resolve(msg.result || {});
  });
  function request(method, params) {
    const id = nextId++;
    parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*');
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  }
  function notify(method, params) {
    parent.postMessage({ jsonrpc: '2.0', method, params: params || {} }, '*');
  }
  return {
    async connect() {
      await request('ui/initialize', {
        appInfo: { name: 'flowpad-mcp-ui-form', version: '1.0.0' },
        appCapabilities: {},
        protocolVersion: '2026-01-26'
      });
      notify('ui/notifications/initialized', {});
    },
    updateModelContext: (params) => request('ui/update-model-context', params),
    sendMessage: (params) => request('ui/message', params),
    sizeChanged: () => notify('ui/notifications/size-changed', {
      width: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight
    })
  };
})();
</script>
```

Register event handlers before calling `mcp.connect()`. Do not use deprecated
`iframe-ready`, `capabilities`, `window.openai`, or flat `_meta["ui/resourceUri"]`
patterns.
