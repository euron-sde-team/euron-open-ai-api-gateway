import path from "node:path";
import type { NextConfig } from "next";

/**
 * Same-origin deployment: the browser only ever talks to this origin. In local
 * development the rewrite below proxies /api to the API; in production the load
 * balancer routes /api to the API before it reaches Next, so the refresh cookie
 * (scoped to /api/auth) stays first-party. The gateway itself (/v1) is routed the same
 * way, so the console's playground calls it at this origin.
 */
const apiInternal = (process.env.API_INTERNAL_URL || "http://localhost:5056").replace(/\/+$/, "");

const nextConfig: NextConfig = {
  // One self-contained server bundle (`node apps/web/server.js`), the unit the image ships.
  output: "standalone",
  // In a monorepo the standalone trace must start at the repo root.
  outputFileTracingRoot: path.join(__dirname, "../.."),
  // The shared packages ship TypeScript source; Next compiles them in place.
  transpilePackages: ["@open-gateway/ui", "@open-gateway/api-client", "@open-gateway/types"],
  poweredByHeader: false,
  // No floating dev badge over the app (it would also land in screenshots).
  devIndicators: false,
  reactStrictMode: true,
  // The app serves no remote images; skip the optimiser entirely.
  images: { unoptimized: true },
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${apiInternal}/api/:path*` },
      { source: "/v1/:path*", destination: `${apiInternal}/v1/:path*` },
    ];
  },
  // Static security headers. The Content-Security-Policy is set per request in
  // middleware.ts, because it carries a nonce and runtime media origins.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          // Razorpay's payment window may use the Payment Request API (UPI apps); nothing else needs a device.
          { key: "Permissions-Policy", value: 'camera=(), microphone=(), geolocation=(), payment=(self "https://api.razorpay.com" "https://checkout.razorpay.com"), fullscreen=(self)' },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
