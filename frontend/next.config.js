/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  // rewrites はローカル開発時（next dev）のみ有効。本番は CloudFront のパスルーティングで /api/* をバックエンドに転送する
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${process.env.BACKEND_URL || 'http://localhost:5000'}/api/:path*`,
      },
    ];
  },
};

module.exports = nextConfig;
