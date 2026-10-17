import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  ValidationPipe,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { Prisma } from '@prisma/client';
import { IsInt, IsString, Max } from 'class-validator';

import {
  ApiExceptionFilter,
  normaliseHttpException,
  prismaErrorBody,
} from './api-exception.filter';

const known = (code: string, meta?: Record<string, unknown>) =>
  new Prisma.PrismaClientKnownRequestError(
    `Invalid \`prisma.thing.create()\` invocation: [${code}] Unique constraint failed on the fields: (\`companyId\`,\`code\`)`,
    { code, clientVersion: '5.22.0', meta },
  );

describe('ApiExceptionFilter (036 B10)', () => {
  describe('HttpException bodies', () => {
    it('passes an existing code through exactly, with the message as given', () => {
      const body = normaliseHttpException(
        new ConflictException({
          statusCode: 409,
          message: 'Another approver at this level recorded a decision first.',
          code: 'APPROVAL_NOT_PENDING',
        }),
      );
      expect(body).toEqual({
        statusCode: 409,
        code: 'APPROVAL_NOT_PENDING',
        message: 'Another approver at this level recorded a decision first.',
      });
    });

    it('keeps the structured fields a service put on its refusal', () => {
      const body = normaliseHttpException(
        new ForbiddenException({
          code: 'PASSWORD_CHANGE_REQUIRED',
          message: 'Change your password first.',
          reason: 'expired',
        }),
      );
      expect(body).toMatchObject({
        statusCode: 403,
        code: 'PASSWORD_CHANGE_REQUIRED',
        reason: 'expired',
      });
    });

    it('gives a plain-string refusal a code from its status, and drops Nest’s `error`', () => {
      const body = normaliseHttpException(
        new NotFoundException('NOC not found'),
      );
      expect(body).toEqual({
        statusCode: 404,
        code: 'NOT_FOUND',
        message: 'NOC not found',
      });
    });

    it('turns class-validator’s array into one string, with the parts in `errors`', async () => {
      class Dto {
        @IsString() name!: string;
        @IsInt() @Max(10) count!: number;
      }
      const pipe = new ValidationPipe();
      const error = await pipe
        .transform({ count: 99 }, { type: 'body', metatype: Dto })
        .catch((e: HttpException) => e);
      const body = normaliseHttpException(error as HttpException);

      expect(body.statusCode).toBe(400);
      expect(body.code).toBe('VALIDATION_FAILED');
      expect(typeof body.message).toBe('string');
      expect(body.errors).toEqual(
        expect.arrayContaining([
          'name must be a string',
          'count must not be greater than 10',
        ]),
      );
      expect(body.message).toContain('name must be a string');
      expect(body.message).toContain('count must not be greater than 10');
    });

    it('answers the throttler with a sentence, not its class name', () => {
      const body = normaliseHttpException(new ThrottlerException());
      expect(body.statusCode).toBe(429);
      expect(body.code).toBe('TOO_MANY_REQUESTS');
      expect(body.message).not.toMatch(/ThrottlerException/);
    });

    it('keeps a 400’s own message', () => {
      expect(
        normaliseHttpException(new BadRequestException('The file is empty.')),
      ).toEqual({
        statusCode: 400,
        code: 'BAD_REQUEST',
        message: 'The file is empty.',
      });
    });
  });

  describe('Prisma errors', () => {
    it.each([
      ['P2000', 400, 'VALUE_TOO_LONG'],
      ['P2002', 409, 'DUPLICATE'],
      ['P2003', 409, 'REFERENCE_CONFLICT'],
      ['P2020', 400, 'VALUE_OUT_OF_RANGE'],
      ['P2025', 404, 'NOT_FOUND'],
      ['P2034', 409, 'WRITE_CONFLICT'],
    ])('%s → %i %s, with no schema detail', (code, status, stable) => {
      const body = prismaErrorBody(
        known(code, { target: ['companyId', 'code'] }),
      );
      expect(body).toMatchObject({ statusCode: status, code: stable });
      expect(body?.message).not.toMatch(/P20|prisma|companyId|constraint/i);
    });

    it('names the clashing field a person would recognise on a duplicate', () => {
      expect(
        prismaErrorBody(known('P2002', { target: ['companyId', 'shortCode'] }))
          ?.message,
      ).toBe('A record with this short code already exists.');
    });

    it('maps a validation error to 400', () => {
      const error = new Prisma.PrismaClientValidationError(
        'Argument `amount`: Invalid value provided.',
        { clientVersion: '5.22.0' },
      );
      expect(prismaErrorBody(error)).toMatchObject({
        statusCode: 400,
        code: 'INVALID_INPUT',
      });
    });

    it('leaves an unmapped code to the generic 500', () => {
      expect(prismaErrorBody(known('P1001'))).toBeNull();
      const filter = new ApiExceptionFilter();
      const logged = jest
        .spyOn(
          (filter as unknown as { logger: { error: () => void } }).logger,
          'error',
        )
        .mockImplementation(() => undefined);
      expect(filter.bodyFor(known('P1001'))).toEqual({
        statusCode: 500,
        code: 'INTERNAL_ERROR',
        message: 'Something went wrong on the server. Please try again.',
      });
      expect(logged).toHaveBeenCalled();
    });
  });

  it('writes the body with its status', () => {
    const json = jest.fn();
    const status = jest.fn(() => ({ json }));
    const host = {
      getType: () => 'http',
      switchToHttp: () => ({
        getResponse: () => ({ headersSent: false, status }),
      }),
    };
    new ApiExceptionFilter().catch(known('P2034'), host as never);
    expect(status).toHaveBeenCalledWith(409);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'WRITE_CONFLICT' }),
    );
  });
});
