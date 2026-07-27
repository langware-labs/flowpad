import type { SVGProps } from 'react';

type PersonRaisedHandIconProps = SVGProps<SVGSVGElement> & { className?: string };

/**
 * Person-raised-hand — a standing figure with one arm raised, the "I'll take
 * this / count me in" mark. Restored from the original `AskForAssistanceButton`
 * (added in 3f5fd6e7, lost when the legacy live-workflow view was removed in
 * 9b3f730d); the path data is that icon's, unchanged.
 *
 * Solid rather than stroked, so unlike the lucide glyphs it sits next to it
 * carries no `strokeWidth` — weight comes from the fill. It keeps the source's
 * 16x16 viewBox (lucide's is 24x24), which renders the figure slightly denser
 * at the same box size. Marks use `currentColor` so it inherits the parent's
 * text color and stays theme-aware, like the other icons in this folder
 * (e.g. {@link WikiIcon}).
 *
 * Decorative by default: `aria-hidden` keeps the glyph out of the a11y tree so
 * an icon-only button's own label is what gets announced (an `aria-label` here
 * would win over the button's `title` and announce the drawing instead of the
 * action). A standalone caller that needs a name can override via props.
 */
export function PersonRaisedHandIcon({ className, ...rest }: PersonRaisedHandIconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 16 16"
      fill="currentColor"
      className={className}
      aria-hidden="true"
      {...rest}
    >
      <path d="M6 6.207v9.043a.75.75 0 0 0 1.5 0V10.5a.5.5 0 0 1 1 0v4.75a.75.75 0 0 0 1.5 0v-8.5a.25.25 0 1 1 .5 0v2.5a.75.75 0 0 0 1.5 0V6.5a3 3 0 0 0-3-3H6.236a1 1 0 0 1-.447-.106l-.33-.165A.83.83 0 0 1 5 2.488V.75a.75.75 0 0 0-1.5 0v2.083c0 .715.404 1.37 1.044 1.689L5.5 5c.32.32.5.754.5 1.207" />
      <path d="M8 3a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3" />
    </svg>
  );
}
