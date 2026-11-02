# Positive-reinforcement visual cues in messaging & AI chat products — examples catalog

## What exact icons/colors/animations/words does each product use and when?

### Takeaway
Messaging apps signal a message's progress with a ladder of small marks: clock → one tick → two ticks → color change or "Read". Productivity apps use rarer, bigger rewards: random flying creatures, mascot transformations, confetti and rotating "all caught up" copy. Those rewards are kept for completions and milestones and are often deliberately intermittent.

### Cited Findings
**Delivery and read status**
- **WhatsApp:**
  - clock icon = still sending
  - one grey tick = sent from the device, delivery not yet confirmed
  - two grey ticks = reached the recipient's device
  - two blue ticks = read
  - In groups, the ticks turn blue only when **all** members have read the message.
  - If either side turns read receipts off, the ticks stay grey.
  - Sources: [TimelinesAI](https://timelines.ai/different-check-marks-mean-on-whatsapp); [Tech Advisor](https://www.techadvisor.com/article/727095/what-are-the-two-blue-ticks-in-whatsapp.html); [LINK Mobility](https://www.linkmobility.com/blog/what-does-one-tick-mean-on-whatsapp)
- **Telegram:**
  - One check = the message reached Telegram's cloud.
  - Two checks = read. Some sources disagree and say two checks mean delivered.
  - The marks are green in the default theme ([itgeared, "one green check"](https://www.itgeared.com/what-does-one-green-check-mean-on-telegram/)).
  - In groups, you can tap a message to see who read it.
  - Read receipts can't be turned off.
  - Sources: [Guiding Tech](https://www.guidingtech.com/telegram-read-receipts/); [iGeeksBlog](https://www.igeeksblog.com/what-do-symbols-icons-mean-on-telegram/). The sources conflict on what the second check means.
- **iMessage:**
  - Status is a text label under the message, "Delivered", then "Read" if the recipient has read receipts on. With receipts off, the sender sees only "Delivered".
  - Exact timestamps are hidden until you swipe left.
  - Sources: [iMore](https://www.imore.com/secret-imessage-shortcuts-gestures-speed-your-iphone-chat). These are secondary sources; I found no Apple doc.

**Reactions**
- **iMessage Tapbacks:** heart, thumbs up, thumbs down, "Ha ha", "!!", "?". They work on any message type ([iMore](https://www.imore.com/secret-imessage-shortcuts-gestures-speed-your-iphone-chat); [OpenClaw docs](https://docs.openclaw.ai/channels/imessage/rich-messages.md)).
- **Slack:** the confetti/party emoji is commonly used in Slack and Discord to mark milestones and congratulate people ([communityone](https://communityone.io/emoji/confetti-1412749318162747422/), a third-party source). A third-party Chrome extension turns reactji into page confetti ([Reactji Confetti Cannon](https://chrome.google.com/webstore/detail/reactji-confetti-cannon/opjjdbgeaeedpihpodiajgpjifmfecom)).

**Celebrations**
- **Asana:**
  - A unicorn, plus a narwhal, phoenix and yeti added in March 2016, flies across the screen when you complete a task.
  - It is *occasional*: "Celebrations don't appear every time you complete a task." Completing several tasks in a row may trigger one.
  - Users opt in via Profile Settings > Display > "Show occasional celebrations upon task completion."
  - The unicorn began as an April Fool's joke and is meant to embody "the amazing collaboration that happens on Asana."
  - Sources: [Asana blog](https://asana.com/inside-asana/new-celebrations). [Zapier](https://zapier.com/blog/asana-celebrations) also lists an otter.
  - A forum user reported that an "Extra Delight" setting showed only a rainbow effect on the task row ([Asana forum](https://forum.asana.com/t/additional-and-customizable-asana-celebrations/3715)).
- **Duolingo:**
  - On a milestone streak, the owl transforms into a flaming phoenix, styled like a video-game "power-up". An earlier version had the owl holding number balloons (50/100/365), which the team found "cute" but lacking energy.
  - The share card reads "I just reached a streak!"
  - Duolingo's team says timing is "everything" in the animation.
  - Source: [Duolingo blog](https://blog.duolingo.com/streak-milestone-design-animation)
  - On an ordinary day, the lesson end shows XP and a small celebration, then the streak increments. The full-screen animation is kept for milestones ([Deconstructor of Fun](https://duolingo.deconstructoroffun.com/mechanics/streaks)).
  - The motion team tested sound-only, haptics-only and combined versions of the Friends Streak animation ([LinkedIn, Duolingo designer](https://vn.linkedin.com/in/bacaibuihung), a weak source).
  - One analysis describes the 365-day screen as having the owl, a flame and confetti ([Desirability Lab](https://desirabilitylab.com/backfill/backfill-2025-353-duolingo-streak-system)).

**Positive microcopy**
- **Slack mobile "Catch up":** after you swipe through unread messages, a congratulations message appears. Its copy rotates, with variants such as "All Clear", "You're up to date" and "All caught up. What's next?" ([UX Collective](https://uxdesign.cc/the-power-of-empty-states-how-slack-drives-user-activation-3a64dda73162), single third-party source).
- **Superhuman:** turns Inbox Zero into an event. Its Inbox Zero Day asks users to "give yourself a high five" ([Superhuman blog](https://blog.superhuman.com/inboxzeroday/)).

### Inferences
- There are two families of cue:
  - **Status confirmation:** small, every time, monochrome, with a color change at the final state.
  - **Celebration:** large, rare or random, delightful, and usually optional.
- Variable rewards (Asana's random creatures, Slack's rotating copy) are used on purpose so the cue doesn't wear out.

### Gaps
- I found no verified source for Linear's inbox-zero or completion illustration, or for the exact Slack wording "Nice work". The only Linear claim I found ([brainy.ink](https://brainy.ink/paper/glossary/inbox-zero)) is unverified.
- I found no official specs (hex colors, durations) for the WhatsApp or Telegram ticks or for Duolingo's animation.
- I found no Apple primary doc for iMessage receipts or Tapbacks.

## How do agent UIs signal step completion and task success?

### Takeaway
Agent UIs mostly show a **structured to-do or plan list**, where each item moves pending → in progress → completed with a check. Some add a replayable step trail. I found little documented evidence of celebration or explicitly "positive" copy in agent UIs. The cue is mostly about progress being visible.

### Cited Findings
- **Claude Code:**
  - The to-do/Tasks list shows each item's state as pending, in progress or completed, in the terminal status area. Ctrl+T toggles it.
  - The Todo system was replaced by "Tasks" in v2.1.16 (January 2026).
  - Markdown `- [x]` now renders as checked boxes.
  - Sources: [ClaudeLog](https://claudelog.com/faqs/what-is-todo-list-in-claude-code/); [claudeissues #61593](https://claudeissues.com/issue/61593-docs-interactive-mode-docs-omit-gfm-task-list-checkbox-rendering-in-markdown-out). These are secondary sources.
  - One issue complains that TodoWrite only showed a "success message" instead of the visual checkbox list ([claudeissues #6891](https://claudeissues.com/issue/6891-todowrite-tool-no-longer-outputs-visual-checkbox-list-only-shows-success-message)). Users clearly value the visible ticked list.
  - A community plugin adds a progress bar above the prompt, driven by the to-do list ([task-line](https://github.com/muellerei/task-line/releases/tag/v0.1.0)).
- **Cursor:**
  - v1.2 added structured to-do lists, so the agent plans ahead and long tasks are easier to follow ([Cursor changelog 1.2](https://cursor.com/hi/changelog/1-2); [Classmethod](https://dev.classmethod.jp/articles/cursor-todo_list/)).
  - v3.0 fixed to-do cards disappearing once every item was complete ([Cursor 3.0 changelog](https://cursor.com/ja/changelog/3-0)). This suggests the "all done" state is meant to stay visible.
  - Users report that the agent sometimes fails to mark items done ([Cursor forum](https://forum.cursor.com/t/cursor-keeps-ignoring-its-own-to-do-list-and-never-marks-tasks-as-completed-is-this-normal/138667)). Completion marks that don't match reality erode trust.
- **ChatGPT agent mode:** a browser inset shows the steps and screenshots the agent went through, and users can scrub back through them. The agent runs until the task ends or needs user intervention ([CometAPI guide](https://www.cometapi.com/de/how-to-use-chatgpt-agent-mode-step-by-step/), third-party).
- **Generic agent to-do components** use the same three states: pending, in-progress, completed ([21st.dev Agent Todo List](https://21st.dev/@starc007/components/todo-list.md)).

### Inferences
- In agent UIs, the reinforcement is mainly *legibility*: ticked steps that persist. Celebration is rare.
- Accuracy matters more than delight. A false or missing tick (the Cursor reports) is a negative signal.

### Gaps
- I found no sources for Copilot's or Claude.ai's tool-done check icons, for "Done"/"All set" copy in AI chats, or for how thumbs-up feedback buttons are shown. My searches returned nothing authoritative.
- I found no OpenAI primary documentation on the agent-mode progress UI.
