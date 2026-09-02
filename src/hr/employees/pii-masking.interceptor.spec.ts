import { Reflector } from '@nestjs/core';
import { of, lastValueFrom } from 'rxjs';

import { PiiMaskingInterceptor } from './pii-masking.interceptor';
import { PiiCipherService } from './pii-cipher.service';

/** Minimal ExecutionContext double — the interceptor only reads handler/class. */
const ctx = () =>
  ({
    getHandler: () => () => undefined,
    getClass: () => class {},
  }) as never;

const run = async (interceptor: PiiMaskingInterceptor, body: unknown) =>
  lastValueFrom(
    interceptor.intercept(ctx(), { handle: () => of(body) } as never),
  );

describe('PiiCipherService.maskValue', () => {
  it('keeps only the last four characters', () => {
    expect(PiiCipherService.maskValue('123456789012')).toBe('XXXXXXXX9012');
  });

  it('masks a value shorter than the visible window entirely', () => {
    // Never reveal the whole thing just because it is short — a 3-character value
    // would otherwise pass through in full.
    expect(PiiCipherService.maskValue('abc')).toBe('XXX');
    expect(PiiCipherService.maskValue('abcd')).toBe('XXXX');
  });
});

describe('PiiMaskingInterceptor', () => {
  let interceptor: PiiMaskingInterceptor;
  let reflector: Reflector;

  beforeEach(() => {
    reflector = new Reflector();
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    interceptor = new PiiMaskingInterceptor(reflector);
  });

  it('masks a PII field at the top level', async () => {
    const out = await run(interceptor, { uan: '100200300400', name: 'Asha' });
    expect(out).toEqual({ uan: 'XXXXXXXX0400', name: 'Asha' });
  });

  it('masks PII nested inside arrays and objects', async () => {
    const out = await run(interceptor, {
      items: [{ employee: { aadhaarNumber: '999988887777' } }],
    });
    expect(out).toEqual({
      items: [{ employee: { aadhaarNumber: 'XXXXXXXX7777' } }],
    });
  });

  it('redacts any *Encrypted column that leaks into a response', async () => {
    // The service layer should never select these. If one does, the interceptor
    // must not emit ciphertext that a client would render as data.
    const out = await run(interceptor, { aadhaarEncrypted: 'ZW5jcnlwdGVk' });
    expect(out).toEqual({ aadhaarEncrypted: '[redacted]' });
  });

  it('leaves a null PII value as null rather than masking it into a string', async () => {
    // "No Aadhaar on file" must stay distinguishable from "an Aadhaar you cannot see".
    const out = await run(interceptor, { uan: null, aadhaarEncrypted: null });
    expect(out).toEqual({ uan: null, aadhaarEncrypted: null });
  });

  it('passes non-PII fields through untouched', async () => {
    const d = new Date('2026-01-01T00:00:00.000Z');
    const out = await run(interceptor, { employeeCode: 'ACME-0001', joined: d });
    expect(out).toEqual({ employeeCode: 'ACME-0001', joined: d });
  });

  it('does not mask when the handler is marked @RevealsPii()', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
    const revealing = new PiiMaskingInterceptor(reflector);
    const out = await run(revealing, { uan: '100200300400' });
    expect(out).toEqual({ uan: '100200300400' });
  });
});
