// Al arrancar: si no hay ningún admin, lo crea con ADMIN_EMAIL / ADMIN_PASSWORD.
// Las migraciones las corren la API y el worker (o `npm run migrar`), no el panel.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { sembrarAdmin } = await import("@redpagos/core");
  try {
    await sembrarAdmin();
  } catch (e) {
    console.error("[panel] no se pudo crear el admin inicial (¿corriste las migraciones?):", (e as Error).message);
  }
}
