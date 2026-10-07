# RedPagos

Pasarela de pagos por transferencia a CVU/alias. Cada orden bloquea un CVU exclusivo del pool por 5 días. Los depósitos se leen de cargavirtual, se imputan solos y se acreditan al comercio menos el 6 %. El diseño completo está en [PLAN.md](PLAN.md).

```
apps/api        API HTTP (Hono): /v1 para comercios, /admin para backoffice
apps/worker     poller de cargavirtual, vencimientos, cuarentenas, webhooks
packages/db     Postgres + migraciones
packages/core   lógica: pool, cobros, imputación, libro, webhooks
packages/cargavirtual   cliente de cargavirtual (scraping, viene de pagoscvu)
packages/medusa-payment-redpagos   plugin de Medusa v2 (se publica aparte)
```

## Correr

Necesita Node 24 (corre TypeScript directo, sin build) y Postgres.

```bash
cp .env.example .env      # completar CLAVE_CIFRADO y ADMIN_API_KEY
docker compose up -d      # Postgres en el 5433
npm install
npm run api               # aplica migraciones y escucha en :3000
npm run worker            # en otra terminal
```

`npm test` levanta un Postgres embebido (o usa `TEST_DATABASE_URL`) y prueba el núcleo, la API y el plugin de Medusa compilado. Antes de correrlo hay que compilar el plugin: `cd packages/medusa-payment-redpagos && npm install && npm run build`.

## Puesta en marcha (backoffice)

Todas las rutas `/admin` piden el header `x-admin-key: <ADMIN_API_KEY>`.

```bash
# 1. Cargar las cuentas recaudadoras al pool
curl -X POST localhost:3000/admin/cvus -H "x-admin-key: $K" -H "content-type: application/json" \
  -d '{"usuario":"...","clave":"...","pv":"150514","cvu":"0000...22 dígitos","alias":"..."}'

# 2. Dar de alta un comercio y su API key (se muestra una sola vez)
curl -X POST localhost:3000/admin/comercios -H "x-admin-key: $K" -H "content-type: application/json" -d '{"nombre":"Mi Tienda"}'
curl -X POST localhost:3000/admin/comercios/<id>/api-keys -H "x-admin-key: $K"
```

El worker lee cada CVU nuevo una vez (como histórico) antes de que se pueda asignar.

| Método | Ruta | Qué hace |
|---|---|---|
| GET | `/admin/pool` | Libres, asignados, en cuarentena y % de ocupación |
| GET / POST | `/admin/cvus` | Listar (`?estado=`) / agregar una cuenta |
| PATCH | `/admin/cvus/:id` | `{clave?, alias?, titular?, habilitado?}` |
| GET / POST / PATCH | `/admin/comercios[/:id]` | Alta y configuración (`comision_pb`, `bloqueo_horas`, cuarentenas) |
| POST / DELETE | `/admin/comercios/:id/api-keys[/:prefijo]` | Crear / revocar API key |
| GET | `/admin/comercios/:id/saldo` · `/movimientos` · `/retiros` | Cuenta corriente |
| POST | `/admin/comercios/:id/retiros` | `{importe, entregado_por, recibido_por, comprobante?, notas?}`: registra la entrega del efectivo |
| POST | `/admin/comercios/:id/ajustes` | `{importe, descripcion}`: corrección manual (±) |
| GET | `/admin/depositos/huerfanos` | Depósitos sin cobro |
| POST | `/admin/depositos/:id/imputar` | `{cobro_id}` |

## API para comercios

`Authorization: Bearer rp_...`. **Los importes van en centavos.**

| Método | Ruta | Qué hace |
|---|---|---|
| POST | `/v1/cobros` | `{importe, referencia?, metadata?, asignar?}` + header `Idempotency-Key`. Con `asignar: false` queda en borrador sin CVU |
| GET | `/v1/cobros` | `?estado=&referencia=&limite=` |
| GET | `/v1/cobros/:id` | El cobro con `transferir_a: {cvu, alias, titular}` y `vence_at` |
| PATCH | `/v1/cobros/:id` | `{importe}`, sólo en borrador |
| POST | `/v1/cobros/:id/asignar` | Bloquea el CVU (idempotente). `503 pool_agotado` si no hay |
| POST | `/v1/cobros/:id/cancelar` | Libera el CVU (a cuarentena). `409` si ya está pagado |
| GET | `/v1/saldo` · `/v1/movimientos` · `/v1/retiros` | Cuenta corriente |
| GET / POST / PATCH | `/v1/webhooks[/:id]` | Crear devuelve el `secreto` |
| POST | `/v1/webhooks/:id/ping` | Evento de prueba |
| GET / POST | `/v1/entregas` · `/v1/entregas/:id/reintentar` | Historial y reintento de webhooks |

## Webhooks

Eventos:
- `cobro.pagado`
- `cobro.parcial` (con `falta`)
- `cobro.excedente` (con `excedente`)
- `cobro.vencido`
- `cobro.cancelado`
- `cobro.pago_tardio`
- `ping`

```json
{ "id": "<id de entrega>", "evento": "cobro.pagado", "creado": "…",
  "data": { "cobro": { "id": "…", "estado": "pagado", "importe": 2000000, "recibido": 2000000, "transferir_a": {…}, "metadata": {…} },
            "deposito": { "id": "…", "importe": 2000000, "fecha_deposito": "…", "nro_transaccion": "…" },
            "comision": 120000 } }
```

Headers: `x-redpagos-evento`, `x-redpagos-entrega` y `x-redpagos-firma: t=<unix>,v1=<hex>`. La firma es `v1 = HMAC-SHA256(secreto, t + "." + body_crudo)`. Hay que responder 2xx en menos de 10 s. Si no, se reintenta a los 30 s, 2 min, 10 min, 30 min, 1 h, 3 h y 6 h. Un evento puede llegar dos veces: deduplicá por `id`.
