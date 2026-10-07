import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { db, fila } from "@redpagos/db";
import * as core from "../src/index.ts";
import { comercio, cvus, deposito, levantarDb, limpiar } from "./db.ts";

let bajar: () => Promise<void>;
before(async () => { bajar = await levantarDb(); });
after(async () => { await bajar(); });
beforeEach(limpiar);

const cvuDe = async (cobroId: string) =>
  (await fila<{ cvu_id: number }>(db(), "SELECT cvu_id FROM cobros WHERE id = $1", [cobroId]))!.cvu_id;

async function cobrar(c: core.Comercio, pesos: number) {
  const cobro = await core.crearCobro(c, { importe: pesos * 100 });
  await core.registrarDepositos(await cvuDe(cobro.id), [deposito(pesos)]);
}

describe("comisión por comercio", () => {
  test("cambiarla afecta sólo a los depósitos nuevos y queda auditada", async () => {
    const c = await comercio();
    await cvus(2);
    await cobrar(c, 1_000); // 6 %
    const cambiado = await core.actualizarComercio(c.id, { comision_pb: 450 }, "ana@redpagos.com");
    await cobrar(cambiado, 1_000); // 4,5 %

    const comisiones = (await core.listarMovimientos(c.id)).filter((m) => m.tipo === "comision").map((m) => m.importe);
    assert.deepEqual(comisiones, [-45_00, -60_00]);
    assert.equal(await core.saldo(c.id), 2_000_00 - 105_00);

    const [cambio] = await core.listarAuditoria(c.id);
    assert.equal(cambio.actor, "ana@redpagos.com");
    assert.equal(cambio.accion, "comercio.actualizado");
    assert.deepEqual(cambio.antes, { comision_pb: 600 });
    assert.deepEqual(cambio.despues, { comision_pb: 450 });
  });

  test("valida rango y no audita si no cambia nada", async () => {
    const c = await comercio();
    await assert.rejects(core.actualizarComercio(c.id, { comision_pb: 10_001 }), { codigo: "comision_invalida" });
    await assert.rejects(core.actualizarComercio(c.id, { comision_pb: 5.5 }), { codigo: "comision_invalida" });
    await assert.rejects(core.actualizarComercio(c.id, { bloqueo_horas: 0 }), { codigo: "plazo_invalido" });
    await core.actualizarComercio(c.id, { comision_pb: 600 });
    assert.deepEqual((await core.listarAuditoria(c.id)).map((a) => a.accion), ["comercio.creado"]);
  });

  test("los ajustes de saldo quedan auditados", async () => {
    const c = await comercio();
    await core.registrarAjuste(c.id, -500, "Diferencia de caja", "ana@redpagos.com");
    assert.equal(await core.saldo(c.id), -500);
    const [a] = await core.listarAuditoria(c.id);
    assert.equal(a.accion, "saldo.ajuste");
    assert.deepEqual(a.despues, { importe: -500, descripcion: "Diferencia de caja" });
  });
});

describe("usuarios", () => {
  test("login con email y clave; comercio inactivo o usuario desactivado no entra", async () => {
    const c = await comercio();
    const u = await core.crearUsuario({ email: " Juan@Tienda.com ", clave: "una-clave-larga", rol: "comercio", comercio_id: c.id });
    assert.equal(u.email, "juan@tienda.com");
    assert.equal(await core.verificarLogin("juan@tienda.com", "otra-clave-xx"), null);
    assert.equal((await core.verificarLogin("JUAN@tienda.com", "una-clave-larga"))?.comercio_id, c.id);

    await core.actualizarComercio(c.id, { activo: false });
    assert.equal(await core.verificarLogin("juan@tienda.com", "una-clave-larga"), null);
    await core.actualizarComercio(c.id, { activo: true });
    await core.activarUsuario(u.id, false);
    assert.equal(await core.verificarLogin("juan@tienda.com", "una-clave-larga"), null);
  });

  test("email único, clave mínima y admin sembrado desde el entorno una sola vez", async () => {
    await assert.rejects(core.crearUsuario({ email: "a@b.c", clave: "corta", rol: "admin" }), { codigo: "clave_corta" });
    await core.crearUsuario({ email: "a@b.c", clave: "suficiente", rol: "admin" });
    await assert.rejects(core.crearUsuario({ email: "A@b.c", clave: "suficiente", rol: "admin" }), { codigo: "email_duplicado" });

    await limpiar();
    process.env.ADMIN_EMAIL = "admin@redpagos.com";
    process.env.ADMIN_PASSWORD = "clave-admin-123";
    await core.sembrarAdmin();
    await core.sembrarAdmin();
    assert.equal((await core.listarUsuarios({ rol: "admin" })).length, 1);
    assert.ok(await core.verificarLogin("admin@redpagos.com", "clave-admin-123"));
  });
});

describe("reportes", () => {
  test("resumen general y comercios con saldo", async () => {
    const a = await comercio({ nombre: "A" });
    const b = await comercio({ nombre: "B", comision_pb: 500 });
    await cvus(3);
    await cobrar(a, 1_000);
    await cobrar(b, 2_000);
    await core.crearCobro(a, { importe: 100_00 });

    const r = await core.resumenGeneral();
    assert.equal(r.bruto_hoy, 3_000_00);
    assert.equal(r.comision_hoy, 60_00 + 100_00);
    assert.equal(r.cobros_abiertos, 1);
    assert.equal(r.saldo_total, 3_000_00 - 160_00);

    const filas = await core.comerciosConSaldo();
    assert.deepEqual(filas.map((f) => [f.nombre, f.saldo, f.cobros_abiertos]), [["A", 940_00, 1], ["B", 1_900_00, 0]]);
    assert.deepEqual(await core.totalesComercio(b.id), { bruto: 2_000_00, comision: 100_00, retirado: 0, cobros_pagados: 1 });
  });
});
