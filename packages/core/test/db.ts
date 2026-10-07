// Postgres para tests: usa TEST_DATABASE_URL si está; si no, levanta uno embebido.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { cerrarDb, db, migrar } from "@redpagos/db";
import { cifrar, crearComercio, type DatosComercio } from "../src/index.ts";

process.env.CLAVE_CIFRADO ??= "clave-de-test";

export async function levantarDb() {
  let pg: EmbeddedPostgres | null = null;
  if (process.env.TEST_DATABASE_URL) {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    await db().query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  } else {
    pg = new EmbeddedPostgres({
      databaseDir: await mkdtemp(join(tmpdir(), "redpagos-pg-")),
      port: 5434,
      user: "redpagos",
      password: "redpagos",
      persistent: false,
      onLog: () => {},
    });
    await pg.initialise();
    await pg.start();
    await pg.createDatabase("redpagos_test");
    process.env.DATABASE_URL = "postgres://redpagos:redpagos@localhost:5434/redpagos_test";
  }
  await migrar();
  return async () => {
    await cerrarDb();
    await pg?.stop();
  };
}

export async function limpiar() {
  await db().query(`TRUNCATE entregas, webhooks, movimientos, retiros, depositos, cobros, cvus, api_keys, comercios RESTART IDENTITY CASCADE`);
}

export const comercio = (d: Partial<DatosComercio> = {}) => crearComercio({ nombre: "Tienda de prueba", ...d });

// CVUs ya inicializados (como si el poller los hubiera leído una vez).
export async function cvus(n: number) {
  for (let i = 0; i < n; i++) {
    await db().query(
      `INSERT INTO cvus (usuario, clave_cifrada, pv, cvu, alias, titular, inicializado, libre_desde)
       VALUES ($1, $2, $3, $4, $5, 'RedPagos', true, now() - make_interval(mins => $6))`,
      [`usuario${i}`, cifrar("x"), String(100 + i), String(i).padStart(22, "0"), `alias.prueba.${i}`, 100 - i],
    );
  }
}

let n = 0;
// Un depósito como lo devuelve cargavirtual (importe en pesos).
export const deposito = (importe: number, fecha = new Date()) => ({
  id: `dep${++n}-${Date.now()}`,
  fecha_deposito: fecha.toISOString(),
  fecha_carga: fecha.toISOString(),
  banco: "Transferencia",
  cuenta: "Operación transferencia",
  nro_transaccion: String(1000 + n),
  importe,
  observaciones: "",
});

export const eventos = async () =>
  (await db().query("SELECT evento FROM entregas ORDER BY creado_at, evento")).rows.map((r) => r.evento as string);
