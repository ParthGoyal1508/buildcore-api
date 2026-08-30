import type { Config } from './config.interface';

/** Parses a numeric env override, falling back when unset or non-numeric. */
function numberFromEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Parses a boolean env override ('true'/'1' → true), falling back when unset. */
function booleanFromEnv(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const normalized = raw.trim().toLowerCase();
  return normalized === 'true' || normalized === '1';
}

const config: Config = {
  nest: {
    port: 3000,
  },
  cors: {
    enabled: true,
    // CORS_ORIGINS: comma-separated allowed origins for prod (e.g. the deployed
    // frontend's URL). Unset → allow all, matching prior local-dev behavior.
    origin: process.env.CORS_ORIGINS
      ? process.env.CORS_ORIGINS.split(',').map((o) => o.trim())
      : true,
  },
  swagger: {
    enabled: true,
    title: 'BuildCore API',
    description: 'BuildCore ERP — REST API',
    version: '1.0',
    path: 'api',
  },
  security: {
    expiresIn: '15m',
    jwtAccessSecret: process.env.JWT_ACCESS_SECRET,
    refreshTokenHashSecret: process.env.JWT_REFRESH_SECRET,
    lockout: {
      maxAttempts: 5,
      durationMinutes: 15,
    },
    refreshCookie: {
      // Defaults to 'none' wherever CORS_ORIGINS is set, since that's precisely the
      // split-origin deployment where 'strict' would silently drop the cookie; local
      // dev (frontend and API both on localhost, same-site regardless of port) keeps
      // the stronger 'strict'. REFRESH_COOKIE_SAMESITE overrides either way.
      sameSite:
        (process.env.REFRESH_COOKIE_SAMESITE as 'strict' | 'lax' | 'none') ||
        (process.env.CORS_ORIGINS ? 'none' : 'strict'),
      secure: true,
    },
    refreshToken: {
      rememberMeDays: 30,
      defaultDays: 1,
    },
    throttle: {
      ttlSeconds: 60,
      limit: 10,
    },
  },
  settings: {
    // Statutory defaults applied to a company at creation time, overridable per
    // company thereafter (FR-002). Env-overridable so a rate change shipped by
    // legislation doesn't require a code release (research.md §11).
    defaultRates: {
      pfEmployer: numberFromEnv(
        process.env.SETTINGS_DEFAULT_PF_EMPLOYER_RATE,
        12,
      ),
      esicEmployer: numberFromEnv(
        process.env.SETTINGS_DEFAULT_ESIC_EMPLOYER_RATE,
        3.25,
      ),
      gratuity: numberFromEnv(process.env.SETTINGS_DEFAULT_GRATUITY_RATE, 4.81),
      bonus: numberFromEnv(process.env.SETTINGS_DEFAULT_BONUS_RATE, 8.33),
    },
    defaultPayrollLockDay: numberFromEnv(
      process.env.SETTINGS_DEFAULT_PAYROLL_LOCK_DAY,
      7,
    ),
  },
  workspace: {
    faceMatch: {
      // face-api's own documented default, and the threshold its published accuracy
      // numbers are quoted at (research.md §2). Env-overridable because the right
      // strictness is a field-tuning question, not a code question — a site with
      // harsh outdoor lighting may need it loosened, and that must not need a deploy.
      distanceThreshold: numberFromEnv(
        process.env.WORKSPACE_FACE_MATCH_DISTANCE_THRESHOLD,
        0.6,
      ),
      minEnrolmentPhotos: numberFromEnv(
        process.env.WORKSPACE_MIN_ENROLMENT_PHOTOS,
        3,
      ),
      maxEnrolmentPhotos: numberFromEnv(
        process.env.WORKSPACE_MAX_ENROLMENT_PHOTOS,
        5,
      ),
    },
    offlineQueue: {
      // 72h covers a long weekend of lost connectivity without letting a device
      // rewrite attendance from an arbitrarily distant past (FR-012).
      maxAgeHours: numberFromEnv(
        process.env.WORKSPACE_MAX_OFFLINE_AGE_HOURS,
        72,
      ),
      clockSkewToleranceMinutes: numberFromEnv(
        process.env.WORKSPACE_CLOCK_SKEW_TOLERANCE_MINUTES,
        5,
      ),
    },
    reEnrolment: {
      // FR-015 fixes the unlock window at 7 days.
      unlockDurationDays: numberFromEnv(
        process.env.WORKSPACE_REENROLMENT_UNLOCK_DAYS,
        7,
      ),
    },
    photoRetention: {
      punchPhotoDays: numberFromEnv(
        process.env.WORKSPACE_PUNCH_PHOTO_RETENTION_DAYS,
        15,
      ),
    },
    imageProcessing: {
      // Enrolment photos feed descriptor computation, so they keep more detail.
      enrolment: {
        maxDimension: numberFromEnv(
          process.env.WORKSPACE_ENROLMENT_PHOTO_MAX_DIMENSION,
          800,
        ),
        jpegQuality: numberFromEnv(
          process.env.WORKSPACE_ENROLMENT_PHOTO_JPEG_QUALITY,
          80,
        ),
      },
      // Punch photos only need to be recognisable to a human reviewer; ~640px at
      // q72 lands around 30 KB, which is what keeps blob storage bounded.
      punch: {
        maxDimension: numberFromEnv(
          process.env.WORKSPACE_PUNCH_PHOTO_MAX_DIMENSION,
          640,
        ),
        jpegQuality: numberFromEnv(
          process.env.WORKSPACE_PUNCH_PHOTO_JPEG_QUALITY,
          72,
        ),
      },
    },
  },
  storage: {
    // Local by default so a fresh clone and the e2e suite work with no cloud
    // credentials. Production sets STORAGE_DRIVER=s3 — see DEPLOYMENT.md; leaving it
    // 'local' on the deployed host would silently lose blobs on every redeploy,
    // because that filesystem is ephemeral.
    driver: (process.env.STORAGE_DRIVER as 'local' | 's3') || 'local',
    encryptionKey: process.env.STORAGE_ENCRYPTION_KEY,
    local: {
      path: process.env.STORAGE_LOCAL_PATH || 'var/storage',
    },
    s3: {
      endpoint: process.env.STORAGE_S3_ENDPOINT,
      region: process.env.STORAGE_S3_REGION || 'auto',
      bucket: process.env.STORAGE_S3_BUCKET,
      accessKeyId: process.env.STORAGE_S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.STORAGE_S3_SECRET_ACCESS_KEY,
      // R2 requires path-style; real AWS S3 does not. Defaults to true because R2
      // is the documented target (constitution v1.4.0).
      forcePathStyle: booleanFromEnv(
        process.env.STORAGE_S3_FORCE_PATH_STYLE,
        true,
      ),
    },
  },
};

export default (): Config => config;
