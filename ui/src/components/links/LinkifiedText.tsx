import { useMemo } from 'react';
import { linkSegments } from '@src/lib/link-matches';
import { linkEventProps, type LinkHandlers } from './link-events';

/**
 * Plain text with every file reference and web URL live — the same matches, click and
 * right-click menu as a terminal (`linkSegments` + `useLinks`). Each link is isolated
 * left-to-right so a URL inside right-to-left prose keeps its own order.
 */
export function LinkifiedText({ text, handlers }: { text: string; handlers: LinkHandlers }) {
  const segments = useMemo(() => linkSegments(text), [text]);
  return (
    <>
      {segments.map((segment, i) =>
        segment.link ? (
          <span
            key={i}
            // No tabIndex: a focusable span blocks a drag-selection from starting inside it, and a
            // terminal link is not a tab stop either.
            role="link"
            dir="ltr"
            className="cursor-pointer text-primary [unicode-bidi:isolate] hover:underline"
            {...linkEventProps(handlers, segment.text)}
          >
            {segment.text}
          </span>
        ) : (
          segment.text
        ),
      )}
    </>
  );
}
