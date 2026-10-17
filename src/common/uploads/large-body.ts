import {
  INestApplication,
  Logger,
  RequestMethod,
  SetMetadata,
} from '@nestjs/common';
import {
  METHOD_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { ModulesContainer } from '@nestjs/core';
import { getMetadataStorage } from 'class-validator';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { json, urlencoded } from 'express';

import { IS_BASE64_PAYLOAD } from './base64-payload';

/**
 * Which routes may receive a large request body (036 B8).
 *
 * ## The rule
 *
 * A route gets the upload limit (`UPLOAD_REQUEST_BODY_LIMIT`, ~14 MB) when **either**:
 *
 * 1. its `@Body()` DTO — or any DTO nested in it through `@ValidateNested` + `@Type` — has a field
 *    validated with `@IsBase64()` or `@IsBase64Payload()`; or
 * 2. the handler, its controller, or its body DTO class is marked `@LargeBody()` — for a large
 *    payload that is not base64, such as the attendance-import CSV.
 *
 * Every other route gets the default (~100 KB).
 *
 * ## Why derived, not listed
 *
 * A hand-kept list of upload paths is a list that is right on the day it is written. Deriving it
 * from the validators means a new upload route is large the moment its DTO says the field is a
 * file — which it must anyway, or the file is not validated — and a route that forgets is refused
 * loudly in development (`413 PAYLOAD_TOO_LARGE`) rather than silently in production.
 *
 * **To audit it**, the list is printed at boot (`LargeBody` logger, `debug`), and
 * `large-body.spec.ts` asserts the known upload routes are on it.
 *
 * ## Why it can only key on the path
 *
 * Express parses the body before Nest routes the request, so the parser cannot ask which handler
 * will run. The routes are resolved once at startup into method + path patterns, and the parser
 * matches the incoming request against those.
 */
export const LARGE_BODY_KEY = 'largeBody';

/** Marks a handler, controller or body DTO class as receiving a large, non-base64 payload. */
export const LargeBody = () => SetMetadata(LARGE_BODY_KEY, true);

export interface LargeBodyRoute {
  method: string;
  path: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/ban-types */
type Ctor = Function;

/** Whether a DTO class (or anything nested in it) carries a file field. */
export function dtoCarriesFile(dto: unknown, seen = new Set<Ctor>()): boolean {
  if (typeof dto !== 'function' || seen.has(dto)) return false;
  seen.add(dto);
  if (Reflect.getMetadata(LARGE_BODY_KEY, dto)) return true;

  const storage = getMetadataStorage() as any;
  const metas: any[] = storage.getTargetValidationMetadatas(
    dto,
    '',
    true,
    false,
  );
  for (const meta of metas) {
    if (meta.name === 'isBase64' || meta.name === IS_BASE64_PAYLOAD) {
      return true;
    }
    const constraintName = meta.constraintCls
      ? storage.getTargetValidatorConstraints?.(meta.constraintCls)?.[0]?.name
      : undefined;
    if (constraintName === 'isBase64' || constraintName === IS_BASE64_PAYLOAD) {
      return true;
    }
  }

  // Nested DTOs: class-transformer's `@Type(() => X)` on any validated property.
  const properties = new Set<string>(metas.map((m) => m.propertyName));
  return [...properties].some((property) =>
    dtoCarriesFile(nestedType(dto, property), seen),
  );
}

function nestedType(dto: Ctor, property: string): unknown {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { defaultMetadataStorage } = require('class-transformer/cjs/storage');
    return defaultMetadataStorage
      .findTypeMetadata(dto, property)
      ?.typeFunction?.();
  } catch {
    return undefined;
  }
}

function joinPath(...parts: (string | undefined)[]): string {
  const joined = parts
    .filter((p) => p !== undefined && p !== '' && p !== '/')
    .map((p) => (p as string).replace(/^\/+|\/+$/g, ''))
    .join('/');
  return `/${joined}`;
}

function asList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (value === undefined || value === null) return [''];
  return [String(value)];
}

/**
 * The routes that may receive a large body, read from the controllers Nest has registered.
 *
 * Exported for the spec and for the boot log; `installBodyParsers` is what uses it.
 */
export function collectLargeBodyRoutes(
  container: ModulesContainer,
): LargeBodyRoute[] {
  const routes: LargeBodyRoute[] = [];
  for (const module of container.values()) {
    for (const wrapper of module.controllers.values()) {
      const controller = wrapper.metatype as Ctor | undefined;
      if (!controller || typeof controller !== 'function') continue;
      const prefixes = asList(Reflect.getMetadata(PATH_METADATA, controller));
      const controllerLarge = Boolean(
        Reflect.getMetadata(LARGE_BODY_KEY, controller),
      );
      const proto = controller.prototype;
      for (const name of Object.getOwnPropertyNames(proto)) {
        if (name === 'constructor') continue;
        const handler = proto[name];
        if (typeof handler !== 'function') continue;
        const method: RequestMethod | undefined = Reflect.getMetadata(
          METHOD_METADATA,
          handler,
        );
        if (method === undefined) continue;
        if (
          ![
            RequestMethod.POST,
            RequestMethod.PUT,
            RequestMethod.PATCH,
            RequestMethod.ALL,
          ].includes(method)
        ) {
          continue;
        }
        if (
          !controllerLarge &&
          !handlerTakesLargeBody(controller, name, handler)
        ) {
          continue;
        }
        const paths = asList(Reflect.getMetadata(PATH_METADATA, handler));
        for (const prefix of prefixes) {
          for (const path of paths) {
            routes.push({
              method: RequestMethod[method],
              path: joinPath(prefix, path),
            });
          }
        }
      }
    }
  }
  return routes;
}

function handlerTakesLargeBody(
  controller: Ctor,
  name: string,
  handler: Ctor,
): boolean {
  if (Reflect.getMetadata(LARGE_BODY_KEY, handler)) return true;
  const args: Record<string, { index: number; data?: unknown }> =
    Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, name) ?? {};
  const paramTypes: unknown[] =
    Reflect.getMetadata('design:paramtypes', controller.prototype, name) ?? [];
  return Object.entries(args).some(([key, arg]) => {
    if (Number(key.split(':')[0]) !== RouteParamtypes.BODY) return false;
    return dtoCarriesFile(paramTypes[arg.index]);
  });
}
/* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/ban-types */

/** `/nocs/:id/file` → a regex matching `/nocs/abc/file`, with or without a trailing slash. */
export function routePattern(path: string): RegExp {
  const escaped = path
    .split('/')
    .map((segment) =>
      segment.startsWith(':')
        ? '[^/]+'
        : segment === '*'
        ? '.*'
        : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    )
    .join('/');
  return new RegExp(`^${escaped}/?$`, 'i');
}

export function largeBodyMatcher(
  routes: LargeBodyRoute[],
): (method: string, path: string) => boolean {
  const compiled = routes.map((r) => ({
    method: r.method,
    pattern: routePattern(r.path),
  }));
  return (method, path) =>
    compiled.some(
      (r) =>
        (r.method === 'ALL' || r.method === method.toUpperCase()) &&
        r.pattern.test(path),
    );
}

/**
 * Installs the JSON and urlencoded parsers: the upload limit on the derived upload routes, the
 * default everywhere else, and a handler that turns a parser refusal into the API's error body
 * (a raw Express 413 is HTML with a stack-trace-ish title, not something a screen can show).
 */
export function installBodyParsers(
  app: INestApplication,
  limits: { defaultLimit: string; uploadLimit: string },
): LargeBodyRoute[] {
  let routes: LargeBodyRoute[] = [];
  try {
    routes = collectLargeBodyRoutes(app.get(ModulesContainer));
  } catch {
    // No container (a unit test's fake app): every route takes the default.
  }
  const isLarge = largeBodyMatcher(routes);
  new Logger('LargeBody').debug(
    `Upload body limit (${limits.uploadLimit}) on: ${routes
      .map((r) => `${r.method} ${r.path}`)
      .join(', ')}`,
  );

  const pick =
    (large: RequestHandler, small: RequestHandler): RequestHandler =>
    (req, res, next) =>
      (isLarge(req.method, req.path) ? large : small)(req, res, next);

  app.use(
    pick(
      json({ limit: limits.uploadLimit }),
      json({ limit: limits.defaultLimit }),
    ),
  );
  app.use(
    pick(
      urlencoded({ extended: true, limit: limits.uploadLimit }),
      urlencoded({ extended: true, limit: limits.defaultLimit }),
    ),
  );
  app.use(bodyParserErrors);
  return routes;
}

/** Express error middleware for the parsers above — runs only when one of them failed. */
export function bodyParserErrors(
  err: { type?: string; status?: number; limit?: number } | undefined,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!err) return next();
  if (err.type === 'entity.too.large') {
    res.status(413).json({
      statusCode: 413,
      code: 'PAYLOAD_TOO_LARGE',
      message:
        'The request is too large. Files can be up to 10 MB; other requests are much smaller.',
    });
    return;
  }
  if (err.type === 'entity.parse.failed') {
    res.status(400).json({
      statusCode: 400,
      code: 'INVALID_JSON',
      message: 'The request body is not valid JSON.',
    });
    return;
  }
  if (typeof err.status === 'number' && err.status >= 400 && err.status < 500) {
    res.status(err.status).json({
      statusCode: err.status,
      code: 'BAD_REQUEST',
      message: 'The request body could not be read.',
    });
    return;
  }
  next(err);
}
