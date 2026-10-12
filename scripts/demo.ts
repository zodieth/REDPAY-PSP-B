// Datos de ejemplo para revisar el backoffice en local: npm run demo
// Sólo corre con la base sin comercios.
//
// Los CVUs son inventados: no corras el worker contra esta base (intentaría
// loguearse en cargavirtual con usuarios que no existen).
import { db, cerrarDb } from "@redpagos/db";
import { migrar } from "@redpagos/db/migraciones";
import * as core from "@redpagos/core";

await migrar();
const hay = (await db().query("SELECT count(*)::int AS n FROM comercios")).rows[0].n as number;
if (hay) {
  console.log(`La base ya tiene ${hay} comercio(s); no cargo nada para no duplicar.`);
  await cerrarDb();
  process.exit(0);
}

const HORA = 3600_000;
const hace = (horas: number) => new Date(Date.now() - horas * HORA);

// Pool: 15 CVUs inventados, ya "leídos" (si no, no se asignan) y uno con login roto.
for (let i = 1; i <= 15; i++) {
  await db().query(
    `INSERT INTO cvus (usuario, clave_cifrada, pv, cvu, alias, titular, inicializado, ultima_sync, proxima_sync, libre_desde)
     VALUES ($1, $2, $3, $4, $5, 'redpagos SRL', true, now(), 'infinity', now() - make_interval(mins => $6))`,
    [`demo${i}`, core.cifrar("demo"), String(900000 + i), `00000031000${String(9000000 + i).padStart(11, "0")}`, `redpagos.demo.${i}`, 100 - i],
  );
}
await db().query(
  `INSERT INTO cvus (usuario, clave_cifrada, pv, cvu, alias, titular, inicializado, ultima_sync, proxima_sync, ultimo_error)
   VALUES ('demo16', $1, '900016', '0000003100000009000016', 'redpagos.demo.16', 'redpagos SRL', true, now() - interval '3 hours', 'infinity',
           to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS') || ' Login rechazado por cargavirtual (HTTP 200)')`,
  [core.cifrar("demo")],
);

let n = 0;
const deposito = (pesos: number, fecha = new Date()) => ({
  id: `demo-${++n}`,
  fecha_deposito: fecha.toISOString(),
  fecha_carga: fecha.toISOString(),
  banco: "Transferencia",
  cuenta: "Operación transferencia",
  nro_transaccion: String(43_400_000 + n),
  importe: pesos,
  observaciones: `CUIL 20-${String(30_000_000 + n * 1111)}-${n % 10}`,
});
const cvuDe = async (cobroId: string) =>
  (await db().query("SELECT cvu_id FROM cobros WHERE id = $1", [cobroId])).rows[0].cvu_id as number;
const pagar = async (c: core.Comercio, pesos: number, ref: string, recibido = pesos) => {
  const cobro = await core.crearCobro(c, { importe: pesos * 100, referencia: ref });
  await core.registrarDepositos(await cvuDe(cobro.id), [deposito(recibido)]);
  return cobro;
};

const tienda = await core.crearComercio({ nombre: "Tienda Demo", cuit: "30-71234567-8" }, "demo");
const moda = await core.crearComercio({ nombre: "Moda Sur", cuit: "30-70987654-3", comision_pb: 450 }, "demo");
const deco = await core.crearComercio({ nombre: "Deco Casa", comision_pb: 500, activo: true }, "demo");

// Tienda Demo: pagos completos, uno parcial, uno esperando y uno con pago de más.
await pagar(tienda, 25_000, "orden #1001");
await pagar(tienda, 18_750.5, "orden #1002");
await pagar(tienda, 10_000, "orden #1003", 6_000); // parcial
await core.crearCobro(tienda, { importe: 12_500_00, referencia: "orden #1004" }); // esperando la transferencia
await pagar(tienda, 9_900, "orden #1005", 10_000); // excedente

// Moda Sur: varios pagos, un retiro ya entregado y uno vencido con pago tardío.
await pagar(moda, 40_000, "pedido 77");
await pagar(moda, 32_400, "pedido 78");
const vencido = await core.crearCobro(moda, { importe: 15_000_00, referencia: "pedido 79" });
await db().query("UPDATE cobros SET vence_at = now() - interval '1 minute' WHERE id = $1", [vencido.id]);
await core.vencerCobros();
await core.registrarDepositos(await cvuDe(vencido.id), [deposito(15_000)]); // tardío
await core.registrarRetiro(moda.id, { importe: 50_000_00, entregado_por: "Caja (demo)", recibido_por: "Laura Gómez DNI 30111222" });

// Deco Casa: le cambiamos la comisión para que se vea en el historial.
await pagar(deco, 7_300, "venta 15");
await core.actualizarComercio(deco.id, { comision_pb: 400 }, "demo");

// Un depósito huérfano: entró a un CVU libre por el importe de la orden #1004.
const libre = (await db().query("SELECT id FROM cvus WHERE estado = 'libre' AND ultimo_error IS NULL ORDER BY id LIMIT 1")).rows[0].id;
await core.registrarDepositos(libre, [deposito(12_500, hace(1))]);

// Webhook del comercio demo (apunta a una URL que no existe: va a quedar fallando, sirve para ver reintentos).
await core.crearWebhook(tienda.id, "https://tienda-demo.invalid/hooks/payment/redpagos_redpagos");

console.log("Datos de ejemplo cargados: 3 comercios, 16 CVUs, cobros en todos los estados, 1 huérfano, 1 retiro.");
await cerrarDb();
