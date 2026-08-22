import type { SVGProps } from 'react';

type OpenCodeIconProps = SVGProps<SVGSVGElement> & { className?: string };

/**
 * The official OpenCode mark.
 *
 * Traced from the vendor's own artwork (https://opencode.ai/favicon.svg): an
 * outer frame with a rectangular void, and the lower half of that void filled —
 * white frame over a mid-grey block in the original. Reproduced here as a single
 * monochrome form so it inherits `currentColor` and reads at 12–16px in the tab
 * strip, exactly like the Claude / Codex / Copilot marks beside it. The
 * favicon's dark `#131010` background plate is deliberately dropped; an inline
 * icon paints on the surrounding surface.
 *
 * Geometry is the official mark rescaled from its 512-unit box to a 16-unit one
 * (the source occupies 128–384 × 96–416 there), fitted with one unit of padding.
 *
 * This is the ONLY place OpenCode's artwork is defined. Every surface reaches it
 * through a registry — `PROVIDER_META`, `PROCESS_ICONS`, `lucideByName`, and the
 * restore-badge wrapper — so the mark is changed here and nowhere else.
 */
export function OpenCodeIcon({ className, 'aria-label': ariaLabel = 'OpenCode', ...rest }: OpenCodeIconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      className={className}
      aria-label={ariaLabel}
      {...rest}
    >
      {/* Frame with the rectangular void punched out (evenodd, as in the source). */}
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M2.4 1H13.6V15H2.4V1ZM5.2 3.8H10.8V12.2H5.2V3.8Z"
        fill="currentColor"
      />
      {/* The filled lower half of the void — the mark's second tone. */}
      <path d="M5.2 6.6H10.8V12.2H5.2V6.6Z" fill="currentColor" opacity="0.45" />
    </svg>
  );
}
