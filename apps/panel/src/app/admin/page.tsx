import { connection } from "next/server";
import Link from "next/link";
import { comerciosConSaldo, estadoPool, resumenGeneral } from "@redpagos/core";
import { Seccion, Tabla, Tarjeta, td, tdNum, th } from "@/components/ui";
import { pesos, porcentaje } from "@/lib/formato";

export default async function Resumen() {
  await connection();
  const [r, pool, comercios] = await Promise.all([resumenGeneral(), estadoPool(), comerciosConSaldo()]);
  const alertaPool = pool.ocupacion >= Number(process.env.ALERTA_POOL_PORCENTAJE ?? 80);

  return (
    <>
      <Seccion titulo="Comisiones">
        <div className="grid gap-3 sm:grid-cols-3">
          <Tarjeta titulo="Hoy" valor={pesos(r.comision_hoy)} detalle={`sobre ${pesos(r.bruto_hoy)} cobrados`} />
          <Tarjeta titulo="Últimos 7 días" valor={pesos(r.comision_7d)} detalle={`sobre ${pesos(r.bruto_7d)} cobrados`} />
          <Tarjeta titulo="Últimos 30 días" valor={pesos(r.comision_30d)} detalle={`sobre ${pesos(r.bruto_30d)} cobrados`} />
        </div>
      </Seccion>

      <Seccion titulo="Operación">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Tarjeta titulo="A pagar a comercios" valor={pesos(r.saldo_total)} detalle="suma de saldos (efectivo a tener)" />
          <Tarjeta
            titulo="Pool de CVU"
            valor={`${pool.ocupacion} %`}
            detalle={`${pool.libre} libres · ${pool.asignado} asignados · ${pool.cuarentena} en cuarentena`}
            href="/admin/cvus"
            alerta={alertaPool}
          />
          <Tarjeta titulo="Huérfanos" valor={r.huerfanos} detalle="depósitos sin cobro" href="/admin/huerfanos" alerta={r.huerfanos > 0} />
          <Tarjeta titulo="CVUs con error" valor={r.cvus_con_error} detalle={`${r.cobros_abiertos} cobros esperando pago`} href="/admin/cvus" alerta={r.cvus_con_error > 0} />
        </div>
      </Seccion>

      <Seccion titulo="Comercios" accion={<Link href="/admin/comercios" className="text-sm underline">Ver todos</Link>}>
        <Tabla filas={comercios.length} vacio="Todavía no hay comercios">
          <thead>
            <tr><th className={th}>Comercio</th><th className={th}>Comisión</th><th className={`${th} text-right`}>Cobrado 30 d</th><th className={`${th} text-right`}>Saldo</th><th className={`${th} text-right`}>Abiertos</th></tr>
          </thead>
          <tbody>
            {[...comercios].sort((a, b) => b.saldo - a.saldo).slice(0, 10).map((c) => (
              <tr key={c.id}>
                <td className={td}><Link href={`/admin/comercios/${c.id}`} className="font-medium hover:underline">{c.nombre}</Link></td>
                <td className={td}>{porcentaje(c.comision_pb)}</td>
                <td className={tdNum}>{pesos(c.bruto_30d)}</td>
                <td className={tdNum}>{pesos(c.saldo)}</td>
                <td className={tdNum}>{c.cobros_abiertos}</td>
              </tr>
            ))}
          </tbody>
        </Tabla>
      </Seccion>
    </>
  );
}
