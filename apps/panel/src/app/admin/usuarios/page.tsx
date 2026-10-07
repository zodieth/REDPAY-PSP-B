import { listarUsuarios } from "@redpagos/core";
import { FormAccion } from "@/components/form-accion";
import { Campo, Estado, Seccion, Tabla, input, td, th } from "@/components/ui";
import { fecha } from "@/lib/formato";
import { requiereAdmin } from "@/lib/sesion";
import { alternarUsuario, cambiarMiClave, crearAdmin } from "../acciones";

export default async function Equipo() {
  const yo = await requiereAdmin();
  const admins = await listarUsuarios({ rol: "admin" });
  return (
    <>
      <Seccion titulo="Equipo de redpagos">
        <Tabla filas={admins.length}>
          <thead><tr><th className={th}>Usuario</th><th className={th}>Último ingreso</th><th className={th}></th></tr></thead>
          <tbody>
            {admins.map((u) => (
              <tr key={u.id}>
                <td className={td}>{u.nombre ?? "—"} {!u.activo && <Estado valor="inactivo" />}<br /><span className="text-xs text-zinc-500">{u.email}</span></td>
                <td className={td}>{fecha(u.ultimo_login)}</td>
                <td className={td}>
                  {u.id !== yo.id && (
                    <FormAccion accion={alternarUsuario.bind(null, u.id, !u.activo, "/admin/usuarios")} boton={u.activo ? "Desactivar" : "Activar"} variante="secundario" />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Tabla>
      </Seccion>

      <div className="grid gap-10 lg:grid-cols-2">
        <Seccion titulo="Agregar admin">
          <FormAccion accion={crearAdmin} boton="Crear" className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Campo etiqueta="Email"><input name="email" type="email" required className={input} /></Campo>
              <Campo etiqueta="Nombre"><input name="nombre" className={input} /></Campo>
            </div>
          </FormAccion>
        </Seccion>
        <Seccion titulo="Cambiar mi clave">
          <FormAccion accion={cambiarMiClave} boton="Cambiar" className="space-y-3">
            <Campo etiqueta="Clave nueva" ayuda="Al menos 8 caracteres">
              <input name="clave" type="password" required minLength={8} autoComplete="new-password" className={input} />
            </Campo>
          </FormAccion>
        </Seccion>
      </div>
    </>
  );
}
