export interface Config {
  nest: NestConfig;
  cors: CorsConfig;
  swagger: SwaggerConfig;
  security: SecurityConfig;
  settings: SettingsConfig;
}

export interface NestConfig {
  port: number;
}

export interface CorsConfig {
  enabled: boolean;
  origin: string[] | boolean;
}

export interface SwaggerConfig {
  enabled: boolean;
  title: string;
  description: string;
  version: string;
  path: string;
}

export interface SecurityConfig {
  /** Access-token TTL, e.g. '15m' (FR-005). */
  expiresIn: string;
  /** Signing secret for access tokens (jwt.strategy.ts, auth.module.ts). */
  jwtAccessSecret: string;
  /**
   * Refresh tokens are opaque, DB-persisted values (refresh-token.service.ts), not JWTs — this
   * secret is used as an HMAC pepper when hashing them at rest, so the raw value is never
   * recoverable even from a full DB dump (data-model.md "Refresh Token").
   */
  refreshTokenHashSecret: string;
  lockout: {
    /** Consecutive failures before lockout (FR-012). */
    maxAttempts: number;
    /** Lock duration in minutes (FR-012). */
    durationMinutes: number;
  };
  refreshCookie: {
    /**
     * `strict` is only viable when the frontend and API are same-site. In production they
     * are not (Vercel frontend, Render API — different registrable domains), and a browser
     * silently refuses to send a `SameSite=Strict` cookie cross-site, which would break
     * refresh and logout while leaving login looking healthy. Cross-site delivery requires
     * `SameSite=None`, which the spec permits only alongside `Secure` (below).
     */
    sameSite: 'strict' | 'lax' | 'none';
    /**
     * Always true: mandatory for `SameSite=None`, and required by FR-019's TLS-only rule.
     * Browsers exempt `localhost` from the HTTPS requirement, so this still works in local
     * dev over plain HTTP.
     */
    secure: boolean;
  };
  refreshToken: {
    /** Refresh-token family lifetime when "remember me" was checked (FR-006). */
    rememberMeDays: number;
    /**
     * Server-side lifetime ceiling for a non-"remember me" token family. The refresh cookie
     * itself carries no `Max-Age` in this case (dies with the browser session per FR-006) — this
     * is a separate, defense-in-depth expiry on the persisted token row so a family can't outlive
     * a reasonable bound even if a cookie somehow survives longer than the browser session.
     */
    defaultDays: number;
  };
  throttle: {
    /** Rate-limit window, in seconds (FR-016). */
    ttlSeconds: number;
    /** Max requests per window per source address, for /auth/* (FR-016). */
    limit: number;
  };
}

/**
 * Seed-time defaults for a newly created company's statutory/payroll rates
 * (Constitution Principle III — these are statutory percentages that change by
 * legislation, so they must not be magic numbers inside CompaniesService).
 *
 * These supply the *initial* value at company-creation time only; every rate stays
 * per-company editable afterwards (spec FR-002, research.md §11).
 */
export interface SettingsConfig {
  defaultRates: {
    /** Employer PF contribution, percent. */
    pfEmployer: number;
    /** Employer ESIC contribution, percent. */
    esicEmployer: number;
    /** Gratuity accrual, percent. */
    gratuity: number;
    /** Statutory bonus, percent. */
    bonus: number;
  };
  /** Day-of-month after which attendance edits lock for payroll processing. */
  defaultPayrollLockDay: number;
}
