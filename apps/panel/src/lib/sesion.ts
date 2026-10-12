// Sesión en una cookie firmada: <usuario_id>.<expira_unix>.<hmac>. En cada pedido
// se vuelve a leer el usuario de la DB, así desactivarlo corta el acceso al instante.
import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { obtenerUsuario, type Usuario } from "@redpagos/core";

export const COOKIE = "rp_sesion";
const DURACION_SEG = 12 * 3600;

const secreto = () => {
  const s = process.env.SESION_SECRETO;
  if (!s || s.length < 32) throw new Error("Falta SESION_SECRETO (al menos 32 caracteres)");
  return s;
};

const firma = (datos: string) => createHmac("sha256", secreto()).update(datos).digest("base64url");

export async function crearSesion(usuarioId: string) {
  const datos = `${usuarioId}.${Math.floor(Date.now() / 1000) + DURACION_SEG}`;
  (await cookies()).set(COOKIE, `${datos}.${firma(datos)}`, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: DURACION_SEG,
  });
}

export async function cerrarSesion() {
  (await cookies()).delete(COOKIE);
}

export const usuarioActual = cache(async (): Promise<Usuario | null> => {
  const valor = (await cookies()).get(COOKIE)?.value;
  if (!valor) return null;
  const [id, exp, sig] = valor.split(".");
  if (!id || !exp || !sig) return null;
  const esperada = firma(`${id}.${exp}`);
  if (esperada.length !== sig.length || !timingSafeEqual(Buffer.from(esperada), Buffer.from(sig))) return null;
  if (Number(exp) < Date.now() / 1000) return null;
  return obtenerUsuario(id);
});

export async function requiereAdmin() {
  const u = await usuarioActual();
  if (!u || u.rol !== "admin") redirect("/login");
  return u;
}
