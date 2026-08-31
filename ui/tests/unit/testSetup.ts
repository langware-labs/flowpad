// Side-effect import: initialize the SDK barrel FIRST so entity modules load in
// barrel order. Without it, a test importing a deep entity path (e.g.
// compute-node -> shell) hits the APIEntity circular-init and "Class extends
// value undefined" at collection.
import '@sdk';
import { beforeEach, vi } from 'vitest';
import { installLeakTripwire } from '../_cleanup';

// The `@lingui/react` shim is registered in its own setup file (../_lingui-mock,
// listed first in this tier's setupFiles) and shared with the api/react tiers.

// Leak tripwire only: the unit tier is fully mocked (no live POSTs), so this is
// a cheap regression guard for a future unit test that starts creating real
// backend entities. No-ops silently when no backend is reachable.
installLeakTripwire(['skill']);

// Mock the ResizeObserver
const ResizeObserverMock = vi.fn(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}));
if (!window.ResizeObserver) {
  window.ResizeObserver = ResizeObserverMock;
}

// Stub the global ResizeObserver
vi.stubGlobal('ResizeObserver', ResizeObserverMock);

// The unit tier runs every file in ONE thread against ONE jsdom document, and
// that document's URL is never reset between files. Production code legitimately
// reads the real browser URL, so a file that leaves a query string on
// `window.location` silently changes the URLs a LATER file asserts on.
//
// Reset per test. This is state isolation, not a wait/retry: the leak is the
// previous test's query string, and this deletes it. A test that needs a
// specific URL still sets it in its own body or `beforeEach`, which run after.
//
// The guard is LOAD-BEARING — do not "simplify" it away because `replaceState`
// is idempotent. Calling it unconditionally on every one of the tier's 4393
// tests breaks `prepare-avatar-image.test.ts` ("RangeError: Offset is outside
// the bounds of the DataView"), which passes on its own and fails only in the
// full tier. Measured, repeatedly: unguarded -> 2 failed, guarded -> 4393
// passed. Only touch the URL when it actually needs resetting.
beforeEach(() => {
  if (window.location.search || window.location.hash || window.location.pathname !== '/') {
    window.history.replaceState(null, '', '/');
  }
});
