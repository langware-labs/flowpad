import { load_config } from './load_config';

// Create the SDK configuration instance
export const sdkConfig = load_config();

// Export types and classes for direct access
export { SDKConfig } from './SDKConfig';
export type { ISDKConfig } from './types';
export { initDesktopBackend } from './desktop';
