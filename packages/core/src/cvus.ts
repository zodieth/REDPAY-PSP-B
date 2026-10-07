// Pool de CVU/alias: cada uno es una cuenta recaudadora de cargavirtual.
import { db, fila, filas, transaccion, type Db } from "@redpagos/db";
import { cifrar, descifrar, ErrorRedpagos } from "./comun.ts";

export type EstadoCvu = "libre" | "asignado" | "cuarentena" | "deshabilitado";

export type Cvu = {
  id: number;
  usuario: string;
  clave_cifrada: string;
  pv: string;
  cvu: string;
  alias: string | null;
  titular: string | null;
  estado: EstadoCvu;
  cobro_id: string | null;
  libre_desde: Date;
  cuarentena_hasta: Date | null;
  inicializado: boolean;
  ultima_sync: Date | null;
  proxima_sync: Date;
  ultimo_error: string | null;
  creado_at: Date;
};

// Lo que se puede mostrar (sin la clave).
export const vistaCvu = ({ clave_cifrada: _, ...c }: Cvu) => c;

export async function agregarCvu(d: { usuario: string; clave: string; pv: string; cvu: string; alias?: string; titular?: string }) {
  if (!/^\d{22}$/.test(d.cvu)) throw new ErrorRedpagos("cvu_invalido", "El CVU tiene que tener 22 dígitos");
  const c = await fila<Cvu>(
    db(),
    `INSERT INTO cvus (usuario, clave_cifrada, pv, cvu, alias, titular) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT DO NOTHING RETURNING *`,
    [d.usuario, cifrar(d.clave), d.pv, d.cvu, d.alias ?? null, d.titular ?? null],
  );
  if (!c) throw new ErrorRedpagos("cvu_duplicado", "Ya existe una cuenta con ese CVU o usuario/PV", 409);
  return vistaCvu(c);
}

export async function actualizarCvu(id: number, d: { clave?: string; alias?: string; titular?: string; habilitado?: boolean }) {
  return transaccion(async (tx) => {
    const c = await fila<Cvu>(tx, "SELECT * FROM cvus WHERE id = $1 FOR UPDATE", [id]);
    if (!c) throw new ErrorRedpagos("cvu_inexistente", "No existe el CVU", 404);
    // Deshabilitar sólo si no tiene un cobro esperando; habilitar lo devuelve al pool como libre.
    let estado = c.estado;
    if (d.habilitado === false && c.estado !== "deshabilitado") {
      if (c.estado === "asignado") throw new ErrorRedpagos("cvu_asignado", "El CVU está asignado a un cobro abierto", 409);
      estado = "deshabilitado";
    } else if (d.habilitado === true && c.estado === "deshabilitado") {
      estado = "libre";
    }
    const r = await fila<Cvu>(
      tx,
      `UPDATE cvus SET clave_cifrada = coalesce($2, clave_cifrada), alias = coalesce($3, alias),
         titular = coalesce($4, titular), estado = $5,
         libre_desde = CASE WHEN $5 = 'libre' AND estado <> 'libre' THEN now() ELSE libre_desde END,
         cobro_id = CASE WHEN $5 = 'libre' THEN NULL ELSE cobro_id END
       WHERE id = $1 RETURNING *`,
      [id, d.clave ? cifrar(d.clave) : null, d.alias ?? null, d.titular ?? null, estado],
    );
    return vistaCvu(r!);
  });
}

export const listarCvus = async (estado?: EstadoCvu) =>
  (await filas<Cvu>(db(), "SELECT * FROM cvus WHERE ($1::text IS NULL OR estado = $1) ORDER BY id", [estado ?? null])).map(vistaCvu);

export const credenciales = (c: Cvu) => ({ id: c.id, usuario: c.usuario, clave: descifrar(c.clave_cifrada), pv: c.pv });

// Cuántos hay en cada estado y qué porcentaje del pool asignable está ocupado.
export async function estadoPool() {
  const r = await filas<{ estado: EstadoCvu; n: number }>(db(), "SELECT estado, count(*)::int AS n FROM cvus GROUP BY estado");
  const n = Object.fromEntries(r.map((x) => [x.estado, x.n])) as Partial<Record<EstadoCvu, number>>;
  const libre = n.libre ?? 0, asignado = n.asignado ?? 0, cuarentena = n.cuarentena ?? 0;
  const total = libre + asignado + cuarentena;
  return {
    libre, asignado, cuarentena, deshabilitado: n.deshabilitado ?? 0,
    ocupacion: total ? Math.round(((asignado + cuarentena) / total) * 100) : 100,
  };
}

// Manda el CVU a cuarentena, o la estira si ya estaba (nunca la acorta). Sólo si
// el CVU sigue atado a ese cobro: si ya se reasignó, no se toca.
export async function ponerEnCuarentena(c: Db, cvuId: number, cobroId: string, horas: number) {
  await c.query(
    `UPDATE cvus SET estado = 'cuarentena',
       cuarentena_hasta = greatest(coalesce(cuarentena_hasta, now()), now() + make_interval(hours => $3))
     WHERE id = $1 AND cobro_id = $2 AND estado IN ('asignado', 'cuarentena')`,
    [cvuId, cobroId, horas],
  );
}

// Devuelve al pool los CVU cuya cuarentena terminó.
export async function liberarCuarentenas() {
  const r = await db().query(
    `UPDATE cvus SET estado = 'libre', cobro_id = NULL, cuarentena_hasta = NULL, libre_desde = now()
     WHERE estado = 'cuarentena' AND cuarentena_hasta <= now()`,
  );
  return r.rowCount ?? 0;
}
