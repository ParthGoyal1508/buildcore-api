import { AuthenticatedUser } from '../../auth/authenticated-user';
import { LETTER_TOKENS } from './letter-tokens.util';
import { LetterController } from './letter.controller';

/**
 * Template validation belongs to the kind's declared fields, and no longer to this controller.
 *
 * ## What this pins, and why it is worth a test of its own
 *
 * The create and update endpoints used to run a pre-check against `LETTER_TOKENS` — a map keyed by
 * the five letter types the product shipped with — before handing the body to
 * `LetterTemplatesService`, which checks it against the fields the kind actually declares
 * (017 FR-011b).
 *
 * With both in place, a field an administrator added to a **shipped** kind through
 * `PUT /letter-kinds/:id/fields/:token` was declared, was offered by the template editor, and was
 * then refused here by a list written before that endpoint existed. FR-011b — "define a new letter
 * kind, its variable fields and its fixed terms, without a developer" — contradicted by a check
 * that could not know about the field. The refusal also said only "unknown tokens", where the
 * service's names the remedy.
 *
 * So the pre-check was removed on 2026-10-03, and this asserts it stays removed: the controller
 * passes the body through, and the service is the single place that decides. A regression would not
 * announce itself — it would look like a correctly-declared field being rejected for no stated
 * reason, on the one screen whose whole purpose is declaring fields.
 */
describe('LetterController template validation', () => {
  // `permissions` is read by `rlsContextFor`, so a stub without it fails inside the controller
  // rather than in the assertion — which reads as a defect in the code under test.
  const caller = {
    id: 'user-1',
    companyId: 'company-1',
    permissions: [],
  } as unknown as AuthenticatedUser;

  /** A token no shipped kind documents, so the retired pre-check would have refused it. */
  const UNDOCUMENTED = 'siteName';

  function build() {
    const created: { bodyTemplate: string; letterKindId: string }[] = [];
    const updated: { id: string; bodyTemplate?: string }[] = [];
    const templates = {
      create: async (
        _caller: unknown,
        dto: { bodyTemplate: string; letterKindId: string },
      ) => {
        created.push(dto);
        return { id: 'template-1', ...dto };
      },
      update: async (
        _caller: unknown,
        id: string,
        dto: { bodyTemplate?: string },
      ) => {
        updated.push({ id, ...dto });
        return { id };
      },
      findAll: async () => [
        { id: 'template-1', letterType: 'offer', letterKindId: 'kind-offer' },
      ],
    };
    const kinds = {
      requireByKey: async (_ctx: unknown, _companyId: string, key: string) => ({
        id: `kind-${key}`,
        key,
      }),
    };
    const controller = new LetterController(
      templates as never,
      {} as never,
      kinds as never,
    );
    return { controller, created, updated };
  }

  it('is checking something real — the token used below is genuinely undocumented', () => {
    // Without this the two cases below would pass against a token that every list happens to
    // contain, and prove nothing about the removed pre-check.
    for (const tokens of Object.values(LETTER_TOKENS)) {
      expect(tokens).not.toContain(UNDOCUMENTED);
    }
    expect(Object.keys(LETTER_TOKENS).length).toBeGreaterThan(0);
  });

  it('passes a body carrying an undocumented token through to the service', async () => {
    const { controller, created } = build();

    await controller.createTemplate(
      caller,
      {
        letterType: 'offer',
        name: 'Offer, with a site field the administrator added',
        bodyTemplate: `Dear {{candidateName}}, you will be posted at {{${UNDOCUMENTED}}}.`,
      } as never,
      '127.0.0.1',
    );

    // Reached the service unaltered. Whether it is accepted is the service's decision, made against
    // what the kind declares — which is the whole point: the administrator may have just declared
    // `siteName` on the offer kind, and only the service can know that.
    expect(created).toHaveLength(1);
    expect(created[0].bodyTemplate).toContain(`{{${UNDOCUMENTED}}}`);
    expect(created[0].letterKindId).toBe('kind-offer');
  });

  it('does not re-check the body on update either', async () => {
    const { controller, updated } = build();

    await controller.updateTemplate(
      caller,
      'template-1',
      {
        bodyTemplate: `Posted at {{${UNDOCUMENTED}}}.`,
      } as never,
      '127.0.0.1',
    );

    // The update path had its own copy of the pre-check, which also fetched every template just to
    // learn the kind's key. Both are gone; the service validates against the stored kind.
    expect(updated).toEqual([
      { id: 'template-1', bodyTemplate: `Posted at {{${UNDOCUMENTED}}}.` },
    ]);
  });

  it('still resolves the wire’s letterType key to a kind row', async () => {
    const { controller, created } = build();

    // 017 §1: the wire still says `letterType` and still carries `offer`, but the enum behind it is
    // a table now. A client that sent `letterType: "offer"` before sends the same thing and gets
    // the same answer — and a kind key invented by an administrator resolves the same way, which is
    // what lets the editor serve all fifteen kinds rather than five.
    await controller.createTemplate(
      caller,
      {
        letterType: 'letter_work_order',
        name: 'Work order',
        bodyTemplate: 'Scope: {{scope}}',
      } as never,
      '127.0.0.1',
    );

    expect(created[0].letterKindId).toBe('kind-letter_work_order');
  });
});
