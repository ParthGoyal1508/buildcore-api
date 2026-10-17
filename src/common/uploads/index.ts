/**
 * The shared upload helpers (036 B4, B5, B6, B8). **Use these in every upload route.**
 *
 * ```ts
 * import {
 *   assertAllowedFileType,
 *   compressImageUpload,
 *   decodeBase64Upload,
 *   DOCUMENT_TYPES,
 *   IsBase64Payload,
 * } from '../common/uploads';
 *
 * // DTO — marking the field as a file is also what gives the route the upload body limit.
 * class UploadThingDto {
 *   @IsBase64Payload() file!: string;           // or @IsBase64() for bare base64 only
 * }
 *
 * // Service
 * const bytes = decodeBase64Upload(dto.file, 'The certificate'); // 400 empty, 413 FILE_TOO_LARGE
 * const type = assertAllowedFileType(bytes, DOCUMENT_TYPES);     // 415 FILE_TYPE_NOT_ALLOWED
 * const image = await compressImageUpload(bytes, type.contentType); // null for PDF/Office
 * const stored = image?.main.data ?? bytes;
 * const storedType = image?.main.contentType ?? type.contentType;  // store the DETECTED type
 * const ref = await storage.put('things', stored, storedType);
 * // image.thumbnail → store it too where the table has a column for its ref.
 * ```
 *
 * - `upload-limits.ts` — `MAX_UPLOAD_BYTES` (10 MB of real file), `assertUploadSize`, and the
 *   two request-body limits.
 * - `base64-payload.ts` — `IsBase64Payload` (accepts a data-URL prefix) and `decodeBase64Upload`.
 * - `file-allow-list.ts` — `assertAllowedFileType`, `DOCUMENT_TYPES`, `IMAGE_TYPES`.
 * - `image-variants.ts` — `compressImageUpload`: ≤2048 px JPEG q80 (or WebP) plus a 320 px
 *   thumbnail.
 * - `large-body.ts` — which routes get the upload body limit, derived from the DTOs; `@LargeBody()`
 *   for a large payload that is not base64.
 *
 * Serve stored files with the stored (detected) type and `X-Content-Type-Options: nosniff`,
 * which helmet sets on every response (036 B9).
 */
export * from './base64-payload';
export * from './file-allow-list';
export * from './image-variants';
export * from './large-body';
export * from './upload-limits';
