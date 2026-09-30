import { SetMetadata } from '@nestjs/common';
import { AccessLevel } from '@prisma/client';

export const ACCESS_LEVEL_KEY = 'accessLevel';

/**
 * Overrides the level `PermissionsGuard` derives from the HTTP method (019 FR-001).
 *
 * The default rule is that `GET` and `HEAD` need `read` and everything else needs
 * `write`. That is right for almost every route here, and it is what lets 019 add a
 * read/write distinction across 419 routes without editing any of the 116 existing
 * `@RequirePermissions(...)` declarations.
 *
 * Where it is wrong, it is wrong in one direction: a **search or report that takes a
 * `POST`** because its filter will not fit in a query string. Those are reads wearing a
 * write verb, and without this decorator a read-only role would be refused one. Mark them
 * explicitly:
 *
 * ```ts
 * @Post('search')
 * @RequireLevel(AccessLevel.read)
 * ```
 *
 * The reverse case — a `GET` that changes something — is not supported on purpose. A `GET`
 * with side effects is a defect to fix rather than a level to declare.
 */
export const RequireLevel = (level: AccessLevel) =>
  SetMetadata(ACCESS_LEVEL_KEY, level);
