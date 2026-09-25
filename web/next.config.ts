import type { NextConfig } from "next";

const noStore = [
  { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
  { key: "Pragma", value: "no-cache" },
  { key: "Expires", value: "0" },
];

const nextConfig: NextConfig = {
  experimental: {
    // Ensure instrumentation.ts runs for env validation.
    serverActions: {
      bodySizeLimit: "12mb",
    },
  },
  async headers() {
    return [
      { source: "/", headers: noStore },
      { source: "/app", headers: noStore },
      { source: "/index.html", headers: noStore },
      { source: "/app.js", headers: noStore },
      { source: "/styles.css", headers: noStore },
    ];
  },
  async redirects() {
    return [{ source: "/app-python", destination: "/app", permanent: true }];
  },
  async rewrites() {
    return [{ source: "/app", destination: "/index.html" }];
  },
};

export default nextConfig;
