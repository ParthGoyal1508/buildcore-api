import { ValidationPipe } from '@nestjs/common';

import { CreateClientDto } from './create-client.dto';
import { UpdateClientDto } from './update-client.dto';

/**
 * The client DTOs under **the pipe's own settings**, not under default ones (025 FR-039).
 *
 * ## Why this exists
 *
 * `configure-app.ts` runs the global pipe at `whitelist` **and** `forbidNonWhitelisted`, so a field
 * the DTO does not declare is a **400 naming it**, never a quietly dropped value. That is the right
 * setting and it has one consequence worth a test: adding a column to the database and to one DTO
 * is not enough — every path that writes it must declare it, or the write is refused with
 * `property <x> should not exist`.
 *
 * `UpdateClientDto` inherits from `CreateClientDto` through `PartialType`, which is exactly the
 * arrangement that makes this easy to get wrong in the other direction: it *looks* like inheritance
 * cannot drift, and it cannot — but only while `PartialType` is reading the parent's Swagger
 * metadata, which is a decorator somebody can forget on a new field.
 *
 * So both shapes are exercised rather than the create alone.
 */
describe('Client DTOs under the global pipe', () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });

  const create = { metatype: CreateClientDto, type: 'body' as const };
  const update = { metatype: UpdateClientDto, type: 'body' as const };

  it('accepts a PAN and a state code on create', async () => {
    await expect(
      pipe.transform(
        {
          name: 'Karnataka Industrial Areas Development Board',
          pan: 'CQEPG8041Q',
          state: '08',
        },
        create,
      ),
    ).resolves.toMatchObject({ pan: 'CQEPG8041Q', state: '08' });
  });

  it('accepts them on edit too, which is the path a client is actually corrected through', async () => {
    // The half that would otherwise go untested: a client created before these columns existed is
    // edited, not re-created, so the update path is the one every real correction travels.
    await expect(
      pipe.transform({ pan: 'CQEPG8041Q', state: '08' }, update),
    ).resolves.toMatchObject({ pan: 'CQEPG8041Q', state: '08' });
  });

  /**
   * The refusal's own sentence, read from the response body rather than from `.message`.
   *
   * A `BadRequestException`'s message is the bare string "Bad Request Exception"; every field-level
   * reason is in `getResponse().message`. Asserting on the former passes against a refusal for
   * *any* reason at all, which would make each test below agree with a DTO that refused everything.
   */
  const refusalFor = async (
    body: Record<string, unknown>,
    meta: typeof create | typeof update,
  ): Promise<string> => {
    try {
      await pipe.transform(body, meta);
    } catch (error) {
      const response = (
        error as { getResponse: () => { message: string[] } }
      ).getResponse();
      return [response.message].flat().join(' ');
    }
    throw new Error('expected the pipe to refuse this body, and it did not');
  };

  it('refuses a PAN that is not one, rather than printing it on a bill', async () => {
    expect(await refusalFor({ pan: 'NOTAPAN' }, update)).toMatch(
      /permanent account number/,
    );
  });

  it('refuses a state code that is not two digits', async () => {
    // `8` is not `08`. A one-character code would compare unequal to every real one and silently
    // read as inter-state.
    expect(await refusalFor({ state: '8' }, update)).toMatch(
      /two-digit GST state code/,
    );
  });

  it('still refuses a field neither DTO declares', async () => {
    // The non-vacuity assertion: without it, a pipe configured with `forbidNonWhitelisted` off
    // would pass every test above while accepting anything at all.
    expect(
      await refusalFor({ name: 'X', gstNumber: '27AAPFU0939F1ZV' }, create),
    ).toMatch(/should not exist/);
  });
});
