import React from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';

/**
 * Creates a test wrapper with MemoryRouter and Routes configured for dock navigation
 * @param initialRoute - The initial route to start with (default: /agent/test-agent/flow/test-flow)
 * @returns A wrapper component for testing
 */
export function createRouterWrapper(initialRoute = '/agent/test-agent/flow/test-flow') {
  const RouterWrapper = ({ children }: { children: React.ReactNode }) => (
    <MemoryRouter initialEntries={[initialRoute]}>
      <Routes>
        {/* Route for dock URLs with all params */}
        <Route path="/agent/:agentId/flow/:processId/dock/:viewType/:pointer" element={children} />
        {/* Fallback route for non-dock URLs */}
        <Route path="/agent/:agentId/flow/:processId" element={children} />
        <Route path="*" element={children} />
      </Routes>
    </MemoryRouter>
  );
  RouterWrapper.displayName = 'RouterWrapper';
  return RouterWrapper;
}
