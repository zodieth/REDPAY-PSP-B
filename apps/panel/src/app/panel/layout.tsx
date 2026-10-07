import { obtenerComercio } from "@redpagos/core";
import { Barra } from "@/components/barra";
import { requiereComercio } from "@/lib/sesion";

export default async function LayoutComercio({ children }: LayoutProps<"/panel">) {
  const u = await requiereComercio();
  const comercio = await obtenerComercio(u.comercio_id);
  return (
    <>
      <Barra
        titulo={`redpagos · ${comercio.nombre}`}
        usuario={u.email}
        enlaces={[["/panel", "Resumen"], ["/panel#cobros", "Cobros"], ["/panel#movimientos", "Movimientos"], ["/panel#integracion", "Integración"]]}
      />
      <main className="mx-auto max-w-6xl space-y-10 px-6 py-8">{children}</main>
    </>
  );
}
