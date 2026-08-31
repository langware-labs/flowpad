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

// The unit tier runs every file in ONE thread against ONE jsdom document
// (`pool: 'threads'`, `singleThread: true`), and that document's URL is never
// reset between files. Production code legitimately reads the real browser URL
// — `NavigationActions.currentBrowserViewMode()` does, to inherit `?viewMode`
// onto a newly opened dock — so a file that leaves `?viewMode=standard` on
// `window.location` silently changes the URLs a LATER file's MemoryRouter test
// asserts on (`?editorMode=editor` arriving as
// `?editorMode=editor&viewMode=standard`).
//
// Reset it per test so each one starts from a clean address. This is state
// isolation, not a wait/retry: the leak is the previous test's query string,
// and this deletes it. A test that needs a specific URL still sets it in its
// own body or `beforeEach`, both of which run after this hook.
beforeEach(() => {
  if (window.location.search || window.location.hash || window.location.pathname !== '/') {
    window.history.replaceState(null, '', '/');
  }
});
