/** The length of an SFace face embedding: 128 32-bit floats. */
export const FACE_DESCRIPTOR_LENGTH = 128;

export interface FaceMatch {
  matched: boolean;
  /** How far apart the two descriptors are; lower is more similar. The real matcher
   * reports cosine distance (`cosineDistance`), which is what lands in the
   * `faceMatchDistance` columns. */
  distance: number;
}

/**
 * Face descriptor computation and comparison.
 *
 * An abstract class, not a concrete service, for two reasons. The e2e suite injects
 * a deterministic fake so attendance behaviour can be tested without running real
 * inference against real photographs of real people — tests that would otherwise be
 * slow, flaky, and would require committing biometric data to the repository. And
 * it keeps every caller honest about the contract: services depend on "something
 * that compares faces", not on a particular model, so the earlier decision to
 * store a descriptor rather than raw photos (research.md §2) stays enforceable.
 */
export abstract class BiometricsService {
  /**
   * Derives one descriptor representing a person from several enrolment photos.
   *
   * Several photos rather than one because a single frame bakes in whatever that
   * moment's lighting and angle were; averaging across a few produces a descriptor
   * that generalises to the conditions a punch will actually happen in.
   *
   * Throws `NoFaceDetectedError` if any photo contains no detectable face — the
   * contract's 400 case. Rejecting the whole enrolment rather than quietly
   * averaging the usable subset is deliberate: silently enrolling from two photos
   * when the worker submitted five produces a weaker template that nobody knows is
   * weak, and the failure then looks like a broken punch weeks later.
   */
  abstract computeDescriptor(photos: Buffer[]): Promise<Float32Array>;

  /** Compares a descriptor against a stored one, against the configured threshold. */
  abstract compareDescriptors(a: Float32Array, b: Float32Array): FaceMatch;

  /** Serialises a descriptor for the encrypted Postgres column. */
  serializeDescriptor(descriptor: Float32Array): Buffer {
    return Buffer.from(
      descriptor.buffer,
      descriptor.byteOffset,
      descriptor.byteLength,
    );
  }

  /** Reverses `serializeDescriptor`. */
  deserializeDescriptor(bytes: Buffer): Float32Array {
    // Copy rather than aliasing the Buffer's memory: Node pools small Buffer
    // allocations, so a view over one can be silently corrupted by unrelated code
    // reusing the pool.
    const copy = Buffer.from(bytes);
    return new Float32Array(
      copy.buffer,
      copy.byteOffset,
      copy.byteLength / Float32Array.BYTES_PER_ELEMENT,
    );
  }
}

/** Raised when a submitted photo contains no detectable face (contract: 400). */
export class NoFaceDetectedError extends Error {
  constructor(photoIndex: number) {
    super(`No face detected in photo ${photoIndex + 1}.`);
    this.name = 'NoFaceDetectedError';
  }
}

function assertSameLength(a: Float32Array, b: Float32Array): void {
  if (a.length !== b.length) {
    throw new Error(
      `Cannot compare descriptors of different lengths (${a.length} vs ${b.length}).`,
    );
  }
}

/**
 * `1 − cosine similarity`: 0 for the same direction, 1 for unrelated, 2 for opposite. The
 * comparison SFace's accuracy figures are defined in terms of, flipped so that — like the
 * Euclidean distance the stored `faceMatchDistance` columns held before it — lower means
 * more alike. OpenCV's published match line of 0.363 similarity is a distance of 0.637.
 */
export function cosineDistance(a: Float32Array, b: Float32Array): number {
  assertSameLength(a, b);
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  return 1 - dot / (Math.sqrt(aa * bb) || 1);
}

/** Euclidean distance between two descriptors. The matcher compares by
 * `cosineDistance`; this stays for the deterministic test fakes, whose descriptors
 * are not unit vectors. */
export function euclideanDistance(a: Float32Array, b: Float32Array): number {
  assertSameLength(a, b);
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    const delta = a[i] - b[i];
    sum += delta * delta;
  }
  return Math.sqrt(sum);
}
