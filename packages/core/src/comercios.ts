import { randomBytes } from "node:crypto";
import { db, fila, filas, transaccion, type Db } from "@redpagos/db";
import { ErrorRedpagos, sha256 } from "./comun.ts";

export type Comercio = {
  id: string;
  nombre: string;
  cuit: string | null;
  comision_pb: number;
  bloqueo_horas: number;
  cuarentena_pagado_horas: number;
  cuarentena_vencido_horas: number;
  activo: boolean;
  creado_at: Date;
};

export type DatosComercio = Partial<Omit<Comercio, "id" | "creado_at">> & { nombre: string };

const CAMPOS = ["nombre", "cuit", "comision_pb", "bloqueo_horas", "cuarentena_pagado_horas", "cuarentena_vencido_horas", "activo"] as const;

function validar(d: Partial<DatosComercio>) {
  if (d.nombre !== undefined && !d.nombre.trim()) throw new ErrorRedpagos("nombre_vacio", "El nombre no puede estar vacío");
  if (d.comision_pb !== undefined && !(Number.isInteger(d.comision_pb) && d.comision_pb >= 0 && d.comision_pb <= 10_000)) {
    throw new ErrorRedpagos("comision_invalida", "La comisión tiene que estar entre 0 % y 100 %");
  }
  for (const k of ["bloqueo_horas", "cuarentena_pagado_horas", "cuarentena_vencido_horas"] as const) {
    const v = d[k];
    if (v !== undefined && !(Number.isInteger(v) && v >= 1 && v <= 24 * 90)) {
      throw new ErrorRedpagos("plazo_invalido", `${k} tiene que ser un entero de horas entre 1 y ${24 * 90}`);
    }
  }
}

// actor: quién hace el cambio (email del usuario o "api-admin"); queda en auditoria.
export async function crearComercio(datos: DatosComercio, actor = "sistema") {
  validar(datos);
  const campos = CAMPOS.filter((k) => datos[k] !== undefined);
  return transaccion(async (tx) => {
    const c = (await fila<Comercio>(
      tx,
      `INSERT INTO comercios (${campos.join(", ")}) VALUES (${campos.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING *`,
      campos.map((k) => datos[k]),
    ))!;
    await auditar(tx, actor, c.id, "comercio.creado", null, c);
    return c;
  });
}

// Cambiar la comisión sólo afecta a los depósitos que entren desde ahora: cada
// depósito ya acreditado tiene su comisión grabada en movimientos.
export async function actualizarComercio(id: string, datos: Partial<DatosComercio>, actor = "sistema") {
  validar(datos);
  return transaccion(async (tx) => {
    const antes = await fila<Comercio>(tx, "SELECT * FROM comercios WHERE id = $1 FOR UPDATE", [id]);
    if (!antes) throw new ErrorRedpagos("comercio_inexistente", "No existe el comercio", 404);
    const campos = CAMPOS.filter((k) => datos[k] !== undefined && datos[k] !== antes[k]);
    if (!campos.length) return antes;
    const c = (await fila<Comercio>(
      tx,
      `UPDATE comercios SET ${campos.map((k, i) => `${k} = $${i + 2}`).join(", ")} WHERE id = $1 RETURNING *`,
      [id, ...campos.map((k) => datos[k])],
    ))!;
    await auditar(tx, actor, id, "comercio.actualizado",
      Object.fromEntries(campos.map((k) => [k, antes[k]])),
      Object.fromEntries(campos.map((k) => [k, c[k]])));
    return c;
  });
}

export async function auditar(c: Db, actor: string, comercioId: string | null, accion: string, antes: unknown, despues: unknown) {
  await c.query(
    "INSERT INTO auditoria (actor, comercio_id, accion, antes, despues) VALUES ($1, $2, $3, $4, $5)",
    [actor, comercioId, accion, antes === null ? null : JSON.stringify(antes), despues === null ? null : JSON.stringify(despues)],
  );
}

export type EntradaAuditoria = {
  id: number; actor: string; comercio_id: string | null; accion: string;
  antes: Record<string, unknown> | null; despues: Record<string, unknown> | null; creado_at: Date;
};

export const listarAuditoria = (comercioId: string, limite = 100) =>
  filas<EntradaAuditoria>(db(), "SELECT * FROM auditoria WHERE comercio_id = $1 ORDER BY id DESC LIMIT $2", [comercioId, limite]);

export async function obtenerComercio(id: string) {
  const c = await fila<Comercio>(db(), "SELECT * FROM comercios WHERE id = $1", [id]);
  if (!c) throw new ErrorRedpagos("comercio_inexistente", "No existe el comercio", 404);
  return c;
}

export const listarComercios = () => filas<Comercio>(db(), "SELECT * FROM comercios ORDER BY creado_at");

// La clave completa se muestra una sola vez; en la DB queda el hash.
export async function crearApiKey(comercioId: string) {
  const clave = "rp_" + randomBytes(24).toString("hex");
  await db().query("INSERT INTO api_keys (comercio_id, prefijo, hash) VALUES ($1, $2, $3)", [
    comercioId, clave.slice(0, 10), sha256(clave),
  ]);
  return clave;
}

export const listarApiKeys = (comercioId: string) =>
  filas<{ prefijo: string; creada_at: Date; revocada_at: Date | null }>(db(),
    "SELECT prefijo, creada_at, revocada_at FROM api_keys WHERE comercio_id = $1 ORDER BY creada_at DESC", [comercioId]);

export async function revocarApiKey(comercioId: string, prefijo: string) {
  await db().query(
    "UPDATE api_keys SET revocada_at = now() WHERE comercio_id = $1 AND prefijo = $2 AND revocada_at IS NULL",
    [comercioId, prefijo],
  );
}

// Devuelve el comercio dueño de la clave, o null si no es válida.
export async function autenticar(clave: string) {
  return (await fila<Comercio>(
    db(),
    `SELECT c.* FROM api_keys k JOIN comercios c ON c.id = k.comercio_id
     WHERE k.hash = $1 AND k.revocada_at IS NULL AND c.activo`,
    [sha256(clave)],
  )) ?? null;
}
