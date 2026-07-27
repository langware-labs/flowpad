import { sdkConfig } from '@sdk/config/index';

// URL of the spec-compliant sandbox proxy (see ui/public/sandbox_proxy.html).
// In dev this deliberately points at the backend origin, which keeps generated
// app code off the Vite app origin while preserving the packaged app path.
export const SANDBOX_URL = new URL('/mcp-sandbox/sandbox_proxy.html', sdkConfig.apiUrl);
