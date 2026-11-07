import { SetMetadata } from '@nestjs/common';

export const EDITOR_MAY_DELETE_KEY = 'editorMayDelete';

/**
 * Marks a `DELETE` route that removes a **part** of something still being edited — a BOQ line, a
 * photo, an attachment, a document — rather than a whole record (2026-11-07).
 *
 * Deleting a whole record is Super Admin only (`RecordDeleteInterceptor`). Removing a part stays
 * with whoever may edit the thing it belongs to, under the route's own permission checks: the
 * person building a BOQ or a draft bill must be able to take a wrong line out again.
 *
 * Routes on an `@OwnRecords()` controller (the caller's own draft claim, own face consent) need no
 * mark. `record-delete.coverage.spec.ts` lists every `DELETE` route and which side it is on.
 */
export const EditorMayDelete = () => SetMetadata(EDITOR_MAY_DELETE_KEY, true);
