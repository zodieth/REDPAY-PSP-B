"use server";

import { revalidatePath } from "next/cache";
import * as core from "@redpagos/core";
import { intentar, texto, type Resultado } from "@/lib/acciones";
import { requiereComercio } from "@/lib/sesion";

// El comercio sale siempre de la sesión, nunca del formulario.

export async function crearWebhookAccion(_prev: Resultado, form: FormData): Promise<Resultado> {
  const u = await requiereComercio();
  return intentar(async () => {
    const w = await core.crearWebhook(u.comercio_id, texto(form, "url"));
    revalidatePath("/panel");
    return { ok: "Webhook creado. Secreto para verificar la firma:", secreto: w.secreto };
  });
}

export async function alternarWebhookAccion(id: string, activo: boolean): Promise<Resultado> {
  const u = await requiereComercio();
  return intentar(async () => {
    await core.actualizarWebhook(u.comercio_id, id, { activo });
    revalidatePath("/panel");
    return { ok: activo ? "Activado" : "Pausado" };
  });
}

export async function probarWebhookAccion(id: string): Promise<Resultado> {
  const u = await requiereComercio();
  return intentar(async () => {
    await core.enviarPing(u.comercio_id, id);
    return { ok: "Ping encolado; sale en unos segundos" };
  });
}

export async function cambiarClaveComercio(_prev: Resultado, form: FormData): Promise<Resultado> {
  const u = await requiereComercio();
  return intentar(async () => {
    await core.cambiarClave(u.id, String(form.get("clave") ?? ""));
    return { ok: "Clave cambiada" };
  });
}
