import { redirect } from "next/navigation";
import { usuarioActual } from "@/lib/sesion";

export default async function Inicio() {
  const u = await usuarioActual();
  redirect(u ? "/admin" : "/login");
}
