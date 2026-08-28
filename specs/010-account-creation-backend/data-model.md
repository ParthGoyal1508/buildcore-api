# Data Model: Account Creation Backend (Invite Flow)

Field names are conceptual; exact Prisma types are a task-level decision. See research.md for
schema placement rationale.

## User Account (`shared` schema — MODIFIES feature 001's model)

```
{ ...unchanged from 001: id, email, password, roleId, companyId, consecutiveFailures, lockedUntil,
  mustChangePassword,
  status: 'pending' | 'active' | 'deactivated',   // MODIFIED — gains 'pending' (was active|deactivated)
  displayName: string?,                            // NEW — used only when no Employee is linked
  createdAt, updatedAt }
```

`password` is nullable at the Prisma level for a `pending` row (no password exists until
set-password succeeds) — 001's column was implicitly non-null in practice since only fully-created
accounts existed before this feature; this is an additive nullability relaxation, not a breaking
change to any existing row (all pre-existing rows already have a password).

## Invite Token (`shared` schema — new)

```
{ id, userId FK→User, tokenHash (SHA-256 hex), expiresAt (createdAt + 48h),
  consumedAt: timestamp?, createdAt }
```

At most one *usable* (unconsumed, unexpired) token per user at a time. Resend does not delete the
prior row (audit trail per FR-014) — it inserts a new row and the prior row's usability is purely
a function of `expiresAt`/`consumedAt` versus "is this the most recent row for this userId,"
enforced at the query level, not via a boolean `invalidated` column (avoids a second source of
truth for the same fact).

## Cross-module references

| Reference | Stored as | Resolved via |
|---|---|---|
| `User.roleId` | Existing FK (002) | `SettingsService.getRoleById()` for name display in the account list |
| `User.companyId` | Existing FK (001) | Read directly — same schema (`shared` reads its own table) |
| `employeeId` (create-user input) | Not stored on `User` — resolved to `Employee.userId` write | `HrService.getUnlinkedEmployees()` (list), `HrService.linkEmployeeToUser(employeeId, userId)` (write, transactional with User creation) |
| Account list's employee name | Not stored | `HrService.getEmployeeById()` per row when `employeeId` link exists |

## `HrService` exported methods this feature requires (new, added to `005-hr-payroll-backend`)

```typescript
interface HrService {
  getUnlinkedEmployees(companyId: string, search?: string): Promise<{ id: string; firstName: string; lastName: string }[]>;
  linkEmployeeToUser(employeeId: string, userId: string): Promise<void>; // throws if already linked
}
```

These do not exist in 005's current shipped scope (005 never needed to query "employees without a
User account" or write `userId`) — this feature adds them to 005's own spec/data-model/tasks as a
small amendment, the same cross-feature-amendment pattern used for `008-projects-backend`'s
`getLabourCostByProject()` addition to 005.

## Response shape: Account List row

```typescript
interface AccountListRow {
  id: string;
  email: string;
  status: 'pending' | 'active' | 'deactivated';
  roleName: string;
  companyName: string | null;    // null only for Super Admin
  displayName: string;           // resolved: Employee full name, or User.displayName
  employeeId: string | null;
  inviteExpiresAt: string | null; // only meaningful while status === 'pending'
  lastLoginAt: string | null;
}
```

This shape is produced by `UsersService.findAllForCompany()` (below) and consumed by
`002-settings-backend`'s `GET /settings/users` (its `UserSummary`, extended to match — see that
feature's data-model.md) — this feature has no separate `GET /account-creation/users` endpoint of
its own (research.md §8).

## `UsersService` (exported from `AccountCreationModule`, research.md §8)

```typescript
interface UsersService {
  // This feature's own concern:
  create(dto: CreateUserDto): Promise<{ id: string; email: string; status: 'pending'; emailDispatchFailed: boolean }>;
  resendInvite(userId: string): Promise<{ emailDispatchFailed: boolean }>; // 409 if not pending

  // Owned here, but consumed by 002-settings-backend's User Story 2 & 3 — corrected from an
  // original assumption that these would live in AuthModule (001), which never built them:
  findAllForCompany(companyId: string | null, filters: { status?; roleId?; companyId? }): Promise<AccountListRow[]>;
  updateRoleOrStatus(userId: string, dto: { roleId?: string; status?: 'active' | 'deactivated' }): Promise<AccountListRow>; // 400 if status:'active' requested on a pending account
  deleteAccount(userId: string): Promise<void>; // also deletes any InviteToken row
  countByRoleId(roleId: string): Promise<number>;
  clearRoleAssignment(roleId: string): Promise<void>;
  countActiveSuperAdmins(): Promise<number>;
}
```
