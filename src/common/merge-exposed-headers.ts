import type { NextFunction, Request, Response } from 'express';

/**
 * `Access-Control-Expose-Headers` writes merge instead of replacing (042, open from 036 Wave 4).
 *
 * The CORS setup in `main.ts` exposes the headers every response needs readable cross-origin —
 * `X-Company-Id` (036 B17) and `X-Total-Count` among them. Thirteen file-download handlers then
 * call `res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition')`, and a plain
 * `setHeader` **replaces** the list the CORS middleware already wrote — so exactly the download
 * responses hid `X-Company-Id`, and the wrong-company tab warning never fired on them. The same
 * failure already happened once with `X-Total-Count` (see the comment in `main.ts`).
 *
 * Fixed here once rather than in each controller: a later `setHeader` on this one header is
 * folded into whatever the response already carries, names de-duplicated case-insensitively with
 * the first spelling kept. Every other header behaves exactly as before, and a controller added
 * tomorrow with the same line cannot reintroduce the bug.
 */
const EXPOSE_HEADER = 'access-control-expose-headers';

type HeaderValue = number | string | readonly string[];

/** The union of two comma-separated header values, de-duplicated case-insensitively. */
export function mergedExposedHeaders(
  existing: HeaderValue | undefined,
  added: HeaderValue,
): string {
  const names = new Map<string, string>();
  for (const value of [existing, added]) {
    if (value === undefined || value === null) continue;
    const parts = Array.isArray(value) ? value : [String(value)];
    for (const part of parts.flatMap((p) => String(p).split(','))) {
      const name = part.trim();
      if (name && !names.has(name.toLowerCase())) {
        names.set(name.toLowerCase(), name);
      }
    }
  }
  return [...names.values()].join(', ');
}

/** Express middleware: wraps `res.setHeader` so the exposed-headers list only ever grows. */
export function mergeExposedHeaders(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const original = res.setHeader.bind(res);
  res.setHeader = ((name: string, value: HeaderValue) => {
    if (typeof name === 'string' && name.toLowerCase() === EXPOSE_HEADER) {
      return original(name, mergedExposedHeaders(res.getHeader(name), value));
    }
    return original(name, value as never);
  }) as Response['setHeader'];
  next();
}
