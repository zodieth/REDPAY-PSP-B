// Cuenta corriente del comercio. El saldo es la suma de sus movimientos.
import { db, fila, filas, transaccion, type Db } from "@redpagos/db";
import { ErrorRedpagos } from "./comun.ts";

export type Movimiento = {
  id: number;
  comercio_id: string;
  tipo: "cobro" | "comision" | "retiro" | "ajuste";
  importe: number;
  cobro_id: string | null;
  deposito_id: string | null;
  retiro_id: string | null;
  descripcion: string | null;
  creado_at: Date;
};

const saldoCon = async (c: Db, comercioId: string) =>
  (await fila<{ saldo: number }>(c, "SELECT coalesce(sum(importe), 0)::bigint AS saldo FROM movimientos WHERE comercio_id = $1", [comercioId]))!.saldo;

export const saldo = (comercioId: string) => saldoCon(db(), comercioId);

// Paginado hacia atrás: antes_de = id del último movimiento recibido.
export const listarMovimientos = (comercioId: string, f: { antes_de?: number; limite?: number } = {}) =>
  filas<Movimiento>(db(), `
    SELECT * FROM movimientos WHERE comercio_id = $1 AND ($2::bigint IS NULL OR id < $2)
    ORDER BY id DESC LIMIT $3`,
    [comercioId, f.antes_de ?? null, Math.min(f.limite ?? 100, 1000)]);

export type NuevoRetiro = { importe: number; entregado_por: string; recibido_por: string; comprobante?: string; notas?: string };

// Backoffice registra la entrega del efectivo. Bloquea el comercio para que dos
// retiros simultáneos no dejen el saldo en negativo.
export async function registrarRetiro(comercioId: string, r: NuevoRetiro) {
  if (!Number.isInteger(r.importe) || r.importe <= 0) throw new ErrorRedpagos("importe_invalido", "importe tiene que ser un entero positivo en centavos");
  if (!r.entregado_por || !r.recibido_por) throw new ErrorRedpagos("datos_incompletos", "Faltan entregado_por / recibido_por");
  return transaccion(async (tx) => {
    const ok = await fila(tx, "SELECT 1 FROM comercios WHERE id = $1 FOR UPDATE", [comercioId]);
    if (!ok) throw new ErrorRedpagos("comercio_inexistente", "No existe el comercio", 404);
    const disponible = await saldoCon(tx, comercioId);
    if (r.importe > disponible) throw new ErrorRedpagos("saldo_insuficiente", `El saldo disponible es ${disponible} centavos`, 409);
    const retiro = (await fila<{ id: string }>(tx, `
      INSERT INTO retiros (comercio_id, importe, entregado_por, recibido_por, comprobante, notas)
      VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [comercioId, r.importe, r.entregado_por, r.recibido_por, r.comprobante ?? null, r.notas ?? null]))!;
    await tx.query(
      "INSERT INTO movimientos (comercio_id, tipo, importe, retiro_id, descripcion) VALUES ($1, 'retiro', $2, $3, 'Retiro en efectivo')",
      [comercioId, -r.importe, retiro.id],
    );
    return { ...retiro, saldo: disponible - r.importe };
  });
}

export const listarRetiros = (comercioId: string) =>
  filas(db(), "SELECT * FROM retiros WHERE comercio_id = $1 ORDER BY creado_at DESC", [comercioId]);

// Corrección manual del saldo (positiva o negativa), siempre con motivo.
export async function registrarAjuste(comercioId: string, importe: number, descripcion: string) {
  if (!Number.isInteger(importe) || importe === 0) throw new ErrorRedpagos("importe_invalido", "importe tiene que ser un entero distinto de 0");
  if (!descripcion) throw new ErrorRedpagos("datos_incompletos", "Falta la descripción del ajuste");
  return (await fila<Movimiento>(db(),
    "INSERT INTO movimientos (comercio_id, tipo, importe, descripcion) VALUES ($1, 'ajuste', $2, $3) RETURNING *",
    [comercioId, importe, descripcion]))!;
}
