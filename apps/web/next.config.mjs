// The browser only talks to this origin; /api/* is proxied to the API so the sid/did cookies stay same-origin.
const API_ORIGIN = process.env.API_ORIGIN ?? 'http://localhost:3001';

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['i18n'],
  // The i18n workspace package imports siblings as './en.js' (NodeNext style) while the files are .ts.
  webpack(config) {
    config.resolve.extensionAlias = { ...config.resolve.extensionAlias, '.js': ['.ts', '.tsx', '.js'] };
    return config;
  },
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${API_ORIGIN}/:path*` }];
  },
};
export default nextConfig;
