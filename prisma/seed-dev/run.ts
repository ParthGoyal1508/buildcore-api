import { PrismaClient } from '@prisma/client';

import { seedAssets } from './assets';
import { seedHr } from './hr';
import { seedComposites, seedInventory } from './inventory';
import { seedLabour } from './labour';
import { seedPayroll } from './payroll';
import { seedPlant } from './plant';
import { seedProjects } from './projects';
import {
  CompletionModule,
  dateOnly,
  encryptPii,
  financialYearOf,
  renderPdf,
  rng,
  writeBlob,
} from './support';

/**
 * Dependency order: HR particulars before payroll (bank sheets read them), inventory before
 * plant (hire orders reference vendors), labour and projects after both, assets and approvals
 * last (they reference everything).
 */
export const MODULES: { name: string; run: CompletionModule; seed: number }[] =
  [
    { name: 'hr', run: seedHr, seed: 1101 },
    { name: 'payroll', run: seedPayroll, seed: 2203 },
    { name: 'inventory', run: seedInventory, seed: 3307 },
    { name: 'composites', run: seedComposites, seed: 3313 },
    { name: 'plant', run: seedPlant, seed: 4409 },
    { name: 'labour', run: seedLabour, seed: 5501 },
    { name: 'projects', run: seedProjects, seed: 6607 },
    { name: 'assets', run: seedAssets, seed: 7703 },
  ];

export async function runCompletion(
  prisma: PrismaClient,
  options: { only?: string[]; label?: string } = {},
): Promise<void> {
  // The same RLS bypass `withRlsContext()` sets for system writes, session-wide.
  await prisma.$executeRaw`SELECT set_config('app.is_super_admin', 'true', false)`;
  const today = dateOnly(new Date());
  const companies = await prisma.company.findMany({
    select: { id: true, name: true, shortCode: true },
    orderBy: { createdAt: 'asc' },
  });
  const modules = MODULES.filter(
    (m) => !options.only?.length || options.only.includes(m.name),
  );
  console.log(
    `Completing the develop database (${options.label ?? 'local'}): ` +
      `${modules.map((m) => m.name).join(', ')}\n`,
  );
  for (const company of companies) {
    for (const module of modules) {
      const started = Date.now();
      const result = await module.run({
        prisma,
        company,
        today,
        fy: financialYearOf(today),
        // Per company and module, so one module's draws never shift another's.
        rng: rng(module.seed + company.shortCode.charCodeAt(0) * 31),
        writeBlob,
        renderPdf,
        encryptPii,
      });
      const summary = Object.entries(result)
        .map(([k, n]) => `${k} ${n}`)
        .join(', ');
      console.log(
        `  ${company.shortCode.padEnd(5)} ${module.name.padEnd(10)} ` +
          `${summary || 'nothing to add'}  (${(
            (Date.now() - started) /
            1000
          ).toFixed(1)}s)`,
      );
    }
  }

  // 2026-10-20: leave, claims, loans and advances are approved on chains. The modules above write
  // pending ones straight into their tables, so they are put into their chains here — through the
  // API's own services, as `npm run backfill:approvals` does on a live database.
  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('../../src/app.module');
  const { backfillApprovalChains } = await import(
    '../backfill-approval-chains'
  );
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const counts = await backfillApprovalChains(app);
    console.log(
      `  approval chains: ${Object.entries(counts)
        .map(([k, n]) => `${k} ${n}`)
        .join(', ')}`,
    );
  } finally {
    await app.close();
  }
}
