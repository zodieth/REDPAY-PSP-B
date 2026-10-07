import * as core from "@redpagos/core";
import { FormAccion } from "@/components/form-accion";
import { Campo, Estado, Seccion, Tabla, Tarjeta, input, td, tdNum, th, tipoMovimiento } from "@/components/ui";
import { dias, fecha, pesos, porcentaje } from "@/lib/formato";
import { requiereComercio } from "@/lib/sesion";
import { alternarWebhookAccion, cambiarClaveComercio, crearWebhookAccion, probarWebhookAccion } from "./acciones";

const ESTADOS = ["todos", "pendiente", "parcial", "pagado", "vencido", "cancelado"];

export default async function PanelComercio({ searchParams }: PageProps<"/panel">) {
  const u = await requiereComercio();
  const id = u.comercio_id;
  const { estado } = await searchParams;
  const filtro = typeof estado === "string" && ESTADOS.includes(estado) && estado !== "todos" ? estado : undefined;

  const [comercio, saldo, totales, cobros, movimientos, retiros, webhooks, keys] = await Promise.all([
    core.obtenerComercio(id),
    core.saldo(id),
    core.totalesComercio(id, 30),
    core.listarCobros(id, { estado: filtro, limite: 100 }),
    core.listarMovimientos(id, { limite: 100 }),
    core.listarRetiros(id) as Promise<{ id: string; importe: number; recibido_por: string; creado_at: Date }[]>,
    core.listarWebhooks(id),
    core.listarApiKeys(id),
  ]);

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tarjeta titulo="Saldo disponible" valor={pesos(saldo)} detalle="para retirar en nuestras oficinas" />
        <Tarjeta titulo="Cobrado (30 d)" valor={pesos(totales.bruto)} detalle={`${totales.cobros_pagados} órdenes pagadas`} />
        <Tarjeta titulo="Comisión (30 d)" valor={pesos(totales.comision)} detalle={`tu comisión: ${porcentaje(comercio.comision_pb)}`} />
        <Tarjeta titulo="Retirado (30 d)" valor={pesos(totales.retirado)} />
      </div>

      <Seccion
        titulo="Cobros"
        id="cobros"
        accion={
          <nav className="flex flex-wrap gap-3 text-sm">
            {ESTADOS.map((e) => (
              <a key={e} href={e === "todos" ? "?#cobros" : `?estado=${e}#cobros`} className={(filtro ?? "todos") === e ? "font-semibold underline" : "hover:underline"}>{e}</a>
            ))}
          </nav>
        }
      >
        <p className="text-sm text-zinc-500">
          Cada orden recibe un CVU propio por {dias(comercio.bloqueo_horas)} días. Si no se paga en ese plazo, vence.
        </p>
        <Tabla filas={cobros.length} vacio="Sin cobros">
          <thead>
            <tr><th className={th}>Creado</th><th className={th}>Estado</th><th className={`${th} text-right`}>Importe</th><th className={`${th} text-right`}>Recibido</th><th className={th}>CVU / alias</th><th className={th}>Vence / pagado</th><th className={th}>Referencia</th></tr>
          </thead>
          <tbody>
            {cobros.map((c) => (
              <tr key={c.id}>
                <td className={td}>{fecha(c.creado_at)}</td>
                <td className={td}><Estado valor={c.estado} /></td>
                <td className={tdNum}>{pesos(c.importe)}</td>
                <td className={tdNum}>{pesos(c.recibido)}</td>
                <td className={`${td} font-mono text-xs`}>{c.transferir_a ? <>{c.transferir_a.alias}<br />{c.transferir_a.cvu}</> : "—"}</td>
                <td className={td}>{c.estado === "pagado" ? fecha(c.pagado_at) : c.estado === "pendiente" || c.estado === "parcial" ? `vence ${fecha(c.vence_at)}` : "—"}</td>
                <td className={`${td} font-mono text-xs`} title={c.id}>{c.referencia ?? c.id.slice(0, 8)}</td>
              </tr>
            ))}
          </tbody>
        </Tabla>
      </Seccion>

      <Seccion titulo="Movimientos" id="movimientos">
        <Tabla filas={movimientos.length} vacio="Sin movimientos">
          <thead>
            <tr><th className={th}>Fecha</th><th className={th}>Tipo</th><th className={th}>Detalle</th><th className={`${th} text-right`}>Importe</th></tr>
          </thead>
          <tbody>
            {movimientos.map((m) => (
              <tr key={m.id}>
                <td className={td}>{fecha(m.creado_at)}</td>
                <td className={td}>{tipoMovimiento(m.tipo)}</td>
                <td className={td}>{m.descripcion}</td>
                <td className={`${tdNum} ${m.importe < 0 ? "text-red-700 dark:text-red-400" : ""}`}>{pesos(m.importe)}</td>
              </tr>
            ))}
          </tbody>
        </Tabla>
        {retiros.length > 0 && (
          <details className="text-sm">
            <summary className="cursor-pointer text-zinc-600 dark:text-zinc-400">Retiros en efectivo ({retiros.length})</summary>
            <ul className="mt-2 space-y-1">
              {retiros.map((r) => <li key={r.id}>{fecha(r.creado_at)} · <b>{pesos(r.importe)}</b> · retiró {r.recibido_por}</li>)}
            </ul>
          </details>
        )}
      </Seccion>

      <Seccion titulo="Integración" id="integracion">
        <div className="grid gap-10 lg:grid-cols-2">
          <div className="space-y-3">
            <h3 className="font-medium">Webhooks</h3>
            <Tabla filas={webhooks.length} vacio="Sin webhooks">
              <tbody>
                {webhooks.map((w) => (
                  <tr key={w.id}>
                    <td className={`${td} break-all font-mono text-xs`}>{w.url} {!w.activo && <Estado valor="cancelado" />}</td>
                    <td className={td}>
                      <div className="flex gap-2">
                        <FormAccion accion={probarWebhookAccion.bind(null, w.id)} boton="Probar" variante="secundario" />
                        <FormAccion accion={alternarWebhookAccion.bind(null, w.id, !w.activo)} boton={w.activo ? "Pausar" : "Activar"} variante="secundario" />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Tabla>
            <FormAccion accion={crearWebhookAccion} boton="Agregar webhook" variante="secundario" className="space-y-3">
              <Campo etiqueta="URL" ayuda="Con Medusa: https://tu-tienda/hooks/payment/redpagos_redpagos">
                <input name="url" type="url" required placeholder="https://" className={input} />
              </Campo>
            </FormAccion>
          </div>
          <div className="space-y-3">
            <h3 className="font-medium">API keys</h3>
            <p className="text-sm text-zinc-500">Para pedir una nueva o revocar una, contactanos.</p>
            <ul className="space-y-1 text-sm">
              {keys.map((k) => (
                <li key={k.prefijo}><span className="font-mono">{k.prefijo}…</span> · {k.revocada_at ? `revocada ${fecha(k.revocada_at)}` : `activa desde ${fecha(k.creada_at)}`}</li>
              ))}
              {!keys.length && <li className="text-zinc-500">Todavía no tenés API keys</li>}
            </ul>
            <h3 className="pt-4 font-medium">Cambiar mi clave</h3>
            <FormAccion accion={cambiarClaveComercio} boton="Cambiar" variante="secundario" className="space-y-3">
              <input name="clave" type="password" required minLength={8} autoComplete="new-password" placeholder="Clave nueva (8+ caracteres)" className={input} />
            </FormAccion>
          </div>
        </div>
      </Seccion>
    </>
  );
}
