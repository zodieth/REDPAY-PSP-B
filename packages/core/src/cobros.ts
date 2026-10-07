// Cobros: un pago esperado. Al asignarse toma un CVU exclusivo del pool
// hasta que se paga, vence o se cancela; después el CVU pasa a cuarentena.
import { db, fila, filas, transaccion, type Db } from "@redpagos/db";
import { ErrorRedpagos } from "./comun.ts";
import type { Comercio } from "./comercios.ts";
import { ponerEnCuarentena } from "./cvus.ts";
import { encolarEvento, type Evento } from "./webhooks.ts";

export type EstadoCobro = "borrador" | "pendiente" | "parcial" | "pagado" | "vencido" | "cancelado";

export type Cobro = {
  id: string;
  comercio_id: string;
  referencia: string | null;
  importe: number;
  moneda: string;
  estado: EstadoCobro;
  recibido: number;
  cvu_id: number | null;
  asignado_at: Date | null;
  vence_at: Date | null;
  pagado_at: Date | null;
  cerrado_at: Date | null;
  metadata: Record<string, unknown>;
  idempotency_key: string | null;
  creado_at: Date;
};

// Cómo se ve un cobro hacia afuera (API y webhooks). Importes en centavos.
export type VistaCobro = {
  id: string;
  estado: EstadoCobro;
  importe: number;
  recibido: number;
  moneda: string;
  referencia: string | null;
  transferir_a: { cvu: string; alias: string | null; titular: string | null } | null;
  asignado_at: Date | null;
  vence_at: Date | null;
  pagado_at: Date | null;
  metadata: Record<string, unknown>;
  creado_at: Date;
};

const SELECT_VISTA = `
  SELECT c.*, v.cvu, v.alias, v.titular
  FROM cobros c LEFT JOIN cvus v ON v.id = c.cvu_id`;

type FilaVista = Cobro & { cvu: string | null; alias: string | null; titular: string | null };

const aVista = (c: FilaVista): VistaCobro => ({
  id: c.id,
  estado: c.estado,
  importe: c.importe,
  recibido: c.recibido,
  moneda: c.moneda,
  referencia: c.referencia,
  transferir_a: c.cvu ? { cvu: c.cvu, alias: c.alias, titular: c.titular } : null,
  asignado_at: c.asignado_at,
  vence_at: c.vence_at,
  pagado_at: c.pagado_at,
  metadata: c.metadata,
  creado_at: c.creado_at,
});

export async function vista(c: Db, cobroId: string) {
  const r = await fila<FilaVista>(c, `${SELECT_VISTA} WHERE c.id = $1`, [cobroId]);
  if (!r) throw new ErrorRedpagos("cobro_inexistente", "No existe el cobro", 404);
  return aVista(r);
}

export async function obtenerCobro(comercioId: string, cobroId: string) {
  const r = await fila<FilaVista>(db(), `${SELECT_VISTA} WHERE c.id = $1 AND c.comercio_id = $2`, [cobroId, comercioId]);
  if (!r) throw new ErrorRedpagos("cobro_inexistente", "No existe el cobro", 404);
  return aVista(r);
}

export async function listarCobros(comercioId: string, f: { estado?: string; referencia?: string; limite?: number } = {}) {
  const r = await filas<FilaVista>(db(), `${SELECT_VISTA}
    WHERE c.comercio_id = $1 AND ($2::text IS NULL OR c.estado = $2) AND ($3::text IS NULL OR c.referencia = $3)
    ORDER BY c.creado_at DESC LIMIT $4`,
    [comercioId, f.estado ?? null, f.referencia ?? null, Math.min(f.limite ?? 50, 500)]);
  return r.map(aVista);
}

// Bloquea el cobro dentro de la transacción y verifica que sea del comercio.
async function bloquear(tx: Db, comercioId: string, cobroId: string) {
  const c = await fila<Cobro>(tx, "SELECT * FROM cobros WHERE id = $1 AND comercio_id = $2 FOR UPDATE", [cobroId, comercioId]);
  if (!c) throw new ErrorRedpagos("cobro_inexistente", "No existe el cobro", 404);
  return c;
}

// Toma el CVU libre que hace más tiempo que no se usa. SKIP LOCKED: dos cobros
// simultáneos nunca se llevan el mismo. Nunca uno que no se puede leer (sin
// primera lectura o con error): el pago entraría y no lo veríamos.
async function asignar(tx: Db, comercio: Comercio, cobro: Cobro) {
  const cvu = await fila<{ id: number }>(tx, `
    SELECT id FROM cvus WHERE estado = 'libre' AND inicializado AND ultimo_error IS NULL
    ORDER BY libre_desde LIMIT 1 FOR UPDATE SKIP LOCKED`);
  if (!cvu) throw new ErrorRedpagos("pool_agotado", "No hay CVU disponibles en este momento", 503);
  await tx.query(
    "UPDATE cvus SET estado = 'asignado', cobro_id = $2, cuarentena_hasta = NULL, proxima_sync = now() WHERE id = $1",
    [cvu.id, cobro.id],
  );
  await tx.query(
    `UPDATE cobros SET estado = 'pendiente', cvu_id = $2, asignado_at = now(),
       vence_at = now() + make_interval(hours => $3) WHERE id = $1`,
    [cobro.id, cvu.id, comercio.bloqueo_horas],
  );
}

export type NuevoCobro = {
  importe: number;
  referencia?: string;
  metadata?: Record<string, unknown>;
  idempotency_key?: string;
  // false: queda en borrador sin CVU (para asignarlo cuando se confirme la orden).
  asignar?: boolean;
};

export async function crearCobro(comercio: Comercio, d: NuevoCobro) {
  if (!Number.isInteger(d.importe) || d.importe <= 0) {
    throw new ErrorRedpagos("importe_invalido", "importe tiene que ser un entero positivo en centavos");
  }
  return transaccion(async (tx) => {
    let cobro = await fila<Cobro>(tx, `
      INSERT INTO cobros (comercio_id, importe, referencia, metadata, idempotency_key)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (comercio_id, idempotency_key) DO NOTHING RETURNING *`,
      [comercio.id, d.importe, d.referencia ?? null, d.metadata ?? {}, d.idempotency_key ?? null]);
    // Misma idempotency_key: devolvemos el cobro que ya existía.
    cobro ??= (await fila<Cobro>(tx,
      "SELECT * FROM cobros WHERE comercio_id = $1 AND idempotency_key = $2 FOR UPDATE", [comercio.id, d.idempotency_key]))!;
    if (d.asignar !== false && cobro.estado === "borrador") await asignar(tx, comercio, cobro);
    return vista(tx, cobro.id);
  });
}

// Sólo en borrador: una vez asignado el CVU, el importe queda fijo.
export async function actualizarImporte(comercio: Comercio, cobroId: string, importe: number) {
  if (!Number.isInteger(importe) || importe <= 0) {
    throw new ErrorRedpagos("importe_invalido", "importe tiene que ser un entero positivo en centavos");
  }
  return transaccion(async (tx) => {
    const c = await bloquear(tx, comercio.id, cobroId);
    if (c.estado !== "borrador") throw new ErrorRedpagos("cobro_no_editable", "Sólo se puede cambiar el importe de un borrador", 409);
    await tx.query("UPDATE cobros SET importe = $2 WHERE id = $1", [c.id, importe]);
    return vista(tx, c.id);
  });
}

// Idempotente: si ya tiene CVU devuelve el cobro como está.
export async function asignarCobro(comercio: Comercio, cobroId: string) {
  return transaccion(async (tx) => {
    const c = await bloquear(tx, comercio.id, cobroId);
    if (c.estado === "borrador") await asignar(tx, comercio, c);
    return vista(tx, c.id);
  });
}

async function cerrar(tx: Db, comercio: Comercio, c: Cobro, estado: "vencido" | "cancelado", evento: Evento) {
  await tx.query("UPDATE cobros SET estado = $2, cerrado_at = now() WHERE id = $1", [c.id, estado]);
  if (c.cvu_id) await ponerEnCuarentena(tx, c.cvu_id, c.id, comercio.cuarentena_vencido_horas);
  if (c.estado !== "borrador") await encolarEvento(tx, comercio.id, evento, { cobro: await vista(tx, c.id) });
}

// Idempotente para vencido/cancelado. Un cobro pagado no se cancela.
export async function cancelarCobro(comercio: Comercio, cobroId: string) {
  return transaccion(async (tx) => {
    const c = await bloquear(tx, comercio.id, cobroId);
    if (c.estado === "pagado") throw new ErrorRedpagos("cobro_pagado", "El cobro ya fue pagado", 409);
    if (c.estado === "borrador" || c.estado === "pendiente" || c.estado === "parcial") {
      await cerrar(tx, comercio, c, "cancelado", "cobro.cancelado");
    }
    return vista(tx, c.id);
  });
}

// Vence los cobros abiertos cuyo plazo terminó. Lo llama el worker.
export async function vencerCobros() {
  return transaccion(async (tx) => {
    const vencidos = await filas<Cobro>(tx, `
      SELECT * FROM cobros WHERE estado IN ('pendiente', 'parcial') AND vence_at <= now()
      ORDER BY vence_at LIMIT 500 FOR UPDATE SKIP LOCKED`);
    for (const c of vencidos) {
      const comercio = await fila<Comercio>(tx, "SELECT * FROM comercios WHERE id = $1", [c.comercio_id]);
      await cerrar(tx, comercio!, c, "vencido", "cobro.vencido");
    }
    return vencidos.length;
  });
}
