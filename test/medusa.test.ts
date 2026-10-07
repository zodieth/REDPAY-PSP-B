// De punta a punta: API HTTP real + el provider de Medusa ya compilado
// (packages/medusa-payment-redpagos, `npm run build` antes).
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { serve, type ServerType } from "@hono/node-server";
import { db, fila } from "@redpagos/db";
import * as core from "@redpagos/core";
import { app } from "../apps/api/src/app.ts";
import { comercio, cvus, deposito, levantarDb } from "../packages/core/test/db.ts";

const require = createRequire(import.meta.url);
const { default: Provider } = require("../packages/medusa-payment-redpagos/.medusa/server/src/providers/redpagos/service.js");

let bajar: () => Promise<void>;
let server: ServerType;
let url: string;

before(async () => {
  bajar = await levantarDb();
  process.env.ADMIN_API_KEY = "admin-test";
  server = serve({ fetch: app.fetch, port: 0 });
  await new Promise((r) => server.once("listening", r));
  url = `http://localhost:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  server.close();
  await bajar();
});

const silencio = { warn() {}, error() {}, info() {} };

test("API: sin API key responde 401 y el backoffice exige x-admin-key", async () => {
  assert.equal((await fetch(`${url}/v1/cobros`)).status, 401);
  assert.equal((await fetch(`${url}/admin/pool`)).status, 401);
  const r = await fetch(`${url}/admin/pool`, { headers: { "x-admin-key": "admin-test" } });
  assert.equal(r.status, 200);
});

test("provider de Medusa: sesión, orden en pending_authorization, webhook y captura", async () => {
  const c = await comercio();
  await cvus(2);
  const apiKey = await core.crearApiKey(c.id);
  const hook = await core.crearWebhook(c.id, "https://tienda.test/hooks/payment/redpagos_redpagos");
  const p = new Provider({ logger: silencio }, { apiUrl: url, apiKey, webhookSecret: hook.secreto });

  await assert.rejects(p.initiatePayment({ amount: 10, currency_code: "usd", data: {} }), /ARS/);

  // Elegir el medio de pago: borrador, sin CVU.
  const ini = await p.initiatePayment({
    amount: 15000.5, currency_code: "ars", data: { session_id: "payses_1" }, context: { idempotency_key: "payses_1" },
  });
  assert.equal(ini.status, "pending");
  assert.equal(ini.data.importe, 15000.5);
  assert.equal(ini.data.transferir_a, null);

  // Cambió el carrito.
  const upd = await p.updatePayment({ amount: 20000, currency_code: "ars", data: ini.data });
  assert.equal(upd.data.importe, 20000);

  // Completar el carrito: bloquea el CVU, la orden se crea esperando la transferencia.
  const aut = await p.authorizePayment({ data: upd.data });
  assert.equal(aut.status, "pending_authorization");
  assert.match(aut.data.transferir_a.cvu, /^\d{22}$/);
  await assert.rejects(p.capturePayment({ data: aut.data }), /todavía no fue pagado/);

  // Entra la transferencia.
  const { cvu_id } = (await fila<{ cvu_id: number }>(db(), "SELECT cvu_id FROM cobros WHERE id = $1", [aut.data.cobro_id]))!;
  await core.registrarDepositos(cvu_id, [deposito(20000)]);
  const { payload } = (await fila<{ payload: string }>(db(), "SELECT payload FROM entregas WHERE evento = 'cobro.pagado'"))!;

  // El webhook firmado le dice a Medusa que autorice la sesión...
  const wh = await p.getWebhookActionAndData({
    data: JSON.parse(payload), rawData: Buffer.from(payload), headers: { "x-redpagos-firma": core.firmar(hook.secreto, payload) },
  });
  assert.equal(wh.action, "authorized");
  assert.equal(wh.data.session_id, "payses_1");
  assert.equal(wh.data.amount.numeric, 20000);

  // ...con firma inválida o vieja, se ignora.
  for (const firma of [core.firmar("otro", payload), core.firmar(hook.secreto, payload, Math.floor(Date.now() / 1000) - 3600)]) {
    const r = await p.getWebhookActionAndData({ data: JSON.parse(payload), rawData: payload, headers: { "x-redpagos-firma": firma } });
    assert.equal(r.action, "not_supported");
  }

  // Medusa vuelve a autorizar: ahora devuelve captured y la captura pasa.
  const aut2 = await p.authorizePayment({ data: aut.data });
  assert.equal(aut2.status, "captured");
  await p.capturePayment({ data: aut2.data });
  assert.equal((await p.getPaymentStatus({ data: aut2.data })).status, "captured");

  await assert.rejects(p.cancelPayment({ data: aut2.data }), /ya fue pagado/);
  await p.deletePayment({ data: aut2.data }); // no falla con un cobro pagado
  await assert.rejects(p.refundPayment({ amount: 1, data: aut2.data }), /no admite devoluciones/);
});

test("provider de Medusa: borrar la sesión cancela el cobro y el pool agotado falla al confirmar", async () => {
  await db().query("TRUNCATE entregas, webhooks, movimientos, retiros, depositos, cobros, cvus, api_keys, comercios RESTART IDENTITY CASCADE");
  const c = await comercio();
  await cvus(1);
  const p = new Provider({ logger: silencio }, { apiUrl: url, apiKey: await core.crearApiKey(c.id), webhookSecret: "whsec_x" });

  const a = await p.initiatePayment({ amount: 100, currency_code: "ARS", data: { session_id: "s_a" } });
  await p.deletePayment({ data: a.data });
  assert.equal((await core.obtenerCobro(c.id, a.data.cobro_id)).estado, "cancelado");

  const b = await p.initiatePayment({ amount: 100, currency_code: "ars", data: { session_id: "s_b" } });
  const d = await p.initiatePayment({ amount: 100, currency_code: "ars", data: { session_id: "s_d" } });
  await p.authorizePayment({ data: b.data });
  await assert.rejects(p.authorizePayment({ data: d.data }), /No hay CVU disponibles/);
});
