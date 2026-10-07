import { connection } from "next/server";
import Link from "next/link";
import { comerciosConSaldo } from "@redpagos/core";
import { FormAccion } from "@/components/form-accion";
import { Campo, Estado, Seccion, Tabla, input, td, tdNum, th } from "@/components/ui";
import { pesos, porcentaje } from "@/lib/formato";
import { crearComercioAccion } from "../acciones";

export default async function Comercios() {
  await connection();
  const comercios = await comerciosConSaldo();
  return (
    <>
      <Seccion titulo={`Comercios (${comercios.length})`}>
        <Tabla filas={comercios.length} vacio="Todavía no hay comercios">
          <thead>
            <tr>
              <th className={th}>Comercio</th><th className={th}>CUIT</th><th className={th}>Comisión</th>
              <th className={`${th} text-right`}>Cobrado 30 d</th><th className={`${th} text-right`}>Saldo</th>
              <th className={`${th} text-right`}>Abiertos</th><th className={th}></th>
            </tr>
          </thead>
          <tbody>
            {comercios.map((c) => (
              <tr key={c.id}>
                <td className={td}><Link href={`/admin/comercios/${c.id}`} className="font-medium hover:underline">{c.nombre}</Link></td>
                <td className={td}>{c.cuit ?? "—"}</td>
                <td className={td}>{porcentaje(c.comision_pb)}</td>
                <td className={tdNum}>{pesos(c.bruto_30d)}</td>
                <td className={tdNum}>{pesos(c.saldo)}</td>
                <td className={tdNum}>{c.cobros_abiertos}</td>
                <td className={td}>{!c.activo && <Estado valor="inactivo" />}</td>
              </tr>
            ))}
          </tbody>
        </Tabla>
      </Seccion>

      <Seccion titulo="Nuevo comercio">
        <FormAccion accion={crearComercioAccion} boton="Crear comercio" className="max-w-xl space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="sm:col-span-2"><Campo etiqueta="Nombre"><input name="nombre" required className={input} /></Campo></div>
            <Campo etiqueta="CUIT"><input name="cuit" className={input} /></Campo>
          </div>
          <Campo etiqueta="Comisión (%)" ayuda="Vacío = 6 %. Se puede cambiar después.">
            <input name="comision" inputMode="decimal" placeholder="6" className={`${input} max-w-32`} />
          </Campo>
        </FormAccion>
      </Seccion>
    </>
  );
}
