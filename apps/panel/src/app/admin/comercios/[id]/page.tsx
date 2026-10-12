import Link from "next/link";
import { notFound } from "next/navigation";
import * as core from "@redpagos/core";
import { FormAccion } from "@/components/form-accion";
import { Campo, Estado, Seccion, Tabla, Tarjeta, input, td, tdNum, th, tipoMovimiento } from "@/components/ui";
import { dias, fecha, pesos, porcentaje } from "@/lib/formato";
import {
  alternarWebhookAccion, crearApiKeyAccion, crearWebhookAccion, guardarConfiguracion,
  probarWebhookAccion, registrarAjusteAccion, registrarRetiroAccion, revocarApiKeyAccion,
} from "../../acciones";

// Cómo se lee un cambio de configuración en el historial.
const CAMPOS: Record<string, (v: unknown) => string> = {
  comision_pb: (v) => `comisión ${porcentaje(Number(v))}`,
  bloqueo_horas: (v) => `bloqueo ${dias(Number(v))} días`,
  cuarentena_pagado_horas: (v) => `cuarentena pagado ${dias(Number(v))} días`,
  cuarentena_vencido_horas: (v) => `cuarentena vencido ${dias(Number(v))} días`,
  activo: (v) => (v ? "activo" : "inactivo"),
  nombre: (v) => `nombre "${v}"`,
  cuit: (v) => `CUIT ${v ?? "—"}`,
  importe: (v) => pesos(Number(v)),
  descripcion: (v) => `"${v}"`,
};
const describir = (o: Record<string, unknown> | null) =>
  o ? Object.entries(o).filter(([k]) => CAMPOS[k]).map(([k, v]) => CAMPOS[k](v)).join(", ") : "";

export default async function FichaComercio({ params }: PageProps<"/admin/comercios/[id]">) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const comercio = await core.obtenerComercio(id).catch(() => null);
  if (!comercio) notFound();

  const [saldo, totales, cobros, movimientos, retiros, webhooks, keys, auditoria] = await Promise.all([
    core.saldo(id),
    core.totalesComercio(id, 30),
    core.listarCobros(id, { limite: 50 }),
    core.listarMovimientos(id, { limite: 100 }),
    core.listarRetiros(id) as Promise<{ id: string; importe: number; entregado_por: string; recibido_por: string; comprobante: string | null; notas: string | null; creado_at: Date }[]>,
    core.listarWebhooks(id),
    core.listarApiKeys(id),
    core.listarAuditoria(id, 50),
  ]);

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Link href="/admin/comercios" className="text-sm text-zinc-500 hover:underline">← Comercios</Link>
          <h1 className="text-2xl font-semibold">
            {comercio.nombre} {!comercio.activo && <Estado valor="inactivo" />}
          </h1>
          <p className="text-sm text-zinc-500">
            {comercio.cuit ? `CUIT ${comercio.cuit} · ` : ""}Comisión {porcentaje(comercio.comision_pb)} · CVU bloqueado {dias(comercio.bloqueo_horas)} días
          </p>
        </div>
        <nav className="flex flex-wrap gap-3 text-sm">
          {[["#retiro", "Retiro"], ["#configuracion", "Configuración"], ["#cobros", "Cobros"], ["#movimientos", "Movimientos"], ["#accesos", "Accesos"], ["#historial", "Historial"]].map(([h, n]) => (
            <a key={h} href={h} className="underline-offset-2 hover:underline">{n}</a>
          ))}
        </nav>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tarjeta titulo="Saldo disponible" valor={pesos(saldo)} detalle="para retirar en efectivo" />
        <Tarjeta titulo="Cobrado (30 d)" valor={pesos(totales.bruto)} detalle={`${totales.cobros_pagados} cobros pagados`} />
        <Tarjeta titulo="Comisión (30 d)" valor={pesos(totales.comision)} />
        <Tarjeta titulo="Retirado (30 d)" valor={pesos(totales.retirado)} />
      </div>

      <div className="grid gap-10 lg:grid-cols-2">
        <Seccion titulo="Registrar retiro" id="retiro">
          <FormAccion
            accion={registrarRetiroAccion.bind(null, id)}
            boton="Registrar entrega de efectivo"
            confirmar="¿Confirmás que se entregó el efectivo? Se descuenta del saldo del comercio."
            className="space-y-3"
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <Campo etiqueta="Importe ($)" ayuda={`Disponible: ${pesos(saldo)}`}>
                <input name="importe" required inputMode="decimal" placeholder="150.000,00" className={input} />
              </Campo>
              <Campo etiqueta="Recibió (nombre y DNI)"><input name="recibido_por" required className={input} /></Campo>
              <Campo etiqueta="Comprobante (opcional)"><input name="comprobante" className={input} /></Campo>
              <Campo etiqueta="Notas (opcional)"><input name="notas" className={input} /></Campo>
            </div>
          </FormAccion>
        </Seccion>

        <Seccion titulo="Configuración" id="configuracion">
          <FormAccion accion={guardarConfiguracion.bind(null, id)} boton="Guardar" className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Campo etiqueta="Nombre"><input name="nombre" required defaultValue={comercio.nombre} className={input} /></Campo>
              <Campo etiqueta="CUIT"><input name="cuit" defaultValue={comercio.cuit ?? ""} className={input} /></Campo>
              <Campo etiqueta="Comisión (%)" ayuda="Aplica a los depósitos que entren desde ahora.">
                <input name="comision" required inputMode="decimal" defaultValue={String(comercio.comision_pb / 100).replace(".", ",")} className={input} />
              </Campo>
              <Campo etiqueta="Bloqueo del CVU (días)" ayuda="Plazo para pagar la orden.">
                <input name="bloqueo_dias" required inputMode="decimal" defaultValue={dias(comercio.bloqueo_horas)} className={input} />
              </Campo>
              <Campo etiqueta="Cuarentena si se pagó (días)">
                <input name="cuarentena_pagado_dias" required inputMode="decimal" defaultValue={dias(comercio.cuarentena_pagado_horas)} className={input} />
              </Campo>
              <Campo etiqueta="Cuarentena si venció o se canceló (días)">
                <input name="cuarentena_vencido_dias" required inputMode="decimal" defaultValue={dias(comercio.cuarentena_vencido_horas)} className={input} />
              </Campo>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="activo" defaultChecked={comercio.activo} /> Activo (si no, no puede cobrar ni entrar al panel)
            </label>
          </FormAccion>
        </Seccion>
      </div>

      <Seccion titulo="Ajuste de saldo">
        <FormAccion
          accion={registrarAjusteAccion.bind(null, id)}
          boton="Registrar ajuste"
          variante="secundario"
          confirmar="¿Registrar el ajuste? Queda en el historial con tu usuario."
          className="grid max-w-3xl gap-3 sm:grid-cols-[10rem_1fr]"
        >
          <Campo etiqueta="Importe ($)" ayuda="Negativo para descontar"><input name="importe" required inputMode="decimal" placeholder="-1.000" className={input} /></Campo>
          <Campo etiqueta="Motivo"><input name="descripcion" required className={input} /></Campo>
        </FormAccion>
      </Seccion>

      <Seccion titulo="Cobros recientes" id="cobros">
        <Tabla filas={cobros.length} vacio="Sin cobros">
          <thead>
            <tr><th className={th}>Creado</th><th className={th}>Estado</th><th className={`${th} text-right`}>Importe</th><th className={`${th} text-right`}>Recibido</th><th className={th}>CVU / alias</th><th className={th}>Vence</th><th className={th}>Referencia</th></tr>
          </thead>
          <tbody>
            {cobros.map((c) => (
              <tr key={c.id}>
                <td className={td}>{fecha(c.creado_at)}</td>
                <td className={td}><Estado valor={c.estado} /></td>
                <td className={tdNum}>{pesos(c.importe)}</td>
                <td className={tdNum}>{pesos(c.recibido)}</td>
                <td className={`${td} font-mono text-xs`}>{c.transferir_a ? <>{c.transferir_a.alias}<br />{c.transferir_a.cvu}</> : "—"}</td>
                <td className={td}>{c.estado === "pendiente" || c.estado === "parcial" ? fecha(c.vence_at) : "—"}</td>
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
            <summary className="cursor-pointer text-zinc-600 dark:text-zinc-400">Retiros ({retiros.length})</summary>
            <ul className="mt-2 space-y-1">
              {retiros.map((r) => (
                <li key={r.id}>
                  {fecha(r.creado_at)} · <b>{pesos(r.importe)}</b> · recibió {r.recibido_por} · entregó {r.entregado_por}
                  {r.comprobante && ` · comprobante ${r.comprobante}`}{r.notas && ` · ${r.notas}`}
                </li>
              ))}
            </ul>
          </details>
        )}
      </Seccion>

      <div id="accesos" className="grid scroll-mt-6 gap-10 lg:grid-cols-2">
        <Seccion titulo="Webhooks">
          <p className="text-sm text-zinc-500">A dónde avisamos los pagos. Con Medusa: https://tienda/hooks/payment/redpagos_redpagos</p>
          <Tabla filas={webhooks.length} vacio="Sin webhooks">
            <tbody>
              {webhooks.map((w) => (
                <tr key={w.id}>
                  <td className={`${td} break-all font-mono text-xs`}>{w.url} {!w.activo && <Estado valor="cancelado" />}</td>
                  <td className={td}>
                    <div className="flex gap-2">
                      <FormAccion accion={probarWebhookAccion.bind(null, id, w.id)} boton="Probar" variante="secundario" />
                      <FormAccion accion={alternarWebhookAccion.bind(null, id, w.id, !w.activo)} boton={w.activo ? "Pausar" : "Activar"} variante="secundario" />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </Tabla>
          <FormAccion accion={crearWebhookAccion.bind(null, id)} boton="Agregar webhook" variante="secundario" className="space-y-3">
            <Campo etiqueta="URL"><input name="url" type="url" required placeholder="https://" className={input} /></Campo>
          </FormAccion>
        </Seccion>

        <Seccion titulo="API keys">
          <p className="text-sm text-zinc-500">Para la app de la tienda (plugin de Medusa): cobra y le muestra al comercio su saldo y movimientos. Se ven completas una sola vez.</p>
          <Tabla filas={keys.length} vacio="Sin API keys">
            <tbody>
              {keys.map((k) => (
                <tr key={k.prefijo}>
                  <td className={`${td} font-mono`}>{k.prefijo}…</td>
                  <td className={td}>{k.revocada_at ? <>revocada {fecha(k.revocada_at)}</> : <>creada {fecha(k.creada_at)}</>}</td>
                  <td className={td}>
                    {!k.revocada_at && (
                      <FormAccion
                        accion={revocarApiKeyAccion.bind(null, id, k.prefijo)}
                        boton="Revocar"
                        variante="peligro"
                        confirmar={`¿Revocar ${k.prefijo}…? La integración que la use deja de funcionar.`}
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Tabla>
          <FormAccion accion={crearApiKeyAccion.bind(null, id)} boton="Crear API key" variante="secundario" />
        </Seccion>
      </div>

      <Seccion titulo="Historial de cambios" id="historial">
        <Tabla filas={auditoria.length} vacio="Sin cambios">
          <thead>
            <tr><th className={th}>Fecha</th><th className={th}>Quién</th><th className={th}>Qué</th></tr>
          </thead>
          <tbody>
            {auditoria.map((a) => (
              <tr key={a.id}>
                <td className={td}>{fecha(a.creado_at)}</td>
                <td className={td}>{a.actor}</td>
                <td className={td}>
                  {a.accion === "comercio.actualizado" && <>{describir(a.antes)} → <b>{describir(a.despues)}</b></>}
                  {a.accion === "comercio.creado" && <>Alta del comercio</>}
                  {a.accion === "saldo.ajuste" && <>Ajuste de saldo: {describir(a.despues)}</>}
                </td>
              </tr>
            ))}
          </tbody>
        </Tabla>
      </Seccion>
    </>
  );
}
