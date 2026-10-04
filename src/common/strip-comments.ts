/**
 * Source with its comments removed, for the guards that scan source text.
 *
 * ## Why this is shared, and why it is load-bearing
 *
 * Two source-scanning guards exist in this repository, and **both of them were wrong in the same
 * way before this existed**, in opposite directions:
 *
 * - `src/common/prisma/e2e-teardown.spec.ts` checks that every e2e suite calls `app.close()`. Its
 *   first version was tested by commenting the call out — and stayed green, because
 *   `// await app.close();` contains `app.close()`. A comment satisfied a requirement.
 * - `src/common/swc-interop.spec.ts` forbids `import * as … from 'pdfkit'`. It failed against
 *   itself the moment it was committed, because its own docblock *quotes* the forbidden form to
 *   explain it. A comment violated a prohibition.
 *
 * A comment is not code in either direction. Both guards strip first now.
 *
 * ## Deliberately crude
 *
 * It does not know about `//` inside a string literal, or about regex literals containing `/*`.
 * Crude is the right trade here: the failure mode of over-stripping is a guard that misses
 * something and says so loudly when the real case appears, while the failure mode it replaces is
 * a guard that passes for the wrong reason — which is the thing both of these exist to prevent.
 * It has its own tests because two guards now depend on it, and a silent bug here would weaken
 * both at once.
 */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}
