import pg from "pg";

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
