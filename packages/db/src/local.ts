// Postgres local para desarrollo, sin Docker: npm run db
// Guarda los datos en .datos-pg/ (en la raíz del repo) y aplica las migraciones.
// Queda corriendo hasta Ctrl+C.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";

const dir = fileURLToPath(new URL("../../../.datos-pg", import.meta.url));
const url = new URL(process.env.DATABASE_URL ?? "postgres://redpagos:redpagos@localhost:5440/redpagos");
const nueva = !existsSync(dir);

const pg = new EmbeddedPostgres({
  databaseDir: dir,
  port: Number(url.port || 5432),
  user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password),
  persistent: true,
  onLog: () => {},
});

if (nueva) await pg.initialise();
await pg.start();
const base = url.pathname.slice(1);
if (nueva) await pg.createDatabase(base);

process.env.DATABASE_URL = url.toString();
const { migrar } = await import("./migraciones.ts");
const aplicadas = await migrar();
console.log(`[db] Postgres en :${url.port}, base "${base}"${aplicadas.length ? `; migraciones: ${aplicadas.join(", ")}` : ""}`);
console.log("[db] Ctrl+C para frenarlo");

const parar = async () => {
  await pg.stop();
  process.exit(0);
};
process.on("SIGINT", parar);
process.on("SIGTERM", parar);
setInterval(() => {}, 1 << 30);
