---
id: b2072b1d-0e04-5eb7-8603-25f8e36f0f83
---

test 1: Time gutter field columns are aligned with fixed widths
- navigate to {APP_URL}/dock/shell/new_terminal, then open the tab-opener "+" (data-testid="opener-plus-button") and pick the "Claude Code" row (data-testid="opener-menu-row-claude")
- wait for Claude CLI banner to appear (up to 45 seconds)
- open the Columns & Trace dropdown in the toolbar
- enable the "Time gutter" toggle if not already on
- enable at least two time sub-fields (e.g. PTY time and Seq #)
- validate the time gutter column is visible (data-testid="time-gutter" or matching border-r element)
- validate each field cell has an explicit fixed width style (not auto/flex)
- enable a third field (e.g. Abs row) and validate the gutter width increases by the expected amount
- validate all field cells remain left-aligned and do not overlap

test 2: PTY segment border markers appear in time gutter
- navigate to an existing Claude process terminal that has run at least one command
  e.g. {APP_URL}/dock/shell/<any agentic_process id>
- wait for replay to complete (terminal content is visible)
- open the Columns & Trace dropdown and enable "Time gutter"
- scroll through the time gutter
- validate at least one sky-blue 3px horizontal bar is visible inside the time gutter (segment start border)
- hover over the sky-blue bar
- validate a tooltip appears showing segment boundary info: Start time, End time, Duration, Row range

test 3: PTY segment border tooltip shows start anchor and end anchor when present
- navigate to a Claude process that has completed at least one prompt/response cycle
- wait for replay to complete
- enable the time gutter
- locate the sky-blue segment border bar in the time gutter
- hover over it
- validate the tooltip contains "Start anchor" and/or "End anchor" labels with timestamp subtext
- validate the tooltip contains "Duration" and a value (e.g. "3.2s" or "1m 12s")

test 4: Prompt annotations appear in annotation gutter after replay completes
- navigate to {APP_URL}/dock/shell/<an agentic_process with at least one completed prompt>
- wait for terminal replay to complete (content is visible)
- open the Columns & Trace dropdown
- enable the "Prompt annotations" toggle (promptAnnotations filter)
- validate the annotation gutter is visible (data-testid="annotation-gutter")
- validate at least one prompt annotation marker appears in the gutter aligned to the line containing the prompt text
- the annotation marker must NOT appear at row 0 or at an empty row

test 5: Prompt annotations do not appear before replay is complete
- navigate to {APP_URL}/dock/shell/<an agentic_process with at least one completed prompt>
- immediately (before terminal content loads) check: annotation gutter markers for prompt kind must be absent
- wait for replay to complete
- validate prompt annotation markers now appear (with promptAnnotations filter enabled)
- this confirms annotations are only positioned after the xterm buffer is fully populated

test 6: Column header bar — hide and restore trace column
- navigate to {APP_URL}/dock/shell/new_terminal, then open the tab-opener "+" (data-testid="opener-plus-button") and pick the "Claude Code" row (data-testid="opener-menu-row-claude")
- wait for Claude CLI banner
- validate the column header bar is visible (18px strip above the terminal content)
- validate the trace gutter is visible (data-testid="trace-gutter")
- click the EyeOff icon in the Trace column header cell
- validate the trace gutter disappears from the content area
- validate the Trace column header cell now shows the Activity icon (dimmed, not EyeOff)
- click the Activity icon to restore
- validate the trace gutter reappears

test 7: Column header bar — hide and restore annotations column
- navigate to {APP_URL}/dock/shell/new_terminal, then open the tab-opener "+" (data-testid="opener-plus-button") and pick the "Claude Code" row (data-testid="opener-menu-row-claude")
- wait for Claude CLI banner
- validate the annotation gutter is visible (data-testid="annotation-gutter")
- click the EyeOff icon in the Annotations column header cell
- validate the annotation gutter disappears
- validate the Annotations header cell now shows the MessageSquare icon (dimmed)
- click the MessageSquare icon to restore
- validate the annotation gutter reappears

test 8: Column visibility persists across page refresh
- navigate to {APP_URL}/dock/shell/new_terminal, then open the tab-opener "+" (data-testid="opener-plus-button") and pick the "Claude Code" row (data-testid="opener-menu-row-claude")
- hide the trace column via the EyeOff button in the column header
- reload the page
- wait for terminal to be ready
- validate the trace gutter is still hidden (colVisibility persisted in localStorage)
- restore via the Activity icon
- reload the page again
- validate the trace gutter is now visible again

test 9: BugPlay dropdown — Trace and Annotations column toggles (entry-point parity with column header)
- navigate to {APP_URL}/dock/shell/new_terminal, then open the tab-opener "+" (data-testid="opener-plus-button") and pick the "Claude Code" row (data-testid="opener-menu-row-claude")
- wait for Claude CLI banner
- open the Columns & Trace dropdown (BugPlay icon in the process toolbar)
- uncheck "Trace events"
- validate the trace gutter disappears (same effect as tests 6/7 via header EyeOff)
- re-check "Trace events"; validate the trace gutter reappears AND traceFilters.events is on
- uncheck "Annotations"; validate the annotation gutter disappears
- re-check "Annotations"; validate the annotation gutter reappears
- this locks entry-point parity: dropdown checkboxes and column-header icons must produce the same colVis state

test 10: Time-gutter row/anchor time-range fields render extra columns
- navigate to a Claude process that has completed at least one prompt/response cycle
  e.g. {APP_URL}/dock/shell/<an agentic_process id>
- wait for replay to complete
- open the Columns & Trace dropdown and enable "Time gutter"
- note the current time-gutter width
- enable "Row time range" (traceFilters.debugTime); validate the gutter widens and a row-time-range field cell appears
- enable "Anchor time range" (traceFilters.refTime); validate the gutter widens again and the anchor-time-range field cell appears
- disable both; validate the gutter returns to its prior width and the extra cells are removed
