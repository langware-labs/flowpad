---
id: 265de32b-bb24-5f3d-86f1-67d6241382c9
---

test 1: while agent is executing, refresh clears previous "thinking" segments of chat. after agent finished execution, refresh is required to render the chat in full (FLOWPAD-1647)
- open a new session
- prompt chat: “create a calculator webapp in react”
- as new “thinking” segments are created by agent, click refresh
- wait until agent finishes executing task
- validate entire chat is visible, if not → test failed (refresh after agent finished executing renders entire chat)
