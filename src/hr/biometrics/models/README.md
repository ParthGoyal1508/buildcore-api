# Face models

Vendored, not downloaded at build or boot: a production container has no business fetching part of
its own runtime, and on a locked-down network that fetch is what would fail. `nest-cli.json` copies
the `.onnx` files into `dist` beside the compiled service, which loads them from `__dirname`.

| File | Model | Source | Licence | SHA-256 |
|---|---|---|---|---|
| `face_detection_yunet_2023mar.onnx` | YuNet face detector (640×640 input, 5 landmarks) | [opencv_zoo/models/face_detection_yunet](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet) | MIT (`LICENSE-yunet`) | `8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4` |
| `face_recognition_sface_2021dec_int8.onnx` | SFace recogniser, int8-quantised (112×112 aligned input, 128-float embedding) | [opencv_zoo/models/face_recognition_sface](https://github.com/opencv/opencv_zoo/tree/main/models/face_recognition_sface) | Apache-2.0 (`LICENSE-sface`) | `2b0e941e6f16cc048c20aee0c8e31f569118f65d702914540f7bfdc14048d78a` |
| `minifasnet_v2_2.7_80x80.onnx` | MiniFASNetV2 passive anti-spoof (80×80 crop at 2.7× the face box, 3 classes) | [minivision-ai/Silent-Face-Anti-Spoofing](https://github.com/minivision-ai/Silent-Face-Anti-Spoofing) `resources/anti_spoof_models/2.7_80x80_MiniFASNetV2.pth`, exported to ONNX (opset 17) | Apache-2.0 (`LICENSE-minifasnet`) | `3a193e9764077a5114e972a1a9c808375885aa4de3f29edb14af161007d3a816` |
| `minifasnet_v1se_4.0_80x80.onnx` | MiniFASNetV1SE passive anti-spoof (80×80 crop at 4.0× the face box, 3 classes) | same repository, `4_0_0_80x80_MiniFASNetV1SE.pth`, exported to ONNX (opset 17) | Apache-2.0 (`LICENSE-minifasnet`) | `f82ef6dc973d3675a645bd4e026e72c546e4069e37bed7123ad89390522d09fd` |

The int8 SFace rather than the 37 MB float one: measured on 2026-10-26 it loads in 115 MB of process
RSS against 181 MB, at the same speed, and still separated a darkened, rotated, recompressed photo of
one person (cosine 0.78) from a different person (0.18) by a wide margin either side of the 0.363
match line.

Do not swap in InsightFace's SCRFD or ArcFace weights: they are licensed for non-commercial research
only.

Changing either model changes every descriptor it produces, so every enrolled face has to be
captured again.

## Anti-spoof models (057)

Exported from the published PyTorch weights on 2026-11-02 (weights loaded with `weights_only=True`;
ONNX output matched PyTorch to 1.8e-7 on random inputs). They expect exactly what the original
pipeline fed them, and anything else silently produces wrong scores:

- a crop centred on the face box, scaled 2.7× (V2) or 4.0× (V1SE), clamped inside the image;
- resized to 80×80, **BGR** channel order, **raw 0–255** floats (not divided by 255), NCHW;
- output: 3 logits. Softmax each, sum the two models; class **1** is a real face, and its share of
  the sum (÷2) is the "real" score.

The original pipeline found the face with RetinaFace; we use YuNet's box, which sits slightly
differently. That is why the pass threshold is configurable and must be calibrated on real devices.
