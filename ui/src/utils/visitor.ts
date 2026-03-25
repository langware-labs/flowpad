// Similar code is in use at https://github.com/your-org/flowpad-website/src/utils/visitor.ts.

// Assuming next line was set on Tag that's triggered when `ad_storage` consent is granted - https://tagmanager.google.com/#/container/accounts/6291846850/containers/218214618/workspaces/12/tags/7
// window.allow_persistent_visitor = true;

import { authManager } from '@sdk';

declare global {
  interface Window {
    allow_persistent_visitor?: boolean;
  }
}

// Global visitor state to ensure single initialization across the entire app
let globalVisitorId: string | null = null;
let globalVisitorPromise: Promise<string> | null = null;
let globalVisitorInitialized = false;

// Helper function to call visit via AuthManager when visitor ID is missing
const callVisitEndpoint = async (isPersistent: boolean): Promise<string> => {
  try {
    // Use AuthManager's visit function instead of direct API call
    const visitorData = await authManager.visit({
      session: !isPersistent, // session=true means non-persistent
      persistent: isPersistent,
      user_agent: navigator.userAgent,
      timestamp: Date.now(),
    });
    return visitorData.visitor_id;
  } catch (error) {
    console.error('Failed to visit:', error);
    throw new Error(`Failed to visit: ${String(error)}`);
  }
};

// Global singleton visitor initialization - used throughout the app
export const ensureVisitor = async (): Promise<string> => {
  // If already initialized, return cached ID
  if (globalVisitorInitialized && globalVisitorId) {
    return globalVisitorId;
  }

  // If initialization is in progress, wait for it
  if (globalVisitorPromise) {
    return await globalVisitorPromise;
  }

  // Check if we're allowed to use persistent storage.
  const isAllowPersistent = !!window.allow_persistent_visitor;
  if (!isAllowPersistent) {
    window.addEventListener('allow_persistent_visitor', () => {
      void (async () => {
        // If initialization is in progress, wait for it
        if (globalVisitorPromise) await globalVisitorPromise;
        void callVisitEndpoint(true); // Persistent visitor
      })();
    });
  }

  // Start initialization
  globalVisitorPromise = callVisitEndpoint(isAllowPersistent)
    .then((visitorId) => {
      globalVisitorId = visitorId;
      globalVisitorInitialized = true;
      globalVisitorPromise = null; // Clear the promise after completion
      return visitorId;
    })
    .catch((error) => {
      globalVisitorPromise = null; // Clear the promise on error
      throw error;
    });

  return await globalVisitorPromise;
};

// Get visitor ID from cache if available (for local access without API call)
export const getVisitorId = (): string | null => globalVisitorId;
