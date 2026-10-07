// Red de seguridad para los webhooks: recorre las órdenes pendientes con pago de
// redpagos sin autorizar y consulta cada cobro.
//   pagado (el webhook no llegó) -> autoriza y captura el pago
//   vencido / cancelado          -> cancela la orden (libera stock)
import type { MedusaContainer } from "@medusajs/framework/types"
import { BigNumber, ContainerRegistrationKeys, PaymentActions, PaymentSessionStatus } from "@medusajs/framework/utils"
import { cancelOrderWorkflow, processPaymentWorkflow } from "@medusajs/medusa/core-flows"
import { aPesos, clienteRedpagos } from "../lib/redpagos"
import { sesionesRedpagos } from "../lib/sesiones"

const LOTE = 200

export default async function conciliarRedpagos(container: MedusaContainer) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const api = clienteRedpagos()
  let pagados = 0
  let canceladas = 0

  for (let skip = 0; ; skip += LOTE) {
    const { ordenes, sesiones } = await sesionesRedpagos(container, { status: "pending" }, { skip, take: LOTE })
    for (const s of sesiones.filter((s) => s.status === PaymentSessionStatus.PENDING_AUTHORIZATION)) {
      try {
        const cobro = await api.obtener(s.cobro_id)
        if (cobro.estado === "pagado") {
          await processPaymentWorkflow(container).run({
            input: { action: PaymentActions.AUTHORIZED, data: { session_id: s.session_id, amount: new BigNumber(aPesos(cobro.importe)) } },
          })
          pagados++
        } else if (cobro.estado === "vencido" || cobro.estado === "cancelado") {
          await cancelOrderWorkflow(container).run({ input: { order_id: s.order_id } })
          canceladas++
        }
      } catch (e) {
        logger.error(`redpagos: no se pudo conciliar la orden ${s.order_id} (cobro ${s.cobro_id}): ${(e as Error).message}`)
      }
    }
    if (ordenes < LOTE) break
  }

  if (pagados || canceladas) {
    logger.info(`redpagos: conciliación — ${pagados} pago(s) recuperado(s), ${canceladas} orden(es) vencida(s) cancelada(s)`)
  }
}

export const config = {
  name: "redpagos-conciliar",
  schedule: "*/15 * * * *",
}
