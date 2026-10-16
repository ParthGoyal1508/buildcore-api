import { resolveHomeModule } from './home-modules';

/** Where a user with several roles lands (029 FR-021). */
describe('resolveHomeModule', () => {
  const role = (
    name: string,
    homeModule: string | null,
    isDefault = false,
  ) => ({
    name,
    homeModule,
    isDefault,
  });

  it('is null when no role names a home — the client falls back to the first module', () => {
    expect(resolveHomeModule([role('Viewer', null)])).toBeNull();
    expect(resolveHomeModule([])).toBeNull();
  });

  it('prefers a chosen role over the default role', () => {
    expect(
      resolveHomeModule([
        role('General User', 'my-workspace', true),
        role('Accountant', 'reports'),
      ]),
    ).toBe('reports');
  });

  it('falls back to the default role when it is the only one with a home', () => {
    expect(
      resolveHomeModule([
        role('General User', 'my-workspace', true),
        role('Viewer', null),
      ]),
    ).toBe('my-workspace');
  });

  it('breaks a tie between chosen roles by name, so it is stable', () => {
    const roles = [
      role('Site Engineer', 'plant'),
      role('Accountant', 'reports'),
    ];
    expect(resolveHomeModule(roles)).toBe('reports');
    expect(resolveHomeModule([...roles].reverse())).toBe('reports');
  });

  it('ignores a stored value that is not a known module', () => {
    expect(
      resolveHomeModule([role('Odd', '/somewhere'), role('B', 'hr')]),
    ).toBe('hr');
  });
});
