// Usuarios del panel (backoffice y comercios).
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { db, fila, filas } from "@redpagos/db";
import { ErrorRedpagos } from "./comun.ts";

const scryptAsync = promisify(scrypt) as (clave: string, sal: Buffer, largo: number) => Promise<Buffer>;

export type Rol = "admin" | "comercio";

export type Usuario = {
  id: string;
  email: string;
  nombre: string | null;
  rol: Rol;
  comercio_id: string | null;
  activo: boolean;
  ultimo_login: Date | null;
  creado_at: Date;
};

const COLUMNAS = "id, email, nombre, rol, comercio_id, activo, ultimo_login, creado_at";

async function hashear(clave: string) {
  const sal = randomBytes(16);
  return `${sal.toString("hex")}.${(await scryptAsync(clave, sal, 64)).toString("hex")}`;
}

async function coincide(clave: string, guardado: string) {
  const [sal, hash] = guardado.split(".");
  const calculado = await scryptAsync(clave, Buffer.from(sal, "hex"), 64);
  return timingSafeEqual(calculado, Buffer.from(hash, "hex"));
}

// Clave legible para entregar a mano (se muestra una sola vez).
export const claveTemporal = () => randomBytes(9).toString("base64url");

export async function crearUsuario(d: { email: string; nombre?: string; clave: string; rol: Rol; comercio_id?: string }) {
  const email = d.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new ErrorRedpagos("email_invalido", "El email no es válido");
  if (d.clave.length < 8) throw new ErrorRedpagos("clave_corta", "La clave tiene que tener al menos 8 caracteres");
  const u = await fila<Usuario>(db(), `
    INSERT INTO usuarios (email, nombre, clave_hash, rol, comercio_id) VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (email) DO NOTHING RETURNING ${COLUMNAS}`,
    [email, d.nombre || null, await hashear(d.clave), d.rol, d.rol === "comercio" ? d.comercio_id : null]);
  if (!u) throw new ErrorRedpagos("email_duplicado", "Ya existe un usuario con ese email", 409);
  return u;
}

// Devuelve el usuario si email y clave coinciden y está activo (y su comercio también).
export async function verificarLogin(email: string, clave: string) {
  const u = await fila<Usuario & { clave_hash: string; comercio_activo: boolean | null }>(db(), `
    SELECT u.*, c.activo AS comercio_activo FROM usuarios u LEFT JOIN comercios c ON c.id = u.comercio_id
    WHERE u.email = $1`, [email.trim().toLowerCase()]);
  if (!u || !(await coincide(clave, u.clave_hash))) return null;
  if (!u.activo || u.comercio_activo === false) return null;
  await db().query("UPDATE usuarios SET ultimo_login = now() WHERE id = $1", [u.id]);
  const { clave_hash: _, comercio_activo: __, ...usuario } = u;
  return usuario as Usuario;
}

export const obtenerUsuario = async (id: string) =>
  (await fila<Usuario>(db(), `SELECT ${COLUMNAS} FROM usuarios WHERE id = $1 AND activo`, [id])) ?? null;

export const listarUsuarios = (f: { comercio_id?: string; rol?: Rol } = {}) =>
  filas<Usuario>(db(), `
    SELECT ${COLUMNAS} FROM usuarios
    WHERE ($1::uuid IS NULL OR comercio_id = $1) AND ($2::text IS NULL OR rol = $2) ORDER BY creado_at`,
    [f.comercio_id ?? null, f.rol ?? null]);

export async function cambiarClave(id: string, clave: string) {
  if (clave.length < 8) throw new ErrorRedpagos("clave_corta", "La clave tiene que tener al menos 8 caracteres");
  await db().query("UPDATE usuarios SET clave_hash = $2 WHERE id = $1", [id, await hashear(clave)]);
}

export async function activarUsuario(id: string, activo: boolean) {
  await db().query("UPDATE usuarios SET activo = $2 WHERE id = $1", [id, activo]);
}

// Primer arranque: si no hay ningún admin, lo crea con ADMIN_EMAIL / ADMIN_PASSWORD.
export async function sembrarAdmin() {
  const email = process.env.ADMIN_EMAIL, clave = process.env.ADMIN_PASSWORD;
  if (!email || !clave) return;
  const hay = await fila(db(), "SELECT 1 FROM usuarios WHERE rol = 'admin' LIMIT 1");
  if (!hay) await crearUsuario({ email, clave, rol: "admin", nombre: "Administrador" });
}
