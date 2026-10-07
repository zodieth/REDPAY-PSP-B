import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { db, fila } from "@redpagos/db";
import * as core from "../src/index.ts";
import { comercio, cvus, deposito, eventos, levantarDb, limpiar } from "./db.ts";

let bajar: () => Promise<void>;
before(async () => { bajar = await levantarDb(); });
after(async () => { await bajar(); });
beforeEach(limpiar);

const estadoCvu = async (id: number) =>
  (await fila<{ estado: string; cobro_id: string | null; horas: number | null }>(db(),
    `SELECT estado, cobro_id, round(extract(epoch FROM cuarentena_hasta - now()) / 3600)::int AS horas FROM cvus WHERE id = $1`, [id]))!;
const cvuDe = async (cobroId: string) =>
  (await fila<{ cvu_id: number }>(db(), "SELECT cvu_id FROM cobros WHERE id = $1", [cobroId]))!.cvu_id;

async function conWebhook() {
  const c = await comercio();
  await core.crearWebhook(c.id, "https://tienda.test/hooks/payment/redpagos_redpagos");
  return c;
}

describe("asignación de CVU", () => {
  test("cada cobro bloquea un CVU distinto, empezando por el que hace más que está libre", async () => {
    const c = await comercio();
    await cvus(3);
    const a = await core.crearCobro(c, { importe: 100_00 });
    const b = await core.crearCobro(c, { importe: 200_00 });
    assert.equal(a.estado, "pendiente");
    assert.equal(a.transferir_a?.cvu, "0".padStart(22, "0"));
    assert.equal(b.transferir_a?.cvu, "1".padStart(22, "0"));
    assert.ok(a.vence_at && Math.abs(a.vence_at.getTime() - Date.now() - 120 * 3600_000) < 60_000, "vence en 5 días");
    assert.equal((await estadoCvu(1)).estado, "asignado");
  });

  test("sin CVU libres devuelve pool_agotado y no deja el cobro creado", async () => {
    const c = await comercio();
    await cvus(1);
    await core.crearCobro(c, { importe: 100_00 });
    await assert.rejects(core.crearCobro(c, { importe: 100_00 }), { codigo: "pool_agotado" });
    assert.equal((await core.listarCobros(c.id)).length, 1);
  });

  test("en paralelo nunca se reparte el mismo CVU", async () => {
    const c = await comercio();
    await cvus(5);
    const r = await Promise.allSettled(Array.from({ length: 12 }, () => core.crearCobro(c, { importe: 100_00 })));
    const ok = r.filter((x) => x.status === "fulfilled").map((x) => x.value.transferir_a!.cvu);
    assert.equal(ok.length, 5);
    assert.equal(new Set(ok).size, 5);
  });

  test("borrador sin CVU, se le cambia el importe y después se asigna", async () => {
    const c = await comercio();
    await cvus(1);
    const b = await core.crearCobro(c, { importe: 100_00, asignar: false });
    assert.equal(b.estado, "borrador");
    assert.equal(b.transferir_a, null);
    await core.actualizarImporte(c, b.id, 150_00);
    const a = await core.asignarCobro(c, b.id);
    assert.equal(a.estado, "pendiente");
    assert.equal(a.importe, 150_00);
    assert.deepEqual(await core.asignarCobro(c, b.id), a, "asignar es idempotente");
    await assert.rejects(core.actualizarImporte(c, b.id, 1), { codigo: "cobro_no_editable" });
  });

  test("idempotency_key devuelve el mismo cobro", async () => {
    const c = await comercio();
    await cvus(2);
    const a = await core.crearCobro(c, { importe: 100_00, idempotency_key: "k1" });
    const b = await core.crearCobro(c, { importe: 100_00, idempotency_key: "k1" });
    assert.equal(a.id, b.id);
    assert.equal((await core.estadoPool()).asignado, 1);
  });

  test("no asigna CVU que el poller todavía no leyó nunca", async () => {
    const c = await comercio();
    await core.agregarCvu({ usuario: "u", clave: "c", pv: "1", cvu: "1".repeat(22) });
    await assert.rejects(core.crearCobro(c, { importe: 100_00 }), { codigo: "pool_agotado" });
  });
});

describe("imputación de depósitos", () => {
  test("pago exacto: cobro pagado, 6 % de comisión, CVU a cuarentena de 48 h y webhook", async () => {
    const c = await conWebhook();
    await cvus(1);
    const cobro = await core.crearCobro(c, { importe: 10_000_00 });
    const cvu = await cvuDe(cobro.id);
    assert.equal(await core.registrarDepositos(cvu, [deposito(10_000)]), 1);

    const r = await core.obtenerCobro(c.id, cobro.id);
    assert.equal(r.estado, "pagado");
    assert.equal(r.recibido, 10_000_00);
    assert.equal(await core.saldo(c.id), 9_400_00);
    assert.deepEqual((await core.listarMovimientos(c.id)).map((m) => [m.tipo, m.importe]), [["comision", -600_00], ["cobro", 10_000_00]]);
    assert.deepEqual(await estadoCvu(cvu), { estado: "cuarentena", cobro_id: cobro.id, horas: 48 });
    assert.deepEqual(await eventos(), ["cobro.pagado"]);
  });

  test("el mismo depósito leído dos veces se acredita una sola vez", async () => {
    const c = await comercio();
    await cvus(1);
    const cobro = await core.crearCobro(c, { importe: 100_00 });
    const d = deposito(100);
    await core.registrarDepositos(await cvuDe(cobro.id), [d]);
    assert.equal(await core.registrarDepositos(await cvuDe(cobro.id), [d]), 0);
    assert.equal(await core.saldo(c.id), 94_00);
  });

  test("pago en dos partes: parcial y después pagado", async () => {
    const c = await conWebhook();
    await cvus(1);
    const cobro = await core.crearCobro(c, { importe: 1_000_00 });
    const cvu = await cvuDe(cobro.id);
    await core.registrarDepositos(cvu, [deposito(400)]);
    assert.equal((await core.obtenerCobro(c.id, cobro.id)).estado, "parcial");
    assert.equal((await estadoCvu(cvu)).estado, "asignado", "sigue bloqueado hasta completar");
    await core.registrarDepositos(cvu, [deposito(600)]);
    assert.equal((await core.obtenerCobro(c.id, cobro.id)).estado, "pagado");
    assert.deepEqual(await eventos(), ["cobro.parcial", "cobro.pagado"]);
  });

  test("pago de más: pagado + excedente, todo al saldo", async () => {
    const c = await conWebhook();
    await cvus(1);
    const cobro = await core.crearCobro(c, { importe: 1_000_00 });
    await core.registrarDepositos(await cvuDe(cobro.id), [deposito(1_200)]);
    assert.equal((await core.obtenerCobro(c.id, cobro.id)).estado, "pagado");
    assert.equal(await core.saldo(c.id), 1_128_00);
    assert.deepEqual(await eventos(), ["cobro.excedente", "cobro.pagado"]);
  });

  test("depósito fechado antes de la asignación queda huérfano y se imputa a mano", async () => {
    const c = await conWebhook();
    await cvus(1);
    const cobro = await core.crearCobro(c, { importe: 500_00 });
    const d = deposito(500, new Date(Date.now() - 3600_000));
    await core.registrarDepositos(await cvuDe(cobro.id), [d]);
    assert.equal((await core.obtenerCobro(c.id, cobro.id)).estado, "pendiente");
    assert.equal(await core.saldo(c.id), 0);
    assert.deepEqual((await core.listarHuerfanos()).map((h) => h.id), [d.id]);

    const r = await core.imputarManual(d.id, cobro.id);
    assert.equal(r.estado, "pagado");
    assert.equal(await core.saldo(c.id), 470_00);
    assert.equal((await core.listarHuerfanos()).length, 0);
    await assert.rejects(core.imputarManual(d.id, cobro.id), { codigo: "deposito_imputado" });
  });

  test("depósito a un CVU libre queda huérfano", async () => {
    await comercio();
    await cvus(1);
    await core.registrarDepositos(1, [deposito(100)]);
    assert.equal((await core.listarHuerfanos()).length, 1);
  });

  test("primera lectura de una cuenta: histórico, no se imputa", async () => {
    const c = await comercio();
    await cvus(1);
    const cobro = await core.crearCobro(c, { importe: 100_00 });
    await core.registrarDepositos(await cvuDe(cobro.id), [deposito(100)], true);
    assert.equal((await core.obtenerCobro(c.id, cobro.id)).estado, "pendiente");
    assert.equal((await core.listarHuerfanos()).length, 0);
  });
});

describe("vencimiento, cancelación y cuarentena", () => {
  test("vence a los 5 días: CVU a cuarentena de 7 días; un pago tardío va al saldo", async () => {
    const c = await conWebhook();
    await cvus(1);
    const cobro = await core.crearCobro(c, { importe: 300_00 });
    const cvu = await cvuDe(cobro.id);
    await db().query("UPDATE cobros SET vence_at = now() - interval '1 second' WHERE id = $1", [cobro.id]);
    assert.equal(await core.vencerCobros(), 1);
    assert.equal((await core.obtenerCobro(c.id, cobro.id)).estado, "vencido");
    assert.deepEqual(await estadoCvu(cvu), { estado: "cuarentena", cobro_id: cobro.id, horas: 168 });

    await core.registrarDepositos(cvu, [deposito(300)]);
    const r = await core.obtenerCobro(c.id, cobro.id);
    assert.equal(r.estado, "vencido", "el comercio decide qué hacer");
    assert.equal(r.recibido, 300_00);
    assert.equal(await core.saldo(c.id), 282_00);
    assert.deepEqual(await eventos(), ["cobro.vencido", "cobro.pago_tardio"]);
  });

  test("terminada la cuarentena el CVU vuelve al pool, último en la fila", async () => {
    const c = await comercio();
    await cvus(2);
    const a = await core.crearCobro(c, { importe: 100_00 });
    const cvu = await cvuDe(a.id);
    await core.cancelarCobro(c, a.id);
    await db().query("UPDATE cvus SET cuarentena_hasta = now() - interval '1 second' WHERE id = $1", [cvu]);
    assert.equal(await core.liberarCuarentenas(), 1);
    assert.deepEqual(await estadoCvu(cvu), { estado: "libre", cobro_id: null, horas: null });
    const b = await core.crearCobro(c, { importe: 100_00 });
    assert.notEqual(await cvuDe(b.id), cvu, "se usa primero el que hace más que está libre");
  });

  test("cancelar: idempotente, y un cobro pagado no se cancela", async () => {
    const c = await comercio();
    await cvus(2);
    const a = await core.crearCobro(c, { importe: 100_00 });
    assert.equal((await core.cancelarCobro(c, a.id)).estado, "cancelado");
    assert.equal((await core.cancelarCobro(c, a.id)).estado, "cancelado");
    const b = await core.crearCobro(c, { importe: 100_00 });
    await core.registrarDepositos(await cvuDe(b.id), [deposito(100)]);
    await assert.rejects(core.cancelarCobro(c, b.id), { codigo: "cobro_pagado" });
  });

  test("un comercio no ve ni toca cobros de otro", async () => {
    const c1 = await comercio();
    const c2 = await comercio({ nombre: "Otra" });
    await cvus(1);
    const a = await core.crearCobro(c1, { importe: 100_00 });
    await assert.rejects(core.obtenerCobro(c2.id, a.id), { codigo: "cobro_inexistente" });
    await assert.rejects(core.cancelarCobro(c2, a.id), { codigo: "cobro_inexistente" });
  });
});

describe("libro y retiros", () => {
  test("retiro descuenta del saldo y no puede superarlo", async () => {
    const c = await comercio();
    await cvus(1);
    const cobro = await core.crearCobro(c, { importe: 1_000_00 });
    await core.registrarDepositos(await cvuDe(cobro.id), [deposito(1_000)]);
    await assert.rejects(core.registrarRetiro(c.id, { importe: 941_00, entregado_por: "Caja", recibido_por: "Juan" }), { codigo: "saldo_insuficiente" });
    const r = await core.registrarRetiro(c.id, { importe: 900_00, entregado_por: "Caja", recibido_por: "Juan" });
    assert.equal(r.saldo, 40_00);
    assert.equal(await core.saldo(c.id), 40_00);
  });

  test("comisión configurable por comercio", async () => {
    const c = await comercio({ comision_pb: 450 });
    await cvus(1);
    const cobro = await core.crearCobro(c, { importe: 1_000_00 });
    await core.registrarDepositos(await cvuDe(cobro.id), [deposito(1_000)]);
    assert.equal(await core.saldo(c.id), 955_00);
  });
});
