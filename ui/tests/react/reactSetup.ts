// React Testing Library Setup for Vitest + jsdom
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { installCleanup } from '../_cleanup';
import { resolveReactTestInstance } from './_instance';

// Config evaluation must remain safe for `--project unit`, but an actual React
// run fails here before importing a test module or touching a backend. These
// compile-time values prove the selected Vite mode and runtime launcher resolve
// to the same instance.
declare const __REACT_INSTANCE_NAME__: string;
declare const __REACT_BACKEND_PORT__: string;
const selectedInstance = process.env.FLOW_INSTANCE?.trim() || '';
if (!selectedInstance) {
  throw new Error('react vitest requires FLOW_INSTANCE=<disposable-name>; `.env.local` is never a live-test fallback');
}
const launchedInstance = resolveReactTestInstance(selectedInstance);
const selectedPort = launchedInstance ? new URL(launchedInstance.apiUrl).port : '';
if (!launchedInstance || __REACT_INSTANCE_NAME__ !== selectedInstance || __REACT_BACKEND_PORT__ !== selectedPort) {
  throw new Error(
    `react vitest FLOW_INSTANCE='${selectedInstance}' is not a matching live launcher-owned backend ` +
      '(generated env, launcher identity/port/env-file, backend PID, and compiled Vite mode must agree)',
  );
}

// The `@lingui/react` shim is registered in its own setup file (../_lingui-mock,
// listed first in this tier's setupFiles) and shared with the unit/api tiers.

// The react tier runs against the live local backend (apiTestSetup → bootstrap).
// Suites that create real AgenticProcess / ComputeNode entities (e.g.
// agentic_process_stress.test.ts) trackForCleanup() each create; this installs
// the per-test purge (afterEach) + end-of-file leak sweep (afterAll) once. The
// sweep also covers agentic_process so an un-tracked live create is caught.
// Coexists with RTL's own afterEach(cleanup) below — they're independent hooks.
installCleanup({ sweepTypes: ['agentic_process'] });

// Mock matchMedia for jsdom (used by react-resizable-panels and other UI libraries)
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  }),
});

// Mock ResizeObserver for jsdom (used by various UI components)
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// Mock scrollIntoView for jsdom (used by cmdk and other UI libraries)
Element.prototype.scrollIntoView = function () {
  // No-op for jsdom
};

// Mock scrollTo for jsdom (used by use-auto-scroll on transcript/chat panes;
// jsdom doesn't implement Element.scrollTo and would throw, white-screening the
// rendered view via the router ErrorBoundary).
Element.prototype.scrollTo = function () {
  // No-op for jsdom
};

// Mock hasPointerCapture for jsdom (used by Radix UI components)
Element.prototype.hasPointerCapture = function () {
  return false;
};

// Ensure React is available globally for all tests
if (typeof globalThis !== 'undefined') {
  (globalThis as any).React = React;
  (globalThis as any).process = (globalThis as any).process || {};
  (globalThis as any).process.env = (globalThis as any).process.env || {};
  // Use test environment for React Testing Library compatibility
  (globalThis as any).process.env.NODE_ENV = 'test';
}

// Cleanup DOM after each test
afterEach(() => {
  cleanup();
});

// Suppress Monaco Editor async cleanup errors (React instance mismatch from micro_apps)
// This happens when Monaco Editor tries to initialize after test component unmounts
if (typeof window !== 'undefined') {
  window.addEventListener('error', (event) => {
    const error = event.error;
    if (error?.message?.includes("Cannot read properties of null (reading 'useState')")) {
      // Suppress Monaco Editor React instance mismatch error
      event.preventDefault();
      return false;
    }
  });

  window.addEventListener('unhandledrejection', (event) => {
    const error = event.reason;
    if (error?.message?.includes("Cannot read properties of null (reading 'useState')")) {
      // Suppress Monaco Editor React instance mismatch error
      event.preventDefault();
      return false;
    }
  });
}

// Mock console.warn to suppress expected warnings during tests
const originalWarn = console.warn;
console.warn = (...args: any[]) => {
  const message = args[0];
  if (typeof message === 'string') {
    // Suppress Lit dev mode warnings
    if (message.includes('Lit is in dev mode')) {
      return;
    }
    // Suppress React Testing Library act warnings (RTL handles these internally)
    if (message.includes('act(...)') || message.includes('testing environment is not configured to support act')) {
      return;
    }
  }
  // Log other warnings normally
  originalWarn.apply(console, args);
};

// Suppress React act() error warnings for async hook updates we can't control
const originalError = console.error;
console.error = (...args: any[]) => {
  const message = args[0];
  if (typeof message === 'string') {
    // Suppress act() warnings from internal hook state updates
    if (message.includes('Warning: An update to') && message.includes('inside a test was not wrapped in act')) {
      return;
    }
    // Suppress Monaco Editor React instance mismatch warnings (harmless async cleanup)
    if (
      message.includes('Invalid hook call') ||
      message.includes('mismatching versions of React') ||
      message.includes('more than one copy of React')
    ) {
      return;
    }
  }
  // Log other errors normally
  originalError.apply(console, args);
};
