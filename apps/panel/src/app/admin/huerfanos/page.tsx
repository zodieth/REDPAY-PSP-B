import { connection } from "next/server";
import { candidatosHuerfano, listarHuerfanos } from "@redpagos/core";
import { FormAccion } from "@/components/form-accion";
import { Estado, Seccion, input } from "@/components/ui";
import { fecha, pesos } from "@/lib/formato";
import { imputarAccion } from "../acciones";

export default async function Huerfanos() {
  await connection();
  const huerfanos = await listarHuerfanos();
  const candidatos = await Promise.all(huerfanos.map((h) => candidatosHuerfano(h.id)));

  return (
    <Seccion titulo={`Depósitos huérfanos (${huerfanos.length})`}>
      <p className="max-w-3xl text-sm text-zinc-500">
        Entraron a un CVU libre, o están fechados antes de que el CVU se asignara. No se acreditaron a nadie.
        Imputalos al cobro que corresponde: se acreditan al comercio (menos su comisión) y, si completan el cobro, queda pagado.
      </p>
      {huerfanos.length === 0 && <p className="text-sm">No hay depósitos para revisar.</p>}
      <div className="space-y-4">
        {huerfanos.map((h, i) => (
          <article key={h.id} className="space-y-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-xl font-semibold tabular-nums">{pesos(h.importe)}</p>
              <p className="text-sm text-zinc-500">depositado {fecha(h.fecha_deposito)} · detectado {fecha(h.detectado_at)}</p>
            </div>
            <p className="text-sm">
              A <span className="font-mono">{h.alias ?? h.cvu}</span> · transacción {h.nro_transaccion ?? "—"} · {h.banco ?? "—"}
              {h.observaciones && <> · <span className="text-zinc-500">{h.observaciones}</span></>}
            </p>
            {candidatos[i].length > 0 && (
              <div className="text-sm">
                <p className="mb-1 font-medium">Cobros con ese importe pendiente:</p>
                <ul className="space-y-1">
                  {candidatos[i].map((c) => (
                    <li key={c.id} className="flex flex-wrap items-center gap-2">
                      <Estado valor={c.estado} /> {c.comercio} · {pesos(c.importe)} · {fecha(c.creado_at)}
                      <span className="font-mono text-xs text-zinc-500">{c.referencia ?? c.id}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <FormAccion
              accion={imputarAccion.bind(null, h.id)}
              boton="Imputar"
              confirmar="¿Imputar el depósito a ese cobro? Se acredita al comercio y no se puede deshacer desde el panel."
              className="flex flex-wrap items-center gap-3"
            >
              <select name="cobro_id" defaultValue="" className={`${input} max-w-md`}>
                <option value="">Elegí un cobro…</option>
                {candidatos[i].map((c) => (
                  <option key={c.id} value={c.id}>{c.comercio} · {pesos(c.importe)} · {c.estado} · {c.referencia ?? c.id.slice(0, 8)}</option>
                ))}
              </select>
              <span className="text-sm text-zinc-500">o pegá el id:</span>
              <input name="cobro_id_manual" placeholder="id del cobro" className={`${input} max-w-xs font-mono`} />
            </FormAccion>
          </article>
        ))}
      </div>
    </Seccion>
  );
}
