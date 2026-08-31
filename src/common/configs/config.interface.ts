export interface Config {
  nest: NestConfig;
  cors: CorsConfig;
  swagger: SwaggerConfig;
  security: SecurityConfig;
  settings: SettingsConfig;
  workspace: WorkspaceConfig;
  storage: StorageConfig;
  email: EmailConfig;
}

export interface NestConfig {
  port: number;
  /**
   * Maximum accepted request body, as a byte-size string body-parser understands
   * (e.g. '10mb').
   *
   * Express defaults to 100 KB, which is far below what this API actually
   * receives: enrolment posts three to five base64-encoded photos in one JSON body
   * and a punch posts one, and base64 adds roughly a third on top of the encoded
   * bytes. Left at the default, every real enrolment and punch fails with
   * `413 request entity too large` — while a test suite using small fixture images
   * passes, which is exactly how that defect survives CI.
   *
   * Sized against the frontend's capture cap rather than picked as a round number:
   * `camera-capture.tsx` limits a frame to 1280px on its longest edge at JPEG
   * quality 0.85, so five enrolment photos land near 1.5 MB as base64. The default
   * below leaves generous headroom for larger devices while still bounding how much
   * a single request can make the server buffer.
   */
  maxRequestBodySize: string;
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

/**
 * My Workspace (feature 003) tunables — Principle III keeps every one of these out of
 * the services that read them, because each is a policy value someone will want to
 * change without a code review: a biometric threshold that turns out too strict in
 * the field, a queue window that has to widen for a site with worse connectivity.
 */
export interface WorkspaceConfig {
  faceMatch: {
    /**
     * Maximum Euclidean distance between two 128-float face descriptors for a punch
     * to count as the same person (research.md §2). Lower is stricter. 0.6 is
     * face-api's own documented default and the value its published accuracy
     * figures are measured at; below ~0.4 legitimate matches start failing on
     * lighting changes alone, which on a construction site means a worker who
     * cannot punch in.
     */
    distanceThreshold: number;
    /**
     * Minimum photos required to enrol, and the cap the DTO validates against
     * (contract: 3–5). Enrolling from several photos averages out one bad frame.
     */
    minEnrolmentPhotos: number;
    maxEnrolmentPhotos: number;
  };
  offlineQueue: {
    /**
     * How stale a client-declared `capturedAt` may be before a synced punch is
     * rejected outright (FR-012). Bounds how far back an offline device can
     * retroactively write attendance.
     */
    maxAgeHours: number;
    /**
     * Client and server clocks are never exactly aligned; a punch whose
     * `capturedAt` trails `receivedAt` by less than this is treated as a normal
     * online punch rather than being mislabelled an offline sync (research.md §4).
     */
    clockSkewToleranceMinutes: number;
  };
  reEnrolment: {
    /** How long an approved re-enrolment unlock stays usable (FR-015). */
    unlockDurationDays: number;
  };
  photoRetention: {
    /**
     * Punch photos are evidence for exception review, not a permanent record — they
     * are purged this many days after capture. Deliberately short: at roughly 30 KB
     * a photo and two punches per employee per day, a long window is what turns
     * blob storage into a cost centre, and nothing in the spec needs an old selfie
     * once its exception is resolved.
     */
    punchPhotoDays: number;
  };
  /**
   * Re-encode parameters applied before a photo is ever stored. Enrolment photos are
   * kept larger and cleaner because descriptor quality depends on them and they are
   * written once per employee; punch photos are captured constantly and only ever
   * need to be good enough for a human reviewer to recognise a face.
   */
  imageProcessing: {
    enrolment: { maxDimension: number; jpegQuality: number };
    punch: { maxDimension: number; jpegQuality: number };
  };
}

/** Which `StorageService` adapter backs blob persistence, and its settings. */
export interface StorageConfig {
  /**
   * `local` writes AES-256-GCM encrypted files under `localPath` — the dev/test
   * default, and viable *only* there: the production host's filesystem is ephemeral,
   * so a local blob does not survive a deploy (constitution v1.4.0).
   */
  driver: 'local' | 's3';
  /**
   * Key for encrypting blobs at rest. 32 bytes, hex-encoded. Required by both
   * adapters — the S3 adapter encrypts client-side too, so the storage provider
   * never holds decryptable biometric data.
   */
  encryptionKey: string;
  local: {
    /** Directory the local adapter writes under. Git- and Docker-ignored. */
    path: string;
  };
  s3: {
    /** R2: `https://<account-id>.r2.cloudflarestorage.com`. */
    endpoint: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    /**
     * R2 and most S3-compatible providers require path-style addressing; real AWS
     * S3 prefers virtual-host style.
     */
    forcePathStyle: boolean;
  };
}

/** Which `EmailService` adapter backs transactional email, and its settings. */
export interface EmailConfig {
  /**
   * `console` writes the message — including the full set-password URL — to the
   * application log instead of sending it. That is the dev/test default and makes
   * the invite flow clickable with no API key and no verified sending domain, which
   * is otherwise a hard prerequisite before any of it can be exercised.
   */
  driver: 'console' | 'resend';
  /** Resend API key. Required when `driver` is `resend`. */
  apiKey: string;
  /**
   * The From address. Resend rejects a send from a domain that has not been verified
   * in the account, so this is not free-form once live.
   */
  fromAddress: string;
  /**
   * Public base URL of the frontend, used to build the set-password link an invite
   * carries. Wrong here means every invite email points somewhere useless, so it has
   * no localhost default in production.
   */
  appBaseUrl: string;
  /**
   * Permits the console adapter to run even when `NODE_ENV=production`.
   *
   * Exists for preview and staging deployments, which set `NODE_ENV=production`
   * like everything else but serve nobody real. Without it those environments
   * cannot start at all until a sending domain has been DNS-verified — blocking a
   * whole deployment on a prerequisite unrelated to the change under review.
   *
   * Deliberately an explicit opt-in rather than something inferred: the operator has
   * to state that logged-instead-of-sent email is acceptable here. Real production
   * simply omits it and keeps the hard failure, which is the behaviour that matters
   * — an invite flow that silently logs credential links is worse than one that
   * refuses to boot.
   */
  allowConsoleInProduction: boolean;
}
