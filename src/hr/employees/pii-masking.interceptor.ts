import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

import { PiiCipherService } from './pii-cipher.service';

/**
 * Marks a handler as one that is *supposed* to return unmasked PII — the audited
 * reveal endpoint, and nothing else. Without this, the interceptor masks.
 *
 * Opt-out rather than opt-in on purpose: a new endpoint added later that forgets to
 * think about PII gets the safe behaviour by default. The failure mode of the
 * inverse (forgetting to opt *in* to masking) is a leak.
 */
export const REVEALS_PII = 'reveals_pii';
export const RevealsPii = () => SetMetadata(REVEALS_PII, true);

/**
 * The regulated-PII field names the constitution names (Principle IV). Matched by
 * property name anywhere in the response tree, so a nested employee inside a list,
 * a payroll line, or a document response is covered without each of those having to
 * remember.
 */
const PII_FIELDS = new Set([
  'aadhaar',
  'aadhaarNumber',
  'pan',
  'panNumber',
  'bankAccountNumber',
  'uan',
]);

/**
 * Defence in depth over `EmployeesService`, which already returns masked values.
 *
 * This exists because "the service masks it" is a convention, and conventions are
 * one careless `select: { aadhaarEncrypted: true }` away from failing. The
 * interceptor is the net under that: whatever a handler returns, an Aadhaar-shaped
 * field leaves the process truncated unless the handler is explicitly marked
 * `@RevealsPii()`.
 *
 * It deliberately does NOT decrypt. If it encounters a value that still looks like
 * a stored envelope, that is a bug in the service layer, and the interceptor
 * replaces it with a redaction marker rather than silently emitting ciphertext that
 * a client would render as though it were data.
 */
@Injectable()
export class PiiMaskingInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const reveals = this.reflector.getAllAndOverride<boolean>(REVEALS_PII, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (reveals) return next.handle();

    return next.handle().pipe(map((body) => this.maskDeep(body)));
  }

  private maskDeep(value: unknown, depth = 0): unknown {
    // Guards against a pathological or cyclic structure turning a response into a
    // stack overflow. Nothing this API returns is legitimately this deep.
    if (depth > 12) return value;

    if (Array.isArray(value)) {
      return value.map((v) => this.maskDeep(v, depth + 1));
    }
    if (value === null || typeof value !== 'object') return value;
    // Dates, Buffers and other non-plain objects pass through untouched.
    if (Object.getPrototypeOf(value) !== Object.prototype) return value;

    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      // An *Encrypted column should never reach a response at all.
      if (key.endsWith('Encrypted')) {
        out[key] = v === null || v === undefined ? v : '[redacted]';
        continue;
      }
      if (PII_FIELDS.has(key) && typeof v === 'string') {
        out[key] = PiiCipherService.maskValue(v);
        continue;
      }
      out[key] = this.maskDeep(v, depth + 1);
    }
    return out;
  }
}
