import pg from "pg";
import { readdir, readFile } from "node:fs/promises";

// bigint (int8) como number: los importes en centavos entran holgados en 2^53.
pg.types.setTypeParser(20, (v) => Number(v));

export type Db = pg.Pool | pg.PoolClient;

let pool: pg.Pool | null = null;

export function db() {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("Falta DATABASE_URL");
    pool = new pg.Pool({ connectionString: url, max: 10 });
  }
  return pool;
}

export async function cerrarDb() {
  await pool?.end();
  pool = null;
}

export async function filas<T>(c: Db, sql: string, params: unknown[] = []) {
  return (await c.query(sql, params)).rows as T[];
}

export async function fila<T>(c: Db, sql: string, params: unknown[] = []) {
  return (await c.query(sql, params)).rows[0] as T | undefined;
}

// Corre fn en una transacción y hace rollback si tira.
export async function transaccion<T>(fn: (c: pg.PoolClient) => Promise<T>) {
  const c = await db().connect();
  try {
    await c.query("BEGIN");
    const r = await fn(c);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}

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
