import { Global, Module } from '@nestjs/common';

import { SearchController } from './search.controller';
import { SearchSourcesRegistry } from './search-sources.registry';

/**
 * Cross-register search (021 US1) — `bugs.md` item 4.
 *
 * **This module owns no tables and issues no queries.** That is not an unfinished state:
 * `Employee` (`hr`), `Vendor` (`partners`), `Equipment` (`plant`) and `Project`
 * (`projects`) are in four schemas, and Principle I forbids a single query spanning them.
 * A module holding a registry and a controller is the only shape that answers "search
 * everything" without either duplicating four registers or violating that boundary.
 *
 * `@Global` so each owning module can inject `SearchSourcesRegistry` and register itself
 * on init without this module importing any of them — the dependency points one way and
 * the data flows back, exactly as `ProjectSourcesRegistry` does and for the same reason
 * (a cycle otherwise, spanning five modules).
 *
 * `src/search/search-boundary.spec.ts` fails if a direct query into any of those four
 * schemas ever appears in this directory. The design eroding by one convenient query is
 * the realistic failure, not a deliberate rewrite.
 */
@Global()
@Module({
  controllers: [SearchController],
  providers: [SearchSourcesRegistry],
  exports: [SearchSourcesRegistry],
})
export class SearchModule {}
