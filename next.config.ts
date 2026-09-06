import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The evidence PDFs are committed under data/ and read off disk at request
  // time by /api/files. Nothing imports them, so Next's file tracing cannot
  // see them and would ship a function that 404s every document in the
  // binder. data/ is 272K, so the whole directory travels with the route.
  outputFileTracingIncludes: {
    "/api/files/[...path]": ["./data/**/*"],
  },
};

export default nextConfig;
