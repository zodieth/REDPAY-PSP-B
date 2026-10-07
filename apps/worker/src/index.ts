// Worker: lee cargavirtual por prioridad, vence cobros, libera cuarentenas y
// manda webhooks. Se puede correr más de uno: cada CVU se "reclama" con SKIP LOCKED.
import { buscarDepositos } from "@redpagos/cargavirtual";
import { db, filas } from "@redpagos/db";
import { migrar } from "@redpagos/db/migraciones";
import {
  credenciales, estadoPool, liberarCuarentenas, procesarCola, registrarDepositos, vencerCobros, type Cvu,
} from "@redpagos/core";

const num = (k: string, def: number) => Number(process.env[k] ?? def);
const EN_PARALELO = num("CONSULTAS_EN_PARALELO", 8);
const INTERVALO_SEG = {
  asignado: num("POLL_ASIGNADO_SEG", 60),
  cuarentena: num("POLL_CUARENTENA_SEG", 600),
  libre: num("POLL_LIBRE_SEG", 3600),
  deshabilitado: 3600,
};
const ALERTA_POOL = num("ALERTA_POOL_PORCENTAJE", 80);
// Primera lectura de una cuenta: estos días se guardan como históricos, sin imputar.
const DIAS_HISTORICO = 2;
// Después de una caída, se relee desde la última sync menos un día, con este tope.
const DIAS_MAX_RELECTURA = 10;

const DIA = 86_400_000;
const fechaAR = (ms = Date.now()) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(new Date(ms));

// Reclama hasta n CVU vencidos para leer. Les corre proxima_sync 5 min para que
// otro worker no los tome; al terminar se reprograma según su estado.
const reclamar = (n: number) =>
  filas<Cvu>(db(), `
    UPDATE cvus SET proxima_sync = now() + interval '5 minutes'
    WHERE id IN (
      SELECT id FROM cvus WHERE estado <> 'deshabilitado' AND proxima_sync <= now()
      ORDER BY (estado = 'asignado') DESC, proxima_sync LIMIT $1 FOR UPDATE SKIP LOCKED)
    RETURNING *`, [n]);

async function sincronizar(cvu: Cvu) {
  try {
    const historico = !cvu.inicializado;
    const desdeMs = historico
      ? Date.now() - DIAS_HISTORICO * DIA
      : Math.max(Math.min((cvu.ultima_sync?.getTime() ?? Date.now()) - DIA, Date.now() - DIA), Date.now() - DIAS_MAX_RELECTURA * DIA);
    const r = await buscarDepositos(credenciales(cvu), { desde: fechaAR(desdeMs), hasta: fechaAR() });
    const nuevos = await registrarDepositos(cvu.id, r.depositos, historico);
    // El estado puede haber cambiado mientras leíamos (p. ej. se asignó): reprogramamos con el actual.
    await db().query(`
      UPDATE cvus SET inicializado = true, ultima_sync = now(), ultimo_error = NULL,
        titular = coalesce(titular, $2),
        proxima_sync = now() + make_interval(secs => CASE estado
          WHEN 'asignado' THEN $3 WHEN 'cuarentena' THEN $4 ELSE $5 END)
      WHERE id = $1`,
      [cvu.id, r.cuenta.nombre, INTERVALO_SEG.asignado, INTERVALO_SEG.cuarentena, INTERVALO_SEG.libre]);
    if (nuevos) console.log(`[poller] CVU ${cvu.id}: ${nuevos} depósito(s) nuevo(s)${historico ? " (históricos)" : ""}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[poller] CVU ${cvu.id}:`, msg);
    await db().query(
      "UPDATE cvus SET ultimo_error = $2, proxima_sync = now() + make_interval(secs => $3) WHERE id = $1",
      [cvu.id, `${new Date().toISOString()} ${msg}`, INTERVALO_SEG[cvu.estado]],
    );
  }
}

async function poll() {
  for (;;) {
    const lote = await reclamar(EN_PARALELO);
    if (!lote.length) return;
    await Promise.all(lote.map(sincronizar));
  }
}

async function alertarPool() {
  const p = await estadoPool();
  if (p.ocupacion >= ALERTA_POOL) {
    console.warn(`[pool] ALERTA: ${p.ocupacion}% ocupado (libres ${p.libre}, asignados ${p.asignado}, cuarentena ${p.cuarentena})`);
  }
}

function cada(ms: number, nombre: string, fn: () => Promise<unknown>) {
  let ocupado = false;
  const tick = async () => {
    if (ocupado) return;
    ocupado = true;
    try {
      await fn();
    } catch (e) {
      console.error(`[${nombre}]`, e);
    } finally {
      ocupado = false;
    }
  };
  void tick();
  setInterval(tick, ms);
}

await migrar();
console.log(`[worker] ${EN_PARALELO} consultas en paralelo; asignados cada ${INTERVALO_SEG.asignado}s, cuarentena ${INTERVALO_SEG.cuarentena}s, libres ${INTERVALO_SEG.libre}s`);
cada(5_000, "poller", poll);
cada(60_000, "vencimientos", async () => {
  const n = await vencerCobros();
  if (n) console.log(`[vencimientos] ${n} cobro(s) vencido(s)`);
});
cada(60_000, "cuarentenas", async () => {
  const n = await liberarCuarentenas();
  if (n) console.log(`[cuarentenas] ${n} CVU liberado(s)`);
});
cada(5_000, "webhooks", procesarCola);
cada(5 * 60_000, "pool", alertarPool);
