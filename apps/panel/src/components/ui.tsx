import Link from "next/link";
import type { ReactNode } from "react";

export const input =
  "w-full rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900";
export const th = "px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-zinc-500";
export const td = "px-3 py-2 border-t border-zinc-200 dark:border-zinc-800 align-top";
export const tdNum = `${td} text-right tabular-nums whitespace-nowrap`;

export function Seccion({ titulo, id, children, accion }: { titulo: string; id?: string; children: ReactNode; accion?: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-6 space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <h2 className="text-lg font-semibold">{titulo}</h2>
        {accion}
      </div>
      {children}
    </section>
  );
}

export function Tarjeta({ titulo, valor, detalle, href, alerta }: {
  titulo: string; valor: ReactNode; detalle?: ReactNode; href?: string; alerta?: boolean;
}) {
  const cuerpo = (
    <div className={`rounded-lg border p-4 ${alerta
      ? "border-amber-400 bg-amber-50 dark:border-amber-700 dark:bg-amber-950"
      : "border-zinc-200 dark:border-zinc-800"}`}>
      <p className="text-xs uppercase tracking-wide text-zinc-500">{titulo}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{valor}</p>
      {detalle && <p className="mt-1 text-xs text-zinc-500">{detalle}</p>}
    </div>
  );
  return href ? <Link href={href} className="block hover:opacity-80">{cuerpo}</Link> : cuerpo;
}

export function Tabla({ children, vacio, filas }: { children: ReactNode; vacio?: string; filas: number }) {
  if (!filas) return <p className="text-sm text-zinc-500">{vacio ?? "Sin datos"}</p>;
  return (
    <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
      <table className="w-full text-sm">{children}</table>
    </div>
  );
}

const COLORES: Record<string, string> = {
  pagado: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  libre: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  pendiente: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
  asignado: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
  parcial: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  cuarentena: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  vencido: "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  cancelado: "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  borrador: "bg-zinc-100 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400",
  deshabilitado: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  inactivo: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
};

export function Estado({ valor }: { valor: string }) {
  return (
    <span className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${COLORES[valor] ?? COLORES.borrador}`}>
      {valor}
    </span>
  );
}

export function Campo({ etiqueta, children, ayuda }: { etiqueta: string; children: ReactNode; ayuda?: string }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">{etiqueta}</span>
      {children}
      {ayuda && <span className="block text-xs text-zinc-500">{ayuda}</span>}
    </label>
  );
}

const TIPOS: Record<string, string> = { cobro: "Cobro", comision: "Comisión", retiro: "Retiro", ajuste: "Ajuste" };
export const tipoMovimiento = (t: string) => TIPOS[t] ?? t;
