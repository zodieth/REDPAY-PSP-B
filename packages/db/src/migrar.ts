import { cerrarDb } from "./index.ts";
import { migrar } from "./migraciones.ts";

const aplicadas = await migrar();
console.log(aplicadas.length ? `Migraciones aplicadas: ${aplicadas.join(", ")}` : "La base ya estaba al día");
await cerrarDb();
