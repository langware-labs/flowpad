// React Testing Library Setup for Vitest + jsdom
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// Cleanup DOM after each test
afterEach(() => {
  cleanup();
});

// Configure environment for testing
if (typeof globalThis !== 'undefined') {
  (globalThis as any).process = (globalThis as any).process || {};
  (globalThis as any).process.env = (globalThis as any).process.env || {};
  // Use test environment for React Testing Library compatibility
  (globalThis as any).process.env.NODE_ENV = 'test';
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
