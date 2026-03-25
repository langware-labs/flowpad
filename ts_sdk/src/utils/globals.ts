/**
 * Global window property management utility
 * Provides a centralized way to define and track global properties on the window object
 */

interface GlobalRegistry {
  [key: string]: any;
}

const globalRegistry: GlobalRegistry = {};

/**
 * Define a global property on the window object
 * If called multiple times with the same name, the latest value wins
 *
 * @param name - The name of the global property
 * @param prop - The value to assign to the global property
 *
 * @example
 * ```typescript
 * const manager = new DataManager();
 * defineGlobal('store', manager);
 *
 * // Access globally
 * window.store === manager; // true
 *
 * // View all registered globals
 * window.all; // ['store', ...]
 * ```
 */
export function defineGlobal(name: string, prop: any = null): void {
  // Register the property in our internal registry
  globalRegistry[name] = prop ?? null;

  // Define the property on window with a getter
  //@ts-ignore
  Object.defineProperty(window, name, {
    get() {
      return globalRegistry[name];
    },
    set(_value) {
      // Ignore any attempts to set the property directly
      // This ensures the property always returns the registered value
    },
    configurable: true, // Allow re-definition if called again with same name
  });
}

// Define the 'all' global that returns list of registered global names
//@ts-ignore
Object.defineProperty(window, 'all', {
  get() {
    return Object.keys(globalRegistry);
  },
  set(_value) {
    // Ignore any attempts to set window.all
  },
  configurable: true,
});
