---
id: 7be5b1ba-5dca-4b62-bbd3-ecdf706c5211
---
# Screens — open it, then say what to click

Open the screen with `flow show`, then give the numbered clicks below in the user's
words. `flow show` exiting `0` means the screen was recorded, not that the user looked
at it.

`<agent>` is the agent folder's absolute path; `<agent-typeid>` is what
`flow record index <agent> --types agent` printed. For any screen not listed here,
the `flowpad-navigation` skill has the full screen table.

| Task | Open with | Tell the user |
| --- | --- | --- |
| **See and edit the agent** | `flow show file <agent>/agent.json` | 1. The agent's page opens beside the chat. 2. **Definition** holds title, description and avatar. 3. **Behaviour — who this agent is, its system prompt** holds the prompt. |
| **Chat with it** | `flow show view home` | 1. On Home ("Hey …"), under **Agents**, find the agent's tile — not the project's asset page. 2. Click the tile — a new chat with the agent opens. (The pencil on the tile edits it instead.) |
| **Turn auto-launch on** | `flow show file <agent>/agent.json` | 1. Switch **Auto-launch on project open** on. 2. Fill **Auto-launch prompt** with the first message. |
| **Re-test auto-launch** | `flow show file <agent>/agent.json` | 1. Next to auto-launch it says **Already launched in this project**. 2. Click **Reset**. 3. Open the project again — the agent starts. |
| **Give it a channel** | `flow show file <agent>/agent.json` | 1. In the left panel **Agent resources**, next to **Channels**, click **+** (Add channel). 2. Pick the channel (email, WhatsApp, …) — a channel is a data source that can send. 3. Finish its setup; a deployment answers only the channels it has. |
| **Schedule it** | `flow show file <agent>/agent.json` | 1. Click **Add schedule**. 2. Pick when, and write the prompt it runs with. 3. **Run now** tries it once. |
| **Deploy it** | `flow show file <agent>/agent.json` | 1. Under **Deployments**, click **New deployment**. 2. Pick the **Deployment type** — this computer, or **Cloud machine** — and the **Environment**. 3. Click **Launch**. |
| **Give it credentials** | `flow show file <agent>/agent.json` | 1. On the deployment, **What the … machine still needs** lists missing credentials. 2. Click **Authorize** (or fill the value) on each. 3. Deploy is enabled once the list is empty. |
| **Share a launch link** | `flow show file <agent>/agent.json` | 1. Under **Sharing**, publish and share the agent first. 2. Then **Copy launch link** — it starts a new cloud sandbox running the agent, for people it is shared with. |
| **See its runs** | `flow show view process-runs` | 1. Each row is one run; open it to read the transcript. |
| **No model set up yet** | `flow show view llm-setup` | 1. Choose a model provider and connect it. Agents cannot run until one is set up. |
| **Which machine runs it** | `flow show view machine` | 1. This computer's status and what is running on it. |

If a label here is not on the screen, say what you expected and ask the user what
they see — the app moves faster than this table.
