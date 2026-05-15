// Auth middleware: redirect unauthenticated users to /login.
// Public routes: /, /login, /login/callback, /billing webhook landing.

import { NextResponse, type NextRequest } from 'next/server';

const PUBLIC = new Set(['/', '/login', '/login/callback', '/connect', '/terms', '/privacy']);

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC.has(pathname) || pathname.startsWith('/_next') || pathname.startsWith('/api')) {
    return NextResponse.next();
  }
  const session = req.cookies.get('session')?.value;
  if (!session) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('next', pathname);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
