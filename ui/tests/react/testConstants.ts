/**
 * Test timing constants for consistent behavior across all hook tests
 */

// Hook timeout for waitFor operations - increased for integration tests with PTY/compute nodes
export const HOOK_TIMEOUT_MS = 10000; // Increased from 200ms to 10000ms for CI environments

// Mock flow action delay - 100ms as specified
export const MOCK_FLOW_DELAY_MS = 100;

// Stream chunk delay for mock streaming (should be faster than processing delay)
export const MOCK_STREAM_CHUNK_DELAY_MS = 10;
