import { parentPort, workerData } from 'worker_threads';
import {
  analyseFace,
  faceDescriptor,
  FaceAnalysis,
  loadFaceModels,
} from './face-inference';

/**
 * The thread face inference runs on.
 *
 * onnxruntime-node's `session.run` is not asynchronous underneath: it defers to `setImmediate` and
 * then runs the whole model synchronously on whichever thread called it. On the main thread that
 * stalled the API ~12 ms per punch, and ~85 ms when ten punches landed together at shift start
 * (2026-10-26). Here it stalls only this thread, which serves nothing else.
 *
 * Messages in: `{ id, photo, kind }`. Messages out: `{ ready: true }` once, or `{ loadError }`;
 * then per photo `{ id, descriptor }` (kind `descriptor`) or `{ id, analysis }` (kind `analyse`,
 * 057: descriptor, head turn and liveness score from one detection) — null when no face was found —
 * or `{ id, error }`.
 */
export interface FaceInferenceRequest {
  id: number;
  photo: Uint8Array;
  kind: 'descriptor' | 'analyse';
}
export type FaceInferenceResponse =
  | { ready: true }
  | { loadError: string }
  | { id: number; descriptor: Float32Array | null }
  | { id: number; analysis: FaceAnalysis | null }
  | { id: number; error: string };

if (!parentPort) {
  throw new Error('face-inference.worker must be started as a worker thread.');
}
const port = parentPort;
const { threads } = workerData as { threads: number };

loadFaceModels(threads).then(
  (models) => {
    port.on('message', ({ id, photo, kind }: FaceInferenceRequest) => {
      const bytes = Buffer.from(
        photo.buffer,
        photo.byteOffset,
        photo.byteLength,
      );
      const work: Promise<FaceInferenceResponse> =
        kind === 'analyse'
          ? analyseFace(models, bytes).then((analysis) => ({ id, analysis }))
          : faceDescriptor(models, bytes).then((descriptor) => ({
              id,
              descriptor,
            }));
      work.then(
        (response) => port.postMessage(response),
        (error) =>
          port.postMessage({
            id,
            error: String(error),
          } satisfies FaceInferenceResponse),
      );
    });
    port.postMessage({ ready: true } satisfies FaceInferenceResponse);
  },
  (error) =>
    port.postMessage({
      loadError: String(error),
    } satisfies FaceInferenceResponse),
);
