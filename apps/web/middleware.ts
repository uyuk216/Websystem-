import { NextResponse, type NextRequest } from 'next/server';

const LOCALES = ['ja', 'en'] as const;

/** First supported language in Accept-Language order (q-values respected); Japanese by default. */
export function pickLocale(header: string | null): 'ja' | 'en' {
  const tags = (header ?? '')
    .split(',')
    .map((part, i) => {
      const [tag = '', ...params] = part.trim().split(';');
      const q = Number(params.find((p) => p.trim().startsWith('q='))?.split('=')[1] ?? 1);
      return { lang: tag.trim().toLowerCase().split('-')[0], q: Number.isNaN(q) ? 0 : q, i };
    })
    .filter((x) => x.q > 0)
    .sort((a, b) => b.q - a.q || a.i - b.i);
  for (const x of tags) if (x.lang === 'ja' || x.lang === 'en') return x.lang;
  return 'ja';
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (LOCALES.some((l) => pathname === `/${l}` || pathname.startsWith(`/${l}/`))) return NextResponse.next();
  const url = req.nextUrl.clone();
  url.pathname = `/${pickLocale(req.headers.get('accept-language'))}${pathname === '/' ? '' : pathname}`;
  return NextResponse.redirect(url); // query string is kept (mail links carry ?c=&t=)
}

export const config = { matcher: ['/((?!api|_next|favicon.ico|.*\\..*).*)'] };
