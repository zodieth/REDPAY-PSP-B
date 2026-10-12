"use server";

import { redirect } from "next/navigation";
import { verificarLogin } from "@redpagos/core";
import { cerrarSesion, crearSesion } from "@/lib/sesion";
import { texto, type Resultado } from "@/lib/acciones";

export async function ingresar(_prev: Resultado, form: FormData): Promise<Resultado> {
  const u = await verificarLogin(texto(form, "email"), String(form.get("clave") ?? ""));
  // El panel es sólo para el equipo de redpagos: los comercios ven sus movimientos desde su tienda.
  if (!u || u.rol !== "admin") return { error: "Email o clave incorrectos" };
  await crearSesion(u.id);
  redirect("/admin");
}

export async function salir() {
  await cerrarSesion();
  redirect("/login");
}
