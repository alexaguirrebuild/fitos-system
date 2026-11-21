import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // App privada y por usuario: todo es dinámico. Sin Cache Components.
  serverExternalPackages: ["@electric-sql/pglite", "pg"],
  // Importar el histórico (Ajustes) sube el export de la app antigua: ~0,3 MB hoy, margen hasta 4 MB.
  experimental: { serverActions: { bodySizeLimit: "4mb" } },
  async headers() {
    return [
      // El service worker nunca se sirve de la caché del navegador: así las versiones nuevas llegan.
      { source: "/sw.js", headers: [{ key: "Cache-Control", value: "no-cache" }] },
      {
        // El consentimiento OAuth no se puede incrustar en un iframe (clickjacking).
        source: "/oauth/authorize",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
        ],
      },
    ];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
