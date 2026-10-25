# Face models

Vendored, not downloaded at build or boot: a production container has no business fetching part of
its own runtime, and on a locked-down network that fetch is what would fail. `nest-cli.json` copies
the `.onnx` files into `dist` beside the compiled service, which loads them from `__dirname`.

| File | Model | Source | Licence | SHA-256 |
|---|---|---|---|---|
| `face_detection_yunet_2023mar.onnx` | YuNet face detector (640×640 input, 5 landmarks) | [opencv_zoo/models/face_detection_yunet](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet) | MIT (`LICENSE-yunet`) | `8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4` |
| `face_recognition_sface_2021dec_int8.onnx` | SFace recogniser, int8-quantised (112×112 aligned input, 128-float embedding) | [opencv_zoo/models/face_recognition_sface](https://github.com/opencv/opencv_zoo/tree/main/models/face_recognition_sface) | Apache-2.0 (`LICENSE-sface`) | `2b0e941e6f16cc048c20aee0c8e31f569118f65d702914540f7bfdc14048d78a` |

The int8 SFace rather than the 37 MB float one: measured on 2026-10-26 it loads in 115 MB of process
RSS against 181 MB, at the same speed, and still separated a darkened, rotated, recompressed photo of
one person (cosine 0.78) from a different person (0.18) by a wide margin either side of the 0.363
match line.

Do not swap in InsightFace's SCRFD or ArcFace weights: they are licensed for non-commercial research
only.

Changing either model changes every descriptor it produces, so every enrolled face has to be
captured again.
