import { requirementApplies } from '../projects/documents/project-documents.service';
import {
  kindAppliesTo,
  REQUIRED_PROJECT_DOCUMENT_KINDS,
} from './document-kinds';

describe('project document kinds by project type (048)', () => {
  const codesFor = (sector: 'government' | 'private') =>
    REQUIRED_PROJECT_DOCUMENT_KINDS.filter((k) => kindAppliesTo(k, sector)).map(
      (k) => k.code,
    );

  it('requires the full government set of a government project', () => {
    expect(codesFor('government')).toEqual([
      'LOI',
      'WORK_ORDER',
      'INSURANCE',
      'MINING_PERMISSION',
      'LABOUR_INSURANCE',
      'BOQ',
      'AGREEMENT',
    ]);
  });

  it('requires work order, BOQ and both insurances of a private project', () => {
    expect(codesFor('private')).toEqual([
      'WORK_ORDER',
      'INSURANCE',
      'LABOUR_INSURANCE',
      'BOQ',
    ]);
  });

  it('holds an untyped project to every kind', () => {
    expect(
      REQUIRED_PROJECT_DOCUMENT_KINDS.every((k) => kindAppliesTo(k, null)),
    ).toBe(true);
    expect(
      requirementApplies({ forGovernment: false, forPrivate: false }, null),
    ).toBe(true);
  });

  it('reads a configured row’s flags', () => {
    const govOnly = { forGovernment: true, forPrivate: false };
    expect(requirementApplies(govOnly, 'government')).toBe(true);
    expect(requirementApplies(govOnly, 'private')).toBe(false);
  });
});
