import { serve } from "@hono/node-server";
import { migrar } from "@redpagos/db/migraciones";
import { app } from "./app.ts";

await migrar();
const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, () => console.log(`[api] escuchando en :${port}`));
