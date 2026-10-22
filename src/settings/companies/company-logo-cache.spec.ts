import type { Response } from 'express';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { logoVersionOf } from '../company-selection/company-selection.service';
import { CompaniesController } from './companies.controller';

/**
 * The company logo's cache headers (2026-10-14 — "the company logo takes too long to load when
 * switching companies").
 *
 * The client names the version it wants (`?v=`, from the selectable-companies list). That URL can
 * never serve different bytes, so it is cached for a year; anything else is revalidated against
 * the ETag, so a client holding an old URL still converges on the new logo.
 */

const REF = 'company-logos/c1/abc123';
const VERSION = logoVersionOf(REF) as string;

function build() {
  const companies = {
    getLogo: jest.fn().mockResolvedValue({
      bytes: Buffer.from('png-bytes'),
      contentType: 'image/png',
      version: VERSION,
    }),
  };
  const controller = new CompaniesController(
    companies as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { controller };
}

function response(ifNoneMatch?: string) {
  const headers: Record<string, string> = {};
  const res = {
    req: { headers: ifNoneMatch ? { 'if-none-match': ifNoneMatch } : {} },
    setHeader: jest.fn((name: string, value: string) => {
      headers[name] = value;
    }),
    status: jest.fn().mockReturnThis(),
    send: jest.fn(),
    end: jest.fn(),
  };
  return { res: res as unknown as Response & typeof res, headers };
}

const caller = { id: 'u1' } as AuthenticatedUser;

describe('GET settings/companies/:id/logo caching', () => {
  it('fingerprints a reference stably, and differently for a new upload', () => {
    expect(VERSION).toMatch(/^[0-9a-f]{16}$/);
    expect(logoVersionOf(REF)).toBe(VERSION);
    expect(logoVersionOf('company-logos/c1/def456')).not.toBe(VERSION);
    expect(logoVersionOf(null)).toBeNull();
  });

  it('caches the current version for a year, privately', async () => {
    const { controller } = build();
    const { res, headers } = response();
    await controller.getLogo(caller, 'c1', res, VERSION);
    expect(headers['Cache-Control']).toBe(
      'private, max-age=31536000, immutable',
    );
    expect(headers.ETag).toBe(`"logo-${VERSION}"`);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('revalidates a request that names no version or a stale one', async () => {
    const { controller } = build();
    for (const v of [undefined, 'stale']) {
      const { res, headers } = response();
      await controller.getLogo(caller, 'c1', res, v);
      expect(headers['Cache-Control']).toBe('private, no-cache');
    }
  });

  it('answers a matching If-None-Match with a bodiless 304', async () => {
    const { controller } = build();
    const { res } = response(`"logo-${VERSION}"`);
    await controller.getLogo(caller, 'c1', res);
    expect(res.status).toHaveBeenCalledWith(304);
    expect(res.send).not.toHaveBeenCalled();
  });
});
