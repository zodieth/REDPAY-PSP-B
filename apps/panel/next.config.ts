import type { NextConfig } from "next";

// La configuración vive en el .env de la raíz del repo (compartido con api y worker).
try {
  process.loadEnvFile(new URL("../../.env", import.meta.url));
} catch {
  // Sin .env: en producción las variables vienen del entorno.
}

const nextConfig: NextConfig = {};

export default nextConfig;
