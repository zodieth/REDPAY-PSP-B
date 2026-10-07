import { timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import * as core from "@redpagos/core";
import { ErrorRedpagos, type Comercio } from "@redpagos/core";

type Vars = { Variables: { comercio: Comercio } };

const cuerpo = async <T>(c: Context) => {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new ErrorRedpagos("json_invalido", "El cuerpo tiene que ser JSON");
  }
};

const numero = (s: string | undefined) => (s === undefined ? undefined : Number(s));

export const app = new Hono();

app.onError((e, c) => {
  if (e instanceof ErrorRedpagos) {
    return c.json({ error: { codigo: e.codigo, mensaje: e.message } }, e.status as 400);
  }
  console.error(e);
  return c.json({ error: { codigo: "error_interno", mensaje: "Error interno" } }, 500);
});

app.get("/health", (c) => c.json({ ok: true }));

// ---------------------------------------------------------------- comercios
// Authorization: Bearer rp_...
const v1 = new Hono<Vars>();

v1.use(async (c, next) => {
  const clave = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
  const comercio = clave ? await core.autenticar(clave) : null;
  if (!comercio) throw new ErrorRedpagos("no_autorizado", "API key inválida", 401);
  c.set("comercio", comercio);
  await next();
});

v1.post("/cobros", async (c) => {
  const b = await cuerpo<core.NuevoCobro>(c);
  const cobro = await core.crearCobro(c.var.comercio, {
    importe: b.importe,
    referencia: b.referencia,
    metadata: b.metadata,
    asignar: b.asignar,
    idempotency_key: c.req.header("idempotency-key") ?? b.idempotency_key,
  });
  return c.json(cobro, 201);
});

v1.get("/cobros", async (c) =>
  c.json(await core.listarCobros(c.var.comercio.id, {
    estado: c.req.query("estado"),
    referencia: c.req.query("referencia"),
    limite: numero(c.req.query("limite")),
  })));

v1.get("/cobros/:id", async (c) => c.json(await core.obtenerCobro(c.var.comercio.id, c.req.param("id"))));

v1.patch("/cobros/:id", async (c) => {
  const b = await cuerpo<{ importe: number }>(c);
  return c.json(await core.actualizarImporte(c.var.comercio, c.req.param("id"), b.importe));
});

v1.post("/cobros/:id/asignar", async (c) => c.json(await core.asignarCobro(c.var.comercio, c.req.param("id"))));
v1.post("/cobros/:id/cancelar", async (c) => c.json(await core.cancelarCobro(c.var.comercio, c.req.param("id"))));

v1.get("/saldo", async (c) => c.json({ saldo: await core.saldo(c.var.comercio.id), moneda: "ARS" }));
v1.get("/movimientos", async (c) =>
  c.json(await core.listarMovimientos(c.var.comercio.id, {
    antes_de: numero(c.req.query("antes_de")),
    limite: numero(c.req.query("limite")),
  })));
v1.get("/retiros", async (c) => c.json(await core.listarRetiros(c.var.comercio.id)));

v1.get("/webhooks", async (c) => c.json(await core.listarWebhooks(c.var.comercio.id)));
v1.post("/webhooks", async (c) => {
  const b = await cuerpo<{ url: string }>(c);
  return c.json(await core.crearWebhook(c.var.comercio.id, b.url), 201);
});
v1.patch("/webhooks/:id", async (c) => {
  const b = await cuerpo<{ url?: string; activo?: boolean }>(c);
  return c.json(await core.actualizarWebhook(c.var.comercio.id, c.req.param("id"), b));
});
v1.post("/webhooks/:id/ping", async (c) => c.json({ entrega: await core.enviarPing(c.var.comercio.id, c.req.param("id")) }));
v1.get("/entregas", async (c) => c.json(await core.listarEntregas(c.var.comercio.id, c.req.query("estado"))));
v1.post("/entregas/:id/reintentar", async (c) => {
  await core.reintentarEntrega(c.var.comercio.id, c.req.param("id"));
  return c.json({ ok: true });
});

app.route("/v1", v1);

// ---------------------------------------------------------------- backoffice
// x-admin-key: ADMIN_API_KEY
const admin = new Hono();

admin.use(async (_c, next) => {
  const esperada = process.env.ADMIN_API_KEY;
  const dada = _c.req.header("x-admin-key") ?? "";
  const ok = !!esperada && dada.length === esperada.length && timingSafeEqual(Buffer.from(dada), Buffer.from(esperada));
  if (!ok) throw new ErrorRedpagos("no_autorizado", "x-admin-key inválida", 401);
  await next();
});

admin.get("/comercios", async (c) => c.json(await core.listarComercios()));
admin.post("/comercios", async (c) => c.json(await core.crearComercio(await cuerpo<core.DatosComercio>(c), "api-admin"), 201));
admin.patch("/comercios/:id", async (c) =>
  c.json(await core.actualizarComercio(c.req.param("id"), await cuerpo<Partial<core.DatosComercio>>(c), "api-admin")));
admin.get("/comercios/:id/auditoria", async (c) => c.json(await core.listarAuditoria(c.req.param("id"))));
admin.post("/comercios/:id/api-keys", async (c) => {
  await core.obtenerComercio(c.req.param("id"));
  return c.json({ api_key: await core.crearApiKey(c.req.param("id")) }, 201);
});
admin.delete("/comercios/:id/api-keys/:prefijo", async (c) => {
  await core.revocarApiKey(c.req.param("id"), c.req.param("prefijo"));
  return c.json({ ok: true });
});
admin.get("/comercios/:id/saldo", async (c) => c.json({ saldo: await core.saldo(c.req.param("id")), moneda: "ARS" }));
admin.get("/comercios/:id/movimientos", async (c) =>
  c.json(await core.listarMovimientos(c.req.param("id"), {
    antes_de: numero(c.req.query("antes_de")),
    limite: numero(c.req.query("limite")),
  })));
admin.get("/comercios/:id/retiros", async (c) => c.json(await core.listarRetiros(c.req.param("id"))));
admin.post("/comercios/:id/retiros", async (c) =>
  c.json(await core.registrarRetiro(c.req.param("id"), await cuerpo<core.NuevoRetiro>(c)), 201));
admin.post("/comercios/:id/ajustes", async (c) => {
  const b = await cuerpo<{ importe: number; descripcion: string }>(c);
  return c.json(await core.registrarAjuste(c.req.param("id"), b.importe, b.descripcion, "api-admin"), 201);
});

admin.get("/pool", async (c) => c.json(await core.estadoPool()));
admin.get("/cvus", async (c) => c.json(await core.listarCvus(c.req.query("estado") as core.EstadoCvu | undefined)));
admin.post("/cvus", async (c) => c.json(await core.agregarCvu(await cuerpo(c)), 201));
admin.patch("/cvus/:id", async (c) => c.json(await core.actualizarCvu(Number(c.req.param("id")), await cuerpo(c))));

admin.get("/depositos/huerfanos", async (c) => c.json(await core.listarHuerfanos()));
admin.post("/depositos/:id/imputar", async (c) => {
  const b = await cuerpo<{ cobro_id: string }>(c);
  return c.json(await core.imputarManual(c.req.param("id"), b.cobro_id));
});

app.route("/admin", admin);
