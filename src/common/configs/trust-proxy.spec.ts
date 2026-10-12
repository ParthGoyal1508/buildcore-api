import { trustedProxyHops } from './config';

/**
 * How `TRUST_PROXY` is read, and why the permissive readings are refused.
 *
 * Express's `trust proxy` decides whether `req.ip` is the caller's address or the
 * address of whatever connected to the process. Three things in this API key on it: the
 * auth rate limiter's buckets, the audit log's record of who acted from where, and the
 * sign-in lockout's per-address failure count.
 *
 * **`'true'` and `'0'` are the cases worth having a test for.** `trust proxy: true`
 * tells Express to believe the left-most entry in `X-Forwarded-For`, a header the client
 * writes — so a caller could hand themselves a fresh lockout and rate-limit bucket on
 * every request, and all three of those mechanisms would be decorative while looking
 * configured. A hop count cannot be forged that way as long as it matches the real
 * topology, so a count is the only accepted form and every other spelling means "no
 * proxy".
 */
describe('reading TRUST_PROXY', () => {
  it('takes a positive integer as the number of proxies in front', () => {
    expect(trustedProxyHops('1')).toBe(1);
    expect(trustedProxyHops('2')).toBe(2);
  });

  it('treats an absent or empty value as no proxy', () => {
    // The local-development case, and the default everywhere until a deployment says
    // otherwise.
    expect(trustedProxyHops(undefined)).toBe(false);
    expect(trustedProxyHops('')).toBe(false);
    expect(trustedProxyHops('   ')).toBe(false);
  });

  it('refuses "true", which would make the limiter trust a client-set header', () => {
    expect(trustedProxyHops('true')).toBe(false);
    expect(trustedProxyHops('yes')).toBe(false);
    expect(trustedProxyHops('on')).toBe(false);
  });

  it('refuses zero, negatives and nonsense', () => {
    expect(trustedProxyHops('0')).toBe(false);
    expect(trustedProxyHops('-1')).toBe(false);
    expect(trustedProxyHops('1.5')).toBe(false);
    expect(trustedProxyHops('abc')).toBe(false);
  });
});
