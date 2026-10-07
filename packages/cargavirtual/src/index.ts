// Cliente de cargavirtual: se loguea con el usuario de servicio, guarda la
// cookie de sesión y, si vence (redirect a /Account/LoginNuevo), se vuelve a loguear.
// No hay API: ConsultaDeDepositos devuelve HTML y lo parseamos.
import { fetch as undiciFetch, ProxyAgent, type RequestInit as UndiciInit } from "undici";

const BASE = "https://net.cargavirtual.com";

// cargavirtual no acepta conexiones desde fuera de Argentina (desde Railway da timeout).
// CARGAVIRTUAL_PROXY=http://usuario:clave@host:puerto hace salir sólo estos pedidos por
// un proxy con IP argentina. Conviene IP fija: la sesión va con cookie.
const g0 = globalThis as unknown as { __cvProxy?: ProxyAgent | null };
function proxy() {
  if (g0.__cvProxy === undefined) {
    const url = process.env.CARGAVIRTUAL_PROXY;
    g0.__cvProxy = url ? new ProxyAgent(url) : null;
  }
  return g0.__cvProxy ?? undefined;
}

export type Deposito = {
  id: string;
  fecha_deposito: string | null;
  fecha_carga: string | null;
  banco: string;
  cuenta: string;
  nro_transaccion: string;
  importe: number;
  observaciones: string;
};

export type Cuenta = {
  nombre: string | null;
  usuario: string | null;
  punto_de_venta: string | null;
};

// Credenciales de una cuenta recaudadora (la clave ya descifrada).
export type Credenciales = { id: number; usuario: string; clave: string; pv: string };

// Una sesión por cuenta, en globalThis para compartirla entre el poller y las rutas.
type Sesion = { jar: Map<string, string>; login: Promise<void> | null };
const g = globalThis as unknown as { __cvSesiones?: Map<number, Sesion> };
const sesiones = (g.__cvSesiones ??= new Map());

const sesion = (cuentaId: number) => {
  let s = sesiones.get(cuentaId);
  if (!s) sesiones.set(cuentaId, (s = { jar: new Map(), login: null }));
  return s;
};

// Al cambiar usuario/clave/PV de una cuenta hay que tirar su sesión.
export const olvidarSesion = (cuentaId: number) => sesiones.delete(cuentaId);

type Respuesta = Awaited<ReturnType<typeof undiciFetch>>;

function guardarCookies(jar: Map<string, string>, res: Respuesta) {
  for (const c of res.headers.getSetCookie()) {
    const [par] = c.split(";");
    const i = par.indexOf("=");
    const nombre = par.slice(0, i).trim();
    const valor = par.slice(i + 1).trim();
    if (valor) jar.set(nombre, valor);
    else jar.delete(nombre);
  }
}

async function pedir(jar: Map<string, string>, path: string, init: UndiciInit = {}) {
  let res: Respuesta;
  try {
    res = await undiciFetch(BASE + path, {
      ...init,
      redirect: "manual",
      dispatcher: proxy(),
      signal: AbortSignal.timeout(20_000),
      headers: {
        ...(init.headers as Record<string, string>),
        cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
        "user-agent": "Mozilla/5.0 redpagos",
      },
    });
  } catch (e) {
    // "fetch failed" solo no dice nada: sumamos la causa real.
    const causa = (e as { cause?: { code?: string; message?: string } }).cause;
    const codigo = causa?.code ?? causa?.message ?? (e instanceof Error ? e.name : "");
    const pista = /CONNECT_TIMEOUT|TimeoutError|ETIMEDOUT/.test(codigo) && !process.env.CARGAVIRTUAL_PROXY
      ? " (cargavirtual no responde desde esta IP: configurá CARGAVIRTUAL_PROXY con un proxy argentino)"
      : "";
    throw new Error(`No se pudo conectar con cargavirtual: ${codigo || "error de red"}${pista}`);
  }
  guardarCookies(jar, res);
  return res;
}

// Con redirect manual, res.url es la URL pedida: sólo sirve el header location.
// Login OK redirige a www.cargavirtual.com/clientes/autologin2.php (no hace falta seguirlo).
const vaAlLogin = (res: Respuesta) => /\/Account\/Login/i.test(res.headers.get("location") ?? "");

async function login(c: Credenciales, jar: Map<string, string>) {
  jar.clear();
  await pedir(jar, "/Account/LoginNuevo");
  const res = await pedir(jar, "/Account/LoginNuevo", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ Usuario: c.usuario, Clave: c.clave, PV: c.pv, Recordarme: "true" }),
  });
  if (res.status !== 302 || vaAlLogin(res)) {
    jar.clear();
    throw new Error(`Login rechazado por cargavirtual (HTTP ${res.status})`);
  }
}

function asegurarLogin(c: Credenciales) {
  const s = sesion(c.id);
  s.login ??= login(c, s.jar).finally(() => {
    s.login = null;
  });
  return s.login;
}

async function traerHtml(c: Credenciales, params: Record<string, string>) {
  const { jar } = sesion(c.id);
  const path = "/Listados/ConsultaDeDepositos?" + new URLSearchParams(params);
  for (let intento = 0; intento < 2; intento++) {
    if (!jar.size) await asegurarLogin(c);
    const res = await pedir(jar, path);
    if (res.status === 200) return res.text();
    if (res.status === 302 && vaAlLogin(res)) {
      jar.clear(); // sesión vencida: re-login y reintento
      continue;
    }
    throw new Error(`cargavirtual respondió HTTP ${res.status}`);
  }
  throw new Error("No se pudo mantener la sesión de cargavirtual");
}

const ENTIDADES: Record<string, string> = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " ",
};
const texto = (html: string) =>
  html
    .replace(/<[^>]*>/g, "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&[a-z#0-9]+;/gi, (e) => ENTIDADES[e] ?? e)
    .replace(/\s+/g, " ")
    .trim();

// "6/10/2026 14:44:07" (hora Argentina) -> ISO con -03:00
function fechaIso(s: string) {
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2}):(\d{2})$/);
  if (!m) return s || null;
  const [, d, mo, y, h, mi, se] = m;
  const p = (x: string) => x.padStart(2, "0");
  return `${y}-${p(mo)}-${p(d)}T${p(h)}:${mi}:${se}-03:00`;
}

// "$ 1.234,56" -> 1234.56
const importe = (s: string) => Number(s.replace(/[^\d,-]/g, "").replace(",", "."));

function parsear(html: string) {
  const tabla = html.match(/<table[^>]*grid-table[\s\S]*?<\/table>/i)?.[0] ?? "";
  const tbody = tabla.match(/<tbody[\s\S]*?<\/tbody>/i)?.[0] ?? "";
  const filas = [...tbody.matchAll(/<tr[\s\S]*?<\/tr>/gi)]
    .map((tr) => [...tr[0].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((td) => texto(td[1])))
    .filter((c) => c.length >= 8);
  const total = Number(html.match(/(\d+)\s*Resultados/i)?.[1] ?? filas.length);
  // Encabezado: "Bienvenido: <nombre> Usuario: <u> Punto de Venta: <pv> Cerrar Sesión"
  const plano = texto(html);
  const cuenta: Cuenta = {
    nombre: plano.match(/Bienvenido:\s*(.+?)\s*Usuario:/i)?.[1] ?? null,
    usuario: plano.match(/Bienvenido:.*?Usuario:\s*(\S+)/i)?.[1] ?? null,
    punto_de_venta: plano.match(/Punto de Venta:\s*(\d+)/i)?.[1] ?? null,
  };
  const depositos: Deposito[] = filas.map(([id, fDep, fCarga, banco, cuenta, nroTrans, imp, obs]) => ({
    id,
    fecha_deposito: fechaIso(fDep),
    fecha_carga: fechaIso(fCarga),
    banco,
    cuenta,
    nro_transaccion: nroTrans,
    importe: importe(imp),
    observaciones: obs,
  }));
  return { cuenta, total, depositos };
}

export async function buscarDepositos(
  c: Credenciales,
  {
    desde = "",
    hasta = "",
    horaDesde = "00:00",
    horaHasta = "23:59",
    filtro = "",
  }: { desde?: string; hasta?: string; horaDesde?: string; horaHasta?: string; filtro?: string },
) {
  const base: Record<string, string> = {
    esPostBack: "true", paramID: "", id: "",
    desde, hDesde: `${horaDesde} Hs.`,
    hasta, hHasta: `${horaHasta} Hs.`,
    filtro,
  };
  // La grilla (Grid.Mvc) puede paginar: seguimos con grid-page mientras falten filas.
  const primera = parsear(await traerHtml(c, base));
  const depositos = [...primera.depositos];
  for (let page = 2; depositos.length < primera.total && page <= 200; page++) {
    const { depositos: mas } = parsear(await traerHtml(c, { ...base, "grid-page": String(page) }));
    if (!mas.length || depositos.some((d) => d.id === mas[0].id)) break;
    depositos.push(...mas);
  }
  return { cuenta: primera.cuenta, total: primera.total, depositos };
}
