test 1: Empty state shown when no log entries exist
- [bash] run "rm -f ~/.flow/logs/cli.log.jsonl" to clear any existing log
- [browser] navigate to {APP_URL}/
- [browser] wait for the app to load
- [browser] click the account/user icon in the sidebar to open account panel
- [browser] click the "System" tab in the account panel
- [browser] click the "CLI Invocation Log" button
- [browser] wait for the CLI log lens panel to open
- [browser] validate "No log entries" text appears in the panel
- [browser] validate the text contains "Run a" and "flow" and "command to see entries here"
- [browser] validate the Trash2 (clear) button is disabled

test 2: Log entry appears after running a flow command
- [bash] run "rm -f ~/.flow/logs/cli.log.jsonl" to clear any existing log
- [browser] navigate to {APP_URL}/
- [browser] click the account/user icon in the sidebar to open account panel
- [browser] click the "System" tab
- [browser] click the "CLI Invocation Log" button
- [browser] validate "No log entries" text appears
- [bash] run ".venv/bin/flow log show" in the project directory and validate it exits without error
- [browser] click the Refresh button (RefreshCw icon) in the CLI log header
- [browser] wait for the entry list to update
- [browser] validate at least one entry row appears in the log list
- [browser] validate the entry row shows "flow" as the binary badge chip
- [browser] validate the entry row shows "log" as a subcommand badge chip
- [browser] validate the entry count badge in the header shows at least "1"

test 3: Index counter is visible and 1-based on entry rows
- [bash] run "rm -f ~/.flow/logs/cli.log.jsonl" to clear any existing log
- [bash] run ".venv/bin/flow log show" to add first entry
- [bash] run ".venv/bin/flow log show" to add second entry
- [browser] navigate to {APP_URL}/
- [browser] click the account/user icon in the sidebar
- [browser] click the "System" tab
- [browser] click the "CLI Invocation Log" button
- [browser] wait for entries to load
- [browser] validate the first visible entry row has index "1" displayed (1-based, newest first)
- [browser] validate the second visible entry row has index "2" displayed
- [browser] validate the entry count badge in the header matches the total number of rows shown

test 4: Click entry to open detail panel
- [bash] run "rm -f ~/.flow/logs/cli.log.jsonl" to clear any existing log
- [bash] run ".venv/bin/flow log show" to add a log entry
- [browser] navigate to {APP_URL}/
- [browser] click the account/user icon in the sidebar
- [browser] click the "System" tab
- [browser] click the "CLI Invocation Log" button
- [browser] wait for at least one entry to appear
- [browser] click the first entry row
- [browser] wait for the detail panel to expand below the row
- [browser] validate the detail panel is visible
- [browser] validate "command:" label is visible in the detail panel
- [browser] validate "workdir" label is visible in the detail panel
- [browser] validate "time:" label is visible in the detail panel
- [browser] validate the Re-invoke button (Play icon with "Re-invoke" text) is visible in the detail panel
- [browser] click the first entry row again to collapse
- [browser] validate the detail panel is no longer visible

test 5: Command parsed into binary, subcommands, and flags as badge chips
- [bash] run "rm -f ~/.flow/logs/cli.log.jsonl" to clear any existing log
- [bash] run ".venv/bin/flow hooks report --name=test_scenario" to add a hook-style entry
- [browser] navigate to {APP_URL}/
- [browser] click the account/user icon in the sidebar
- [browser] click the "System" tab
- [browser] click the "CLI Invocation Log" button
- [browser] wait for the entry to appear
- [browser] validate a badge chip showing the binary name ("flow" or path ending in "flow") appears on the entry row
- [browser] validate a badge chip showing "hooks" appears on the entry row as a subcommand
- [browser] validate a badge chip showing "report" appears on the entry row as a subcommand
- [browser] click the entry row to open the detail panel
- [browser] validate the detail panel shows "bin:" followed by the binary name
- [browser] validate flags section shows "--name" flag with value "test_scenario" as a badge in the detail panel

test 6: Stdin hook data display — structured view with collapsible JSON
- [bash] run "rm -f ~/.flow/logs/cli.log.jsonl" to clear any existing log
- [bash] run "echo '{\"hook_event_name\":\"PreToolUse\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"echo hi\"},\"session_id\":\"test-abc\"}' | .venv/bin/flow hooks report --name=test_hook" to add an entry with stdin hook data
- [browser] navigate to {APP_URL}/
- [browser] click the account/user icon in the sidebar
- [browser] click the "System" tab
- [browser] click the "CLI Invocation Log" button
- [browser] wait for the entry to appear
- [browser] click the entry row to open the detail panel
- [browser] validate "hook data:" label is visible in the detail panel
- [browser] validate a badge chip showing "PreToolUse" event name appears in the hook data section
- [browser] validate a badge chip showing "Bash" tool name appears in the hook data section
- [browser] validate "tool_input" collapsible section is visible in the detail panel
- [browser] click the "tool_input" collapsible section to expand it
- [browser] validate the expanded JSON shows "command" key and "echo hi" value
- [browser] validate a "raw" toggle link appears to switch between structured and raw view
- [browser] click the "raw" toggle
- [browser] validate the raw JSON blob is shown in a pre/code block

test 7: Re-invoke button replays the CLI command in terminal
- [bash] run "rm -f ~/.flow/logs/cli.log.jsonl" to clear any existing log
- [bash] run ".venv/bin/flow log show" to add a log entry
- [browser] navigate to {APP_URL}/
- [browser] click the account/user icon in the sidebar
- [browser] click the "System" tab
- [browser] click the "CLI Invocation Log" button
- [browser] wait for at least one entry to appear
- [browser] click the first entry row to open the detail panel
- [browser] validate the "Re-invoke" button is visible in the detail panel
- [browser] click the "Re-invoke" button
- [browser] wait for the terminal/shell tab to open or become active
- [browser] validate a shell terminal tab is now visible or has become focused
- [bash] run ".venv/bin/flow log show" and validate exit code is 0 (the re-invoked command ran)
- [browser] click the Refresh button in the CLI log header
- [browser] wait for the entry list to refresh
- [browser] validate at least 2 entries now appear in the log (original + re-invoked)

test 8: Delete/Clear button clears all log entries
- [bash] run "rm -f ~/.flow/logs/cli.log.jsonl" to clear any existing log
- [bash] run ".venv/bin/flow log show" to add a log entry
- [bash] run ".venv/bin/flow log show" to add a second log entry
- [browser] navigate to {APP_URL}/
- [browser] click the account/user icon in the sidebar
- [browser] click the "System" tab
- [browser] click the "CLI Invocation Log" button
- [browser] wait for at least 2 entries to appear
- [browser] validate the Trash2 (clear) button is enabled
- [browser] click the Trash2 (clear) button
- [browser] wait 1 second for the clear action to complete
- [browser] validate "No log entries" empty state message appears
- [browser] validate the Trash2 button is now disabled
- [browser] validate the entry count badge in the header shows "0"
- [bash] run "cat ~/.flow/logs/cli.log.jsonl 2>/dev/null | wc -l" and validate output contains "0"

test 9: Working directory tooltip — hover FolderOpen icon shows path, click copies to clipboard
- [bash] run "rm -f ~/.flow/logs/cli.log.jsonl" to clear any existing log
- [bash] run ".venv/bin/flow log show" to add a log entry (workdir will be set to the invocation directory)
- [browser] navigate to {APP_URL}/
- [browser] click the account/user icon in the sidebar
- [browser] click the "System" tab
- [browser] click the "CLI Invocation Log" button
- [browser] wait for at least one entry to appear
- [browser] hover over the FolderOpen icon at the right end of the first entry row
- [browser] validate a tooltip appears showing the working directory path as monospace text
- [browser] validate the tooltip path is a non-empty directory path (starts with "/" or contains a drive letter on Windows)
- [browser] click the FolderOpen icon
- [browser] validate the FolderOpen icon changes to a green Check icon (indicating copy success)
- [browser] wait 2 seconds
- [browser] validate the Check icon reverts back to the FolderOpen icon after the copy confirmation

test 10: Level toggle switches between info and debug log levels
- [browser] navigate to {APP_URL}/
- [browser] click the account/user icon in the sidebar
- [browser] click the "System" tab
- [browser] click the "CLI Invocation Log" button
- [browser] wait for the CLI log panel to load
- [browser] validate the "info" level button appears in the header
- [browser] validate the "debug" level button appears in the header
- [browser] validate the "info" button has active/primary styling (default level)
- [browser] click the "debug" button
- [browser] wait 1 second for the setting to be saved
- [browser] validate the "debug" button now has active/primary styling
- [browser] validate the "info" button no longer has active/primary styling
- [browser] click the "info" button to restore default
- [browser] validate the "info" button returns to active styling

test 11: Refresh button reloads entries without clearing state
- [bash] run "rm -f ~/.flow/logs/cli.log.jsonl" to clear any existing log
- [bash] run ".venv/bin/flow log show" to add one entry
- [browser] navigate to {APP_URL}/
- [browser] click the account/user icon in the sidebar
- [browser] click the "System" tab
- [browser] click the "CLI Invocation Log" button
- [browser] wait for 1 entry to appear
- [bash] run ".venv/bin/flow log show" to add a second entry (while panel is open)
- [browser] validate still only 1 entry is shown (panel has not auto-refreshed)
- [browser] click the Refresh button (RefreshCw icon) in the CLI log header
- [browser] wait for the entry list to update
- [browser] validate 2 entries are now visible in the log list
