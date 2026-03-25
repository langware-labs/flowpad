test 1: Scroll sync - viewportY tracks correctly as terminal scrolls
- navigate to /dock/shell/new_terminal
- wait for PTY to be ready (prompt visible)
- run 60 commands to fill the terminal with output: type a loop or many echo commands
- validate the terminal has scrolled (content extends beyond visible rows)
- scroll the terminal to the top
- validate the top of the terminal content is visible (earliest output)
- scroll the terminal to the bottom
- validate the latest output (most recent prompt) is visible at the bottom
- validate no ANSI escape sequences are visible as raw text in the terminal

test 2: Scroll sync - resize does not break scroll position
- navigate to /dock/shell/new_terminal
- wait for PTY to be ready
- run 40 echo commands to generate scrollback content
- scroll to the middle of the terminal output
- note the visible content (a specific echo output line)
- resize the browser window to a smaller width (triggers terminal refit)
- validate the terminal is still functional (can accept input)
- type "echo AFTER_RESIZE" and press Enter
- validate "AFTER_RESIZE" appears in the terminal output
- validate no raw escape sequences are visible
