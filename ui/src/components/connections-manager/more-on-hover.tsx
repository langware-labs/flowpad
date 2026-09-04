import * as React from 'react';

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip';

/**
 * A cell that shows a couple of chips and a `+N` — with the rest actually
 * revealable.
 *
 * Both connection cells (OAuth scopes, a credential's env vars) used to hang the
 * full list off a native `title`. That asks for a second of stillness, renders
 * as an unstyled OS bubble, is cancelled the moment the pointer keeps moving,
 * and in the desktop shell frequently never appears at all — so the `+N` read as
 * a dead end. This is the same reveal through the app's own tooltip, which opens
 * on hover AND on keyboard focus.
 *
 * Mounts its own `TooltipProvider`, like `TabStrip`: a cell that owns a hover
 * should not stop working because of where it was mounted.
 */
export function MoreOnHover({ lines, children }: { lines: string[]; children: React.ReactNode }) {
  // Nothing hidden, nothing to reveal: a tooltip that repeats what is already on
  // screen is noise, and a hover target that says nothing new is worse than none.
  if (lines.length <= 1) return <>{children}</>;
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0} className="inline-flex outline-none">
            {children}
          </span>
        </TooltipTrigger>
        <TooltipContent align="start" className="max-h-64 overflow-auto">
          <ul className="space-y-0.5 font-mono text-[11px]">
            {lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
