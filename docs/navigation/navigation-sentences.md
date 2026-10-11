---
id: 35d88a4c-447a-435e-b68d-aa60cf8dcd6d
---
# Navigation sentences — the whole Flowpad UX surface

200 things a person types into the magic line ("What do you want to do?"), covering every screen,
tab, thing to open, and thing to start or create. Built from the code: `VIEW_META`
(`flow_sdk/core/dock_address.py`), `VIEWER_REGISTRY` (`ui/src/types/ViewType.ts`), the rail
(`rail-visibility.ts`, `hub-rail.ts`), the top bar, the footer, the Settings dialog,
`RECORD_TYPE_NAV`, `EDITOR_TYPES`, the quick-create registry and the Preferences categories.

It is the classifier's coverage map. **target** says where each one should land:

* `/dock/…` — a place to open;
* `entity:<type>` — one thing, found by search; `file:` / `url:` / `log:` likewise;
* `ACTION: …` — start or create something. The navigator has no action targets yet, so these are
  sent to the assistant today; they mark the gap.

Measure the navigator against it with `scripts/navigation_coverage.py` (see `navigation-spec.md`).


### A. Home and global chrome (12)
| # | sentence | target |
|---|---|---|
| 1 | go home | /dock/home |
| 2 | open the start page | /dock/home |
| 3 | go back | ACTION: history back |
| 4 | go forward | ACTION: history forward |
| 5 | reload this page | ACTION: reload |
| 6 | open the file explorer | /dock/explorer |
| 7 | browse files | /dock/explorer |
| 8 | open spotlight | ACTION: Cmd+K spotlight |
| 9 | search for agent-builder | /dock/search?q=agent-builder |
| 10 | open my bookmarks | ACTION: bookmarks menu |
| 11 | pop this out into a new window | ACTION: open in window |
| 12 | switch to dark mode | ACTION: theme toggle |

### B. Chats, sessions, terminals (18)
| # | sentence | target |
|---|---|---|
| 13 | show my chats | /dock/shell |
| 14 | open chats | /dock/shell |
| 15 | start a new chat | ACTION: new chat (default harness) |
| 16 | start a new Claude Code chat | ACTION: new chat claude_code |
| 17 | start a Codex session | ACTION: new chat codex |
| 18 | start a Copilot chat | ACTION: new chat copilot |
| 19 | start an OpenCode session | ACTION: new chat opencode |
| 20 | open a terminal | ACTION: new terminal |
| 21 | give me a new shell | ACTION: new terminal |
| 22 | resume my last chat | /dock/shell (vibe resumes last) |
| 23 | open the refactor session | entity:agentic_process |
| 24 | show this session's transcript | /dock/lens/claude/transcript/<ref> |
| 25 | fork this session | ACTION: fork session |
| 26 | show the diff of this session | /dock/diff/<checkpoint> |
| 27 | open the process screen | /dock/agentic_process/<id> |
| 28 | show my run history | /dock/process-runs |
| 29 | open runs | /dock/process-runs |
| 30 | open the live session | /dock/live_session/<id> |

### C. Projects and collaboration (16)
| # | sentence | target |
|---|---|---|
| 31 | open project home | /dock/assets/project-home |
| 32 | open my project | /dock/project/<id> |
| 33 | switch project | ACTION: project list |
| 34 | open the gtm-studio project | entity:project |
| 35 | create a new project | ACTION: new project dialog |
| 36 | open a folder as a project | ACTION: open folder |
| 37 | clone a repo | ACTION: new project from git |
| 38 | open a project from git | ACTION: new project from git |
| 39 | invite someone to this project | ACTION: invite members |
| 40 | publish this project | ACTION: publish dialog |
| 41 | set up git for this project | ACTION: git checks dialog |
| 42 | upload a message | ACTION: upload .flowmsg |
| 43 | open the collaboration room | /dock/project/<id>/collaboration_room/<room> |
| 44 | show this project's dependency graph | /dock/graph/project/<id> |
| 45 | add a dependency | ACTION: add dependency |
| 46 | open the assistant project | entity:project (@flowpad_assistant) |

### D. Assets, by type (32)
| # | sentence | target |
|---|---|---|
| 47 | open assets | /dock/assets |
| 48 | show all my assets | /dock/assets/list/all |
| 49 | show my skills | /dock/assets/list/skill |
| 50 | show agents | /dock/assets/list/agent |
| 51 | show sub-agents | /dock/assets/list/subagent |
| 52 | show my prompts | /dock/assets/list/prompt |
| 53 | show my documents | /dock/assets/list/markdown |
| 54 | show my tasks | /dock/assets/list/task |
| 55 | open datasets | /dock/assets/list/dataset |
| 56 | show my plans | /dock/assets/list/plan |
| 57 | show specs | /dock/assets/list/spec |
| 58 | show workflows | /dock/assets/list/dynamic_workflow |
| 59 | show journeys | /dock/assets/list/journey |
| 60 | show wizards | /dock/assets/list/wizard |
| 61 | show whiteboards | /dock/assets/list/whiteboard |
| 62 | show my decks | /dock/assets/list/deck |
| 63 | show deck templates | /dock/assets/list/deck_template |
| 64 | show spreadsheets | /dock/assets/list/spreadsheet |
| 65 | show my apps | /dock/assets/list/micro_app |
| 66 | show MCP servers | /dock/assets/list/mcp |
| 67 | show commands | /dock/assets/list/command |
| 68 | show claude rules | /dock/assets/list/claude_rules |
| 69 | show help desks | /dock/assets/list/helpdesk |
| 70 | show data schemas | /dock/assets/list/data_schema |
| 71 | show compute ops | /dock/assets/list/compute_op |
| 72 | open the project manifest | /dock/assets/list/project_manifest |
| 73 | open the agent-builder skill | entity:skill |
| 74 | open the zoom oauth task | entity:task |
| 75 | open CLAUDE.md | entity:claude_md |
| 76 | open the SmartNavigator dataset | entity:dataset → app editor |
| 77 | open the smart navigation log | log:smart-navigation |
| 78 | open the README | file:README.md |

### E. Create / new (22)
| # | sentence | target |
|---|---|---|
| 79 | create an agent | ACTION: quick-create agent |
| 80 | new skill | ACTION: quick-create skill |
| 81 | make a sub-agent | ACTION: quick-create subagent |
| 82 | new workflow | ACTION: quick-create dynamic_workflow |
| 83 | create a task | ACTION: quick-create task |
| 84 | new markdown doc | ACTION: quick-create markdown |
| 85 | open a new whiteboard | ACTION: quick-create whiteboard |
| 86 | add an MCP server | ACTION: quick-create mcp |
| 87 | add a credential | ACTION: quick-create credential |
| 88 | add an API key | ACTION: quick-create credential |
| 89 | connect a data source | ACTION: new data source dialog |
| 90 | add a feed | ACTION: new data source dialog |
| 91 | new automation | /dock/automations?creating=event |
| 92 | schedule a job | /dock/automations?creating=schedule |
| 93 | add a file watcher automation | /dock/automations?creating=file |
| 94 | new LLM endpoint | ACTION: new endpoint dialog (hub) |
| 95 | create a sandbox | ACTION: new sandbox (hub) |
| 96 | add a machine | ACTION: add machine (hub) |
| 97 | send a message to Dana | ACTION: new conversation dialog |
| 98 | start a conversation | ACTION: new conversation dialog |
| 99 | add a help desk | ACTION: add help desk |
| 100 | open the quick create menu | ACTION: quick-create modal |

### F. Connections, credentials, secrets (10)
| # | sentence | target |
|---|---|---|
| 101 | open connections | /dock/credentials/connections |
| 102 | open credentials | /dock/credentials |
| 103 | manage my API keys | /dock/credentials/connections |
| 104 | show env vars | /dock/credentials/connections |
| 105 | show my OAuth accounts | /dock/credentials/connections |
| 106 | open connecitons (typo) | /dock/credentials |
| 107 | show machine secrets | /dock/machine/secrets |
| 108 | open the secrets settings | ACTION: Settings › Secrets |
| 109 | show this project's connections | /dock/credentials/connections/<project> |
| 110 | open the google credential | entity:credential |

### G. LLM and AI configuration (14)
| # | sentence | target |
|---|---|---|
| 111 | open AI configuration | /dock/ai-config |
| 112 | show LLM APIs | /dock/ai-config/llm-apis |
| 113 | show harnesses | /dock/ai-config/clis |
| 114 | show my CLIs | /dock/ai-config/clis |
| 115 | open LLM sources | /dock/llm-sources |
| 116 | how is Claude funded | /dock/llm-sources/claude |
| 117 | show codex funding | /dock/llm-sources/codex |
| 118 | set up my LLM | /dock/llm-setup |
| 119 | connect an LLM | /dock/llm-setup |
| 120 | show LLM endpoints | /dock/hub/llm-endpoints |
| 121 | show endpoint usage | /dock/hub/llm-endpoints/<id>/usage |
| 122 | show endpoint models | /dock/hub/llm-endpoints/<id>/models |
| 123 | show my token budget | /dock/hub/token-plan |
| 124 | show the team budget | /dock/hub/token-plan/team |

### H. Data sources, indexes, datasets (12)
| # | sentence | target |
|---|---|---|
| 125 | open data sources | /dock/data-sources |
| 126 | show integrations | /dock/data-sources |
| 127 | show source drivers | /dock/data-sources/drivers |
| 128 | open the whatsapp driver | /dock/data-sources/drivers/whatsapp |
| 129 | open my gmail source | entity:data_source |
| 130 | show search indexes | /dock/rag |
| 131 | show the vector index | /dock/rag |
| 132 | open the knowledge browser | /dock/k-browser/… |
| 133 | open the indexer status | /dock/lens/fs-records/scan |
| 134 | show LLM indexers | /dock/lens/fs-records/llm-indexers |
| 135 | review the navigation log | log:smart-navigation |
| 136 | show records that need labels | log:smart-navigation (needs-label filter) |

### I. Automations, events, runs (14)
| # | sentence | target |
|---|---|---|
| 137 | open automations | /dock/automations |
| 138 | show my triggers | /dock/automations |
| 139 | show scheduled jobs | /dock/automations |
| 140 | show cron | /dock/automations |
| 141 | show automation runs | /dock/automations/runs |
| 142 | show failed runs | /dock/automations/runs?status=failed |
| 143 | open the event bus | /dock/automations/bus |
| 144 | show live events | /dock/automations/bus |
| 145 | show signals | /dock/automations/bus |
| 146 | open the nightly report automation | entity:trigger |
| 147 | show the trigger log | /dock/lens/trigger/log/<ref> |
| 148 | show hooks | /dock/hooks |
| 149 | open claude hooks | /dock/hooks |
| 150 | show graph workflows | /dock/graph-workflows |

### J. Machine and system (12)
| # | sentence | target |
|---|---|---|
| 151 | open this machine | /dock/machine |
| 152 | show running processes | /dock/machine/processes |
| 153 | show open ports | /dock/machine/network |
| 154 | show sandbox metrics | /dock/machine/metrics |
| 155 | show sandbox logs | /dock/machine/logs |
| 156 | open system profile | /dock/system_profile |
| 157 | show claude code status | /dock/system_profile |
| 158 | show installed plugins | /dock/system_profile/plugins |
| 159 | show capabilities | /dock/capabilities |
| 160 | run system checks | /dock/capabilities |
| 161 | show the CLI log | /dock/lens/cli/log/all |
| 162 | show errors | /dock/lens/heartbeat/errors/<status> |

### K. Preferences and settings (18)
| # | sentence | target |
|---|---|---|
| 163 | open preferences | /dock/preferences |
| 164 | general preferences | /dock/preferences/general |
| 165 | terminal preferences | /dock/preferences/terminal |
| 166 | notification settings | /dock/preferences/notifications |
| 167 | turn the sound on | /dock/preferences/notifications |
| 168 | advanced preferences | /dock/preferences/advanced |
| 169 | turn on the smart navigation log | /dock/preferences/advanced |
| 170 | auto index settings | /dock/preferences/auto_index |
| 171 | change the language | /dock/preferences/i18n |
| 172 | change the view mode | /dock/preferences/ui |
| 173 | show tool calls in chat | /dock/preferences/chat |
| 174 | open claude settings | /dock/settings |
| 175 | open settings | ACTION: Settings dialog |
| 176 | open the database settings | ACTION: Settings › Database |
| 177 | run setup again | ACTION: setup wizard |
| 178 | switch to vibe mode | ACTION: view mode vibe |
| 179 | switch to terminal mode | ACTION: view mode advanced |
| 180 | log out | ACTION: logout |

### L. Messages, inbox, help (12)
| # | sentence | target |
|---|---|---|
| 181 | open my inbox | /dock/stream_inbox |
| 182 | show my messages | /dock/stream_inbox |
| 183 | open my conversation with Dana | entity:conversation |
| 184 | open the agent's inbox | /dock/agent/<id>/stream_inbox |
| 185 | open the help desk | /dock/helpdesk/<project> |
| 186 | contact support | /dock/helpdesk/<project> |
| 187 | ask someone for help | ACTION: ask-for-help dialog |
| 188 | ask the assistant | ACTION: assistant chat |
| 189 | pop out the assistant | /win/assistant |
| 190 | show my artifacts | /dock/artifacts |
| 191 | what did we deliver | /dock/artifacts |
| 192 | open my desktop | /dock/desktop |

### M. Graphs, knowledge, docs, hub (8)
| # | sentence | target |
|---|---|---|
| 193 | open the docs | /dock/docs |
| 194 | open the tag graph | /dock/tag/graph |
| 195 | show my world | /dock/hub/worldview/world |
| 196 | show the org graph | /dock/hub/worldview/organization |
| 197 | show people and teams | /dock/hub/organization |
| 198 | show deployed apps | /dock/worldview/deployment |
| 199 | discover agents | /discover |
| 200 | open flowpad cloud | url:https://app.flowpad.ai |

