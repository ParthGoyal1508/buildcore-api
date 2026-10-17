import { Transform } from 'class-transformer';

/**
 * Reads a query-string boolean as the caller meant it.
 *
 * `@Type(() => Boolean)` is the obvious spelling and the wrong one: it calls `Boolean(value)`, and
 * every non-empty string is truthy, so `?isActive=false` arrived as `true`. The employee list's
 * Inactive filter returned active staff for exactly that reason (036 B12).
 *
 * `'true'`/`true` and `'false'`/`false` map to themselves; anything else becomes `undefined`, so an
 * `@IsOptional()` field treats it as absent rather than guessing.
 */
export function BooleanQuery(): PropertyDecorator {
  return Transform(({ value }) => {
    if (value === 'true' || value === true) return true;
    if (value === 'false' || value === false) return false;
    return undefined;
  });
}
