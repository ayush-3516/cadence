import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Every hook/component import across this app uses an explicit ".js" suffix
  // (TypeScript's Node16/NodeNext-style ESM resolution convention, consistent
  // with every other package in this monorepo — see apps/api, packages/sdk).
  // Next's webpack dev/build resolver does not map ".js" specifiers to ".ts"/
  // ".tsx" source files unless this experimental flag is enabled; without it,
  // every relative import in this app (e.g. "../../lib/hooks/useApiKeys.js")
  // fails to resolve and every route 500s at compile time. This was previously
  // undetected because no prior task's smoke check actually booted a page that
  // imports through this chain (Task 1's check only hit the pre-hook placeholder
  // page at "/").
  experimental: {
    extensionAlias: {
      ".js": [".ts", ".tsx", ".js"],
    },
  },
};

export default nextConfig;
