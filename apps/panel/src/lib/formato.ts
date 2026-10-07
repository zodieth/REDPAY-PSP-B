const ars = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" });

// Importes de la DB en centavos.
export const pesos = (centavos: number) => ars.format(centavos / 100);

export const fecha = (d: Date | string | null | undefined) =>
  d ? new Date(d).toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires", hourCycle: "h23", dateStyle: "short", timeStyle: "short" }) : "—";

// Puntos básicos a "6 %" / "4,5 %".
export const porcentaje = (pb: number) => `${(pb / 100).toLocaleString("es-AR", { maximumFractionDigits: 2 })} %`;

export const dias = (horas: number) => (horas / 24).toLocaleString("es-AR", { maximumFractionDigits: 2 });

// "1.234,56", "1234,56", "40.000" o "1234.56" -> centavos. NaN si no es un número.
// Sin coma, el punto es de miles si separa grupos de 3 ("40.000", "1.250.000").
export function aCentavos(texto: string) {
  let s = texto.replace(/[\s$]/g, "");
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, "");
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return NaN;
  return Math.round(Number(s) * 100);
}

// "4,5" -> 4.5
export const numero = (texto: string) => Number(texto.trim().replace(",", "."));
