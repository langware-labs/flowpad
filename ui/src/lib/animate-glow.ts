// The existing one-shot notification glow, applied without changing React's classes.
const GLOW_SOFT = '0 0 0 1px hsl(var(--primary) / 0.40), 0 0 4px 0 hsl(var(--primary) / 0.30)';
const GLOW_STRONG = '0 0 0 2px hsl(var(--primary) / 0.85), 0 0 12px 2px hsl(var(--primary) / 0.65)';
const GLOW_KEYFRAMES: Keyframe[] = [
  { boxShadow: GLOW_SOFT, offset: 0 },
  { boxShadow: GLOW_STRONG, offset: 0.25 },
  { boxShadow: GLOW_STRONG, offset: 0.75 },
  { boxShadow: GLOW_SOFT, offset: 1 },
];
const animations = new WeakMap<HTMLElement, Animation>();

/** Repeated notifications restart the glow; completion restores the element's own styles. */
export function animateGlow(target: HTMLElement, duration = 3000): void {
  if (typeof target.animate !== 'function') return;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  animations.get(target)?.cancel();
  const animation = target.animate(GLOW_KEYFRAMES, { duration, easing: 'ease-in-out' });
  animations.set(target, animation);
  const release = () => {
    if (animations.get(target) === animation) animations.delete(target);
  };
  animation.addEventListener('finish', release, { once: true });
  animation.addEventListener('cancel', release, { once: true });
}
