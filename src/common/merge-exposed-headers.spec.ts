import {
  mergedExposedHeaders,
  mergeExposedHeaders,
} from './merge-exposed-headers';

/**
 * The bug this guards against (042, open from 036 Wave 4): a download handler's
 * `res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition')` used to *replace* the
 * list the CORS middleware had already written, hiding `X-Company-Id` on exactly the download
 * responses — so the wrong-company tab warning (036 B17) never fired on them.
 */
describe('mergedExposedHeaders', () => {
  it('unions the two lists', () => {
    expect(
      mergedExposedHeaders(
        'X-Company-Id, X-Total-Count',
        'Content-Disposition',
      ),
    ).toBe('X-Company-Id, X-Total-Count, Content-Disposition');
  });

  it('de-duplicates case-insensitively, keeping the first spelling', () => {
    expect(
      mergedExposedHeaders(
        'Content-Disposition',
        'content-disposition, X-Company-Id',
      ),
    ).toBe('Content-Disposition, X-Company-Id');
  });

  it('copes with nothing already set, and with array values', () => {
    expect(mergedExposedHeaders(undefined, 'Content-Disposition')).toBe(
      'Content-Disposition',
    );
    expect(
      mergedExposedHeaders(
        ['X-Company-Id'],
        ['Content-Disposition', 'X-Total-Count'],
      ),
    ).toBe('X-Company-Id, Content-Disposition, X-Total-Count');
  });
});

describe('mergeExposedHeaders middleware', () => {
  function fakeResponse() {
    const headers = new Map<string, unknown>();
    const res = {
      getHeader: (name: string) => headers.get(name.toLowerCase()),
      setHeader(name: string, value: unknown) {
        headers.set(name.toLowerCase(), value);
        return res;
      },
    };
    return { res, headers };
  }

  it('keeps what CORS exposed when a download handler sets its own list', () => {
    const { res } = fakeResponse();
    const next = jest.fn();
    mergeExposedHeaders({} as never, res as never, next);
    expect(next).toHaveBeenCalled();

    // The CORS middleware writes the global list first…
    res.setHeader(
      'Access-Control-Expose-Headers',
      'Content-Disposition,X-Total-Count,X-Company-Id',
    );
    // …then the download controller overrides it with just the file name header.
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');

    expect(res.getHeader('Access-Control-Expose-Headers')).toBe(
      'Content-Disposition, X-Total-Count, X-Company-Id',
    );
  });

  it('leaves every other header alone', () => {
    const { res } = fakeResponse();
    mergeExposedHeaders({} as never, res as never, jest.fn());

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Type', 'image/jpeg');

    expect(res.getHeader('Content-Type')).toBe('image/jpeg');
  });
});
