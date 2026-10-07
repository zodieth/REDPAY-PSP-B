import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

export type SesionRedpagos = {
  order_id: string
  session_id: string
  status: string
  cobro_id: string
}

type FilaOrden = {
  id: string
  payment_collections?: {
    payment_sessions?: { id: string; provider_id: string; status: string; data: Record<string, unknown> | null }[]
  }[]
}

const CAMPOS = [
  "id",
  "payment_collections.payment_sessions.id",
  "payment_collections.payment_sessions.provider_id",
  "payment_collections.payment_sessions.status",
  "payment_collections.payment_sessions.data",
]

// Sesiones de RedPagos de las órdenes que cumplen el filtro.
export async function sesionesRedpagos(container: MedusaContainer, filtros: Record<string, unknown>, paginacion?: { skip: number; take: number }) {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({ entity: "order", fields: CAMPOS, filters: filtros, pagination: paginacion })
  const ordenes = data as unknown as FilaOrden[]
  const sesiones: SesionRedpagos[] = []
  for (const o of ordenes) {
    for (const pc of o.payment_collections ?? []) {
      for (const s of pc.payment_sessions ?? []) {
        const cobroId = s.data?.cobro_id
        if (s.provider_id.startsWith("pp_redpagos") && typeof cobroId === "string") {
          sesiones.push({ order_id: o.id, session_id: s.id, status: s.status, cobro_id: cobroId })
        }
      }
    }
  }
  return { ordenes: ordenes.length, sesiones }
}
