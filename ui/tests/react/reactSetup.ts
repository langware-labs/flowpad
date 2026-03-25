// React Testing Library Setup for Vitest + jsdom
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import React from 'react';

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
    if (
      message.includes('Warning: An update to ReactChatTester inside a test was not wrapped in act') ||
      (message.includes('Warning: An update to') && message.includes('inside a test was not wrapped in act'))
    ) {
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
