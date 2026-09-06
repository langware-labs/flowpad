import type { IconPackSpec } from '@sdk/icons';

/**
 * Throwaway packs that exist only to make collisions visible.
 *
 * They are injected client-side and never shipped under `server/icons/` — they
 * are fixtures, not artwork. Both declare the leaf `slack`, so the page can show
 * that `demo-a.slack` and `demo-b.slack` are two different icons and that
 * neither collides: a full tag names exactly one thing.
 *
 * The artwork is a data URI so the demo needs no files on the backend.
 */
const mark = (bg: string, letter: string) =>
  'data:image/svg+xml,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">` +
      `<rect width="24" height="24" rx="6" fill="${bg}"/>` +
      `<text x="12" y="17" font-family="system-ui,sans-serif" font-size="14" font-weight="700" ` +
      `text-anchor="middle" fill="#fff">${letter}</text></svg>`,
  );

export const DEMO_PACKS: IconPackSpec[] = [
  {
    kind: 'demo-a',
    license: 'Demo fixture — not shipped.',
    icons: [
      { kind: 'slack', asset: mark('#2563eb', 'A'), tintable: false },
      { kind: 'inbox', asset: mark('#2563eb', 'A'), tintable: false },
    ],
  },
  {
    kind: 'demo-b',
    license: 'Demo fixture — not shipped.',
    icons: [
      { kind: 'slack', asset: mark('#dc2626', 'B'), tintable: false },
      { kind: 'inbox', asset: mark('#dc2626', 'B'), tintable: false },
    ],
  },
];
