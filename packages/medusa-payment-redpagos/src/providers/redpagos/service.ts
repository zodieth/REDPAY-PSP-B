import {
  AbstractPaymentProvider,
  BigNumber,
  MedusaError,
  PaymentActions,
  PaymentSessionStatus,
} from "@medusajs/framework/utils"
import type {
  AuthorizePaymentInput,
  AuthorizePaymentOutput,
  CancelPaymentInput,
  CancelPaymentOutput,
  CapturePaymentInput,
  CapturePaymentOutput,
  DeletePaymentInput,
  DeletePaymentOutput,
  GetPaymentStatusInput,
  GetPaymentStatusOutput,
  InitiatePaymentInput,
  InitiatePaymentOutput,
  Logger,
  ProviderWebhookPayload,
  RefundPaymentInput,
  RefundPaymentOutput,
  RetrievePaymentInput,
  RetrievePaymentOutput,
  UpdatePaymentInput,
  UpdatePaymentOutput,
  WebhookActionResult,
} from "@medusajs/framework/types"
import {
  aCentavos,
  aPesos,
  clienteRedpagos,
  ErrorApiRedpagos,
  firmaValida,
  opciones,
  type ClienteRedpagos,
  type Cobro,
  type EstadoCobro,
  type OpcionesRedpagos,
} from "../../lib/redpagos"

type Dependencias = { logger: Logger }

// Estado de la sesión de Medusa según el estado del cobro en RedPagos.
// pendiente/parcial = pending_authorization: Medusa crea la orden sin esperar el
// pago, y cuando entra la transferencia el webhook la autoriza y captura.
const ESTADO_SESION: Record<EstadoCobro, PaymentSessionStatus> = {
  borrador: PaymentSessionStatus.PENDING,
  pendiente: PaymentSessionStatus.PENDING_AUTHORIZATION,
  parcial: PaymentSessionStatus.PENDING_AUTHORIZATION,
  pagado: PaymentSessionStatus.CAPTURED,
  vencido: PaymentSessionStatus.CANCELED,
  cancelado: PaymentSessionStatus.CANCELED,
}

// Lo que queda guardado en payment_session.data (y lo que lee el storefront para
// mostrar a dónde transferir).
const datos = (c: Cobro, sessionId?: unknown) => ({
  cobro_id: c.id,
  session_id: sessionId ?? c.metadata?.session_id,
  estado: c.estado,
  importe: aPesos(c.importe),
  recibido: aPesos(c.recibido),
  transferir_a: c.transferir_a,
  vence_at: c.vence_at,
  pagado_at: c.pagado_at,
})

class RedpagosProviderService extends AbstractPaymentProvider<OpcionesRedpagos> {
  static identifier = "redpagos"

  protected logger_: Logger
  protected api_: ClienteRedpagos
  protected webhookSecret_: string

  static validateOptions(o: Record<string, unknown>) {
    const { apiUrl, apiKey, webhookSecret } = opciones(o as OpcionesRedpagos)
    if (!apiUrl) throw new MedusaError(MedusaError.Types.INVALID_DATA, "RedPagos: falta apiUrl (o REDPAGOS_API_URL)")
    if (!apiKey) throw new MedusaError(MedusaError.Types.INVALID_DATA, "RedPagos: falta apiKey (o REDPAGOS_API_KEY)")
    if (!webhookSecret) throw new MedusaError(MedusaError.Types.INVALID_DATA, "RedPagos: falta webhookSecret (o REDPAGOS_WEBHOOK_SECRET)")
  }

  constructor(container: Dependencias, options: OpcionesRedpagos) {
    super(container, options)
    this.logger_ = container.logger
    this.api_ = clienteRedpagos(options)
    this.webhookSecret_ = opciones(options).webhookSecret
  }

  private cobroId(data?: Record<string, unknown>) {
    const id = data?.cobro_id
    if (typeof id !== "string") throw new MedusaError(MedusaError.Types.INVALID_DATA, "La sesión no tiene cobro_id de RedPagos")
    return id
  }

  // Traduce errores de la API a errores de Medusa.
  private async llamar<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (e) {
      if (e instanceof ErrorApiRedpagos) {
        const tipo = e.status === 404 ? MedusaError.Types.NOT_FOUND
          : e.status === 409 ? MedusaError.Types.NOT_ALLOWED
          : e.status === 400 ? MedusaError.Types.INVALID_DATA
          : MedusaError.Types.UNEXPECTED_STATE
        throw new MedusaError(tipo, `RedPagos: ${e.message}`, e.codigo)
      }
      throw e
    }
  }

  // Se llama al elegir el medio de pago. Crea el cobro en borrador, sin CVU:
  // el CVU se bloquea recién al confirmar la orden (authorizePayment).
  async initiatePayment({ amount, currency_code, data, context }: InitiatePaymentInput): Promise<InitiatePaymentOutput> {
    if (currency_code.toLowerCase() !== "ars") {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, "RedPagos sólo cobra en pesos (ARS)")
    }
    const sessionId = data?.session_id
    const cobro = await this.llamar(() => this.api_.crear(
      {
        importe: aCentavos(new BigNumber(amount).numeric),
        referencia: typeof sessionId === "string" ? sessionId : undefined,
        metadata: { session_id: sessionId, origen: "medusa" },
        asignar: false,
      },
      context?.idempotency_key,
    ))
    return { id: cobro.id, data: datos(cobro, sessionId), status: ESTADO_SESION[cobro.estado] }
  }

  async updatePayment({ amount, currency_code, data }: UpdatePaymentInput): Promise<UpdatePaymentOutput> {
    if (currency_code.toLowerCase() !== "ars") {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, "RedPagos sólo cobra en pesos (ARS)")
    }
    const cobro = await this.llamar(() => this.api_.actualizar(this.cobroId(data), aCentavos(new BigNumber(amount).numeric)))
    return { data: datos(cobro, data?.session_id), status: ESTADO_SESION[cobro.estado] }
  }

  // Al completar el carrito: bloquea un CVU por 5 días y la orden se crea en
  // pending_authorization. También lo llama el webhook cuando entra el pago:
  // ahí el cobro ya está pagado y devolvemos captured.
  async authorizePayment({ data }: AuthorizePaymentInput): Promise<AuthorizePaymentOutput> {
    const cobro = await this.llamar(() => this.api_.asignar(this.cobroId(data)))
    return { data: datos(cobro, data?.session_id), status: ESTADO_SESION[cobro.estado] }
  }

  // La plata ya entró: sólo se confirma que el cobro esté pagado.
  async capturePayment({ data }: CapturePaymentInput): Promise<CapturePaymentOutput> {
    const cobro = await this.llamar(() => this.api_.obtener(this.cobroId(data)))
    if (cobro.estado !== "pagado") {
      throw new MedusaError(MedusaError.Types.NOT_ALLOWED, "RedPagos: el cobro todavía no fue pagado; se captura solo cuando entra la transferencia")
    }
    return { data: datos(cobro, data?.session_id) }
  }

  // Cancelar libera el CVU (pasa a cuarentena). Un cobro pagado no se cancela.
  async cancelPayment({ data }: CancelPaymentInput): Promise<CancelPaymentOutput> {
    const cobro = await this.llamar(() => this.api_.cancelar(this.cobroId(data)))
    return { data: datos(cobro, data?.session_id) }
  }

  // Medusa borra sesiones al cambiar de medio de pago o recrear la colección.
  async deletePayment({ data }: DeletePaymentInput): Promise<DeletePaymentOutput> {
    if (typeof data?.cobro_id !== "string") return { data }
    try {
      const cobro = await this.api_.cancelar(data.cobro_id)
      return { data: datos(cobro, data.session_id) }
    } catch (e) {
      if (e instanceof ErrorApiRedpagos && (e.status === 404 || e.codigo === "cobro_pagado")) return { data }
      throw e
    }
  }

  async getPaymentStatus({ data }: GetPaymentStatusInput): Promise<GetPaymentStatusOutput> {
    const cobro = await this.llamar(() => this.api_.obtener(this.cobroId(data)))
    return { data: datos(cobro, data?.session_id), status: ESTADO_SESION[cobro.estado] }
  }

  async retrievePayment({ data }: RetrievePaymentInput): Promise<RetrievePaymentOutput> {
    const cobro = await this.llamar(() => this.api_.obtener(this.cobroId(data)))
    return { data: datos(cobro, data?.session_id) }
  }

  async refundPayment(_: RefundPaymentInput): Promise<RefundPaymentOutput> {
    throw new MedusaError(MedusaError.Types.NOT_ALLOWED, "RedPagos no admite devoluciones")
  }

  // POST /hooks/payment/redpagos_redpagos
  // cobro.pagado -> "authorized": Medusa vuelve a llamar authorizePayment, que
  // devuelve captured, y eso crea el pago ya capturado en la orden existente.
  async getWebhookActionAndData({ data, rawData, headers }: ProviderWebhookPayload["payload"]): Promise<WebhookActionResult> {
    if (!firmaValida(this.webhookSecret_, rawData, headers["x-redpagos-firma"])) {
      this.logger_.warn("RedPagos: webhook con firma inválida, se ignora")
      return { action: PaymentActions.NOT_SUPPORTED }
    }
    const evento = data.evento as string
    const cobro = (data.data as { cobro?: Cobro } | undefined)?.cobro
    const sessionId = cobro?.metadata?.session_id
    if (evento !== "cobro.pagado" || !cobro || typeof sessionId !== "string") {
      return { action: PaymentActions.NOT_SUPPORTED }
    }
    return {
      action: PaymentActions.AUTHORIZED,
      data: { session_id: sessionId, amount: new BigNumber(aPesos(cobro.importe)) },
    }
  }
}

export default RedpagosProviderService
