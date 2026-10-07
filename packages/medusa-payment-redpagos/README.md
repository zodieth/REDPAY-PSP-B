# @redpagos/medusa-payment

Provider de pagos de Medusa v2 (≥ 2.21) para cobrar por transferencia a CVU/alias con redpagos.

## Cómo funciona

1. El comprador elige "Transferencia" y se crea un cobro en redpagos, todavía sin CVU.
2. Confirma la orden: redpagos le bloquea un CVU exclusivo por 5 días. La orden se crea en `pending_authorization`, con el stock reservado.
3. El comprador transfiere. redpagos detecta el depósito y avisa por webhook, y la orden queda **pagada y capturada**.
4. Si vence sin pago, un job cancela la orden. Si se cancela la orden, se cancela el cobro y se libera el CVU.

No hay devoluciones: `refundPayment` falla siempre.

## Instalación

```bash
npm install @redpagos/medusa-payment
```

`medusa-config.ts`:

```ts
module.exports = defineConfig({
  // ...
  plugins: [{ resolve: "@redpagos/medusa-payment", options: {} }],
  modules: [
    {
      resolve: "@medusajs/medusa/payment",
      options: {
        providers: [
          {
            resolve: "@redpagos/medusa-payment/providers/redpagos",
            id: "redpagos",
            options: {
              apiUrl: process.env.REDPAGOS_API_URL,
              apiKey: process.env.REDPAGOS_API_KEY,
              webhookSecret: process.env.REDPAGOS_WEBHOOK_SECRET,
            },
          },
        ],
      },
    },
  ],
})
```

El plugin se registra en `plugins` para que Medusa cargue el job de conciliación y el subscriber. Esos dos leen la configuración de las variables `REDPAGOS_API_URL` y `REDPAGOS_API_KEY`, así que tienen que estar definidas aunque las opciones del provider se pasen a mano.

Pasos siguientes:

1. Habilitar el provider `pp_redpagos_redpagos` en la región (Admin → Settings → Regions). La moneda tiene que ser **ARS**.
2. Crear el webhook en redpagos apuntando a la tienda y guardar el `secreto` que devuelve en `REDPAGOS_WEBHOOK_SECRET`:

```bash
curl -X POST $REDPAGOS_API_URL/v1/webhooks -H "authorization: Bearer $REDPAGOS_API_KEY" \
  -H "content-type: application/json" -d '{"url":"https://mi-tienda.com/hooks/payment/redpagos_redpagos"}'
```

## Storefront

Después de completar el carrito, la orden trae los datos para transferir en la sesión de pago:

```ts
const sesion = order.payment_collections[0].payment_sessions.find((s) => s.provider_id === "pp_redpagos_redpagos")
const { transferir_a, importe, vence_at, estado } = sesion.data
// transferir_a = { cvu, alias, titular }; importe en pesos
```

Conviene mostrar con claridad que **ese CVU/alias es sólo para esta orden**, el importe exacto y el vencimiento. Para saber si ya se pagó, consultá la orden hasta que su `payment_status` sea `captured`.

## Desarrollo

```bash
npm install
npm run build      # medusa plugin:build -> .medusa/server
```
