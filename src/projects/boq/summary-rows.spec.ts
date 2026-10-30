import { summaryRowKind } from './summary-rows';

describe('summaryRowKind', () => {
  it.each([
    ['Add GST @18%', 'tax'],
    ['GST @ 18%', 'tax'],
    ['CGST 9%', 'tax'],
    ['Add: SGST @ 9 %', 'tax'],
    ['Plus labour cess 1%', 'tax'],
    ['Total', 'total'],
    ['Total amount ', 'total'],
    ['Grand Total', 'total'],
    ['Sub-Total', 'total'],
    ['Total in Figures', 'total'],
    ['Quoted Rate in Figures', 'total'],
  ])('%s is a %s row', (description, kind) => {
    expect(summaryRowKind(description)).toBe(kind);
  });

  it.each([
    'Total station survey for alignment',
    'Providing and laying bituminous concrete, rates inclusive of GST',
    'Excavation in ordinary soil',
    'Dismantling of total roof sheeting',
    '',
  ])('%s is an ordinary row', (description) => {
    expect(summaryRowKind(description)).toBeNull();
  });
});
