import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

// Error de negocio: lo que la API devuelve tal cual al cliente.
export class ErrorRedpagos extends Error {
  codigo: string;
  status: number;
  constructor(codigo: string, mensaje: string, status = 400) {
    super(mensaje);
    this.codigo = codigo;
    this.status = status;
  }
}

// Comisión sobre el bruto, en centavos. pb = puntos básicos (600 = 6 %).
export const comision = (importe: number, pb: number) => Math.round((importe * pb) / 10_000);

// "1.234,56" de cargavirtual ya viene como 1234.56 -> 123456 centavos.
export const aCentavos = (pesos: number) => Math.round(pesos * 100);

// AES-256-GCM para las claves de cargavirtual guardadas en la DB.
const llave = () => {
  const clave = process.env.CLAVE_CIFRADO;
  if (!clave) throw new Error("Falta CLAVE_CIFRADO");
  return createHash("sha256").update(clave).digest();
};

export function cifrar(texto: string) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", llave(), iv);
  const datos = Buffer.concat([c.update(texto, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), datos].map((b) => b.toString("base64")).join(".");
}

export function descifrar(guardado: string) {
  const [iv, tag, datos] = guardado.split(".").map((s) => Buffer.from(s, "base64"));
  const d = createDecipheriv("aes-256-gcm", llave(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(datos), d.final()]).toString("utf8");
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
