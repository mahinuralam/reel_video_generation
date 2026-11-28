import path from 'node:path';
import type { NextConfig } from 'next';

// The project root: the app imports src/reel/avatar_engines.json from outside webapp/.
const ROOT = path.join(__dirname, '..');

const nextConfig: NextConfig = {
  // The MongoDB driver stays a plain Node dependency instead of being bundled.
  serverExternalPackages: ['mongodb'],
  turbopack: { root: ROOT },
  outputFileTracingRoot: ROOT,
};

export default nextConfig;
