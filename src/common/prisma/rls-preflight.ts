import { Logger } from '@nestjs/common';
import { PrismaService } from 'nestjs-prisma';

const logger = new Logger('RlsPreflight');

interface RolePrivileges {
  rolsuper: boolean;
  rolbypassrls: boolean;
}

/**
 * Fails startup when the database role would silently disable row-level security.
 *
 * Every tenant-scoped table in this schema is protected by an RLS policy, but
 * Postgres exempts superusers and `BYPASSRLS` roles from policies **unconditionally**
 * — `ENABLE`/`FORCE ROW LEVEL SECURITY` do not apply to them, and no error is raised.
 * A deployment connecting as such a role therefore has no tenant isolation at all
 * while looking completely healthy, which is precisely how this went unnoticed until
 * feature 002's convergence pass.
 *
 * The application-layer `companyScope()` filters are the other half of the defence,
 * but they only cover queries that remember to apply them; this check is what makes
 * the database-level guarantee's absence impossible to miss.
 *
 * In production this refuses to boot. Elsewhere it warns loudly and continues, so a
 * local superuser setup still works — see DEPLOYMENT.md §2a for the role to use.
 */
export async function assertRlsEnforceable(
  prisma: PrismaService,
  isProduction: boolean,
): Promise<void> {
  let privileges: RolePrivileges | undefined;

  try {
    const rows = await prisma.$queryRaw<RolePrivileges[]>`
      SELECT rolsuper, rolbypassrls
      FROM pg_roles
      WHERE rolname = current_user
    `;
    privileges = rows[0];
  } catch (error) {
    // An inconclusive check is not proof of a problem, and refusing to boot on one
    // would take down a healthy deployment over a missing catalog grant. Say so
    // and continue.
    logger.warn(
      `Could not verify whether the database role enforces row-level security: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return;
  }

  if (!privileges) {
    logger.warn(
      'Could not resolve the current database role; row-level security enforcement is unverified.',
    );
    return;
  }

  const { rolsuper, rolbypassrls } = privileges;
  if (!rolsuper && !rolbypassrls) {
    logger.log('Row-level security is enforced for this database role.');
    return;
  }

  const reason = rolsuper ? 'is a superuser' : 'holds BYPASSRLS';
  const message =
    `The database role this application connects as ${reason}, so every row-level ` +
    'security policy is bypassed and tenant isolation is NOT in effect. Connect as a ' +
    'NOSUPERUSER, NOBYPASSRLS role instead (see DEPLOYMENT.md §2a).';

  if (isProduction) {
    throw new Error(message);
  }
  logger.warn(
    `${message} Continuing anyway because this is not a production run.`,
  );
}
