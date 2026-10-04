import { useMemo, type MouseEvent } from 'react';
import { linkSegments, type LinkHandlers } from '@src/lib/link-matches';

/** The terminal's rule, on the DOM: only a plain primary click activates (never a macOS ctrl-click). */
function isPrimaryClick(event: MouseEvent): boolean {
  return event.button === 0 && !(event.ctrlKey && /Mac/i.test(navigator.userAgent));
}

/** A drag that selected text is a selection, not a click. */
function selectedText(): boolean {
  const selection = window.getSelection();
  return !!selection && !selection.isCollapsed && selection.toString().length > 0;
}

/**
 * Plain text with every file reference and web URL live — the same matches, click and
 * right-click menu as a terminal (`linkSegments` + `useLinks`). Each link is isolated
 * left-to-right so a URL inside right-to-left prose keeps its own order.
 */
export function LinkifiedText({ text, handlers }: { text: string; handlers: LinkHandlers }) {
  const segments = useMemo(() => linkSegments(text), [text]);
  return (
    <>
      {segments.map((segment, i) => {
        const link = segment.link;
        if (!link) return segment.text;
        return (
          <span
            key={i}
            // No tabIndex: a focusable span blocks a drag-selection from starting inside it, and a
            // terminal link is not a tab stop either.
            role="link"
            dir="ltr"
            data-link={link}
            className="cursor-pointer text-primary [unicode-bidi:isolate] hover:underline"
            onClick={(event) => {
              if (!isPrimaryClick(event) || selectedText()) return;
              event.stopPropagation();
              handlers.activate(event.nativeEvent, link);
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              handlers.openMenu(link, event.clientX, event.clientY);
            }}
          >
            {segment.text}
          </span>
        );
      })}
    </>
  );
}
