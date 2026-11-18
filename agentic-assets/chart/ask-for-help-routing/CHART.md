---
id: 4f5f59c0-8321-4690-b0f4-19d55fa187e6
name: ask-for-help-routing
description: Where a help request goes today, from the click to the hub. The user
  picks a help desk, people, or nobody. A desk request becomes a ticket in the nearest
  configured desk, and Flowpad support is the last fallback. Read from the code on
  2026-11-18.
format: excalidraw
session: cb455f48-3c7e-4352-9f5c-a83fcc90d6d3
version: 24
---
The real flow, not a design. Sources: `flow_sdk/app/actions/ask_for_help_action.py` (capture, `help-recipients`, `_open_ticket`, `_open_person_ask`, `_report_target`), `flow_sdk/app/actions/flow_message_action.py` (`resolve_helpdesk`, `_hub_default_helpdesk`), `flow_sdk/app/helpdesk_resolver.py`, `ui/src/components/help/AskForHelpDialog.tsx`, and the hub's `flowpad/config.py` (`HELPDESK_PROJECT_ID`).

The desk is the user's choice, not an automatic route: the dialog lists every desk they can ask, nearest first, and pre-checks the first one. Adding a person unchecks the desks. A desk and people together make two conversations: the people's conversation and the desk's own ticket. Every extra desk checked gets a ticket of its own.

```mermaid
flowchart TD
  start(["User clicks Ask for help<br/>top bar, a desk's page, a credential page, a diagnosis"])
  fix(["User clicks Diagnose & fix<br/>on a warning or an error"])
  start --> q1

  subgraph NEAREST["1 · Dialog opens: which desk is pre-checked (help-recipients)"]
    direction TB
    q1{"Is this project itself<br/>a help desk portal?"}
    q2{"Did this project adopt a desk?<br/>helpdesk.json in its root<br/>or in a dependency"}
    q3{"Did the user add a desk<br/>on the hub?"}
    q4{"Does the hub have a default desk?<br/>/version helpdesk_project_id"}
    k1["This help desk"]
    k2["This project's help desk"]
    k3["The desk the user added"]
    k4["Flowpad support<br/>hub project<br/>4f9f1fd1-39b6-5465-9c20-cb4c59b08318"]
    k5["Last known Flowpad support,<br/>else a Help desk chip with no id"]
    k6["No desk is offered"]
    q1 -- yes --> k1
    q1 -- no --> q2
    q2 -- yes --> k2
    q2 -- no --> q3
    q3 -- yes --> k3
    q3 -- no --> q4
    q4 -- yes --> k4
    q4 -- "hub not reachable" --> k5
    q4 -- "hub has none" --> k6
  end

  k1 --> sendto
  k2 --> sendto
  k3 --> sendto
  k4 --> sendto
  k5 --> sendto
  k6 --> sendto
  sendto{"2 · Send to:<br/>what is checked when<br/>the user presses Send?"}

  subgraph PERSON["3a · People"]
    direction TB
    p1["Saved on this computer:<br/>a task for the first person and<br/>a conversation with the people.<br/>Diagnosis runs in the background"]
    p2["Hub: task shared and assigned,<br/>conversation shared with the people,<br/>then the messages"]
    p3(["The person gets the conversation<br/>and the task"])
    p1 --> p2 --> p3
  end

  subgraph DESK["3b · A help desk"]
    direction TB
    t1["Saved on this computer:<br/>a ticket conversation that keeps<br/>the desk id. Diagnosis runs<br/>in the background"]
    t2{"Does the ticket<br/>have a desk id?"}
    t3{"Resolve it now:<br/>adopted desk,<br/>else the hub default"}
    t4["POST project/DESK_ID/<br/>start_guest_conversation"]
    t5(["Ticket in that desk's queue"])
    t6["Not sent: This hub has no help desk,<br/>ask a person instead"]
    t1 --> t2
    t2 -- yes --> t4
    t2 -- no --> t3
    t3 -- found --> t4
    t3 -- none --> t6
    t4 --> t5
  end

  subgraph PRIVATE["3c · Nobody"]
    direction TB
    n1["Private conversation on this computer<br/>with the diagnosis. Nothing is sent"]
    n2["User presses Report it<br/>offered when the cause is Flowpad,<br/>a dependency or unknown"]
    n3{"Is the cause a dependency<br/>with its own adopted desk?"}
    n4["Becomes a ticket<br/>for that dependency's desk"]
    n5["Becomes a ticket<br/>for Flowpad support"]
    n1 --> n2 --> n3
    n3 -- yes --> n4
    n3 -- no --> n5
  end

  sendto -- "people" --> p1
  sendto -- "a desk" --> t1
  sendto -- "nobody" --> n1
  fix --> n1
  n4 --> t2
  n5 --> t2

  owed["Signed out or hub not reachable:<br/>the request stays saved and is sent<br/>on sign-in, reconnect or startup"]
  p1 -.-> owed
  t1 -.-> owed
```

<!-- BEGIN chart:auto -->
```mermaid
flowchart TD
  N1[3c · Nobody]
  N2[3b · A help desk]
  N3[3a · People]
  N4["1 · Dialog opens: which desk is pre-checked (help-recipients)"]
  N5["User clicks Ask for help<br>top bar, a desk's page, a credential page, a
diagnosis"]
  N6["User clicks Diagnose &
fix<br>on a warning or an error"]
  N7{{"Is this project
itself<br>a help
desk portal?"}}
  N8{{"Did this project adopt a
desk?<br>helpdesk.json in
its root<br>or in a
dependency"}}
  N9{{"Did the user add a
desk<br>on the hub?"}}
  N10{{"Does the hub have a default
desk?<br>/version
helpdesk_project_id"}}
  N11[This help desk]
  N12[This project's help desk]
  N13[The desk the user added]
  N14["Flowpad support<br>hub project<br>4f9f1fd1-39b6-
5465-9c20-cb4c59b08318"]
  N15["Last known Flowpad support,<br>else a
Help desk chip with no id"]
  N16[No desk is offered]
  N17{{"2 · Send to:<br>what
is checked
when<br>the user
presses Send?"}}
  N18["Saved on this computer:<br>a task for the
first person and<br>a conversation with the
people.<br>Diagnosis runs in the background"]
  N19["Hub: task shared and assigned,<br>conversation
shared with the people,<br>then the messages"]
  N20["The person gets the conversation<br>and the task"]
  N21["Saved on this computer:<br>a ticket
conversation that keeps<br>the desk id.
Diagnosis runs<br>in the background"]
  N22{{"Does the
ticket<br>have
a desk id?"}}
  N23{{"Resolve it now:
<br>adopted desk,
<br>else the hub
default"}}
  N24["POST project/DESK_ID/
<br>start_guest_conversation"]
  N25[Ticket in that desk's queue]
  N26["Not sent: This hub has no help desk,<br>ask a
person instead"]
  N27["Private conversation on this computer<br>with the
diagnosis. Nothing is sent"]
  N28["User presses Report it<br>offered when the cause
is Flowpad,<br>a dependency or unknown"]
  N29{{"Is the cause a
dependency<br>with
its own adopted desk?"}}
  N30["Becomes a ticket<br>for that
dependency's desk"]
  N31["Becomes a ticket<br>for
Flowpad support"]
  N32["Signed out or hub not reachable:<br>the request
stays saved and is sent<br>on sign-in, reconnect
or startup"]
  N5 --> N7
  N7 --> N11
  N7 --> N8
  N8 --> N12
  N8 --> N9
  N9 --> N13
  N9 --> N10
  N10 --> N14
  N10 -->|hub not reachable| N15
  N10 --> N16
  N11 --> N17
  N12 --> N17
  N13 --> N17
  N14 --> N17
  N15 --> N17
  N16 --> N17
  N18 --> N19
  N19 --> N20
  N21 --> N22
  N22 --> N24
  N22 --> N23
  N23 --> N24
  N23 -->|none| N26
  N24 --> N25
  N28 --> N28
  N29 --> N29
  N29 --> N30
  N29 --> N31
  N17 --> N18
  N17 --> N21
  N17 --> N27
  N6 --> N27
  N30 --> N22
  N31 --> N22
  N18 --> N32
  N21 --> N32
  %% loose elements: 16 orphan-text
```

_Auto-generated from board.json — edits inside this block are overwritten on next save._
<!-- END chart:auto -->
