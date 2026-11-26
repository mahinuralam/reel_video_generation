import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The MongoDB driver stays a plain Node dependency instead of being bundled.
  serverExternalPackages: ['mongodb'],
};

export default nextConfig;
