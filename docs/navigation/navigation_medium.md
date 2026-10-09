# Smart navigation — 200 medium sentences

The second suite for the smart navigator, after the 200 easy ones in
[`navigation-sentences.md`](navigation-sentences.md). Each group is one place in the app; its 10
sentences are what someone working there might actually type: indirect wording, the user's own
words next to the app's, "this"/"it" that only the current screen resolves, an occasional typo,
and a few requests that sound like navigation but belong to the assistant.

Columns:

- **from** — the dock address the person is on while typing (`<id>`, `<path>` … are placeholders
  the example's context fills in).
- **sentence** — what they type into the magic line.
- **target** — the right answer: `/dock/<address>` (a screen), `entity:<type>` (one thing found by
  search), `file:<path>`, `url:<url>`, `log:smart-navigation`, `ACTION: <id>` (an id of
  `flow_sdk/core/ui_actions.json`), or `AGENTIC` (the assistant's). Several acceptable answers are
  separated by `\|`.


### A. Home and global chrome (10)

| # | from | sentence | target |
|---|---|---|---|
| 1 | /dock/lens/claude/transcript/<ref> | get me out of this transcript and back to the start screen | /dock/home |
| 2 | /dock/agentic_process/<id> | this tab looks stuck, just refresh the whole page | ACTION: reload |
| 3 | /dock/assets/list/skill | hmm not what i wanted, take me back to the screen i was on before | ACTION: history-back |
| 4 | /dock/home | find everything that mentions the whatsapp webhook | /dock/search?q=whatsapp%20webhook |
| 5 | /dock/credentials/connections | it's way too bright in here at night, flip it to the dark theme | ACTION: theme-toggle |
| 6 | /dock/project/<id>/collaboration_room/<room> | put this room in its own window so I can drag it to my other monitor | ACTION: open-in-window |
| 7 | /dock/home | show me everything I starred as a big grid, the full page, not the little dropdown | /dock/desktop |
| 8 | /dock/assets/project-home | where's that quick list of stuff i bookmakred, the one that hangs off the star | ACTION: bookmarks-menu |
| 9 | /dock/home | that onboarding deck i put together last week, pull it up | entity:deck |
| 10 | /dock/desktop | go through my favorites and unstar anything that points at a file that no longer exists | AGENTIC |

### B. Chats, workers and terminals (10)

| # | from | sentence | target |
|---|---|---|---|
| 11 | /dock/shell/<id> | this one's frozen, just kick it and start it over | ACTION: restart-session |
| 12 | /dock/agentic_process/<id> | branch off a copy of this convo so i can try another approach without losing it | ACTION: fork-session |
| 13 | /dock/agentic_process/<id> | i need a plain bash prompt next to this, not another agent | ACTION: new-terminal |
| 14 | /dock/shell/<id> | walk me through everything codex did in here, step by step | /dock/lens/codex/transcript/<session> |
| 15 | /dock/shell | where can i see what my agents ran earlier and what came out of it | /dock/process-runs |
| 16 | /dock/agentic_process/<id> | copliot instead pls — new chat, same project | ACTION: new-chat-copilot |
| 17 | /dock/shell/<id> | this terminal only keeps a few hundred lines of scrollback, where do i raise that | /dock/preferences/advanced |
| 18 | /dock/shell/<id> | figure out why the tests in this session keep failing and fix them, then rerun | AGENTIC |
| 19 | /dock/assets/project-home | take me back into the chat i was in a minute ago | /dock/agentic_process/<id> \| /dock/shell |
| 20 | /dock/home | the harness picker doesn't show opencode, where do i manage the coding CLIs | /dock/ai-config/clis |

### C. A session in context (10)

| # | from | sentence | target |
|---|---|---|---|
| 21 | /dock/agentic_process/<id> | where's the full conversation log for this one, i want to scroll back through everything it did | /dock/lens/<harness>/transcript/<session> |
| 22 | /dock/lens/claude/transcript/<session> | ok enough reading, take me back to the actual running terminal for this | /dock/agentic_process/<id> \| /dock/shell/<id> |
| 23 | /dock/agentic_process/<id> | it's frozen and not responding, kill it and bring it back up fresh | ACTION: restart-session |
| 24 | /dock/agentic_process/<id> | branch off a copy of this convo so i can try a diferent approach without losing this one | ACTION: fork-session |
| 25 | /dock/agentic_process/<id> | what's still on its todo list right now? | /dock/lens/claude/tasks/<session> |
| 26 | /dock/agentic_process/<id> | pull up again whatever it showed me last | file:<last_shown.path> \| entity:<last_shown.type> |
| 27 | /dock/agentic_process/<id> | which project is this session working in — take me to that project's home | /dock/assets/project-home |
| 28 | /dock/agentic_process/<id> | open the live view of this session, the one my teammate is watching | /dock/live_session/<live_session> |
| 29 | /dock/agentic_process/<id> | show me the plan it came up with before it started coding | /dock/plan/vfs/<plan_path> \| entity:plan |
| 30 | /dock/agentic_process/<id> | go through what this session changed so far and write it up as a task for tomorrow | AGENTIC |

### D. Projects (10)

| # | from | sentence | target |
|---|---|---|---|
| 31 | /dock/assets/project-home | I want to bring Dana onto this one so she can see it and work on it with me | ACTION: invite-members |
| 32 | /dock/home | take me over to my langware-site project, the one with the marketing pages | entity:project |
| 33 | /dock/agentic_process/<id> | what does this project actually depend on? draw it for me | /dock/graph/project/<id> |
| 34 | /dock/assets/project-home | a colleague emailed me a .flowmsg file, where do I drop it in here? | ACTION: upload-flowmsg |
| 35 | /dock/home | there's a repo on github I want to work on, pull it down as a new projet | ACTION: new-project-from-git |
| 36 | /dock/assets/project-home | the git chip is showing a warning, sort out the git setup for it | ACTION: git-checks-dialog |
| 37 | /dock/assets/project-home | hook another one of my repos into this project as a dependancy | ACTION: add-dependency |
| 38 | /dock/assets/project-home | put this up on the hub so the rest of the team can find it | ACTION: publish-dialog |
| 39 | /dock/assets/project-home | the shared-utils dependency says missing — install it, then add our docs repo as an optional one too | AGENTIC |
| 40 | /dock/project/<id>/collaboration_room/<room> | leave the room and show me this project's overview page | /dock/assets/project-home |

### E. Collaboration, conversations and the inbox (10)

| # | from | sentence | target |
|---|---|---|---|
| 41 | /dock/home | where do the invites people send me end up? noa says she added me to her project | /dock/stream_inbox |
| 42 | /dock/stream_inbox | the whatsapp chat with the plumber, open that one | entity:conversation |
| 43 | /dock/conversation/<id>/message/<mid> | pop this chat out so I can keep it open next to my code | ACTION: open-in-window |
| 44 | /dock/assets/project-home | let Dana in on this so she can see what we're doing in the room | ACTION: invite-members |
| 45 | /dock/stream_inbox | take me to where the team is colaborating on this project right now | /dock/project/<id>/collaboration_room/<room> |
| 46 | /dock/agentic_process/<id> | im stuck on this one, can a teammate take a look? | ACTION: ask-for-help-dialog |
| 47 | /dock/assets/project-home | our customers keep asking how to install it, where's this project's suport portal | /dock/helpdesk/<project> |
| 48 | /dock/home | I want to DM someone I've never chatted with before | ACTION: new-conversation-dialog |
| 49 | /dock/assets/editor/agent/<ref> | what has it received on whatsapp lately? show me its inbox | /dock/agent/<id>/stream_inbox |
| 50 | /dock/conversation/<id>/message/<mid> | turn this message into a task and give it to Ron, due friday | AGENTIC |

### F. Assets and per-type lists (10)

| # | from | sentence | target |
|---|---|---|---|
| 51 | /dock/assets/list/skill | ok now the same list but for the sub agents | /dock/assets/list/subagent |
| 52 | /dock/assets/editor/skill/typeid/skill-<id> | show me all the other skills, not just this one | /dock/assets/list/skill |
| 53 | /dock/assets/list/agent | add another one of these here, a blank one is fine | ACTION: quick-create-agent |
| 54 | /dock/assets/list/mcp | i want to hook up a new mcp srever | ACTION: quick-create-mcp |
| 55 | /dock/assets/list/task | where's the memory claude keeps about this repo | /dock/assets/list/claude_memory \| entity:claude_memory |
| 56 | /dock/assets/list/plan | pull up the plan we wrote for the onboarding revamp | entity:plan |
| 57 | /dock/assets | get me out of the tree and onto the project overview | /dock/assets/project-home |
| 58 | /dock/assets/list/dynamic_workflow | where are the traces of how my agent runs went | /dock/assets/list/agent_trace |
| 59 | /dock/assets/list/skill | write a skill here that turns my standup notes into a jira update every morning | AGENTIC |
| 60 | /dock/assets/editor/agent/typeid/agent-<id> | which of my skills does this agent actually use, and are any of them out of date? | AGENTIC |

### G. Creating things (10)

| # | from | sentence | target |
|---|---|---|---|
| 61 | /dock/assets/list/skill | i want to start another one of these from scratch, blank is fine | ACTION: quick-create-skill |
| 62 | /dock/home | the "q4 launch" task I created a minute ago, open it back up | entity:task |
| 63 | /dock/assets/project-home | the code is already on github, pull it down and make it a project | ACTION: new-project-from-git |
| 64 | /dock/automations/bus?tag=<tag> | make an automation that fires whenever this happens | /dock/automations?creating=event&tag=<tag> |
| 65 | /dock/automations | use the morning briefing starter instead of an empty one | /dock/automations?creating=schedule&recipe=morning-briefing |
| 66 | /dock/hooks | rather than hand-editing hooks, set up a new automation for when an agent does something | /dock/automations?creating=agent_hook |
| 67 | /dock/data-sources/drivers/<name> | ok, hook up a new source with this driver | ACTION: new-data-source-dialog |
| 68 | /dock/shell | I need somewhere to stash my openai api key, add a new credentail | ACTION: quick-create-credential |
| 69 | /dock/assets/list/agent | create an agent that reads my gmail every morning and opens a task for anything urgent | AGENTIC |
| 70 | /dock/assets/project-home | add a skill to this project that explains how we cut a pypi release, based on our deploy script | AGENTIC |

### H. Specific things by name (10)

| # | from | sentence | target |
|---|---|---|---|
| 71 | /dock/assets/list/task | the one about the stripe webhook retries, open that | entity:task |
| 72 | /dock/home | where's my skil for writing release notes | entity:skill |
| 73 | /dock/assets/list/agent | take me to what people sent the support-triage agent | /dock/agent/<id>/stream_inbox |
| 74 | /dock/data-sources | go to the hacker news rss feed i hooked up last week | entity:data_source |
| 75 | /dock/automations?trigger=<id> | the weekly digest one, when did it last fire? show me its log | /dock/lens/trigger/log/<id> |
| 76 | /dock/credentials/connections | open the stripe secrt key, the live one not test | entity:credential |
| 77 | /dock/stream_inbox | my convo w/ the acme folks about the pilot | entity:conversation |
| 78 | /dock/assets/project-home | how does billing-service depend on the other repos, show me its graph | /dock/graph/project/<id> |
| 79 | /dock/agentic_process/<id> | pull up that onboarding checklist doc we wrote for new hires | entity:markdown |
| 80 | /dock/assets/list/dataset | open the churn-labels dataset and merge its gold rows into the q3 training set | AGENTIC |

### I. Credentials, connections and secrets (10)

| # | from | sentence | target |
|---|---|---|---|
| 81 | /dock/credentials/connections/<project> | the openai key in this list, open it up so I can look at it | entity:credential |
| 82 | /dock/credentials/connections | i need one more api key on here, blank is fine, I'll type the value myself | ACTION: quick-create-credential |
| 83 | /dock/assets/project-home | take me to the conections for this project (typo) | /dock/credentials/connections/<project> |
| 84 | /dock/credentials/connections/<project> | stop filtering by this project, I want all my keys across every project | /dock/credentials/connections |
| 85 | /dock/home | which of this project's secrets is the machine actually allowed to see? | /dock/machine/secrets |
| 86 | /dock/credentials/connections | not this page, the secrets tab inside the settings popup | ACTION: settings-secrets |
| 87 | /dock/credentials/connections | codex keeps saying it has no key, where do I hand it one | /dock/llm-sources/codex |
| 88 | /dock/credentials/connections | I don't just want to sign in to slack, I want its messages synced into flowpad | ACTION: new-data-source-dialog |
| 89 | /dock/credentials/connections | the github test on this row keeps failing, figure out why and fix it | AGENTIC |
| 90 | /dock/agentic_process/<id> | go through this repo and tell me every env var it needs, then add them as credentials | AGENTIC |

### J. AI configuration and LLMs (10)

| # | from | sentence | target |
|---|---|---|---|
| 91 | /dock/ai-config/llm-apis | ok flip over to the other tab here, the one listing the harnesses | /dock/ai-config/clis |
| 92 | /dock/ai-config | change the default LLM shown up here to sonnet for all my agents | AGENTIC |
| 93 | /dock/llm-sources/claude | and copilot? how is that one getting paid for | /dock/llm-sources/copilot |
| 94 | /dock/llm-sources/codex | codex says nothing eligible, where do i put an openai key for it | /dock/credentials/connections/<project> \| ACTION: quick-create-credential |
| 95 | /dock/ai-config/clis | codex shows available now so start a codex sesion | ACTION: new-chat-codex |
| 96 | /dock/llm-sources/claude | my claude runs keep failing, test which of these sources is broken and switch it to the hub endpoint | AGENTIC |
| 97 | /dock/home | just installed this and nothing can talk to a model yet, where do i choose what issues my llm calls | /dock/llm-setup \| ACTION: setup-wizard |
| 98 | /dock/llm-sources/opencode | open the hub endpoint this one is using | /dock/hub/llm-endpoints/<id> \| entity:llm_endpoint |
| 99 | /dock/llm-sources | none of these work for me, i want to make a fresh endpoint on the hub | ACTION: new-endpoint-dialog-hub |
| 100 | /dock/llm-setup | skip this question, take me to the page that shows what funds each assistant | /dock/llm-sources |

### K. Hub pages (10)

| # | from | sentence | target |
|---|---|---|---|
| 101 | /dock/hub/llm-endpoints/<id> | how much of this one have we burned through so far this month? | /dock/hub/llm-endpoints/<id>/usage |
| 102 | /dock/hub/llm-endpoints/<id>/usage | ok and wich models can I actually call through it | /dock/hub/llm-endpoints/<id>/models |
| 103 | /dock/hub/token-plan | that's just mine, how is my team doing against its cap? | /dock/hub/token-plan/team |
| 104 | /dock/hub/organization | can I see these people and teams drawn as a graph instead | /dock/hub/worldview/organization |
| 105 | /dock/hub/worldview/world | too busy, just give me a plain list of the cloud tasks | /dock/hub/records/task |
| 106 | /dock/hub/records/markdown | open the Q3 onboarding playbook someone shared up here | entity:markdown |
| 107 | /dock/hub/home | spin up another cloud workspace for me | ACTION: new-sandbox-hub |
| 108 | /dock/hub/home | hook my linux box at home up so it shows here with the others | ACTION: add-machine-hub |
| 109 | /dock/hub/llm-endpoints | add one more of these | ACTION: new-endpoint-dialog-hub |
| 110 | /dock/hub/token-plan/team | bump Dana's monthly budget to $40 and let her know it changed | AGENTIC |

### L. Data sources and channels (10)

| # | from | sentence | target |
|---|---|---|---|
| 111 | /dock/data-sources | where do the messages from each of these channels actually end up? show me the routing | /dock/data-sources/channels |
| 112 | /dock/data-sources/<id> | let me see everything that came in through this one | /dock/data-sources/<id>/messages |
| 113 | /dock/data-sources/<id>/messages | ok now how is it configured, open its setings | /dock/data-sources/<id>/settings |
| 114 | /dock/data-sources/drivers | the one that reads rss feeds — open its page | /dock/data-sources/drivers/rss |
| 115 | /dock/data-sources/<id> (a telegram source) | which driver is this built on? take me there | /dock/data-sources/drivers/telegram |
| 116 | /dock/data-sources/channels | jump to the telegram bot source we set up for support | entity:data_source |
| 117 | /dock/data-sources | i need to hook up one more integration next to these | ACTION: new-data-source-dialog |
| 118 | /dock/data-sources/<id>/settings | where's the google login this gmail source signs in with? | /dock/credentials/connections |
| 119 | /dock/data-sources/<id> | this feed hasn't pulled anything new since yesterday, figure out why and fix it | AGENTIC |
| 120 | /dock/data-sources/drivers/gmail | connect my work gmail with it but only pull the billing label, every hour | AGENTIC |

### M. Search, knowledge and docs (10)

| # | from | sentence | target |
|---|---|---|---|
| 121 | /dock/tag/graph | this hairball is unreadable, can I see it as a tree with parents on top | /dock/tag/graph?view=tree |
| 122 | /dock/assets/project-home | browse this project's knowledge as a map of its docs folder | /dock/k-browser/vfs/<path> |
| 123 | /dock/assets/project-home | what does this repo depend on? draw it for me | /dock/graph/project/<id> |
| 124 | /dock/home | where do i choose which folders the semantic serch covers | /dock/rag |
| 125 | /dock/search?q=oauth | same search but only skills please | /dock/search?q=oauth&record_type=skill |
| 126 | /dock/home | take me to the docs tree with all my stuff in it | /dock/assets |
| 127 | /dock/k-browser/vfs/<path> | I just want to jump to a file by typing part of its name | ACTION: cmd-k-spotlight |
| 128 | /dock/k-browser/vfs/<path> | open the glossary doc itself, not the graph | entity:markdown \| file:docs/glossary.md |
| 129 | /dock/rag | add ~/Documents/notes to this index and kick off a rebuild | AGENTIC |
| 130 | /dock/k-browser/vfs/<path> | which of these docs still talk about data_spec and need updating to data_schema? | AGENTIC |

### N. Automations (10)

| # | from | sentence | target |
|---|---|---|---|
| 131 | /dock/automations?trigger=<id> | only show me the runs of this one that failed | /dock/automations/runs?status=failed&trigger=<id> |
| 132 | /dock/automations/bus | pop the event bus out into its own window so I can keep an eye on it on my other screen | ACTION: open-in-window |
| 133 | /dock/automations/runs?run=<id> | take me to the automation this run came from | /dock/automations?trigger=<trigger-id> |
| 134 | /dock/automations | every weekday at 9am have an agent go through yesterday's failed runs and send me a summary | AGENTIC |
| 135 | /dock/automations | start a new one from that "review docs on save" starter | /dock/automations?creating=file&recipe=docs-on-save |
| 136 | /dock/automations/bus | who's listning to task.assigned events here? | /dock/automations/bus?tag=task.assigned |
| 137 | /dock/automations | I want a rule that steps in when the coding agent is about to use a tool | /dock/automations?creating=agent_hook \| /dock/hooks |
| 138 | /dock/automations?trigger=<id> | not the pretty view, give me the raw trigger log for this automation | /dock/lens/trigger/log/<id> |
| 139 | /dock/graph-workflows | open the deploy pipeline graph workflow in the editor | entity:graph_workflow \| /dock/graph-workflows/graph_workflow-<id> |
| 140 | /dock/automations/runs?status=failed | look at these failures, figure out what's broken and fix the automations | AGENTIC |

### O. Machine and system (10)

| # | from | sentence | target |
|---|---|---|---|
| 141 | /dock/machine/processes | whats hogging port 8093 on here? flip to the ports | /dock/machine/network |
| 142 | /dock/machine/network | which of the project's secrets are actually attached to this box | /dock/machine/secrets |
| 143 | /dock/machine/processes | is this sandbox running out of memory? I want the cpu and memory graphs | /dock/machine/metrics |
| 144 | /dock/system_profile/plugins | ok and the github repos it knows about? | /dock/system_profile/repos |
| 145 | /dock/lens/heartbeat/errors/open | now just the ones I snoozed | /dock/lens/heartbeat/errors/snoozed |
| 146 | /dock/lens/heartbeat/errors/all | the same error shows up 20 times in this list, where do I stop it duplicating | /dock/preferences/errors |
| 147 | /dock/agentic_process/<id> | which flow comands got fired off lately? the whole command history | /dock/lens/cli/log/all |
| 148 | /dock/capabilities | I skipped the first-run setup and half of this list is unavailable, walk me through that wizard again | ACTION: setup-wizard |
| 149 | /dock/lens/heartbeat/errors/open | open the diagnosis report I made after these errors yesterday | entity:flowpad_diagnosis |
| 150 | /dock/capabilities | github says unavailable here but gh is definitely installed, figure out why and fix it | AGENTIC |

### P. Preferences and settings (10)

| # | from | sentence | target |
|---|---|---|---|
| 151 | /dock/assets/project-home | every time I pick a project it starts crawling the whole folder, make it stop doing that on its own | /dock/preferences/auto_index |
| 152 | /dock/agentic_process/<id> | this terminal forgets everything past a few thousand lines, where do i raise that limit | /dock/preferences/advanced |
| 153 | /dock/home | i want the standard layout — not vibe, and not the full terminal one either | /dock/preferences/ui |
| 154 | /dock/preferences/general | there's no dark theme anywhere in this appearance page?? just make it dark | ACTION: theme-toggle |
| 155 | /dock/assets/project-home | which tools is claude code allowed to run for this project — the permissions in its settings.json | /dock/settings \| /dock/settings/permissions |
| 156 | /dock/preferences | where do I stash an app secret so it lands in my keychain | ACTION: settings-secrets \| /dock/machine/secrets |
| 157 | /dock/home | I want flowpad to use a different sqlite file than the default one, where's that | ACTION: settings-database |
| 158 | /dock/lens/heartbeat/errors/<status> | this list shows the same failure a hundred times, can it colapse the duplicates | /dock/preferences/errors |
| 159 | /dock/preferences/advanced | im handing this mac to someone else, sign me out of my account | ACTION: logout |
| 160 | /dock/preferences/notifications | turn this off, and while you're at it switch everything to french and bump the scrollback to 20k | AGENTIC |

### Q. Files, the editor and deliverables (10)

| # | from | sentence | target |
|---|---|---|---|
| 161 | /dock/explorer | open ~/Documents/notes/launch-plan.md, I want to edit it | file:~/Documents/notes/launch-plan.md |
| 162 | /dock/agentic_process/<id> | bring back the file you showed me earlier, i closed it by mistake | file:<last_shown.path> \| entity:<last_shown.typeid> |
| 163 | /dock/home | the vite dev server I just started on port 5173, preview it in here | url:http://localhost:5173 |
| 164 | /dock/explorer | can I have this files panel in a seperate window next to my editor | ACTION: open-in-window |
| 165 | /dock/agentic_process/<id> | where's the list of deliverables this project produced? | /dock/artifacts |
| 166 | /dock/assets/project-home | lay out everything I starred as big tiles, full page | /dock/desktop |
| 167 | /dock/editor/<path> | rename the useFoo hook in this file and fix every import that uses it | AGENTIC |
| 168 | /dock/artifacts | take the newest artifact, turn it into a one-page html summary and show it to me | AGENTIC |
| 169 | /dock/assets/editor/markdown/vfs/<path> | start another blank markdown doc, separate from this one | ACTION: quick-create-markdown |
| 170 | /dock/editor/<path> | show me the file tree for this project so I can poke around the other folders | /dock/explorer |

### R. Datasets, evals and the navigation log (10)

| # | from | sentence | target |
|---|---|---|---|
| 171 | /dock/assets/list/dataset | open the smartnaviagtor one in the eval browser, I want to see how the last run scored | /dock/app/<eval-browser>?subject=dataset-<id> |
| 172 | /dock/app/<dataset-editor>?subject=dataset-<id> | this log has no rows at all — where do I switch it on? | /dock/preferences/advanced |
| 173 | /dock/home | I want to go over what the magic line decided for me today and fix the wrong picks | log:smart-navigation |
| 174 | /dock/graph-workflows/graph_workflow-<id> | show me every time this one has run | /dock/graph-workflows/graph_workflow-<id>?panel=runs \| /dock/process-runs?flow_id=<id> |
| 175 | /dock/assets/project-home | where do the reports from analyzing my agent sessions end up? | /dock/assets/list/agent_trace |
| 176 | /dock/process-runs | pull up the weekly token usage reports | /dock/assets/list/usage_report |
| 177 | /dock/assets/list/workflow_run | open the transcript of the deploy-check workflow run | entity:workflow_run |
| 178 | /dock/graph-workflows | take me to the workflow runs — the Claude Code ones, not these graph ones | /dock/assets/list/workflow_run |
| 179 | /dock/agentic_process/<id> | trace this session and tell me where the agent went off track | AGENTIC |
| 180 | /dock/app/<dataset-editor>?subject=dataset-<id> | pop this out into its own window so I can label next to the chat | ACTION: open-in-window |

### S. The assistant, help and discovery (10)

| # | from | sentence | target |
|---|---|---|---|
| 181 | /dock/home | where can I browse the agents and skills other people published, I want to install one | /discover |
| 182 | /dock/helpdesk/<project>/article/<path> | ok done reading this one, back to the list of guides here | /dock/helpdesk/<project> |
| 183 | /dock/agentic_process/<id> | this agent is stuck again, I want a real person on my team to take a look at it | ACTION: ask-for-help-dialog |
| 184 | /dock/home | can I have the flowpad assistnat in its own separate window? | /win/assistant |
| 185 | /dock/llm-setup | I think I messed up the first-run setup, take me through the whole thing from the start | ACTION: setup-wizard |
| 186 | /dock/docs | how do I let my agent read my gmail without pasting my password anywhere? explain the steps | AGENTIC |
| 187 | /win/assistant | why did my last session stop halfway, and what should I change in its prompt so it doesn't happen again | AGENTIC |
| 188 | /dock/assets/project-home | where's the documentation for flowpad itself, like the help pages | /dock/docs |
| 189 | /dock/home | I want to sign in to the flowpad cloud website in my browser | url:https://app.flowpad.ai |
| 190 | /dock/home | the welcome bookmark from onboarding is gone, where do I make it come back next start | /dock/preferences/onboarding |

### T. Agents and deployments (10)

| # | from | sentence | target |
|---|---|---|---|
| 191 | /dock/assets/editor/agent/typeid/agent-<id> | where do the messages people send this agent end up? show me | /dock/agent/<id>/stream_inbox |
| 192 | /dock/agent/<id>/stream_inbox | ok take me back to this agent's own page, i want to tweak its settings | entity:agent \| /dock/assets/editor/agent/typeid/agent-<id> |
| 193 | /dock/assets/list/agent | which of these are actualy deployed and running somewhere right now | /dock/worldview/deployment |
| 194 | /dock/worldview/deployment | this graph is too much, just give me all my agents as a plain list | /dock/assets/list/agent |
| 195 | /dock/assets/editor/agent/typeid/agent-<id> | add an empty sub-agent for this one, I'll write its prompt myself later | ACTION: quick-create-subagent |
| 196 | /dock/app/artifact-<id> | pop this app out into its own window so I can keep it next to the chat | ACTION: open-in-window |
| 197 | /dock/home | my vite dev server is up on port 5173, open it here inside flowpad | url:http://localhost:5173 |
| 198 | /dock/assets/editor/agent/typeid/agent-<id> | open the connect-data-source skill this agent leans on | entity:skill |
| 199 | /dock/assets/editor/agent/typeid/agent-<id> | it stopped answering on whatsapp since yesterday, check the deployment and fix whatever broke | AGENTIC |
| 200 | /dock/assets/list/agent | build me an agent that triages the support inbox and answers customers in hebrew | AGENTIC |
