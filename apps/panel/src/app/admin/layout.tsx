import { Barra } from "@/components/barra";
import { requiereAdmin } from "@/lib/sesion";

export default async function LayoutAdmin({ children }: LayoutProps<"/admin">) {
  const u = await requiereAdmin();
  return (
    <>
      <Barra
        titulo="redpagos · Backoffice"
        usuario={u.email}
        enlaces={[
          ["/admin", "Resumen"],
          ["/admin/comercios", "Comercios"],
          ["/admin/cvus", "CVUs"],
          ["/admin/huerfanos", "Huérfanos"],
          ["/admin/usuarios", "Equipo"],
        ]}
      />
      <main className="mx-auto max-w-6xl space-y-10 px-6 py-8">{children}</main>
    </>
  );
}
