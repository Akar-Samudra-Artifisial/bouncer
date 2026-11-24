import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // @bouncer/shared ships TypeScript source from the workspace.
  transpilePackages: ['@bouncer/shared'],
  // Webhook routes need the raw body for HMAC verification; nothing else to tune yet.
}

export default nextConfig
