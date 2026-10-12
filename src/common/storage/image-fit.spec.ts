import { fitImage } from './image-fit';

/**
 * Scaling a photograph to fit a document (2026-10-12).
 *
 * ## Vacuity note
 *
 * _Asserting that bytes came back proves a buffer._ The failure this guards against is a
 * photograph that arrives in the DPR workbook **distorted or sideways** — a portrait picture of a
 * pour squashed into a landscape box, which is what happens when a caller places an image without
 * knowing its proportions. So these assert the **dimensions reported back**, because those are
 * what the renderer draws the picture at.
 */
describe('fitting a photograph into a document', () => {
  /**
   * A 40 × 120 PNG — deliberately taller than it is wide, so a renderer or a helper that assumed
   * landscape fails rather than passing by coincidence.
   */
  const TALL = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAACgAAAB4CAIAAAAPEifNAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAA' +
      'i0lEQVRoge3YwQkAIBADQQtLJakk5VuGPgb8C6IOt2fNk3VsXEc9lyueU30g82UGEsVisFgsDov' +
      'BYrE4LJoWYzCvFDHxJXJTBbZJihFRh8VgsVgcFoPFYnFYLBaHxWCxWBwWg8ViMVgsFofFYLFYHB' +
      'aDxWExWCwWh8VgsVgcFovFYTFYLBaHxfzL4gXSIseeauM1EQAAAABJRU5ErkJggg==',
    'base64',
  );

  it('scales the longest edge to the box and keeps the proportions', async () => {
    const fitted = await fitImage(TALL, 60, 72);

    expect(fitted).not.toBeNull();
    // The **height** is what meets the box, because this picture is portrait. A helper that fit
    // the width would answer 60 × 180 and the picture would overflow the row it was drawn in.
    expect(fitted!.height).toBe(60);
    expect(fitted!.width).toBe(20);
  });

  it('never enlarges a picture that is already smaller than the box', async () => {
    // Blowing a small photograph up adds bytes and no detail, and a 40px-wide picture printed at
    // 480 is a smear rather than evidence.
    const fitted = await fitImage(TALL, 4000, 72);

    expect(fitted!.width).toBe(40);
    expect(fitted!.height).toBe(120);
  });

  it('answers null for something that is not a picture', async () => {
    // A signed PDF filed against a line. Null rather than a throw, because the caller names it on
    // the form instead of failing the whole download over one attachment.
    expect(await fitImage(Buffer.from('%PDF-1.7 not an image'), 480, 72)).toBe(
      null,
    );
  });
});
