import { FormAccion } from "@/components/form-accion";
import { Campo, input } from "@/components/ui";
import { ingresar } from "../sesion";

export default function Login() {
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">redpagos</h1>
          <p className="text-sm text-zinc-500">Ingresá con tu email y clave</p>
        </div>
        <FormAccion accion={ingresar} boton="Ingresar" className="space-y-4">
          <Campo etiqueta="Email">
            <input name="email" type="email" required autoComplete="username" className={input} />
          </Campo>
          <Campo etiqueta="Clave">
            <input name="clave" type="password" required autoComplete="current-password" className={input} />
          </Campo>
        </FormAccion>
      </div>
    </main>
  );
}
