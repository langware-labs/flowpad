/**
 * Extra browser-runtime primitives for booting the WHOLE app in jsdom.
 *
 * NOTHING here mocks the app or the backend. jsdom is a DOM implementation, not
 * a browser, so a handful of platform globals are simply absent; the app's real
 * code (apiClient over HTTP, the SDK WebSocket, observers) runs unchanged once
 * these exist. `reactSetup.ts` already supplies matchMedia / ResizeObserver /
 * scrollIntoView / hasPointerCapture and the afterEach cleanup; this file only
 * adds what a full RouterProvider boot additionally touches.
 */
import { afterAll } from 'vitest';
import { installCleanup } from '../_cleanup';

// Guaranteed teardown + leak sweep for any test-created entities (skills, etc.).
installCleanup({ sweepTypes: ['skill'] });

// 1. WebSocket — jsdom ships none. Node 22 has a real global WebSocket (undici);
//    expose it on `window` so the SDK's `new WebSocket(ws_url)` opens a REAL
//    socket to the REAL backend. If the runtime somehow lacks it, we leave it
//    undefined: HTTP boot still works and WS live-updates degrade gracefully
//    (same posture as the hub harness).
if (typeof (globalThis as any).WebSocket !== 'undefined') {
  (window as any).WebSocket = (globalThis as any).WebSocket;
}

// 2. IntersectionObserver — used by lazy/virtualized lists. jsdom has none.
if (typeof (globalThis as any).IntersectionObserver === 'undefined') {
  class IO {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [] as unknown[];
    }
  }
  (globalThis as any).IntersectionObserver = IO as unknown as typeof IntersectionObserver;
  (window as any).IntersectionObserver = (globalThis as any).IntersectionObserver;
}

// 3. Canvas 2D context — jsdom returns null from getContext, which throws inside
//    layout-measuring components on mount. A null-returning stub is enough to let
//    the tree mount; nothing in this smoke path actually paints (xterm /
//    Excalidraw canvas surfaces are out of scope for jsdom — use Playwright).
if (typeof HTMLCanvasElement !== 'undefined' && !(HTMLCanvasElement.prototype as any).__headlessStubbed) {
  (HTMLCanvasElement.prototype as any).__headlessStubbed = true;
  HTMLCanvasElement.prototype.getContext = function getContext() {
    return null as unknown as CanvasRenderingContext2D;
  } as typeof HTMLCanvasElement.prototype.getContext;
}

// 4. Element.scrollTo / scrollBy — jsdom implements neither. Scroll-managing
//    panels (e.g. EntityExecutionPanel) call el.scrollTo() on mount, which
//    otherwise throws and trips the router error boundary, hiding the view.
if (typeof Element !== 'undefined') {
  if (!('scrollTo' in Element.prototype)) {
    (Element.prototype as any).scrollTo = function scrollTo() {};
  }
  if (!('scrollBy' in Element.prototype)) {
    (Element.prototype as any).scrollBy = function scrollBy() {};
  }
}
if (typeof window !== 'undefined' && typeof window.scrollTo !== 'function') {
  (window as any).scrollTo = function scrollTo() {};
}

// Reset the per-realm backend override after the whole file so it never leaks
// into another project's run on the shared (single-threaded) globalThis. Mirrors
// tests/hub/_setup.ts.
afterAll(() => {
  delete (globalThis as Record<string, unknown>).__FLOWPAD_API_URL__;
});
