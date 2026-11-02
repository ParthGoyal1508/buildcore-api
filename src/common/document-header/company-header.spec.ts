import { companyContactLines, websiteUrl } from './company-header';
import { clauseLead } from '../../letters/letter-pdf.renderer';

/** The company band every generated PDF opens with (055). */
describe('companyContactLines', () => {
  it('prints each office labelled, then phone and email, then the website as a link', () => {
    expect(
      companyContactLines({
        registeredOffice: '28 A Gandhi Nagar, Deoli, Rajasthan - 304804',
        corporateOffice: 'Tirupati House, Gaurav Path Road, Deoli',
        branchOffice: 'Holambi Kalan, Delhi - 110082',
        phone: '9784570406',
        email: 'INFO@PARTHREALCON.COM',
        website: 'WWW.PARTHREALCON.COM',
      }),
    ).toEqual([
      'Regd. Office: 28 A Gandhi Nagar, Deoli, Rajasthan - 304804',
      'Corp. Office: Tirupati House, Gaurav Path Road, Deoli',
      'Branch Office: Holambi Kalan, Delhi - 110082',
      'Ph: 9784570406  |  Email: info@parthrealcon.com',
      'Website: https://www.parthrealcon.com',
    ]);
  });

  it('leaves out blank parts, and an office that is the registered office again', () => {
    expect(
      companyContactLines({
        registeredOffice: '28 A Gandhi Nagar, Deoli',
        corporateOffice: '28 A, Gandhi Nagar, DEOLI',
        branchOffice: null,
        email: ' ',
      }),
    ).toEqual(['Regd. Office: 28 A Gandhi Nagar, Deoli']);
  });

  it('keeps a scheme already typed and drops a trailing slash', () => {
    expect(websiteUrl('https://tirupatigroups.in/')).toBe(
      'https://tirupatigroups.in',
    );
    expect(websiteUrl('')).toBeNull();
  });
});

describe('clauseLead — the heading printed bold', () => {
  it.each([
    ['4. DELIVERY TERMS:', '4. DELIVERY TERMS:', ''],
    [
      '4.1 Delivery Date: Time of delivery is essential.',
      '4.1 Delivery Date:',
      ' Time of delivery is essential.',
    ],
    ['Payment Terms: 30 days', 'Payment Terms:', ' 30 days'],
    [
      '9. Taxation — 9.1: For products under this PO',
      '9. Taxation — 9.1:',
      ' For products under this PO',
    ],
  ])('%s', (line, lead, rest) => {
    expect(clauseLead(line)).toEqual({ lead, rest });
  });

  it.each([
    'Please arrange to supply the following items as stipulated: below',
    'the meeting starts at 10:30 sharp',
    'Visit https://parthrealcon.com for details',
    '1. Any special conditions issued under this Purchase Order shall be read together: with',
    'no colon at all',
  ])('leaves "%s" as prose', (line) => {
    expect(clauseLead(line)).toBeNull();
  });
});
