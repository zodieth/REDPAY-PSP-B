// Imputación: cada depósito que entra a un CVU se asigna al cobro que lo tiene
// (o al último que lo tuvo, si está en cuarentena) y se acredita en el libro.
import { db, fila, filas, transaccion, type Db } from "@redpagos/db";
import type { Deposito } from "@redpagos/cargavirtual";
import { aCentavos, comision, ErrorRedpagos } from "./comun.ts";
import type { Comercio } from "./comercios.ts";
import { vista, type Cobro } from "./cobros.ts";
import { ponerEnCuarentena, type Cvu } from "./cvus.ts";
import { encolarEvento } from "./webhooks.ts";

// Un depósito fechado más de esto antes de la asignación no puede ser de ese cobro.
const MARGEN_ASIGNACION_MS = 2 * 60_000;

export type FilaDeposito = {
  id: string;
  cvu_id: number;
  cobro_id: string | null;
  imputacion: "cobro" | "tardio" | "huerfano" | "manual" | "historico";
  importe: number;
  fecha_deposito: Date | null;
  fecha_carga: Date | null;
  banco: string | null;
  cuenta: string | null;
  nro_transaccion: string | null;
  observaciones: string | null;
  detectado_at: Date;
};

const vistaDeposito = (d: FilaDeposito) => ({
  id: d.id,
  importe: d.importe,
  fecha_deposito: d.fecha_deposito,
  banco: d.banco,
  nro_transaccion: d.nro_transaccion,
  observaciones: d.observaciones,
});

// Acredita el depósito al comercio del cobro y actualiza el estado del cobro.
async function acreditar(tx: Db, cobro: Cobro, dep: FilaDeposito) {
  const comercio = (await fila<Comercio>(tx, "SELECT * FROM comercios WHERE id = $1", [cobro.comercio_id]))!;
  const fee = comision(dep.importe, comercio.comision_pb);
  await tx.query(
    `INSERT INTO movimientos (comercio_id, tipo, importe, cobro_id, deposito_id, descripcion)
     VALUES ($1, 'cobro', $2, $3, $4, $5)`,
    [comercio.id, dep.importe, cobro.id, dep.id, `Transferencia ${dep.nro_transaccion ?? dep.id}`],
  );
  if (fee) {
    await tx.query(
      `INSERT INTO movimientos (comercio_id, tipo, importe, cobro_id, deposito_id, descripcion)
       VALUES ($1, 'comision', $2, $3, $4, $5)`,
      [comercio.id, -fee, cobro.id, dep.id, `Comisión ${comercio.comision_pb / 100} %`],
    );
  }
  const { recibido } = (await fila<{ recibido: number }>(tx,
    "UPDATE cobros SET recibido = recibido + $2 WHERE id = $1 RETURNING recibido", [cobro.id, dep.importe]))!;
  const data = async () => ({ cobro: await vista(tx, cobro.id), deposito: vistaDeposito(dep), comision: fee });

  if (cobro.estado === "pendiente" || cobro.estado === "parcial") {
    if (recibido >= cobro.importe) {
      await tx.query("UPDATE cobros SET estado = 'pagado', pagado_at = now(), cerrado_at = now() WHERE id = $1", [cobro.id]);
      if (cobro.cvu_id) await ponerEnCuarentena(tx, cobro.cvu_id, cobro.id, comercio.cuarentena_pagado_horas);
      await encolarEvento(tx, comercio.id, "cobro.pagado", await data());
      if (recibido > cobro.importe) {
        await encolarEvento(tx, comercio.id, "cobro.excedente", { ...(await data()), excedente: recibido - cobro.importe });
      }
    } else {
      await tx.query("UPDATE cobros SET estado = 'parcial' WHERE id = $1", [cobro.id]);
      await encolarEvento(tx, comercio.id, "cobro.parcial", { ...(await data()), falta: cobro.importe - recibido });
    }
  } else {
    // Cobro ya cerrado: la plata va igual al saldo del comercio y le avisamos.
    // Si el comprador sigue usando el alias, estiramos la cuarentena.
    if (cobro.cvu_id) await ponerEnCuarentena(tx, cobro.cvu_id, cobro.id, comercio.cuarentena_vencido_horas);
    await encolarEvento(tx, comercio.id, "cobro.pago_tardio", await data());
  }
}

// Guarda los depósitos leídos de un CVU e imputa los nuevos. historico = primera
// lectura de la cuenta: se guardan para no reprocesarlos, pero no se imputan.
export async function registrarDepositos(cvuId: number, depositos: Deposito[], historico = false) {
  let nuevos = 0;
  for (const d of depositos) {
    // Una transacción por depósito: si uno falla, los demás quedan.
    const nuevo = await transaccion(async (tx) => {
      // Locks siempre en el orden cobro -> cvu (como asignar/cancelar/vencer) para no trabarse.
      const previo = (await fila<Cvu>(tx, "SELECT * FROM cvus WHERE id = $1", [cvuId]))!;
      if (previo.cobro_id) await tx.query("SELECT 1 FROM cobros WHERE id = $1 FOR UPDATE", [previo.cobro_id]);
      const cvu = (await fila<Cvu>(tx, "SELECT * FROM cvus WHERE id = $1 FOR UPDATE", [cvuId]))!;
      if (cvu.cobro_id !== previo.cobro_id) throw new Error(`El CVU ${cvuId} cambió de cobro durante la imputación; se reintenta`);
      const existe = await fila(tx, "SELECT 1 FROM depositos WHERE id = $1", [d.id]);
      if (existe) return false;

      let cobro: Cobro | undefined;
      let imputacion: FilaDeposito["imputacion"] = historico ? "historico" : "huerfano";
      if (!historico && cvu.cobro_id && (cvu.estado === "asignado" || cvu.estado === "cuarentena")) {
        cobro = await fila<Cobro>(tx, "SELECT * FROM cobros WHERE id = $1", [cvu.cobro_id]);
        const fecha = d.fecha_deposito ? Date.parse(d.fecha_deposito) : NaN;
        const anterior = cobro?.asignado_at && fecha < cobro.asignado_at.getTime() - MARGEN_ASIGNACION_MS;
        if (cobro && !anterior) imputacion = cvu.estado === "asignado" ? "cobro" : "tardio";
        else cobro = undefined;
      }

      const dep = (await fila<FilaDeposito>(tx, `
        INSERT INTO depositos (id, cvu_id, cobro_id, imputacion, importe, fecha_deposito, fecha_carga,
                               banco, cuenta, nro_transaccion, observaciones)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
        [d.id, cvuId, cobro?.id ?? null, imputacion, aCentavos(d.importe), d.fecha_deposito, d.fecha_carga,
          d.banco, d.cuenta, d.nro_transaccion, d.observaciones]))!;
      if (cobro) await acreditar(tx, cobro, dep);
      return true;
    });
    if (nuevo) nuevos++;
  }
  return nuevos;
}

export const listarHuerfanos = () =>
  filas<FilaDeposito & { cvu: string; alias: string | null }>(db(), `
    SELECT d.*, v.cvu, v.alias FROM depositos d JOIN cvus v ON v.id = d.cvu_id
    WHERE d.imputacion = 'huerfano' ORDER BY d.detectado_at DESC`);

// Backoffice: asigna un depósito huérfano a un cobro (de cualquier comercio).
export async function imputarManual(depositoId: string, cobroId: string) {
  return transaccion(async (tx) => {
    const dep = await fila<FilaDeposito>(tx, "SELECT * FROM depositos WHERE id = $1 FOR UPDATE", [depositoId]);
    if (!dep) throw new ErrorRedpagos("deposito_inexistente", "No existe el depósito", 404);
    if (dep.imputacion !== "huerfano") throw new ErrorRedpagos("deposito_imputado", "El depósito ya está imputado", 409);
    const cobro = await fila<Cobro>(tx, "SELECT * FROM cobros WHERE id = $1 FOR UPDATE", [cobroId]);
    if (!cobro) throw new ErrorRedpagos("cobro_inexistente", "No existe el cobro", 404);
    if (cobro.estado === "borrador") throw new ErrorRedpagos("cobro_borrador", "El cobro todavía no tiene CVU asignado", 409);
    const r = (await fila<FilaDeposito>(tx,
      "UPDATE depositos SET imputacion = 'manual', cobro_id = $2 WHERE id = $1 RETURNING *", [dep.id, cobro.id]))!;
    await acreditar(tx, cobro, r);
    return vista(tx, cobro.id);
  });
}
