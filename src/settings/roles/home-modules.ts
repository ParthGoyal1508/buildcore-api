/**
 * The places a role's holders can land after signing in (029 FR-020).
 *
 * Module keys, not URLs. The frontend owns its routes and maps each key to one; a stored path
 * would be a post-login redirect target that anyone able to edit a role could point anywhere.
 * Kept in step with the web client's `HOME_MODULE_ROUTES` — a key added here and not there falls
 * back to the user's first module, so the two drifting is untidy rather than broken.
 */
export const HOME_MODULES = [
  'dashboard',
  'my-workspace',
  'hr',
  'projects',
  'plant',
  'inventory',
  'labour',
  'recruitment',
  'assets',
  'partners',
  'reports',
  'settings',
] as const;

export type HomeModule = (typeof HOME_MODULES)[number];

/**
 * Where a user with these roles lands (029 FR-021).
 *
 * A role chosen on purpose beats the default role: someone who is a General User *and* an
 * Accountant is an accountant who also has My Workspace, and should land where accountants do.
 * Between two chosen roles the first by name wins — arbitrary, but stable, so the same person
 * lands in the same place every time. Null means no role names a home, and the client falls back
 * to the first module the user can open — exactly the behaviour before this existed.
 *
 * Whether the user can actually open the module is the client's check, against the permissions
 * it already holds; a role whose home its holders cannot open degrades to that same fallback.
 */
export function resolveHomeModule(
  roles: readonly {
    name: string;
    homeModule: string | null;
    isDefault: boolean;
  }[],
): HomeModule | null {
  const candidates = roles
    .filter(
      (role): role is typeof role & { homeModule: HomeModule } =>
        role.homeModule !== null &&
        (HOME_MODULES as readonly string[]).includes(role.homeModule),
    )
    .sort(
      (a, b) =>
        Number(a.isDefault) - Number(b.isDefault) ||
        a.name.localeCompare(b.name),
    );
  return candidates[0]?.homeModule ?? null;
}
