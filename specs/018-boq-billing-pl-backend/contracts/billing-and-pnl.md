# Contract: BOQ, Billing and P&L (018, backend)

**Date**: 2026-09-16 · Shapes: [data-model.md](../data-model.md)

## Part 1 — Service methods across module boundaries

### `ProjectPnlService` (projects)

```ts
/** Revenue and cost by category for one project, monthly and cumulative (FR-010, FR-011). */
summaryFor(ctx, projectId: string, month: string): Promise<{
  month: string;
  revenue: { billed: number; certified: number | null };
  costs: { category: CostCategory; month: number; cumulative: number; budget: number | null }[];
  unavailableModules: string[];   // "we could not ask", never "there is none"
  margin: { month: number; cumulative: number };
}>;

/** Every project the caller may see, each with its position, plus the company total (FR-014). */
groupSummary(ctx, caller, month: string): Promise<{
  projects: ProjectPosition[];
  total: ProjectPosition;
}>;
```

> **`groupSummary` calls `summaryFor` and sums.** It has no query of its own, for the reason
> research §7 gives: a total computed by a different path than the rows beneath it is how a director
> ends up with a company figure that does not equal the sum of the projects on the same screen.

### Registered cost sources

```ts
/** What a module contributes to a project's monthly cost. Registered, never imported. */
interface ProjectCostSource {
  readonly module: string;             // 'labour', 'inventory', 'plant'
  readonly category: CostCategory;
  costFor(ctx, projectIds: string[], month: string): Promise<Map<string, number>>;
}
```

**Batch by construction.** `projectIds` is an array because the group view asks for every project at
once, and a per-project signature would make the group view an N+1 with no way to fix it short of
changing every registrant.

## Part 2 — HTTP surface

| Method | Path | Guard | Notes |
|---|---|---|---|
| `GET` | `/projects/:id/client-bills` | `PROJECT_FINANCIALS` | With cumulative billed quantity per line |
| `POST` | `/projects/:id/client-bills` | `PROJECT_FINANCIALS` | Compose from BOQ lines; over-scope lines flagged, not refused |
| `POST` | `/client-bills/:id/submit` | `PROJECT_FINANCIALS` | `400 BILL_DEVIATION_REASON_REQUIRED` when a flagged line has no reason |
| `POST` | `/client-bills/:id/certify` | `PROJECT_FINANCIALS` | FR-005. Retains both figures |
| `POST` | `/ra-bills/:id/lines` | `PROJECT_FINANCIALS` | Measured against the awarded BOQ |
| `POST` | `/work-orders/:id/retention-release` | `PROJECT_FINANCIALS` | Explicit act, never automatic |
| `GET` | `/projects/:id/summary?month=` | `PROJECT_FINANCIALS` | FR-010 to FR-012 |
| `GET` | `/projects/summary?month=` | `PROJECT_FINANCIALS` | FR-014, the group view |

### Error codes

| Code | Meaning |
|---|---|
| `BOQ_REQUIRED` | FR-001 scenario 5: the project has no BOQ to bill from |
| `BILL_DEVIATION_REASON_REQUIRED` | FR-004: a line exceeds contracted quantity and no reason was given |
| `BOQ_RATE_MISSING` | A line's BOQ rate is still 0 — billing it would claim nothing |
| `RA_BILL_APPROVAL_INVALIDATED` | FR-009: quantities changed under a completed approval |
| `RETENTION_EXCEEDS_HELD` | A release for more than was ever withheld |
