/**
 * The visible part of the page, as CSS variables. Mobile Safari does not resize the page when its keyboard
 * opens — it shrinks the visual viewport and slides it down the page — so the app's bottom edge (the
 * composer, a dialog sheet) would sit under the keys and its top bar off screen.
 *
 *  - `--vvt`  px from the top of the page to the top of the visible area (0 until the keyboard opens).
 *  - `--vvh`  height of the visible area (`100dvh` until this runs).
 *
 * On a touch device the shell is pinned to exactly that box (index.css); a bottom sheet hangs from its
 * bottom edge. Without a keyboard the two are simply 0 and the window's height.
 */
export function trackKeyboardInset(): void {
  const vv = window.visualViewport;
  if (!vv) return;
  const style = document.documentElement.style;
  let top = -1;
  let height = -1;
  let frame = 0;
  const apply = () => {
    frame = 0;
    // A pinch-zoom also shrinks the visual viewport; it is not a keyboard.
    if (vv.scale !== 1) return;
    const nextTop = Math.max(0, Math.round(vv.offsetTop));
    const nextHeight = Math.round(vv.height);
    if (nextTop !== top) style.setProperty('--vvt', `${(top = nextTop)}px`);
    if (nextHeight !== height) style.setProperty('--vvh', `${(height = nextHeight)}px`);
  };
  // The keyboard animation fires these every frame; one write per frame, and only when a value moved.
  const update = () => {
    frame ||= requestAnimationFrame(apply);
  };
  vv.addEventListener('resize', update);
  vv.addEventListener('scroll', update);
}
