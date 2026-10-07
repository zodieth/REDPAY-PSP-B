// Si se cancela una orden que esperaba la transferencia, se cancela el cobro para
// que el CVU no quede bloqueado hasta el vencimiento.
import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { clienteRedpagos, ErrorApiRedpagos } from "../lib/redpagos"
import { sesionesRedpagos } from "../lib/sesiones"

export default async function ordenCancelada({ event: { data }, container }: SubscriberArgs<{ id: string }>) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const api = clienteRedpagos()
  const { sesiones } = await sesionesRedpagos(container, { id: data.id })
  for (const s of sesiones) {
    try {
      await api.cancelar(s.cobro_id)
    } catch (e) {
      if (e instanceof ErrorApiRedpagos && e.codigo === "cobro_pagado") {
        logger.warn(`RedPagos: se canceló la orden ${data.id} pero el cobro ${s.cobro_id} ya estaba pagado (RedPagos no hace devoluciones)`)
      } else {
        logger.error(`RedPagos: no se pudo cancelar el cobro ${s.cobro_id} de la orden ${data.id}: ${(e as Error).message}`)
      }
    }
  }
}

export const config: SubscriberConfig = {
  event: "order.canceled",
}
