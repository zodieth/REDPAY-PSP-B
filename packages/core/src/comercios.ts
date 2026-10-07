import { randomBytes } from "node:crypto";
import { db, fila, filas } from "@redpagos/db";
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

export async function crearComercio(datos: DatosComercio) {
  const campos = CAMPOS.filter((k) => datos[k] !== undefined);
  return (await fila<Comercio>(
    db(),
    `INSERT INTO comercios (${campos.join(", ")}) VALUES (${campos.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING *`,
    campos.map((k) => datos[k]),
  ))!;
}

export async function actualizarComercio(id: string, datos: Partial<DatosComercio>) {
  const campos = CAMPOS.filter((k) => datos[k] !== undefined);
  if (!campos.length) return obtenerComercio(id);
  const c = await fila<Comercio>(
    db(),
    `UPDATE comercios SET ${campos.map((k, i) => `${k} = $${i + 2}`).join(", ")} WHERE id = $1 RETURNING *`,
    [id, ...campos.map((k) => datos[k])],
  );
  if (!c) throw new ErrorRedpagos("comercio_inexistente", "No existe el comercio", 404);
  return c;
}

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
