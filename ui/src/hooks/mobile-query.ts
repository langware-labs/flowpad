/**
 * The phone line, spelled once for CSS (tailwind.config.ts builds `md` / `max-md` from it) and for JS
 * (`use-mobile.tsx`). No imports: the Tailwind config loads this file at build time.
 *
 * A phone on its side is still a phone: wide enough for `md` (an iPhone is ~870px across in landscape) but
 * only ~350px tall, where the desktop chrome leaves no room for content.
 */
export const PHONE_ON_ITS_SIDE = '(pointer: coarse) and (max-height: 500px)';
export const MOBILE_QUERY = `(max-width: 767px), ${PHONE_ON_ITS_SIDE}`;
/** Everything else — `md` and up. The same set as "not MOBILE_QUERY", without `not (...)`, which older engines drop. */
export const DESKTOP_QUERY =
  '(min-width: 768px) and (min-height: 501px), (min-width: 768px) and (pointer: fine), (min-width: 768px) and (pointer: none)';
