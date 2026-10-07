import Link from "next/link";
import { salir } from "@/app/sesion";

export function Barra({ titulo, enlaces, usuario }: { titulo: string; enlaces: [string, string][]; usuario: string }) {
  return (
    <header className="border-b border-zinc-200 dark:border-zinc-800">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-6 py-3">
        <span className="font-semibold">{titulo}</span>
        <nav className="flex flex-wrap gap-4 text-sm">
          {enlaces.map(([href, nombre]) => (
            <Link key={href} href={href} className="text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100">
              {nombre}
            </Link>
          ))}
        </nav>
        <form action={salir} className="ml-auto flex items-center gap-3 text-sm">
          <span className="text-zinc-500">{usuario}</span>
          <button className="text-zinc-600 underline-offset-2 hover:underline dark:text-zinc-400">Salir</button>
        </form>
      </div>
    </header>
  );
}
