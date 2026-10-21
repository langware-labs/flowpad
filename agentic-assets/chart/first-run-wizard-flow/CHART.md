---
id: 6369e1c6-75f3-449b-af4b-b070fcc4fb9f
name: first-run-wizard-flow
description: When the first-run setup wizard opens, what Skip and X do at each window,
  and where the person lands afterwards. FLOWPAD-2249, as agreed on 2026-10-19.
format: mermaid
session: 1a755eb5-f736-4731-a9ba-9af01bc7ec8b
---
"Ran fully" means every step finished OK, on this computer. The wizard opens whenever it has not: on every app load and before every project setup.
An invitation to a project (a shared-project link) is a project setup that starts with a dialog: that dialog is NOT shown until everything in this chart has happened. A project setup always goes through the wizard first; when it already ran fully the person sees nothing of it, only the project setup they came for.
While windows 1 to 3 are on screen no other dialog is shown (the invitation, a project load, a source setup and so on): each waits and appears after the flow ends. Only the wizard's own questions (approve an install, choose an LLM source) may appear inside it.
Window 1 has X (Minimize appears after Start and does not leave the flow; a run that ended short also offers a Skip, which is the same as X); Continue anyway and X are the same in window 2. Window 3 has no button: X is the only way out, and for a project setup or an invitation it opens the gate for this session (a load waits on nothing, so leaving it opens nothing). Installs already started keep running in the background after X; if they all end OK, that counts as "ran fully".

```mermaid
flowchart TD
  L([App load]) --> C
  S([Project setup requested]) --> C
  I([Invitation link opened]) --> C
  C{"Ran fully on this<br/>computer before?"}
  C -- "yes: nothing is shown" --> R
  C -- "no" --> W1

  W1["Window 1 - Setup wizard<br/>checks and installs the dependencies"]
  W1 -- "all steps finished OK" --> OK["Remember: ran fully<br/>(never opens again)"]
  W1 -- "X" --> W2
  W1 -. "X while installs run:<br/>they keep running" .-> BG["Installs continue in the background"]
  BG -- "all steps finished OK" --> OK
  BG -- "any step failed or declined" --> NO["Not remembered:<br/>the wizard opens again next time"]

  W2["Window 2<br/>'Flowpad was not installed with all the required dependencies'<br/>[Run setup] [Continue anyway]"]
  W2 -- "Run setup" --> W1
  W2 -- "Continue anyway or X" --> W3

  W3["Window 3<br/>explains where to run setup again<br/>Settings -> General -> Run setup again<br/>(no button: closed with X)"]
  W3 -- "X" --> R
  OK --> R

  Q["Rule: while windows 1 to 3 are active<br/>no other dialog is shown.<br/>They wait, and appear after the flow ends.<br/>Only the wizard's own questions<br/>(approve an install, LLM source) may appear"]
  Q -.- W1
  Q -.- W2
  Q -.- W3

  R{"Where did the person come from?"}
  R -- "project setup" --> P["Continue the project setup"]
  R -- "invitation link" --> ID["Only now: show the invitation dialog<br/>'Someone shared a project with you'"]
  ID -- "Set up project" --> P
  R -- "app load" --> H["Home page"]
```
