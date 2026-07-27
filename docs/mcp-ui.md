---
id: 7b3cc65e-6e92-4e55-b452-a61b19f2060d
title: MCP UI Architecture
---

# MCP UI Architecture

MCP UI in Flowpad is the Vibe path for interactive chat forms and MCP Apps. The
agent writes a self-contained `.mcp.html` file, presents it with `flow show file`,
and the Vibe display renders that file as an MCP App inside a sandbox. The user
submits through the app; Flowpad turns the app's MCP message back into a prompt
for the same Vibe agent.

This doc focuses on the Vibe `.mcp.html` path. Flowpad also has other MCP App
host surfaces that share the same sandbox proxy but have different routing and
submission semantics.

## Address Model

There are three different addresses in this path. They are intentionally not
interchangeable.

| Address | Example | Owner | Purpose |
| --- | --- | --- | --- |
| Dock URL | `/dock/shell/agentic_process-<id>?viewMode=vibe...` | Flowpad router | Opens the process workspace. It does not name the MCP UI file and does not fetch app HTML. |
| MCP resource URI | `ui://flowpad-local/%2FUsers%2F...%2Fform.mcp.html` | MCP Apps host | Identifies the displayed file as a resource for `@mcp-ui/client`. It is not a browser URL. |
| Sandbox URL | `/mcp-sandbox/sandbox_proxy.html` on the backend origin | Flowpad backend | Serves the sandbox proxy iframe that receives and hosts the guest HTML. |

The dock URL is stable while the display target changes. The resource URI is
created inside the frontend from the shown absolute file path. The sandbox URL is
the only network URL involved in hosting the guest app.

## Host Families

Flowpad currently hosts MCP Apps in three related places:

| Host family | Entry point | HTML source | App messages |
| --- | --- | --- | --- |
| Vibe `.mcp.html` preview | `flow show file <path.mcp.html>` inside a process dock URL | `ui://flowpad-local/<encoded-path>` resolved through `McpAppPreview.onReadResource` | `ui/message` becomes an async prompt to the same Vibe `AgenticProcess`. |
| Skill/component show view | `/dock/show/<entity-vfs>?component=<name>` | `ShowView` downloads `<entity-vfs>/ui/<component>.html` and passes it as inline HTML | Messages are acknowledged but not routed to a Vibe agent. |
| Named app host | `/dock/apps/<uname>/<routerPath>` | `AppHost` resolves app HTML by app name | Messages drive app navigation/open-link behavior, not Vibe prompt submission. |

All three use `@mcp-ui/client` and the shared backend sandbox URL. Only the
Vibe `.mcp.html` preview is the interactive chat-form path where submitted data
is handed back to the agent.

## Render Flow

1. The Vibe agent uses the `mcp-ui` skill to write one `.mcp.html` file.
2. The agent runs `flow show file <absolute-path-to-file.mcp.html>`.
3. `AgenticProcess.show` broadcasts the show payload and persists it as
   `context_data.last_shown`, so a refreshed or late-opened Vibe workspace can
   restore the same display.
4. `VibeWorkspace` prefers the explicit show target over stream focus. For a
   shown VFS path ending in `.mcp.html`, it renders `McpAppPreview` instead of
   the regular HTML preview or code editor.
5. `McpAppPreview` converts the absolute file path into a
   `ui://flowpad-local/<encoded-path>` resource URI and passes it to
   `@mcp-ui/client` as `toolResourceUri`.
6. `@mcp-ui/client` calls the host `onReadResource` callback. Flowpad decodes
   the resource URI and reads the file through the active compute node with
   `FSRef`, returning MIME type `text/html;profile=mcp-app`.
7. The app renderer loads the backend sandbox proxy at
   `/mcp-sandbox/sandbox_proxy.html`, waits for
   `ui/notifications/sandbox-proxy-ready`, then sends the app HTML in
   `ui/notifications/sandbox-resource-ready`.
8. `sandbox_proxy.html` writes the guest HTML into an inner iframe with `srcdoc`,
   applies a CSP, and relays JSON-RPC messages between the guest app and the
   Flowpad host.

## Submission Flow

The MCP App speaks MCP Apps JSON-RPC from inside the sandbox:

1. The guest sends `ui/initialize`.
2. The guest sends `ui/notifications/initialized`.
3. On form submit, the guest sends `ui/update-model-context` with structured
   data. Flowpad stores the latest payload in the preview component.
4. The guest sends `ui/message`. Flowpad combines that message with the latest
   model-context payload and calls `AgenticProcess.prompt(...)` on the same
   Vibe agent.
5. The host returns success to the guest immediately; prompt delivery happens
   asynchronously. Delivery failures are logged by the preview, not reported as
   a rejected form submission.
6. The prompt is only sent when the process is not currently prompting and
   `isBusy(process)` is false. This uses process status, not worker status,
   because the worker status can be absent or stale after reconnects.

There is no form-specific REST endpoint. Submission is conversational: the app
turns user input into an agent prompt.

## Sandboxing Boundary

The sandbox proxy is served by the backend, even when the frontend is running on
Vite. In dev this means the frontend app can be on port `4098` while the sandbox
comes from the backend API origin, such as port `9008`.

The backend route:

```text
GET /mcp-sandbox/sandbox_proxy.html
```

serves `ui/public/sandbox_proxy.html` during development and the packaged static
asset in built deployments. It sets CSP and cross-origin response headers. The
proxy then owns the inner guest iframe and relays JSON-RPC only; the Flowpad app
origin does not execute generated MCP UI code directly.

## Design Rules

- `flow show file` is the presentation API. Agents should not ask users to open
  `ui://...` resource URIs or sandbox URLs.
- The process dock URL identifies the workspace, not the current MCP UI file.
- The `.mcp.html` file is the deliverable. It should be self-contained unless it
  deliberately references allowed external resources through the MCP UI CSP
  model.
- `ui/message` is the handoff back to the agent. `ui/update-model-context` is
  supporting context, not the final delivery trigger by itself.
- Tool calls from the guest are not routed through the Vibe MCP preview today;
  unsupported tool calls return an error result.
- The host may normalize legacy/simple message shapes, but new MCP UI files
  should emit the structured MCP Apps methods described in the `mcp-ui` skill.

## Key Files

| Concern | File |
| --- | --- |
| Vibe display target selection and `last_shown` restore | `ui/src/pages/flow-page/vibe-workspace.tsx` |
| MCP App preview host | `ui/src/components/mcp-app-preview/McpAppPreview.tsx` |
| Local MCP resource URI and compute-node file reads | `ui/src/lib/mcp-app-resources.ts` |
| Sandbox URL selection | `ui/src/lib/mcp-sandbox.ts` |
| Sandbox proxy HTML | `ui/public/sandbox_proxy.html` |
| Backend sandbox route and CSP headers | `flow_sdk/server/routes/ui.py` |
| Agent-facing MCP UI contract | `flow_sdk/system_projects/flowpad_assistant/.claude/skills/mcp-ui/SKILL.md` |
| Vibe agent routing to the skill | `flow_sdk/system_projects/flowpad_assistant/.claude/agents/vibe.md` |

## Debug Checklist

When an MCP UI does not appear, check the boundaries in this order:

1. The process has `context_data.last_shown` or a fresh `on_show` payload for the
   `.mcp.html` file.
2. The Vibe display is on the process dock URL, not a guessed file URL.
3. The frontend built a `ui://flowpad-local/...` resource URI and `onReadResource`
   returned the `.mcp.html` content with MCP App MIME type.
4. The backend returns `200` for `/mcp-sandbox/sandbox_proxy.html`.
5. The proxy sends `ui/notifications/sandbox-proxy-ready` and receives
   `ui/notifications/sandbox-resource-ready`.
6. Submit emits `ui/update-model-context` and `ui/message`, and the process is
   idle enough for `AgenticProcess.prompt(...)` to accept the handoff.
