import { join } from 'path';
import type { InferenceSession, Tensor } from 'onnxruntime-node';

/**
 * The face pipeline itself — decode, YuNet detection, five-point alignment, SFace embedding — with
 * no Nest in it, because it runs inside `face-inference.worker.ts` rather than on the event loop.
 * `OnnxBiometricsService` is the only caller, by message.
 */

/**
 * sharp's `types` field points at its ESM declarations, which this project's node10 module
 * resolution cannot call through an `import` — see `image-processing.service.ts`.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sharp: (input?: Buffer) => import('sharp').Sharp = require('sharp');

/** YuNet's fixed input square. A frame is downscaled to fit it and padded, never stretched. */
export const DETECTOR_INPUT_SIZE = 640;
/** SFace's input: a 112×112 crop aligned on five landmarks. */
const ALIGNED_SIZE = 112;
/** The anchor grids YuNet predicts on, one per output scale. */
const STRIDES = [8, 16, 32] as const;
/**
 * Below OpenCV's own 0.9 default, on purpose. The detector only decides *whether* there is a face;
 * SFace decides *whose* it is, so a lower bar cannot cause a false match — it lets a dim or angled
 * face through to be compared, where 0.9 would refuse the punch as "no face" (020 FR-013).
 */
const DETECTION_SCORE_THRESHOLD = 0.8;

/**
 * Where SFace expects the right eye, left eye, nose tip and mouth corners in its 112×112 input —
 * the standard ArcFace alignment template SFace was trained on. YuNet emits landmarks in the same
 * order, so aligning is fitting one point set onto the other.
 */
export const ALIGNMENT_TEMPLATE: ReadonlyArray<readonly [number, number]> = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
];

type Point = readonly [number, number];

/** Raw interleaved pixels plus their dimensions. */
export interface RawImage {
  data: Buffer;
  width: number;
  height: number;
  channels: number;
}

/** `x' = a·x − b·y + tx`, `y' = b·x + a·y + ty`: rotation, uniform scale and shift. */
export interface Similarity {
  a: number;
  b: number;
  tx: number;
  ty: number;
}

export interface FaceModels {
  ort: typeof import('onnxruntime-node');
  detector: InferenceSession;
  recogniser: InferenceSession;
}

export async function loadFaceModels(threads: number): Promise<FaceModels> {
  // Required here rather than imported at the top so nothing loads the native binding until a
  // face is actually about to be matched.
  /* eslint-disable-next-line @typescript-eslint/no-var-requires */
  const ort: typeof import('onnxruntime-node') = require('onnxruntime-node');
  const options: InferenceSession.SessionOptions = {
    // Capped rather than left to ORT's default of one thread per core: in a container that
    // default counts the host's cores, not the instance's share, and oversubscribing a small
    // instance slows every other request too.
    intraOpNumThreads: threads,
    interOpNumThreads: 1,
    // 3 = errors only. YuNet's export trips a graph-optimisation warning on every load that
    // says nothing about whether inference is correct.
    logSeverityLevel: 3,
  };
  // Vendored beside this file; `nest-cli.json` copies them into `dist` (models/README.md).
  const modelDir = join(__dirname, 'models');
  return {
    ort,
    detector: await ort.InferenceSession.create(
      join(modelDir, 'face_detection_yunet_2023mar.onnx'),
      options,
    ),
    recogniser: await ort.InferenceSession.create(
      join(modelDir, 'face_recognition_sface_2021dec_int8.onnx'),
      options,
    ),
  };
}

/** One photo to its unit-length 128-float embedding, or null if it shows no face. */
export async function faceDescriptor(
  models: FaceModels,
  photo: Buffer,
): Promise<Float32Array | null> {
  const image = await decode(photo);
  const landmarks = await detect(models, image);
  return landmarks ? embed(models, image, landmarks) : null;
}

/**
 * Decodes to raw RGB, no larger than the detector's square on either edge.
 *
 * Downscaled here, not by the model: the detector works on a fixed square anyway, and handing it
 * a full camera frame only multiplies the memory every later step copies — a 12 MP photo decoded
 * at full size held 1.3 GB of process memory under face-api (2026-10-26). `withoutEnlargement`,
 * because upscaling adds pixels and no detail. Rotated per EXIF, as `ImageProcessingService`
 * does, so a photo taken sideways reaches the detector upright. Three channels: an alpha channel
 * carries nothing a face matcher uses, and RGBA read as RGB shifts every pixel's colour.
 */
async function decode(photo: Buffer): Promise<RawImage> {
  const { data, info } = await sharp(photo)
    .resize({
      width: DETECTOR_INPUT_SIZE,
      height: DETECTOR_INPUT_SIZE,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .rotate()
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    data,
    width: info.width,
    height: info.height,
    channels: info.channels,
  };
}

/** The five landmarks of the most confident face, in `image`'s pixel space. */
async function detect(
  { ort, detector }: FaceModels,
  image: RawImage,
): Promise<Point[] | null> {
  const size = DETECTOR_INPUT_SIZE;
  const plane = size * size;
  // YuNet takes BGR, 0–255, channels-first. The image already fits the square, so it is copied
  // into the top-left corner and the rest stays black — which keeps detector coordinates
  // identical to image coordinates.
  const input = new Float32Array(3 * plane);
  const { data, width, height, channels } = image;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const src = (y * width + x) * channels;
      const dst = y * size + x;
      input[dst] = data[src + 2];
      input[plane + dst] = data[src + 1];
      input[2 * plane + dst] = data[src];
    }
  }
  const out = await detector.run({
    input: new ort.Tensor('float32', input, [1, 3, size, size]),
  });

  let best: { score: number; landmarks: Point[] } | null = null;
  for (const stride of STRIDES) {
    const cols = size / stride;
    const cells = cols * cols;
    const cls = out[`cls_${stride}`].data as Float32Array;
    const obj = out[`obj_${stride}`].data as Float32Array;
    const kps = out[`kps_${stride}`].data as Float32Array;
    for (let i = 0; i < cells; i += 1) {
      // YuNet's score is the geometric mean of the class and objectness heads, each clamped to
      // [0, 1] — as OpenCV's `FaceDetectorYN` decodes it.
      const score = Math.sqrt(clamp01(cls[i]) * clamp01(obj[i]));
      if (score < DETECTION_SCORE_THRESHOLD || score <= (best?.score ?? 0)) {
        continue;
      }
      const col = i % cols;
      const row = (i - col) / cols;
      const landmarks: Point[] = [];
      for (let n = 0; n < 5; n += 1) {
        landmarks.push([
          (kps[i * 10 + 2 * n] + col) * stride,
          (kps[i * 10 + 2 * n + 1] + row) * stride,
        ]);
      }
      best = { score, landmarks };
    }
  }
  // The single most confident face, not every face: enrolment and punching are both one person
  // in front of the camera, so non-maximum suppression across several faces would compute boxes
  // nothing reads.
  return best?.landmarks ?? null;
}

/** Aligns the face onto SFace's template and returns its L2-normalised embedding. */
async function embed(
  { ort, recogniser }: FaceModels,
  image: RawImage,
  landmarks: Point[],
): Promise<Float32Array> {
  const input = alignFace(image, fitSimilarity(landmarks, ALIGNMENT_TEMPLATE));
  const out = await recogniser.run({
    data: new ort.Tensor('float32', input, [1, 3, ALIGNED_SIZE, ALIGNED_SIZE]),
  });
  return normalise(Float32Array.from((out.fc1 as Tensor).data as Float32Array));
}

function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

export function normalise(vector: Float32Array): Float32Array {
  let sum = 0;
  for (const value of vector) sum += value * value;
  const length = Math.sqrt(sum) || 1;
  return vector.map((value) => value / length);
}

/**
 * The least-squares similarity transform taking `from` onto `to` — the 2-D case of Umeyama's
 * method without reflection, which is what OpenCV's `alignCrop` estimates for SFace.
 */
export function fitSimilarity(
  from: ReadonlyArray<Point>,
  to: ReadonlyArray<Point>,
): Similarity {
  const n = from.length;
  let fx = 0;
  let fy = 0;
  let tx = 0;
  let ty = 0;
  for (let i = 0; i < n; i += 1) {
    fx += from[i][0];
    fy += from[i][1];
    tx += to[i][0];
    ty += to[i][1];
  }
  fx /= n;
  fy /= n;
  tx /= n;
  ty /= n;

  let dot = 0;
  let cross = 0;
  let norm = 0;
  for (let i = 0; i < n; i += 1) {
    const px = from[i][0] - fx;
    const py = from[i][1] - fy;
    const qx = to[i][0] - tx;
    const qy = to[i][1] - ty;
    dot += px * qx + py * qy;
    cross += px * qy - py * qx;
    norm += px * px + py * py;
  }
  const a = dot / norm;
  const b = cross / norm;
  return { a, b, tx: tx - (a * fx - b * fy), ty: ty - (b * fx + a * fy) };
}

/**
 * Warps the face into SFace's 112×112 input: RGB, 0–255, channels-first, bilinear.
 *
 * Each output pixel is mapped back through the inverse transform and sampled from the source, so
 * every output pixel is filled exactly once; pixels that land outside the photo stay black, as
 * OpenCV's `warpAffine` leaves them.
 */
export function alignFace(image: RawImage, t: Similarity): Float32Array {
  const { data, width, height, channels } = image;
  const plane = ALIGNED_SIZE * ALIGNED_SIZE;
  const out = new Float32Array(3 * plane);
  const det = t.a * t.a + t.b * t.b;
  const at = (x: number, y: number, c: number) =>
    x < 0 || y < 0 || x >= width || y >= height
      ? 0
      : data[(y * width + x) * channels + c];

  for (let v = 0; v < ALIGNED_SIZE; v += 1) {
    for (let u = 0; u < ALIGNED_SIZE; u += 1) {
      const dx = u - t.tx;
      const dy = v - t.ty;
      const x = (t.a * dx + t.b * dy) / det;
      const y = (t.a * dy - t.b * dx) / det;
      const x0 = Math.floor(x);
      const y0 = Math.floor(y);
      const wx = x - x0;
      const wy = y - y0;
      for (let c = 0; c < 3; c += 1) {
        out[c * plane + v * ALIGNED_SIZE + u] =
          at(x0, y0, c) * (1 - wx) * (1 - wy) +
          at(x0 + 1, y0, c) * wx * (1 - wy) +
          at(x0, y0 + 1, c) * (1 - wx) * wy +
          at(x0 + 1, y0 + 1, c) * wx * wy;
      }
    }
  }
  return out;
}
