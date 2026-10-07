"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import * as core from "@redpagos/core";
import { intentar, texto, type Resultado } from "@/lib/acciones";
import { aCentavos, numero } from "@/lib/formato";
import { requiereAdmin } from "@/lib/sesion";

const actor = (u: core.Usuario) => u.email;
const ficha = (id: string) => `/admin/comercios/${id}`;

// "4,5" (%) -> 450 pb. Días con decimales -> horas enteras.
const pb = (s: string) => Math.round(numero(s) * 100);
const horas = (s: string) => Math.round(numero(s) * 24);

export async function crearComercioAccion(_prev: Resultado, form: FormData): Promise<Resultado> {
  const u = await requiereAdmin();
  let id = "";
  const r = await intentar(async () => {
    const comision = texto(form, "comision");
    const c = await core.crearComercio({
      nombre: texto(form, "nombre"),
      cuit: texto(form, "cuit") || null,
      ...(comision ? { comision_pb: pb(comision) } : {}),
    }, actor(u));
    id = c.id;
  });
  if (r?.error) return r;
  redirect(ficha(id));
}

export async function guardarConfiguracion(id: string, _prev: Resultado, form: FormData): Promise<Resultado> {
  const u = await requiereAdmin();
  return intentar(async () => {
    await core.actualizarComercio(id, {
      nombre: texto(form, "nombre"),
      cuit: texto(form, "cuit") || null,
      comision_pb: pb(texto(form, "comision")),
      bloqueo_horas: horas(texto(form, "bloqueo_dias")),
      cuarentena_pagado_horas: horas(texto(form, "cuarentena_pagado_dias")),
      cuarentena_vencido_horas: horas(texto(form, "cuarentena_vencido_dias")),
      activo: form.get("activo") === "on",
    }, actor(u));
    revalidatePath(ficha(id));
    return { ok: "Configuración guardada" };
  });
}

export async function registrarRetiroAccion(id: string, _prev: Resultado, form: FormData): Promise<Resultado> {
  const u = await requiereAdmin();
  return intentar(async () => {
    const importe = aCentavos(texto(form, "importe"));
    if (!(importe > 0)) return { error: "Importe inválido" };
    await core.registrarRetiro(id, {
      importe,
      entregado_por: u.nombre ? `${u.nombre} (${u.email})` : u.email,
      recibido_por: texto(form, "recibido_por"),
      comprobante: texto(form, "comprobante") || undefined,
      notas: texto(form, "notas") || undefined,
    });
    revalidatePath(ficha(id));
    return { ok: "Retiro registrado" };
  });
}

export async function registrarAjusteAccion(id: string, _prev: Resultado, form: FormData): Promise<Resultado> {
  const u = await requiereAdmin();
  return intentar(async () => {
    const importe = aCentavos(texto(form, "importe"));
    if (!Number.isFinite(importe) || importe === 0) return { error: "Importe inválido (usá - para descontar)" };
    await core.registrarAjuste(id, importe, texto(form, "descripcion"), actor(u));
    revalidatePath(ficha(id));
    return { ok: "Ajuste registrado" };
  });
}

export async function crearUsuarioComercio(id: string, _prev: Resultado, form: FormData): Promise<Resultado> {
  await requiereAdmin();
  return intentar(async () => {
    const clave = core.claveTemporal();
    const nuevo = await core.crearUsuario({ email: texto(form, "email"), nombre: texto(form, "nombre"), clave, rol: "comercio", comercio_id: id });
    revalidatePath(ficha(id));
    return { ok: `Usuario ${nuevo.email} creado. Clave temporal:`, secreto: clave };
  });
}

export async function crearAdmin(_prev: Resultado, form: FormData): Promise<Resultado> {
  await requiereAdmin();
  return intentar(async () => {
    const clave = core.claveTemporal();
    const nuevo = await core.crearUsuario({ email: texto(form, "email"), nombre: texto(form, "nombre"), clave, rol: "admin" });
    revalidatePath("/admin/usuarios");
    return { ok: `Admin ${nuevo.email} creado. Clave temporal:`, secreto: clave };
  });
}

export async function alternarUsuario(usuarioId: string, activo: boolean, ruta: string): Promise<Resultado> {
  const u = await requiereAdmin();
  if (usuarioId === u.id) return { error: "No podés desactivarte a vos mismo" };
  return intentar(async () => {
    await core.activarUsuario(usuarioId, activo);
    revalidatePath(ruta);
    return { ok: activo ? "Usuario activado" : "Usuario desactivado" };
  });
}

export async function cambiarMiClave(_prev: Resultado, form: FormData): Promise<Resultado> {
  const u = await requiereAdmin();
  return intentar(async () => {
    await core.cambiarClave(u.id, String(form.get("clave") ?? ""));
    return { ok: "Clave cambiada" };
  });
}

export async function crearApiKeyAccion(id: string): Promise<Resultado> {
  await requiereAdmin();
  return intentar(async () => {
    const clave = await core.crearApiKey(id);
    revalidatePath(ficha(id));
    return { ok: "API key creada:", secreto: clave };
  });
}

export async function revocarApiKeyAccion(id: string, prefijo: string): Promise<Resultado> {
  await requiereAdmin();
  return intentar(async () => {
    await core.revocarApiKey(id, prefijo);
    revalidatePath(ficha(id));
    return { ok: "Revocada" };
  });
}

export async function agregarCvuAccion(_prev: Resultado, form: FormData): Promise<Resultado> {
  await requiereAdmin();
  return intentar(async () => {
    const c = await core.agregarCvu({
      usuario: texto(form, "usuario"),
      clave: String(form.get("clave") ?? ""),
      pv: texto(form, "pv"),
      cvu: texto(form, "cvu").replace(/\D/g, ""),
      alias: texto(form, "alias") || undefined,
      titular: texto(form, "titular") || undefined,
    });
    revalidatePath("/admin/cvus");
    return { ok: `CVU ${c.id} agregado; el worker lo lee en unos segundos y queda disponible` };
  });
}

export async function alternarCvu(id: number, habilitado: boolean): Promise<Resultado> {
  await requiereAdmin();
  return intentar(async () => {
    await core.actualizarCvu(id, { habilitado });
    revalidatePath("/admin/cvus");
    return { ok: habilitado ? "Habilitado" : "Deshabilitado" };
  });
}

export async function imputarAccion(depositoId: string, _prev: Resultado, form: FormData): Promise<Resultado> {
  await requiereAdmin();
  return intentar(async () => {
    const cobroId = texto(form, "cobro_id_manual") || texto(form, "cobro_id");
    if (!/^[0-9a-f-]{36}$/i.test(cobroId)) return { error: "Elegí un cobro o pegá un id válido" };
    const cobro = await core.imputarManual(depositoId, cobroId);
    revalidatePath("/admin/huerfanos");
    return { ok: `Imputado: el cobro quedó ${cobro.estado}` };
  });
}
