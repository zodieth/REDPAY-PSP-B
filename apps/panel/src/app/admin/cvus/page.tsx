import { estadoPool, listarCvus, type EstadoCvu } from "@redpagos/core";
import { FormAccion } from "@/components/form-accion";
import { Campo, Estado, Seccion, Tabla, Tarjeta, input, td, th } from "@/components/ui";
import { fecha } from "@/lib/formato";
import { agregarCvuAccion, alternarCvu } from "../acciones";

const FILTROS: (EstadoCvu | "todos")[] = ["todos", "libre", "asignado", "cuarentena", "deshabilitado"];

export default async function Cvus({ searchParams }: PageProps<"/admin/cvus">) {
  const { estado } = await searchParams;
  const filtro = FILTROS.includes(estado as EstadoCvu) && estado !== "todos" ? (estado as EstadoCvu) : undefined;
  const [pool, cvus] = await Promise.all([estadoPool(), listarCvus(filtro)]);
  const conError = cvus.filter((c) => c.ultimo_error && c.estado !== "deshabilitado");

  return (
    <>
      <Seccion titulo="Pool de CVU">
        <div className="grid gap-3 sm:grid-cols-5">
          <Tarjeta titulo="Ocupación" valor={`${pool.ocupacion} %`} alerta={pool.ocupacion >= Number(process.env.ALERTA_POOL_PORCENTAJE ?? 80)} />
          <Tarjeta titulo="Libres" valor={pool.libre} href="?estado=libre" />
          <Tarjeta titulo="Asignados" valor={pool.asignado} href="?estado=asignado" />
          <Tarjeta titulo="En cuarentena" valor={pool.cuarentena} href="?estado=cuarentena" />
          <Tarjeta titulo="Deshabilitados" valor={pool.deshabilitado} href="?estado=deshabilitado" />
        </div>
        {conError.length > 0 && (
          <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950">
            {conError.length} CVU con error de lectura: sus depósitos no se están leyendo. Revisá la clave o la cuenta en cargavirtual.
          </p>
        )}
      </Seccion>

      <Seccion
        titulo={`Cuentas (${cvus.length})`}
        accion={
          <nav className="flex gap-3 text-sm">
            {FILTROS.map((f) => (
              <a key={f} href={f === "todos" ? "?" : `?estado=${f}`} className={(filtro ?? "todos") === f ? "font-semibold underline" : "hover:underline"}>{f}</a>
            ))}
          </nav>
        }
      >
        <Tabla filas={cvus.length} vacio="No hay cuentas cargadas">
          <thead>
            <tr><th className={th}>#</th><th className={th}>CVU / alias</th><th className={th}>Titular · usuario / PV</th><th className={th}>Estado</th><th className={th}>Última lectura</th><th className={th}></th></tr>
          </thead>
          <tbody>
            {cvus.map((c) => (
              <tr key={c.id}>
                <td className={td}>{c.id}</td>
                <td className={`${td} font-mono text-xs`}>{c.alias ?? "—"}<br />{c.cvu}</td>
                <td className={td}>{c.titular ?? "—"}<br /><span className="text-xs text-zinc-500">{c.usuario} / {c.pv}</span></td>
                <td className={td}>
                  <Estado valor={c.estado} />
                  {c.estado === "cuarentena" && <div className="text-xs text-zinc-500">hasta {fecha(c.cuarentena_hasta)}</div>}
                  {!c.inicializado && c.estado !== "deshabilitado" && <div className="text-xs text-zinc-500">esperando primera lectura</div>}
                </td>
                <td className={td}>
                  {fecha(c.ultima_sync)}
                  {c.ultimo_error && <div className="max-w-xs text-xs text-red-700 dark:text-red-400">{c.ultimo_error}</div>}
                </td>
                <td className={td}>
                  {c.estado === "deshabilitado"
                    ? <FormAccion accion={alternarCvu.bind(null, c.id, true)} boton="Habilitar" variante="secundario" />
                    : c.estado !== "asignado" && (
                      <FormAccion accion={alternarCvu.bind(null, c.id, false)} boton="Deshabilitar" variante="peligro"
                        confirmar="¿Deshabilitar? No se va a asignar a nuevos cobros ni se va a leer." />
                    )}
                </td>
              </tr>
            ))}
          </tbody>
        </Tabla>
      </Seccion>

      <Seccion titulo="Agregar cuenta de cargavirtual">
        <FormAccion accion={agregarCvuAccion} boton="Agregar al pool" className="max-w-3xl space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <Campo etiqueta="Usuario"><input name="usuario" required autoComplete="off" className={input} /></Campo>
            <Campo etiqueta="Clave"><input name="clave" type="password" required autoComplete="new-password" className={input} /></Campo>
            <Campo etiqueta="Punto de venta"><input name="pv" required className={input} /></Campo>
            <div className="sm:col-span-2"><Campo etiqueta="CVU (22 dígitos)"><input name="cvu" required inputMode="numeric" className={`${input} font-mono`} /></Campo></div>
            <Campo etiqueta="Alias"><input name="alias" className={input} /></Campo>
            <Campo etiqueta="Titular (opcional)" ayuda="Si se deja vacío, se toma de cargavirtual."><input name="titular" className={input} /></Campo>
          </div>
        </FormAccion>
      </Seccion>
    </>
  );
}
