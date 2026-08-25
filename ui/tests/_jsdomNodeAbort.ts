/**
 * `jsdom`, with the jsdom/Node `AbortSignal` realm split bridged at `fetch`.
 *
 * jsdom installs its own `AbortController`/`AbortSignal` over Node's, but global
 * `fetch` is Node's undici, which validates `init.signal` against the class it
 * captured when it loaded — Node's. So a jsdom-realm signal is rejected
 * cross-realm with
 *
 *     TypeError: RequestInit: Expected signal ("AbortSignal {}") to be an
 *     instance of AbortSignal
 *
 * even though `signal instanceof AbortSignal` is `true` inside the test. Real
 * browsers have a single realm, so this has no product analogue: the SDK is
 * right to create an `AbortController` and pass its signal to `fetch`, and the
 * tests are right to pass `AbortSignal.timeout(...)`.
 *
 * Where the resulting TypeError is swallowed — `waitHealthy`'s "not up yet"
 * catch in the backend-spawning SLO tests — it misreported a perfectly healthy
 * backend as "did not come up", so this removes a whole class of false failure.
 *
 * ## Why translate instead of swapping the globals
 *
 * The obvious fix — restore Node's `AbortController`/`AbortSignal` as the
 * globals after jsdom's setup — trades one realm error for its mirror image.
 * jsdom's own `addEventListener` validates `options.signal` against *jsdom's*
 * class and rejects Node's:
 *
 *     Failed to execute 'addEventListener' on 'EventTarget': parameter 3
 *     dictionary has member 'signal' that is not of type 'AbortSignal'.
 *
 * (Proven: swapping fixed `view-mode-dock-override` and broke
 * `vibe-new-process-parity`; it also broke 5 `unit`-tier tests that abort
 * through jsdom's DOM event plumbing.) Application code legitimately uses both
 * APIs, so neither class can be the single winner.
 *
 * So the globals are left exactly as jsdom set them, and only `fetch` is
 * wrapped: a foreign signal is mirrored onto a Node-realm controller for the
 * duration of the call. Abort semantics are preserved — including a signal that
 * is already aborted — so nothing is weakened and no timeout is involved.
 */
import type { Environment } from 'vitest/environments';
import { builtinEnvironments } from 'vitest/environments';

// Module scope: the worker's Node realm, BEFORE jsdom's setup() swaps globals.
const NodeAbortController = globalThis.AbortController;
const NodeAbortSignal = globalThis.AbortSignal;

export default <Environment>{
  name: 'jsdom-node-abort',
  transformMode: 'web',
  async setup(global: any, options: any) {
    const { teardown } = await builtinEnvironments.jsdom.setup(global, options);

    const innerFetch: typeof fetch = global.fetch;
    if (typeof innerFetch === 'function') {
      global.fetch = (input: any, init?: any) => {
        const signal = init?.signal;
        if (!signal || signal instanceof NodeAbortSignal) return innerFetch(input, init);

        // Foreign (jsdom) signal — mirror it onto a Node-realm one.
        const controller = new NodeAbortController();
        if (signal.aborted) {
          controller.abort(signal.reason);
        } else {
          signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
        }
        return innerFetch(input, { ...init, signal: controller.signal });
      };
    }

    return { teardown };
  },
};
