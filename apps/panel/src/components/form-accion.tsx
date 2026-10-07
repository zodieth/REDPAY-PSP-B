"use client";

import { startTransition, useActionState, useEffect, useRef, type ReactNode } from "react";
import type { Resultado } from "@/lib/acciones";

type Props = {
  accion: (prev: Resultado, form: FormData) => Promise<Resultado>;
  children?: ReactNode;
  boton: string;
  className?: string;
  // Pide confirmación antes de enviar (acciones que mueven plata o revocan accesos).
  confirmar?: string;
  variante?: "primario" | "secundario" | "peligro";
};

const BOTON = {
  primario: "bg-zinc-900 text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300",
  secundario: "border border-zinc-300 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800",
  peligro: "border border-red-300 text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950",
};

export function FormAccion({ accion, children, boton, className = "", confirmar, variante = "primario" }: Props) {
  const [estado, enviar, pendiente] = useActionState(accion, null);
  const form = useRef<HTMLFormElement>(null);

  // Con action={...} React vacía el form siempre, aunque falle. Enviamos a mano
  // para conservar lo cargado si hay error, y lo limpiamos sólo si salió bien.
  useEffect(() => {
    if (estado?.ok) form.current?.reset();
  }, [estado]);

  return (
    <form
      ref={form}
      className={className}
      onSubmit={(e) => {
        e.preventDefault();
        if (confirmar && !window.confirm(confirmar)) return;
        const datos = new FormData(e.currentTarget);
        startTransition(() => enviar(datos));
      }}
    >
      {children}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pendiente}
          className={`rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50 ${BOTON[variante]}`}
        >
          {pendiente ? "…" : boton}
        </button>
        {estado?.error && <p className="text-sm text-red-600 dark:text-red-400">{estado.error}</p>}
        {estado?.ok && <p className="text-sm text-emerald-700 dark:text-emerald-400">{estado.ok}</p>}
      </div>
      {estado?.secreto && (
        <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950">
          <p className="mb-1 font-medium">Copialo ahora: no se vuelve a mostrar.</p>
          <code className="break-all select-all">{estado.secreto}</code>
        </div>
      )}
    </form>
  );
}
