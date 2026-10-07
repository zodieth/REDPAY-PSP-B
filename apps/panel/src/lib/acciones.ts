import "server-only";
import { ErrorRedpagos } from "@redpagos/core";

// Lo que devuelve una acción de formulario. secreto: algo que se muestra una sola
// vez (API key, clave temporal, secreto de webhook).
export type Resultado = { ok?: string; error?: string; secreto?: string } | null;

// Convierte errores de negocio en mensajes para el formulario; el resto se loguea.
export async function intentar(fn: () => Promise<Resultado | void>): Promise<Resultado> {
  try {
    return (await fn()) ?? { ok: "Listo" };
  } catch (e) {
    if (e instanceof ErrorRedpagos) return { error: e.message };
    console.error(e);
    return { error: "Error inesperado; revisá los logs" };
  }
}

export const texto = (form: FormData, k: string) => String(form.get(k) ?? "").trim();
