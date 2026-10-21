/**
 * Shared plumbing for the develop-database completion modules (`prisma/seed-dev/*.ts`).
 *
 * The base seed (`prisma/seed-dev.ts`) builds the two companies, their staff and the core
 * registers. The modules here fill everything a production database would also hold — employee
 * particulars, tax slabs, purchase orders, hire orders, labour punches, work reports — so every
 * screen opens on believable data. They run after the base seed (`npm run seed:dev` calls them),
 * or on their own against an already-seeded database (`npm run seed:dev:complete`).
 *
 * House rules for every module:
 * - Realistic and fictional: Rajasthan road works, Indian names, valid-looking PAN/IFSC/UAN
 *   formats. Never the words dummy, demo, sample or test in anything a user can see.
 * - Idempotent: a module that finds its data already present for a company skips it, so a rerun
 *   adds nothing twice.
 * - Deterministic: use `ctx.rand`, never `Math.random`, so two runs build the same database.
 * - Files go through `ctx.writeBlob` (R2 when STORAGE_DRIVER=s3, else local disk) and PII through
 *   `ctx.encryptPii`, both under STORAGE_ENCRYPTION_KEY — the same key the API reading this
 *   database holds, or nothing will decrypt.
 */
import { randomUUID } from 'crypto';
import { promises as fs, readFileSync } from 'fs';
import { dirname, resolve as resolvePath } from 'path';

import { parse as parseEnv } from 'dotenv';
import { Prisma, PrismaClient } from '@prisma/client';
import * as PDFDocument from 'pdfkit';

import config from '../../src/common/configs/config';
import {
  encryptBlob,
  parseEncryptionKey,
} from '../../src/common/storage/blob-cipher';
import { S3StorageAdapter } from '../../src/common/storage/s3-storage.adapter';

// ─── Target guard ─────────────────────────────────────────────────────────────

/**
 * Refuses to write fabricated data anywhere it was not deliberately aimed: local hosts are
 * allowed, any other host must be named exactly in SEED_DEV_ALLOW_HOST, and the production host
 * (read from `.env.production.local`) is refused even when named. Mirrors `seed-dev.ts`.
 */
export function assertSeedTarget(script: string): {
  host: string;
  isLocal: boolean;
} {
  const url = process.env.DATABASE_URL ?? '';
  const host = url.match(/@([^:/?]+)/)?.[1];
  if (!host) throw new Error('DATABASE_URL is missing or unparseable.');
  if (process.env.NODE_ENV === 'production') {
    throw new Error(`${script} must never run with NODE_ENV=production.`);
  }
  try {
    const prodUrl = parseEnv(
      readFileSync(resolvePath(process.cwd(), '.env.production.local')),
    ).DATABASE_URL;
    const prodHost = prodUrl?.match(/@([^:/?]+)/)?.[1];
    const stem = (h: string) => h.split('.')[0].replace('-pooler', '');
    if (prodHost && stem(prodHost) === stem(host)) {
      throw new Error(
        `${script} refuses ${host}: that is the production database.`,
      );
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes('production database')
    ) {
      throw error;
    }
  }
  if (['localhost', '127.0.0.1', '::1', 'postgres', 'db'].includes(host)) {
    return { host, isLocal: true };
  }
  if (process.env.SEED_DEV_ALLOW_HOST === host) {
    // One connection: the RLS bypass is a session setting (see seed-dev.ts pinSingleConnection).
    const pinned = new URL(url);
    pinned.searchParams.set('connection_limit', '1');
    process.env.DATABASE_URL = pinned.toString();
    return { host, isLocal: false };
  }
  throw new Error(
    `${script} refuses a non-local DATABASE_URL (host: ${host}). To aim it at this host on ` +
      `purpose, re-run with SEED_DEV_ALLOW_HOST=${host}`,
  );
}

// ─── Dates (business timezone, as seed-dev.ts) ────────────────────────────────

const IST_OFFSET_MIN = 330;

/** The IST calendar date, as the UTC midnight a `@db.Date` column stores. */
export const dateOnly = (t: Date): Date => {
  const ist = new Date(t.getTime() + IST_OFFSET_MIN * 60_000);
  return new Date(
    Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()),
  );
};
/** The instant an IST wall-clock time on `day` occurs. */
export const at = (day: Date, h: number, m: number): Date =>
  new Date(
    Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), h, m) -
      IST_OFFSET_MIN * 60_000,
  );
export const daysAgo = (n: number): Date => {
  const t = dateOnly(new Date());
  t.setUTCDate(t.getUTCDate() - n);
  return t;
};
export const d = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);
export const money = (n: number): Prisma.Decimal => new Prisma.Decimal(n);

// ─── Deterministic randomness ─────────────────────────────────────────────────

export interface Rng {
  rand: () => number;
  pick: <T>(xs: readonly T[]) => T;
  int: (min: number, max: number) => number;
}

/** A seeded generator; give each module its own seed so modules don't shift each other. */
export function rng(seed: number): Rng {
  let state = seed % 2147483648;
  const rand = () =>
    (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
  return {
    rand,
    pick: <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)],
    int: (min: number, max: number) =>
      min + Math.floor(rand() * (max - min + 1)),
  };
}

// ─── Files and PII ────────────────────────────────────────────────────────────

const r2 =
  process.env.STORAGE_DRIVER === 's3'
    ? new S3StorageAdapter({
        get: (key: string) =>
          (config() as unknown as Record<string, unknown>)[key],
      } as never)
    : null;

export function contentTypeOf(bytes: Buffer): string {
  const head = bytes.subarray(0, 4).toString('hex');
  if (head.startsWith('ffd8')) return 'image/jpeg';
  if (head === '89504e47') return 'image/png';
  if (head === '25504446') return 'application/pdf';
  return 'application/octet-stream';
}

/** Stores bytes the way the API's storage adapter does and returns the stored reference. */
export async function writeBlob(
  namespace: string,
  bytes: Buffer,
): Promise<string> {
  if (r2) return r2.put(namespace, bytes, contentTypeOf(bytes));
  const ref = `${namespace}/${randomUUID()}`;
  const target = resolvePath(
    process.cwd(),
    process.env.STORAGE_LOCAL_PATH || 'var/storage',
    ref,
  );
  await fs.mkdir(dirname(target), { recursive: true });
  await fs.writeFile(
    target,
    encryptBlob(bytes, parseEncryptionKey(process.env.STORAGE_ENCRYPTION_KEY)),
    { mode: 0o600 },
  );
  return ref;
}

/** A one-column A4 PDF with a title and body text — scanned-document stand-ins, letters. */
export async function renderPdf(title: string, body: string): Promise<Buffer> {
  return new Promise((done, fail) => {
    const doc = new PDFDocument({ margin: 56 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => done(Buffer.concat(chunks)));
    doc.on('error', fail);
    doc.fontSize(14).text(title, { align: 'center' }).moveDown(1.5);
    doc.fontSize(11).text(body, { align: 'left' });
    doc.end();
  });
}

/** Encrypts a PII value exactly as `PiiCipherService.encrypt` does. */
export function encryptPii(
  plaintext: string | null | undefined,
): string | null {
  if (plaintext === null || plaintext === undefined) return null;
  const trimmed = plaintext.trim();
  if (trimmed === '') return null;
  return encryptBlob(
    Buffer.from(trimmed, 'utf8'),
    parseEncryptionKey(process.env.STORAGE_ENCRYPTION_KEY),
  ).toString('base64');
}

// ─── Context handed to every module ───────────────────────────────────────────

export interface CompanyContext {
  prisma: PrismaClient;
  company: { id: string; name: string; shortCode: string };
  /** Today in IST, as a `@db.Date` value. */
  today: Date;
  /** Current financial year label, e.g. '2026-2027'. */
  fy: string;
  rng: Rng;
  writeBlob: typeof writeBlob;
  renderPdf: typeof renderPdf;
  encryptPii: typeof encryptPii;
}

/** What a module reports: row counts by label, printed by the runner. */
export type ModuleResult = Record<string, number>;

export type CompletionModule = (ctx: CompanyContext) => Promise<ModuleResult>;

/** The financial year (April–March) containing `day`, as '2026-2027'. */
export function financialYearOf(day: Date): string {
  const y = day.getUTCFullYear();
  const start = day.getUTCMonth() >= 3 ? y : y - 1;
  return `${start}-${start + 1}`;
}
