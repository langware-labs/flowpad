# Deployed agent chat demo

This is a no-framework HTML client for the existing FlowPad TypeScript SDK. It exercises the deployed-chat route without introducing a chat API or SDK abstraction:

```text
browser HTML -> Agent.use() / AgenticProcess.* -> Hub -> deployment :9007 -> agent process
```

The tester intentionally has only two buttons: **Connect** and **Send**. Connect logs in and either reconnects the `process` URL parameter or creates a process with `Agent.use()`. Send streams the normal FlowData response; pressing it again while a turn is active uses the existing prompt queue.

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
http://localhost:4173/examples/deployed-agent-chat/?hub=https://YOUR-HUB-ORIGIN&agent=AGENT_UUID
```

Enter the Hub login and click **Connect**, then type a message and click **Send**. The page adds the returned process ID to its URL, so refreshing that URL reconnects the same chat.

Use `localhost` as shown (rather than the numeric loopback address), because it
is part of the Hub's existing development-origin allowlist.

The page stores nothing in local or session storage. The password and bearer token remain in memory only. The Hub and Agent are URL parameters because the SDK must know its API origin before it loads.

<!-- flowpad:capsule identity
version: 1
data:
  id: 3c8b15b1-1b53-4007-8926-f3a7a3171ec5
flowpad:endcapsule identity -->
