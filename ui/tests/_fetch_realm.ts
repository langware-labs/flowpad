// Bridge jsdom's AbortSignal across to the realm that owns `fetch`.
//
// Every vitest tier here runs in `environment: 'jsdom'`, but jsdom implements no
// `fetch` — requests go through Node's built-in undici. The two realms each
// brand-check the abort primitive against their OWN class, in opposite
// directions:
//
//   * undici rejects a jsdom signal:
//       TypeError: RequestInit: Expected signal ("AbortSignal {}") to be an
//                  instance of AbortSignal
//   * jsdom rejects a Node signal:
//       TypeError: Failed to execute 'addEventListener' on 'EventTarget':
//                  parameter 3 dictionary has member 'signal' that is not of
//                  type 'AbortSignal'
//
// So swapping the GLOBAL `AbortController` to either realm just moves the
// breakage (the Node-global variant broke react-resizable-panels' DOM
// `addEventListener`). The global must stay jsdom's — DOM code is the majority
// consumer — and `fetch` is the one call that needs translating.
//
// This is a two-realm test artifact, not app behaviour: in a real browser both
// primitives come from one realm. Two places it bit this cycle:
//   * api tier   — ComputeNode.executeCommandStreaming → store.callStreamingAction
//   * react tier — an unhandled rejection that left the whole app unrendered, so
//                  the failure surfaced as a missing `terminal-tab-bar` testid.
//
// `node:util.transferableAbortController()` is the only public handle on Node's
// own AbortController from inside the jsdom global scope. Abort semantics are
// preserved: aborting the caller's signal aborts the bridged one, with the reason.
import { transferableAbortController } from 'node:util';

const NodeAbortController = transferableAbortController()
  .constructor as unknown as new () => AbortController;
const NodeAbortSignal = Object.getPrototypeOf(new NodeAbortController().signal).constructor;

/** Replace a foreign (jsdom) `init.signal` with an equivalent Node-realm one. */
function bridgeInit(init: any): any {
  const signal = init?.signal;
  if (!signal || signal instanceof NodeAbortSignal) return init;

  const bridge = new NodeAbortController();
  if (signal.aborted) {
    bridge.abort(signal.reason);
  } else {
    signal.addEventListener('abort', () => bridge.abort(signal.reason), { once: true });
  }
  return { ...init, signal: bridge.signal };
}

const nativeFetch = globalThis.fetch;
globalThis.fetch = function patchedFetch(input: any, init?: any) {
  return nativeFetch(input, bridgeInit(init));
} as typeof fetch;

// `Request` is undici's too (jsdom ships none), and react-router builds one per
// data-loader call with an AbortSignal from its OWN (jsdom) AbortController — so
// the same brand check fires before `fetch` is ever reached. Subclassing keeps
// `instanceof Request` intact for everything downstream.
const NativeRequest = globalThis.Request;
class BridgedRequest extends NativeRequest {
  constructor(input: any, init?: any) {
    super(input, bridgeInit(init));
  }
}
globalThis.Request = BridgedRequest as unknown as typeof Request;
