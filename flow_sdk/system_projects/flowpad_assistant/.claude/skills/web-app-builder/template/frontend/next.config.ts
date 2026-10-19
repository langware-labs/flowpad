import type { NextConfig } from "next";

// FastAPI backend. Flowpad starts it as this app's `api` service (webapp.json) and tells this
// process its port in FLOWPAD_APP_PORT_API. On Vercel set BACKEND_URL to the deployed backend, so
// client code can keep fetching relative /api/* paths unchanged.
const BACKEND_URL =
  process.env.BACKEND_URL ??
  `http://127.0.0.1:${process.env.FLOWPAD_APP_PORT_API ?? "8080"}`;

const nextConfig: NextConfig = {
  async rewrites() {
    // Plain (afterFiles) rewrites: Next.js route handlers under app/api/
    // win; everything else under /api/* is proxied to FastAPI.
    return [
      {
        source: "/api/:path*",
        destination: `${BACKEND_URL}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
