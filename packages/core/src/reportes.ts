// Números para el backoffice.
import { db, fila, filas } from "@redpagos/db";

// Ventanas en hora argentina: "hoy" empieza a las 00:00 de Buenos Aires.
const DESDE_HOY = "date_trunc('day', now() AT TIME ZONE 'America/Argentina/Buenos_Aires') AT TIME ZONE 'America/Argentina/Buenos_Aires'";

export async function resumenGeneral() {
  const r = await fila<{
    bruto_hoy: number; comision_hoy: number; bruto_7d: number; comision_7d: number; bruto_30d: number; comision_30d: number;
  }>(db(), `
    SELECT
      coalesce(sum(importe) FILTER (WHERE tipo = 'cobro' AND creado_at >= ${DESDE_HOY}), 0)::bigint AS bruto_hoy,
      coalesce(-sum(importe) FILTER (WHERE tipo = 'comision' AND creado_at >= ${DESDE_HOY}), 0)::bigint AS comision_hoy,
      coalesce(sum(importe) FILTER (WHERE tipo = 'cobro' AND creado_at >= now() - interval '7 days'), 0)::bigint AS bruto_7d,
      coalesce(-sum(importe) FILTER (WHERE tipo = 'comision' AND creado_at >= now() - interval '7 days'), 0)::bigint AS comision_7d,
      coalesce(sum(importe) FILTER (WHERE tipo = 'cobro' AND creado_at >= now() - interval '30 days'), 0)::bigint AS bruto_30d,
      coalesce(-sum(importe) FILTER (WHERE tipo = 'comision' AND creado_at >= now() - interval '30 days'), 0)::bigint AS comision_30d
    FROM movimientos WHERE creado_at >= now() - interval '30 days'`);
  const otros = await fila<{ cobros_abiertos: number; huerfanos: number; cvus_con_error: number; saldo_total: number }>(db(), `
    SELECT
      (SELECT count(*) FROM cobros WHERE estado IN ('pendiente', 'parcial'))::int AS cobros_abiertos,
      (SELECT count(*) FROM depositos WHERE imputacion = 'huerfano')::int AS huerfanos,
      (SELECT count(*) FROM cvus WHERE estado <> 'deshabilitado' AND ultimo_error IS NOT NULL)::int AS cvus_con_error,
      (SELECT coalesce(sum(importe), 0) FROM movimientos)::bigint AS saldo_total`);
  return { ...r!, ...otros! };
}

export type FilaComercio = {
  id: string; nombre: string; cuit: string | null; comision_pb: number; activo: boolean;
  saldo: number; cobros_abiertos: number; bruto_30d: number;
};

export const comerciosConSaldo = () =>
  filas<FilaComercio>(db(), `
    SELECT c.id, c.nombre, c.cuit, c.comision_pb, c.activo,
      coalesce((SELECT sum(importe) FROM movimientos m WHERE m.comercio_id = c.id), 0)::bigint AS saldo,
      (SELECT count(*) FROM cobros x WHERE x.comercio_id = c.id AND x.estado IN ('pendiente', 'parcial'))::int AS cobros_abiertos,
      coalesce((SELECT sum(importe) FROM movimientos m WHERE m.comercio_id = c.id AND m.tipo = 'cobro'
        AND m.creado_at >= now() - interval '30 days'), 0)::bigint AS bruto_30d
    FROM comercios c ORDER BY c.nombre`);

// Totales del comercio en una ventana (para su panel y la ficha del backoffice).
export async function totalesComercio(comercioId: string, dias = 30) {
  return (await fila<{ bruto: number; comision: number; retirado: number; cobros_pagados: number }>(db(), `
    SELECT
      coalesce(sum(importe) FILTER (WHERE tipo = 'cobro'), 0)::bigint AS bruto,
      coalesce(-sum(importe) FILTER (WHERE tipo = 'comision'), 0)::bigint AS comision,
      coalesce(-sum(importe) FILTER (WHERE tipo = 'retiro'), 0)::bigint AS retirado,
      (SELECT count(*) FROM cobros WHERE comercio_id = $1 AND estado = 'pagado'
        AND pagado_at >= now() - make_interval(days => $2))::int AS cobros_pagados
    FROM movimientos WHERE comercio_id = $1 AND creado_at >= now() - make_interval(days => $2)`,
    [comercioId, dias]))!;
}
