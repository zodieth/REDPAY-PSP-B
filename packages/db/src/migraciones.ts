// Aparte del índice: lee archivos del disco, así que no se puede empaquetar (Next).
import { readdir, readFile } from "node:fs/promises";
import { db, filas, transaccion } from "./index.ts";

// Aplica en orden los .sql de migraciones/ que todavía no corrieron.
export async function migrar() {
  const dir = new URL("../migraciones/", import.meta.url);
  const archivos = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  await db().query("CREATE TABLE IF NOT EXISTS migraciones (nombre text PRIMARY KEY, aplicada_at timestamptz NOT NULL DEFAULT now())");
  const hechas = new Set((await filas<{ nombre: string }>(db(), "SELECT nombre FROM migraciones")).map((m) => m.nombre));
  const aplicadas: string[] = [];
  for (const f of archivos) {
    if (hechas.has(f)) continue;
    const sql = await readFile(new URL(f, dir), "utf8");
    await transaccion(async (c) => {
      await c.query(sql);
      await c.query("INSERT INTO migraciones (nombre) VALUES ($1)", [f]);
    });
    aplicadas.push(f);
  }
  return aplicadas;
}
