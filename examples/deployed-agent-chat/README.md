# Deployed agent chat demo

This is a no-framework HTML client for the existing FlowPad TypeScript SDK. It exercises the deployed-chat route without introducing a chat API or SDK abstraction:

```text
browser HTML -> Agent.use() / AgenticProcess.* -> Hub -> deployment :9007 -> agent process
```

It uses the existing `Agent`, `AgenticProcess`, `FlowDataStream`, `ActionInfo`, and `dataManager` exports. The page supports Hub login, a new session, reconnect, transcript reload, live FlowData streaming, status, cancellation, and the existing prompt queue. Sending another message while a turn is running calls `AgenticProcess.enqueue()` just like the standard chat UI.

## Run

Build the self-contained browser SDK, then serve the OSS repository root:

```bash
cd ui
npm run build:sdk
cd ..
python3 -m http.server 4173
```

Open:

```text
http://localhost:4173/examples/deployed-agent-chat/?hub=https://YOUR-HUB-ORIGIN
```

Log in to the Hub and enter the ID of an agent that has a cloud deployment. **New chat** calls `Agent.use()`; the returned process ID can be used later with **Reconnect**.

Use `localhost` as shown (rather than the numeric loopback address), because it
is part of the Hub's existing development-origin allowlist.

The page stores only the Hub URL, agent ID, and process ID in local storage. It never stores the password or bearer token. The Hub URL must be known before the SDK script loads, so **Apply Hub URL** reloads the page.
