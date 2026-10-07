// Webhooks de los comercios: cola en la DB, firma HMAC y reintentos con backoff.
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { db, fila, filas, type Db } from "@redpagos/db";
import { ErrorRedpagos } from "./comun.ts";

// Espera antes de cada reintento; agotada la lista, la entrega queda "fallida".
const BACKOFF_SEG = [30, 120, 600, 1800, 3600, 3 * 3600, 6 * 3600];
const MAX_INTENTOS = BACKOFF_SEG.length + 1;

export type Evento =
  | "cobro.pagado"
  | "cobro.parcial"
  | "cobro.excedente"
  | "cobro.vencido"
  | "cobro.cancelado"
  | "cobro.pago_tardio"
  | "ping";

export type Webhook = { id: string; comercio_id: string; url: string; secreto: string; activo: boolean; creado_at: Date };

// Firma: HMAC-SHA256(secreto, `${t}.${body}`) en el header x-redpagos-firma: t=<unix>,v1=<hex>
export function firmar(secreto: string, body: string, t = Math.floor(Date.now() / 1000)) {
  const v1 = createHmac("sha256", secreto).update(`${t}.${body}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

export async function crearWebhook(comercioId: string, url: string) {
  if (!/^https?:\/\//.test(url)) throw new ErrorRedpagos("url_invalida", "La URL tiene que empezar con http(s)://");
  const secreto = "whsec_" + randomBytes(24).toString("hex");
  return (await fila<Webhook>(
    db(),
    "INSERT INTO webhooks (comercio_id, url, secreto) VALUES ($1, $2, $3) RETURNING *",
    [comercioId, url, secreto],
  ))!;
}

export const listarWebhooks = (comercioId: string) =>
  filas<Webhook>(db(), "SELECT * FROM webhooks WHERE comercio_id = $1 ORDER BY creado_at", [comercioId]);

export async function actualizarWebhook(comercioId: string, id: string, datos: { url?: string; activo?: boolean }) {
  const w = await fila<Webhook>(
    db(),
    `UPDATE webhooks SET url = coalesce($3, url), activo = coalesce($4, activo)
     WHERE id = $1 AND comercio_id = $2 RETURNING *`,
    [id, comercioId, datos.url ?? null, datos.activo ?? null],
  );
  if (!w) throw new ErrorRedpagos("webhook_inexistente", "No existe el webhook", 404);
  return w;
}

// Encola el evento para cada webhook activo del comercio. Llamar dentro de la misma
// transacción que el cambio de estado: si no se guarda uno, no se guarda el otro.
export async function encolarEvento(c: Db, comercioId: string, evento: Evento, data: unknown) {
  const hooks = await filas<{ id: string }>(c, "SELECT id FROM webhooks WHERE comercio_id = $1 AND activo", [comercioId]);
  for (const h of hooks) {
    const id = randomUUID();
    const payload = JSON.stringify({ id, evento, creado: new Date().toISOString(), data });
    await c.query("INSERT INTO entregas (id, webhook_id, evento, payload) VALUES ($1, $2, $3, $4)", [id, h.id, evento, payload]);
  }
}

type Pendiente = { id: string; evento: string; payload: string; intentos: number; url: string; secreto: string };

async function entregar(e: Pendiente) {
  let status: number | null = null;
  let error: string | null = null;
  try {
    const res = await fetch(e.url, {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
      headers: {
        "content-type": "application/json",
        "user-agent": "redpagos-webhooks/1",
        "x-redpagos-evento": e.evento,
        "x-redpagos-entrega": e.id,
        "x-redpagos-firma": firmar(e.secreto, e.payload),
      },
      body: e.payload,
    });
    status = res.status;
    if (!res.ok) error = `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const intentos = e.intentos + 1;
  if (!error) {
    await db().query(
      "UPDATE entregas SET estado = 'entregada', intentos = $2, ultimo_status = $3, ultimo_error = NULL, entregado_at = now() WHERE id = $1",
      [e.id, intentos, status],
    );
  } else if (intentos >= MAX_INTENTOS) {
    await db().query(
      "UPDATE entregas SET estado = 'fallida', intentos = $2, ultimo_status = $3, ultimo_error = $4 WHERE id = $1",
      [e.id, intentos, status, error],
    );
  } else {
    await db().query(
      `UPDATE entregas SET intentos = $2, ultimo_status = $3, ultimo_error = $4,
         proximo_intento = now() + make_interval(secs => $5) WHERE id = $1`,
      [e.id, intentos, status, error, BACKOFF_SEG[intentos - 1]],
    );
  }
}

// Manda las entregas vencidas. Webhooks desactivados quedan en espera.
export async function procesarCola() {
  const pendientes = await filas<Pendiente>(db(), `
    SELECT e.id, e.evento, e.payload, e.intentos, w.url, w.secreto
    FROM entregas e JOIN webhooks w ON w.id = e.webhook_id
    WHERE e.estado = 'pendiente' AND e.proximo_intento <= now() AND w.activo
    ORDER BY e.creado_at LIMIT 50
  `);
  await Promise.all(pendientes.map(entregar));
  return pendientes.length;
}

export const listarEntregas = (comercioId: string, estado?: string) =>
  filas(db(), `
    SELECT e.id, e.webhook_id, e.evento, e.estado, e.intentos, e.ultimo_status, e.ultimo_error, e.creado_at, e.entregado_at
    FROM entregas e JOIN webhooks w ON w.id = e.webhook_id
    WHERE w.comercio_id = $1 AND ($2::text IS NULL OR e.estado = $2)
    ORDER BY e.creado_at DESC LIMIT 200
  `, [comercioId, estado ?? null]);

export async function reintentarEntrega(comercioId: string, id: string) {
  await db().query(
    `UPDATE entregas e SET estado = 'pendiente', proximo_intento = now()
     FROM webhooks w WHERE w.id = e.webhook_id AND w.comercio_id = $1 AND e.id = $2`,
    [comercioId, id],
  );
}

export async function enviarPing(comercioId: string, webhookId: string) {
  const w = await fila<Webhook>(db(), "SELECT * FROM webhooks WHERE id = $1 AND comercio_id = $2", [webhookId, comercioId]);
  if (!w) throw new ErrorRedpagos("webhook_inexistente", "No existe el webhook", 404);
  const id = randomUUID();
  const payload = JSON.stringify({ id, evento: "ping", creado: new Date().toISOString(), data: {} });
  await db().query("INSERT INTO entregas (id, webhook_id, evento, payload) VALUES ($1, $2, 'ping', $3)", [id, w.id, payload]);
  return id;
}
