import config from '../common/configs/config';

/**
 * The term-length bounds, read once at module load.
 *
 * `class-validator`'s decorators are evaluated when the class is defined, so they cannot
 * take a value injected later — which is the one place this codebase's
 * configuration-over-literals rule needs a seam rather than a `ConfigService`. The values
 * still come from `config()` (Principle III); only the moment of reading is early.
 *
 * The registry and the controller read their caps through `ConfigService` normally.
 */
const loaded = config();

export const SEARCH_MIN_TERM_LENGTH = loaded.search.minTermLength;
export const SEARCH_MAX_TERM_LENGTH = loaded.search.maxTermLength;
