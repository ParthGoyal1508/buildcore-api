import {
  ArgumentsHost,
  Catch,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import type { Response } from 'express';

/**
 * One error body for every refusal the API sends (036 B10).
 *
 * ## The contract
 *
 * ```json
 * { "statusCode": 409, "code": "DUPLICATE", "message": "A record with this code already exists." }
 * ```
 *
 * - `statusCode` — the HTTP status, repeated in the body.
 * - `code` — a stable identifier the web branches on. **A code a service already threw is passed
 *   through exactly** (`PASSWORD_CHANGE_REQUIRED`, `SESSION_*`, `APPROVAL_NOT_PENDING`, …); one
 *   that threw none gets a generic code from its status (`BAD_REQUEST`, `NOT_FOUND`, …), and a
 *   class-validator refusal gets `VALIDATION_FAILED`.
 * - `message` — **always one string**, written for a person. class-validator's array is joined
 *   into a sentence list, so a client never has to guess which shape it got.
 * - `errors` — present only when the refusal had several parts (class-validator): the same
 *   messages one per entry, for a form that wants to place them beside their fields.
 *
 * Any other field a service put on its refusal (`companyId`, `missingFields`, …) is kept as it
 * was: those are structured halves the interface already reads, and dropping them would break
 * screens to tidy a body. Nest's own `error` ("Bad Request") is dropped — it repeated the status
 * as text and nothing reads it.
 *
 * ## Prisma
 *
 * Database errors that are the caller's doing, or a race, are answered as such instead of 500,
 * and **never with the database's own text**. `nestjs-prisma`'s filter answered P2002 with
 * "[P2002]: Unique constraint failed on the fields: (`companyId`,`code`)" — a schema detail on a
 * user's screen, and not a sentence anyone could act on.
 *
 * | Prisma | Status | code |
 * |---|---|---|
 * | P2000 value too long | 400 | `VALUE_TOO_LONG` |
 * | P2002 unique | 409 | `DUPLICATE` |
 * | P2003 foreign key | 409 | `REFERENCE_CONFLICT` |
 * | P2020 out of range | 400 | `VALUE_OUT_OF_RANGE` |
 * | P2025 not found | 404 | `NOT_FOUND` |
 * | P2034 write conflict | 409 | `WRITE_CONFLICT` |
 * | validation error | 400 | `INVALID_INPUT` |
 *
 * Anything else — an unmapped Prisma code, a `TypeError` — is logged in full and answered 500
 * `INTERNAL_ERROR` with a generic sentence.
 */
@Catch()
export class ApiExceptionFilter extends BaseExceptionFilter {
  private readonly logger = new Logger('ApiExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') {
      super.catch(exception, host);
      return;
    }
    const response = host.switchToHttp().getResponse<Response>();
    if (response.headersSent) {
      // A stream that failed part-way: there is no body left to replace.
      super.catch(exception, host);
      return;
    }

    const body = this.bodyFor(exception);
    response.status(body.statusCode).json(body);
  }

  bodyFor(exception: unknown): ApiErrorBody {
    if (exception instanceof HttpException) {
      return normaliseHttpException(exception);
    }
    const prisma = prismaErrorBody(exception);
    if (prisma) return prisma;

    this.logger.error(
      exception instanceof Error ? exception.message : String(exception),
      exception instanceof Error ? exception.stack : undefined,
    );
    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL_ERROR',
      message: 'Something went wrong on the server. Please try again.',
    };
  }
}

export interface ApiErrorBody {
  statusCode: number;
  code: string;
  message: string;
  errors?: string[];
  [extra: string]: unknown;
}

/** A generic code for a refusal that carried none, from its status. */
const STATUS_CODES: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  409: 'CONFLICT',
  410: 'GONE',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  422: 'UNPROCESSABLE_ENTITY',
  423: 'LOCKED',
  429: 'TOO_MANY_REQUESTS',
  500: 'INTERNAL_ERROR',
  503: 'SERVICE_UNAVAILABLE',
};

/** Friendlier words than Nest's defaults for the refusals people actually meet. */
const STATUS_MESSAGES: Record<number, string> = {
  413: 'The upload is too large.',
  429: 'Too many requests. Please wait a moment and try again.',
};

function codeForStatus(status: number): string {
  return STATUS_CODES[status] ?? (status >= 500 ? 'INTERNAL_ERROR' : 'ERROR');
}

export function normaliseHttpException(exception: HttpException): ApiErrorBody {
  const statusCode = exception.getStatus();
  const raw = exception.getResponse();
  const source: Record<string, unknown> =
    typeof raw === 'string'
      ? { message: raw }
      : raw && typeof raw === 'object'
      ? { ...(raw as Record<string, unknown>) }
      : {};

  const rawMessage = source.message;
  const errors = Array.isArray(rawMessage)
    ? rawMessage.map((m) => String(m))
    : undefined;

  let message: string;
  if (errors) {
    message = errors.join('; ');
  } else if (typeof rawMessage === 'string' && rawMessage.trim() !== '') {
    message = rawMessage;
  } else {
    message = exception.message;
  }
  // `ThrottlerException: Too Many Requests` and Nest's bare status names are not sentences.
  if (
    STATUS_MESSAGES[statusCode] &&
    (typeof rawMessage !== 'string' ||
      /^ThrottlerException|^Too Many Requests$|^request entity too large$|^Payload Too Large$/i.test(
        message,
      ))
  ) {
    message = STATUS_MESSAGES[statusCode];
  }

  const code =
    typeof source.code === 'string' && source.code !== ''
      ? source.code
      : errors
      ? 'VALIDATION_FAILED'
      : codeForStatus(statusCode);

  // Nest's `error` repeats the status as text; nothing reads it.
  delete source.error;
  delete source.message;
  delete source.statusCode;
  delete source.code;

  return {
    ...source,
    statusCode,
    code,
    message,
    ...(errors ? { errors } : {}),
  };
}

/** Field names a person would recognise, never the tenant key or a raw id. */
function friendlyTarget(meta: Record<string, unknown> | undefined): string {
  const target = meta?.target;
  const fields = (Array.isArray(target) ? target : [])
    .map(String)
    .filter((f) => f !== 'companyId' && f !== 'id' && !f.endsWith('Id'));
  if (fields.length === 0) return 'these details';
  const words = fields.map((f) =>
    f.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase(),
  );
  return `this ${words.join(' and ')}`;
}

export function prismaErrorBody(exception: unknown): ApiErrorBody | null {
  if (exception instanceof Prisma.PrismaClientValidationError) {
    return {
      statusCode: HttpStatus.BAD_REQUEST,
      code: 'INVALID_INPUT',
      message: 'The request contained a value the server could not accept.',
    };
  }
  if (!(exception instanceof Prisma.PrismaClientKnownRequestError)) {
    return null;
  }
  const meta = exception.meta as Record<string, unknown> | undefined;
  switch (exception.code) {
    case 'P2000':
      return {
        statusCode: HttpStatus.BAD_REQUEST,
        code: 'VALUE_TOO_LONG',
        message: 'A value is longer than the field allows.',
      };
    case 'P2002':
      return {
        statusCode: HttpStatus.CONFLICT,
        code: 'DUPLICATE',
        message: `A record with ${friendlyTarget(meta)} already exists.`,
      };
    case 'P2003':
      return {
        statusCode: HttpStatus.CONFLICT,
        code: 'REFERENCE_CONFLICT',
        message:
          'This record is linked to other records, or refers to one that no longer exists.',
      };
    case 'P2020':
      return {
        statusCode: HttpStatus.BAD_REQUEST,
        code: 'VALUE_OUT_OF_RANGE',
        message: 'A value is outside the range the field allows.',
      };
    case 'P2025':
      return {
        statusCode: HttpStatus.NOT_FOUND,
        code: 'NOT_FOUND',
        message: 'The record was not found. It may have been deleted.',
      };
    case 'P2034':
      return {
        statusCode: HttpStatus.CONFLICT,
        code: 'WRITE_CONFLICT',
        message:
          'Another change was saved at the same time. Reload and try again.',
      };
    default:
      return null;
  }
}
