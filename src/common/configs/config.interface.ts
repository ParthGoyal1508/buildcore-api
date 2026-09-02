export interface Config {
  nest: NestConfig;
  cors: CorsConfig;
  swagger: SwaggerConfig;
  security: SecurityConfig;
  settings: SettingsConfig;
  workspace: WorkspaceConfig;
  storage: StorageConfig;
  email: EmailConfig;
  hrPayroll: HrPayrollConfig;
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
    /**
     * Overtime pay multiplier applied to the derived hourly rate (005 FR-014a).
     * A multiplier, not a percent. Seeded onto each new Company, editable
     * per-company thereafter — Principle III keeps the 2x out of the engine.
     */
    otMultiplier: number;
  };
  /** Day-of-month after which attendance edits lock for payroll processing. */
  defaultPayrollLockDay: number;
  /**
   * The IANA zone every calendar day in this system is reckoned against.
   *
   * A punch, a leave day and a payroll lock are all *calendar* facts, but the
   * values they are derived from are *instants*. Without a zone, `toISOString()`
   * decides, which means UTC — and in IST every punch before 05:30 local is filed
   * under the previous day, taking its attendance and OT with it.
   *
   * Configured rather than hardcoded (Principle III), single rather than
   * per-company: this ERP is India-specific throughout — GSTIN, PAN, PF/ESIC,
   * BOCW, April–March financial years — so one zone is an honest assumption, and
   * an explicit one beats the accidental UTC it replaces.
   */
  timezone: string;
}

/**
 * My Workspace (feature 003) tunables — Principle III keeps every one of these out of
 * the services that read them, because each is a policy value someone will want to
 * change without a code review: a biometric threshold that turns out too strict in
 * the field, a queue window that has to widen for a site with worse connectivity.
 */
/**
 * HR & Payroll (feature 005) tunables. Principle III: every one of these is a policy
 * value someone will want to change without a code review.
 */
export interface HrPayrollConfig {
  /**
   * How many days before an employee document's expiry it starts reporting as
   * expiring-soon (005 FR-006). 30 by default.
   */
  documentExpiryWarningDays: number;

  /**
   * Standard hours in a working day, used to derive an hourly rate for overtime
   * when the employee record does not set its own `hoursPerDay`.
   */
  standardHoursPerDay: number;

  /**
   * Statutory rates the payroll engine applies (Principle III — none of these may
   * be a literal in the engine).
   *
   * Employer-side PF/ESIC percentages are deliberately absent: those are
   * per-company columns on `settings.Company` (002 FR-002), because a company can
   * be registered under a different contribution scheme. What lives here is the
   * statutory framework itself — employee-side rates, wage ceilings, and the
   * split of the employer's PF share — which is set by law rather than by company.
   */
  statutory: {
    pf: {
      /** Employee contribution, percent of PF wage. */
      employeeRatePercent: number;
      /** Monthly PF wage ceiling; contributions are computed on the lesser. */
      wageCeiling: number;
      /** Pension share of the employer contribution, percent of PF wage. */
      epsRatePercent: number;
      /** Employee deposit-linked insurance, percent of PF wage. */
      edliRatePercent: number;
      /** EPFO administrative charges, percent of PF wage. */
      adminChargesPercent: number;
    };
    esic: {
      /** Employee contribution, percent of gross. */
      employeeRatePercent: number;
      /** Gross above which ESIC does not apply. */
      wageCeiling: number;
    };
    /**
     * Professional tax slabs, ascending. `upToMonthlyGross: null` marks the final
     * open-ended band. State-specific, so configured rather than assumed.
     */
    professionalTaxSlabs: {
      upToMonthlyGross: number | null;
      monthlyAmount: number;
    }[];

    /** Income tax (005 amendment US14). */
    tds: {
      /**
       * Rate applied when an employee has no PAN on file (FR-053). Higher than
       * any slab on purpose — filing without a PAN attracts a penal rate.
       */
      noPanRatePercent: number;
      /**
       * Month (1-12) after which only *verified* declarations count (FR-052).
       * Before it, an employee's word is enough; after it, proof is required.
       */
      proofCutOffMonth: number;
      /** Statutory ceilings per section code, e.g. `{ "80C": 150000 }`. */
      sectionCeilings: Record<string, number>;
      /** Standard deduction applied to salary income before slabs. */
      standardDeduction: number;
    };
  };

  /** Salary advances (005 amendment US15). */
  salaryAdvance: {
    /**
     * An advance above this multiple of monthly net pay is flagged and needs
     * explicit approval (FR-054).
     */
    limitMultipleOfMonthlyNet: number;
  };

  /** Shift compliance / late-coming reporting (005 amendment US17). */
  shiftCompliance: {
    /** Late days in a month beyond which an employee is flagged a repeat offender. */
    repeatLateComerThreshold: number;
  };
}

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
  /**
   * Escape hatch for a deployment that sets `NODE_ENV=production` but serves nobody
   * real — a preview or staging host — where losing blobs on redeploy costs nothing
   * and demanding R2 credentials would block unrelated work.
   *
   * Never inferred. A real production environment that simply forgets to configure
   * S3 still refuses to boot, which is the behaviour that matters: an app that
   * silently destroys biometric photos on every restart is worse than one that does
   * not start.
   */
  allowLocalInProduction: boolean;
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
