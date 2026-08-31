import { TokenService } from './token.service';
import { INVITE_TOKEN_BYTES } from '../constants/account-creation.constants';

describe('TokenService', () => {
  const service = new TokenService();

  it('generates a hex token of the configured entropy', () => {
    const { raw } = service.generate();
    expect(raw).toMatch(/^[0-9a-f]+$/);
    expect(raw).toHaveLength(INVITE_TOKEN_BYTES * 2);
  });

  it('never returns the same token twice', () => {
    const seen = new Set(
      Array.from({ length: 200 }, () => service.generate().raw),
    );
    expect(seen.size).toBe(200);
  });

  it('stores a hash, not the token itself', () => {
    // The whole point of research.md §2: a database dump must not yield usable
    // invite links.
    const { raw, hash } = service.generate();
    expect(hash).not.toBe(raw);
    expect(hash).toHaveLength(64);
  });

  it('hashes deterministically, so lookup by hash works', () => {
    const { raw, hash } = service.generate();
    expect(service.hash(raw)).toBe(hash);
  });

  it('gives different tokens different hashes', () => {
    const a = service.generate();
    const b = service.generate();
    expect(service.hash(a.raw)).not.toBe(service.hash(b.raw));
  });
});
