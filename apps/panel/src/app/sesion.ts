"use server";

import { redirect } from "next/navigation";
import { verificarLogin } from "@redpagos/core";
import { cerrarSesion, crearSesion } from "@/lib/sesion";
import { texto, type Resultado } from "@/lib/acciones";

export async function ingresar(_prev: Resultado, form: FormData): Promise<Resultado> {
  const u = await verificarLogin(texto(form, "email"), String(form.get("clave") ?? ""));
  if (!u) return { error: "Email o clave incorrectos" };
  await crearSesion(u.id);
  redirect(u.rol === "admin" ? "/admin" : "/panel");
}

export async function salir() {
  await cerrarSesion();
  redirect("/login");
}
