---
id: ae88605f-7f35-59c9-a9a0-c72f8948cd98
---

test 1: Prompt index icon appears in agentic process terminal ribbon
- navigate to {APP_URL}/dock/shell/new_terminal
- click the "Start Claude" button to create a new agentic process
- wait for URL to match /dock/shell/agentic_process-/ (up to 20 seconds)
- wait 3 seconds for terminal and ribbon to initialize
- validate the bottom ribbon is visible (the area with the idle/running LED)
- validate a MessageSquare button is visible in the ribbon's right section (.ml-auto)
  (it is the 4th button at index 3: Shell(0), Worktree(1), Git(2), Prompts(3), Queue(4), Files(5))
- validate the button has NO title attribute — it uses a tooltip on hover instead
- validate a badge with the prompt count (lime pill) appears when prompts exist

test 2: Prompt panel opens as a tab in the side window
- navigate to an agentic process terminal
- click the MessageSquare (Prompts) ribbon button
- validate the side window appears: a w-80 flex-col border-l div
- validate the tab strip shows a "Prompts" tab
- validate the tab has a × close button (aria-label="Close Prompts")
- validate the panel inner header shows "Prompts (N)" with a MessageSquare icon
- validate the panel inner header has NO X close button (closing is done via the tab strip ×)
- validate either "No prompts yet" text or a list of prompt items is shown

test 3: Prompt tab closes via the × button in the tab strip
- navigate to an agentic process terminal
- open the Prompts panel (click MessageSquare ribbon button)
- validate the "Prompts" tab is visible in the tab strip
- click the × button inside the "Prompts" tab (aria-label="Close Prompts")
- validate the side window is no longer visible (no tabs remain)

test 4: Clicking ribbon button when Prompts is already active does NOT close the panel
- navigate to an agentic process terminal
- click the Prompts ribbon button once → Prompts tab opens and is active
- click the Prompts ribbon button a second time → Prompts tab remains open and active
  (the new behavior: second click re-selects the already-active tab; it does NOT close it)
- to close, click the × in the "Prompts" tab → panel closes

test 5: Prompt count badge appears and matches panel header count
- navigate to an agentic process terminal that has completed at least one prompt/response cycle
- wait for terminal replay to complete (terminal content is visible)
- validate the Prompts ribbon button shows a numeric badge (lime-colored pill) with count > 0
- click the button to open the Prompts panel
- validate the panel inner header shows "Prompts (N)" where N equals the badge number
- validate N prompt items are listed in the panel body

test 6: Clicking a prompt item expands it to show full text
- navigate to an agentic process with at least one completed prompt
- open the Prompts panel (badge count > 0)
- in the panel body, click a prompt item
- validate the item expands to show the full prompt text (in a <pre> block)
- validate the collapsed preview (first 80 chars + ellipsis) is replaced by the full text
- validate a "→ N" row number indicator is shown if absRow is known

test 7: Clicking a collapsed prompt item a second time collapses it
- follow test 6 steps to expand a prompt item
- click the same prompt item again
- validate the item returns to collapsed view (single line preview, no <pre> block)

test 8: Annotation-sourced prompts show lime color indicator
- navigate to an agentic process with at least one completed prompt annotation
- open the Prompts panel
- validate at least one prompt item shows a lime-colored source badge labeled "A" (annotation)

test 9: Trace-sourced prompts show sky color indicator
- navigate to an agentic process with UserMessage trace events (any completed session)
- open the Prompts panel
- validate at least one prompt item shows a sky-colored source badge labeled "T" (trace)

test 10: Prompt icon is absent in plain shell terminal (no agentic process)
- navigate to {APP_URL}/dock/shell/new_terminal and wait for the plain shell to load
  (do NOT click Start Claude — stay on the plain shell tab)
- validate the bottom ribbon (idle LED + icons) is NOT present in the DOM
- validate no MessageSquare button (index 3 in .ml-auto) exists in the active terminal panel
  (the ribbon only renders when an agentic process is attached)

test 11: Prompt panel refit — terminal resizes when panel opens and closes
- navigate to an agentic process terminal
- note the terminal's xterm container width before opening any side panel
- click the Prompts button → side window (320px) appears on the right
- wait 500ms for the terminal to refit
- validate the terminal area (xterm container) is narrower
- click × in the Prompts tab to close the side window
- wait 500ms for refit
- validate the terminal area returns to its original width

test 12: Multiple panels open as tabs in the same side window
- navigate to an agentic process terminal
- open the Files panel (click Paperclip icon at index 5)
- validate the side window appears with a "Files" tab
- open the Prompts panel (click MessageSquare icon at index 3)
- validate the "Prompts" tab is added to the same side window (both tabs visible in the strip)
- validate the Prompts panel content is shown (last opened = active)
- validate the terminal area width is reduced by one side window (320px), NOT by two
  (all panels share the single 320px side window — they do not stack side-by-side)
- click the "Files" tab → Files panel becomes active; Prompts tab still present
- close both tabs via × → side window disappears
