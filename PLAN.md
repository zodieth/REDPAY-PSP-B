# RedPagos — plan

Pasarela de pagos por transferencia a CVU/alias, estilo Pago Nube, con integración a Medusa v2.

## Modelo

| Concepto | Qué es |
|---|---|
| **Comercio** | Cliente de RedPagos. Tiene cuenta corriente (saldo), API keys y webhooks. |
| **Pool de CVU** | Cuentas recaudadoras de cargavirtual de RedPagos. Cada una tiene su CVU/alias. No hay cuenta maestra: cada CVU es un login aparte. |
| **Cobro** | Un pago esperado. Al confirmarse la orden **bloquea un CVU exclusivo por 5 días**. Todo lo que entra a ese CVU es de ese cobro. |
| **Comisión** | 6 % sobre el bruto de cada depósito, sin IVA aparte. Configurable por comercio (`comision_pb`). |
| **Retiro** | El comercio retira efectivo en las oficinas. Sin día fijo: se coordina y el backoffice lo registra al entregar. |

Decisiones cerradas: no hay devoluciones, no hay plazo de disponibilidad (lo acreditado se puede retirar en el momento) y los alias no son personalizables.

## Ciclo de vida

```
CVU:   libre ──asignar──► asignado ──pagado / vencido / cancelado──► cuarentena ──► libre
Cobro: borrador ──asignar──► pendiente ──► (parcial) ──► pagado
                                       └──► vencido (5 días) | cancelado
```

- **Asignación LRU:** el CVU libre que hace más tiempo que no se usa, con `FOR UPDATE SKIP LOCKED`. Dos órdenes nunca se llevan el mismo.
- **Cuarentena:** 48 h si se pagó y 7 días si venció o se canceló. Es obligatoria porque el comprador puede agendar el alias y reusarlo. Un pago que entra durante la cuarentena estira la cuarentena.
- **Pago parcial:** el CVU sigue bloqueado hasta completar o vencer.
- **Pago de más:** el cobro queda pagado y el excedente va al saldo, con el evento `cobro.excedente`.
- **Pago tardío** (CVU en cuarentena): va al saldo del comercio y se avisa con `cobro.pago_tardio`. Lo resuelve el comercio.
- **Huérfano:** depósito a un CVU libre, o fechado antes de la asignación. Se imputa a mano desde el backoffice.
- La primera lectura de cada cuenta se guarda como **histórico**: no se imputa, y hasta entonces el CVU no se asigna.

## Dimensionamiento

CVUs ≈ órdenes/día × (días bloqueado + días de cuarentena), ponderado por cuántas se pagan:

| Supuesto (100 órdenes/día, 30 % abandono) | CVU-días por orden | Cuentas |
|---|---|---|
| 5 días, cuarentena 2/7 (configuración inicial) | 0,7×3 + 0,3×12 = 5,7 | **~570 (~700 con margen)** |
| 5 días, cuarentena 1/3 | 3,8 | ~380 |
| 48 h, cuarentena 1/3 | 2,9 | ~290 |

Plazo y cuarentenas se configuran por comercio (`bloqueo_horas`, `cuarentena_pagado_horas`, `cuarentena_vencido_horas`). Conviene medir el abandono real las primeras semanas.

- **Pool agotado:** la API devuelve `503 pool_agotado` y en Medusa falla la confirmación con "medio de pago no disponible". El worker avisa al llegar al 80 % de ocupación.
- **Polling por prioridad:**

  | Estado del CVU | Frecuencia |
  |---|---|
  | Asignado | Cada 60 s |
  | En cuarentena | Cada 10 min |
  | Libre | Cada hora |

  Con unos 220 CVU asignados son ~4 consultas por segundo a través del proxy argentino.

## Medusa (`@redpagos/medusa-payment`)

Flujo "orden primero", con el estado `pending_authorization` que Medusa ≥ 2.21 trae para pagos diferidos:

1. **Elegir el medio de pago** (`initiatePayment`): se crea un cobro en borrador, sin CVU.
2. **Completar el carrito** (`authorizePayment`): se bloquea el CVU y se devuelve `pending_authorization`. Medusa crea la orden sin pago. El storefront muestra CVU, alias, importe y vencimiento desde `payment_session.data`.
3. **Entra la transferencia:** RedPagos manda el webhook `cobro.pagado` a `/hooks/payment/redpagos_redpagos`. El provider responde `authorized`, Medusa vuelve a llamar `authorizePayment`, recibe `captured` y la orden queda pagada.
4. **Job cada 15 min:** si se perdió un webhook de pago, autoriza la orden. Si el cobro venció, cancela la orden y libera el stock.
5. **Subscriber `order.canceled`:** cancela el cobro para no dejar el CVU bloqueado.
6. `refundPayment` falla: no hay devoluciones.

## Etapas

1. ✅ **Núcleo:**
   - Pool, cobros, imputación, libro con comisión, webhooks firmados.
   - API para comercios y backoffice.
   - Worker con poller por prioridad, vencimientos, cuarentenas y cola de webhooks.
2. ✅ **Plugin de Medusa:** provider, job de conciliación, subscriber.
   - Falta probarlo en una tienda Medusa real.
3. ⬜ **Paneles:**
   - Comercio: cobros, saldo, movimientos.
   - Backoffice: alta de CVUs, ocupación del pool, huérfanos, registrar retiros. Hoy esto se hace por la API de `/admin`.
4. ⬜ **Link de pago / checkout alojado** para comercios sin Medusa: página con CVU, alias, QR y cuenta regresiva.
5. ⬜ **Producción:**
   - Deploy de API y worker, Postgres con backups, proxy con IP argentina fija.
   - Alertas del pool por mail o WhatsApp, no solo en el log.
   - Carga masiva de CVUs.

## Riesgos abiertos

- **Escala del polling:** cientos de logins a cargavirtual por un proxy. Hay que medir los límites reales de cargavirtual antes de pasar los ~200 CVU activos.
- **Cuentas inválidas:** si una cuenta cambia la clave o la dan de baja, sus depósitos no se leen. Cada error queda en `cvus.ultimo_error` y hay que mirarlo en el backoffice.
- **Pagos tardíos tras la cuarentena:** con alias no personalizables el riesgo no es cero. Por eso la cuarentena es larga para lo vencido y se estira con cada pago tardío.
