// Chequeo rápido: sin cookie de sesión, al login. La verificación real (firma,
// usuario activo, rol) la hace cada página y cada acción con requiereAdmin.
import { NextResponse, type NextRequest } from "next/server";

export function proxy(req: NextRequest) {
  if (req.nextUrl.pathname === "/login") return NextResponse.next();
  if (!req.cookies.has("rp_sesion")) return NextResponse.redirect(new URL("/login", req.nextUrl));
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
