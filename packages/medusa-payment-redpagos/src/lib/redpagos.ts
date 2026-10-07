import { createHmac, timingSafeEqual } from "node:crypto"

export type OpcionesRedpagos = {
  /** URL de la API de redpagos, p. ej. https://api.redpagos.com.ar */
  apiUrl?: string
  /** API key del comercio (rp_...) */
  apiKey?: string
  /** Secreto del webhook que apunta a /hooks/payment/redpagos_redpagos (whsec_...) */
  webhookSecret?: string
}

export type EstadoCobro = "borrador" | "pendiente" | "parcial" | "pagado" | "vencido" | "cancelado"

// Importes en centavos.
export type Cobro = {
  id: string
  estado: EstadoCobro
  importe: number
  recibido: number
  moneda: string
  referencia: string | null
  transferir_a: { cvu: string; alias: string | null; titular: string | null } | null
  asignado_at: string | null
  vence_at: string | null
  pagado_at: string | null
  metadata: Record<string, unknown>
}

export class ErrorApiRedpagos extends Error {
  status: number
  codigo: string
  constructor(status: number, codigo: string, mensaje: string) {
    super(mensaje)
    this.status = status
    this.codigo = codigo
  }
}

// Las opciones del provider pisan a las variables de entorno (los jobs y
// subscribers no tienen acceso a las opciones, sólo al entorno).
export function opciones(o: OpcionesRedpagos = {}) {
  return {
    apiUrl: (o.apiUrl ?? process.env.REDPAGOS_API_URL ?? "").replace(/\/$/, ""),
    apiKey: o.apiKey ?? process.env.REDPAGOS_API_KEY ?? "",
    webhookSecret: o.webhookSecret ?? process.env.REDPAGOS_WEBHOOK_SECRET ?? "",
  }
}

export function clienteRedpagos(o: OpcionesRedpagos = {}) {
  const { apiUrl, apiKey } = opciones(o)

  async function pedir<T>(metodo: string, ruta: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(apiUrl + ruta, {
      method: metodo,
      signal: AbortSignal.timeout(15_000),
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const json = (await res.json().catch(() => ({}))) as { error?: { codigo: string; mensaje: string } }
    if (!res.ok) {
      throw new ErrorApiRedpagos(res.status, json.error?.codigo ?? "error", json.error?.mensaje ?? `redpagos respondió HTTP ${res.status}`)
    }
    return json as T
  }

  return {
    crear: (d: { importe: number; referencia?: string; metadata?: Record<string, unknown>; asignar?: boolean }, idempotencyKey?: string) =>
      pedir<Cobro>("POST", "/v1/cobros", d, idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    obtener: (id: string) => pedir<Cobro>("GET", `/v1/cobros/${encodeURIComponent(id)}`),
    actualizar: (id: string, importe: number) => pedir<Cobro>("PATCH", `/v1/cobros/${encodeURIComponent(id)}`, { importe }),
    asignar: (id: string) => pedir<Cobro>("POST", `/v1/cobros/${encodeURIComponent(id)}/asignar`),
    cancelar: (id: string) => pedir<Cobro>("POST", `/v1/cobros/${encodeURIComponent(id)}/cancelar`),
  }
}

export type ClienteRedpagos = ReturnType<typeof clienteRedpagos>

// x-redpagos-firma: t=<unix>,v1=HMAC-SHA256(secreto, `${t}.${body}`). Rechaza firmas de más de 5 min.
export function firmaValida(secreto: string, body: string | Buffer, header: unknown, toleranciaSeg = 300) {
  if (!secreto || typeof header !== "string") return false
  const partes = Object.fromEntries(header.split(",").map((p) => p.split("=") as [string, string]))
  const t = Number(partes.t)
  if (!t || !partes.v1 || Math.abs(Date.now() / 1000 - t) > toleranciaSeg) return false
  const esperada = createHmac("sha256", secreto).update(`${t}.${body.toString()}`).digest("hex")
  return esperada.length === partes.v1.length && timingSafeEqual(Buffer.from(esperada), Buffer.from(partes.v1))
}

// Medusa v2 guarda importes en unidades de la moneda (pesos); redpagos, en centavos.
export const aCentavos = (pesos: number) => Math.round(pesos * 100)
export const aPesos = (centavos: number) => centavos / 100
