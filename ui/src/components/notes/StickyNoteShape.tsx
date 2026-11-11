import { useId } from 'react';
import { noteColor } from './note-palette';

/**
 * The sticky-note glyph, drawn inline so its colour can follow the note
 * (`flowpad.sticky-note` in the icon pack is the same artwork, fixed yellow).
 * Gradient ids come from `useId()`: two notes on a page must not share one —
 * an id defined inside a hidden subtree draws nothing for the others.
 */
export function StickyNoteShape({
  color,
  size = 16,
  className,
}: {
  color?: string;
  size?: number;
  className?: string;
}) {
  const id = useId().replace(/:/g, '');
  const c = noteColor(color);
  return (
    <svg viewBox="3 3 18 18" width={size} height={size} className={className} aria-hidden="true">
      <defs>
        <linearGradient id={`${id}f`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={c.face[0]} />
          <stop offset="1" stopColor={c.face[1]} />
        </linearGradient>
        <linearGradient id={`${id}p`} x1="17.25" y1="17.25" x2="14.6" y2="14.6" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={c.fold} />
          <stop offset=".35" stopColor={c.face[1]} />
          <stop offset="1" stopColor={c.flap} />
        </linearGradient>
      </defs>
      <path d="M3.5 3.5h17v10.5L14 20.5H3.5z" fill={`url(#${id}f)`} />
      <rect x="3.5" y="3.5" width="17" height="2.4" fill="#000" opacity=".08" />
      <path
        d="M20.5 14L14 20.5Q13.7 17 13.9 14.3Q16.9 14 20.5 14z"
        fill="#000"
        opacity=".3"
        transform="translate(-.25 -.25)"
      />
      <path d="M20.5 14L14 20.5Q14.2 17.2 14.6 14.6Q17.2 14.2 20.5 14z" fill={`url(#${id}p)`} />
      <path d="M20.5 14L14 20.5" stroke={c.fold} strokeWidth=".35" strokeLinecap="round" />
    </svg>
  );
}
