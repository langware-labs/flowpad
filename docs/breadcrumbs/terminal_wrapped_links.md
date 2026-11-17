---
id: b37d22ca-1459-45aa-a14c-a9c8daa734cf
title: 'Terminal links: a wrapped path ends at the shell prompt'
tags:
- breadcrumb.test.terminal_wrapped_links.rules
description: A path the terminal wrapped, even one that fills its last row to the
  edge, never takes in the shell prompt word on the row below it.
---
# Terminal links: a wrapped path ends at the shell prompt

> Ground truth. Proven by RCA on 2026-11-15. Do not edit without the user's approval.

```breadcrumb
tag: breadcrumb.test.terminal_wrapped_links.rules
sites:
  - rel_path: "ui/tests/unit/terminal-links-prompt-after-path.test.ts"
    line: 6
    note: "FAILING? read this tag's rules before editing terminal-links.ts continuesBelow"
```

## Expected behavior

A file path printed in a terminal and soft-wrapped by xterm over several rows opens on click from
any of its rows. The shell prompt printed after it (`host%`, `dir $`, `#`, `>`, `❯`) is the next
command line, never the rest of the path.

## Internals

- `ui/src/components/terminal/interactive-terminal/terminal-links.ts`, `continuesBelow(buffer, row, cols)`
  decides whether a row runs on into the next. A soft wrap (`next.isWrapped`) always joins. Otherwise
  two heuristics may still join a "hard" break, as when a TUI cut a long path itself:
  1. the row ends at the edge (`above.margin <= MAX_MARGIN`) and the edge word plus the next row's
     first word would not fit on one row;
  2. the row stops short of the edge (`columnTail`) and the next row's first word is a path in progress.
- `PROMPT_END = /[$%#>❯]$/u` names a bare prompt word. The check
  `if (PROMPT_END.test(head.text)) return undefined;` sits **before both heuristics**, right after
  `commandContinues`.
- zsh draws its end-of-line mark row (`%` and spaces, then CR) and then the prompt. After `\r\n` the
  prompt row is not `isWrapped`, so only the heuristics can glue it on.

## Invariants

- The next row's first word ending in a prompt character never joins the row above. This holds
  whether that row stopped short of the edge or filled it.
- Whether a printed path fills its last row depends on its length: the temp folder's path changes the
  wrap. So this bug is host-dependent, and the unit test pins both shapes (short of the edge, and
  exactly two full rows).

## Failure modes

- Guard only in the short-of-the-edge branch: a path of exactly `n × cols` characters resolves as
  `<path>flowpad-workload%`. The click resolves nothing and no editor opens. Seen in
  `ui/tests/manual_regression/terminal/terminal_links.md.ts` › "hover and selection do not resolve;
  a wrapped file link still opens" (a 218-character path on a 109-column terminal).
- Proven: in a headless xterm at 109 or 110 columns, `linkAtCell` returned the path plus the prompt.
  With the check moved before both branches it returns the exact path. Switching the check off again
  makes both unit cases fail.
