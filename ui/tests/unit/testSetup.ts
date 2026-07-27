// Side-effect import: initialize the SDK barrel FIRST so entity modules load in
// barrel order. Without it, a test importing a deep entity path (e.g.
// compute-node -> shell) hits the APIEntity circular-init and "Class extends
// value undefined" at collection.
import '@sdk';
import { vi } from 'vitest';
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
