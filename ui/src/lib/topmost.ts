/**
 * Shared frame for topmost floating panels (Flowpad Assistant window, journey
 * tray): sky accent border + ring and a theme-aware glow shadow so the panel
 * reads as a floating top-level window on any background. Light theme uses a
 * deeper blue-grey drop + softer sky bloom so it pops off white without a flat
 * black cast; dark stays glowing-blue.
 */
export const topmost = [
  'fixed z-50 flex flex-col rounded-lg bg-background',
  'border border-sky-400/70 ring-1 ring-sky-400/30',
  'dark:border-sky-400/50 dark:ring-sky-400/20',
  'shadow-[0_22px_50px_-10px_rgba(15,23,42,0.30),0_12px_28px_-8px_rgba(30,64,175,0.28),0_0_0_1px_rgba(56,189,248,0.18)]',
  'dark:shadow-[0_22px_60px_-12px_rgba(56,189,248,0.55),0_10px_32px_-10px_rgba(56,189,248,0.45)]',
].join(' ');
