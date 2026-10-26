import { parentPort, workerData } from 'worker_threads';
import { faceDescriptor, loadFaceModels } from './face-inference';

/**
 * The thread face inference runs on.
 *
 * onnxruntime-node's `session.run` is not asynchronous underneath: it defers to `setImmediate` and
 * then runs the whole model synchronously on whichever thread called it. On the main thread that
 * stalled the API ~12 ms per punch, and ~85 ms when ten punches landed together at shift start
 * (2026-10-26). Here it stalls only this thread, which serves nothing else.
 *
 * Messages in: `{ id, photo }`. Messages out: `{ ready: true }` once, or `{ loadError }`; then
 * `{ id, descriptor }` per photo, `descriptor` null when no face was found, or `{ id, error }`.
 */
export interface FaceInferenceRequest {
  id: number;
  photo: Uint8Array;
}
export type FaceInferenceResponse =
  | { ready: true }
  | { loadError: string }
  | { id: number; descriptor: Float32Array | null }
  | { id: number; error: string };

if (!parentPort) {
  throw new Error('face-inference.worker must be started as a worker thread.');
}
const port = parentPort;
const { threads } = workerData as { threads: number };

loadFaceModels(threads).then(
  (models) => {
    port.on('message', ({ id, photo }: FaceInferenceRequest) => {
      faceDescriptor(
        models,
        Buffer.from(photo.buffer, photo.byteOffset, photo.byteLength),
      ).then(
        (descriptor) =>
          port.postMessage({ id, descriptor } satisfies FaceInferenceResponse),
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
