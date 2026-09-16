import { BadRequestException } from '@nestjs/common';

import { DOCUMENT_TYPE_RESTRICTED } from './letter-error-codes';

/** `{{token}}`, the same shape 011 established for recruitment templates. */
const TOKEN_RE = /\{\{\s*([\w.]+)\s*\}\}/g;

/** One document type, as the resolver needs to see it. */
export interface ResolverDocumentType {
  code: string;
  isRestricted: boolean;
}

/** Every `{{token}}` in a body, deduplicated, in first-seen order. */
export function extractTokens(body: string): string[] {
  const found = new Set<string>();
  let match: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;
  while ((match = TOKEN_RE.exec(body)) !== null) found.add(match[1]);
  return [...found];
}

/**
 * Normalises a token to the document code it might be naming.
 *
 * Both `{{document.AADHAAR}}` and a bare `{{AADHAAR}}` are treated as references to the
 * `AADHAAR` document type. Belt and braces on purpose: the cost of missing one here is
 * legal rather than functional, and a template author who writes the short form did not
 * intend a different rule.
 */
function documentCodeOf(token: string): string {
  const withoutPrefix = token.replace(/^document[._]/i, '');
  return withoutPrefix.toUpperCase();
}

/**
 * Refuses a template body that references a restricted document type (FR-024, research §6).
 *
 * **This is the enforcement point, and it is structural.** The alternative — listing the
 * letter kinds that may not render an Aadhaar — is a rule written into the kinds that
 * existed when the code shipped, and FR-011 lets an administrator create a kind tomorrow
 * that the list has never heard of. Quickstart Pass 5 tests exactly that: define a new
 * kind, try the same thing, and it must fail identically.
 *
 * Takes the company's document types as data rather than reading them, because
 * `DocumentType` lives in `settings` and the letters module may not query it
 * (Principle I). The caller fetches them through the exported service method.
 */
export function assertNoRestrictedTypes(
  body: string,
  documentTypes: ResolverDocumentType[],
): void {
  const restricted = new Set(
    documentTypes
      .filter((t) => t.isRestricted)
      .map((t) => t.code.toUpperCase()),
  );
  if (restricted.size === 0) return;

  const offending = extractTokens(body).filter((token) =>
    restricted.has(documentCodeOf(token)),
  );
  if (offending.length === 0) return;

  throw new BadRequestException({
    statusCode: 400,
    message:
      `This template references ${offending.join(
        ', ',
      )}, which is regulated personal ` +
      `data and is never rendered into a letter. It can be retrieved only through an ` +
      `explicit, permission-checked, audit-logged download.`,
    code: DOCUMENT_TYPE_RESTRICTED,
  });
}

/**
 * Substitutes `{{token}}` with values; an unresolved token renders empty.
 *
 * Empty rather than left as `{{token}}`: a letter that goes out with a literal
 * `{{employeeName}}` in it has already embarrassed somebody, whereas a blank is
 * visible in the preview the composer requires before issue.
 */
export function renderTemplate(
  body: string,
  values: Record<string, string>,
): string {
  return body.replace(TOKEN_RE, (_, token: string) => values[token] ?? '');
}
