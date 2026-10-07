import { cerrarDb, migrar } from "./index.ts";

const aplicadas = await migrar();
console.log(aplicadas.length ? `Migraciones aplicadas: ${aplicadas.join(", ")}` : "La base ya estaba al día");
await cerrarDb();
