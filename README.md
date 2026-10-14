# REMOVEBG — Local High-Precision Dichotomous Image Segmentation Studio

![Python](https://img.shields.io/badge/Python-3.10%2B-111111?style=flat-square&logo=python&logoColor=white)
![PyTorch](https://img.shields.io/badge/PyTorch-2.5%2B%20(FP16)-111111?style=flat-square&logo=pytorch&logoColor=EE4C2C)
![FastAPI](https://img.shields.io/badge/FastAPI-Async%20Engine-111111?style=flat-square&logo=fastapi&logoColor=009688)
![Compute](https://img.shields.io/badge/Compute-CUDA%20%7C%20Apple%20MPS%20%7C%20CPU-111111?style=flat-square)
![License](https://img.shields.io/badge/License-MIT-111111?style=flat-square)

**REMOVEBG** is a self-hosted, zero-telemetry background removal workstation powered by **BiRefNet** (*Bilateral Reference Network for High-Resolution Dichotomous Image Segmentation*). It delivers studio-grade alpha matting for complex hair, fur, and semi-transparent edges locally on consumer hardware—eliminating recurring SaaS API costs, cloud privacy risks, and lossy resolution downscaling.

---

## Key Engineering Highlights

- **5.5× Faster Inference via Automatic FP16 Mixed Precision:** Dynamically selects `torch.float16` on NVIDIA CUDA and Apple Silicon Metal Performance Shaders (`MPS`), reducing memory bandwidth and VRAM/Unified RAM consumption by **50%** while dropping 1080p inference latency from ~7.1s (FP32) to **~1.2s–2.1s**.
- **Deterministic Memory Lifecycle (`ModelManager`):** Thread-safe singleton model orchestration with explicit tensor deallocation, garbage collection, and hardware cache flushing (`torch.cuda.empty_cache()` / `torch.mps.empty_cache()`) when hot-swapping between Swin-T and Swin-L backbones—preventing swap thrashing on 8 GB systems.
- **C-Accelerated Edge Color Decontamination (Defringe):** Eliminates background color bleed in semi-transparent boundary pixels ($0.03 < \alpha < 0.94$) using morphological maximum filtering and box-filtered foreground color propagation rather than slow iterative CPU matting solvers.
- **Cache-First Air-Gapped Execution:** Queries local Hugging Face Hub storage (`try_to_load_from_cache` + `local_files_only=True`) prior to initializing network sockets. Once weights are hydrated, the application operates 100% offline with zero outbound requests.
- **Zero-Dependency Industrial Web Studio:** Vanilla HTML5/CSS3/JS frontend designed with a high-contrast, utilitarian grid layout—featuring interactive split-plane comparison, custom matte backdrops, direct `ClipboardItem` PNG copy (`⌘V` / `Ctrl+V` workflow), and real-time hardware telemetry headers.

---

## System Architecture & Inference Pipeline

```text
+-----------------------------------------------------------------------------------+
|                              CLIENT STUDIO (BROWSER)                              |
|  Drag & Drop / Clipboard Paste -> Split-Plane Viewport -> Lossless RGBA Export    |
+-----------------------------------------+-----------------------------------------+
                                          |
                          POST /api/remove-bg (multipart/form-data)
                                          v
+-----------------------------------------------------------------------------------+
|                            FASTAPI INFERENCE ENGINE                               |
|                                                                                   |
|  1. Input Normalization     EXIF orientation transpose + 3-channel RGB projection |
|  2. Adaptive Tensor Prep    Bilinear resize (768x768 or 1024x1024) + ImageNet norm|
|  3. Hardware Dispatch       Auto-routed to CUDA (FP16) / Apple MPS (FP16) / CPU   |
|  4. BiRefNet Forward Pass   Bilateral Reference Swin-T (Lite) or Swin-L (Full)    |
|  5. Native Upsampling       Sigmoid probability -> LANCZOS resize to (W_orig, H)  |
|  6. Edge Decontamination    Morphological foreground dilation into alpha fringe   |
|  7. Fast Lossless Encode    32-bit RGBA PNG (DEFLATE level 1 for 4x faster I/O)   |
+-----------------------------------------------------------------------------------+
```

---

## Universal Hardware Presets

Instead of hardcoding parameters for a single GPU class, **REMOVEBG** exposes three adaptive execution tiers that decouple internal segmentation tensor dimensions from the final output resolution (masks are always upsampled back to 100% native source dimensions via `LANCZOS` interpolation):

| Preset | Backbone Architecture | Internal Tensor | Memory Footprint | Target Hardware | Typical Latency (GPU/MPS) |
| :--- | :--- | :---: | :---: | :--- | :---: |
| **Low-End (`Fast`)** | `BiRefNet_lite` (Swin-T) | `768 × 768` | ~180 MB | Integrated GPUs, CPUs, Laptops | **~0.7s – 1.2s** |
| **Mid-Range (`Balanced`)** | `BiRefNet_lite` (Swin-T) | `1024 × 1024` | ~220 MB | Consumer GPUs, Apple Silicon | **~1.3s – 2.1s** |
| **High-End (`Ultra`)** | `BiRefNet` (Swin-L) | `1024 × 1024` | ~900 MB | Dedicated Workstation GPUs | **~2.5s – 4.0s** |

*Note: Switching between **Low-End** and **Mid-Range** reuses the in-memory `BiRefNet_lite` weights with zero reload overhead.*

---

## Quick Start

Requires **Python 3.10+**.

### macOS & Linux

```bash
git clone https://github.com/markoshaq/removebg.git
cd removebg
./start.sh
```

### Windows

```bat
git clone https://github.com/markoshaq/removebg.git
cd removebg
start.bat
```
*(Or double-click `start.bat` directly in Windows Explorer).*

On first launch, the bootstrap script automatically:
1. Provisions an isolated `.venv` virtual environment.
2. Installs dependencies and writes a `.venv/.installed` state marker so subsequent launches start in **< 1 second**.
3. Preloads cached model weights in a background daemon thread and opens `http://127.0.0.1:7860`.

> **Windows / Linux NVIDIA CUDA Tip:** If your system's default `pip` index resolves to a CPU-only PyTorch wheel, install the CUDA-enabled wheel inside `.venv`:
> ```bash
> .venv/Scripts/pip install torch torchvision --index-url https://download.pytorch.org/whl/cu124
> ```

---

## REST API Reference

The FastAPI backend can also be consumed headlessly as a local microservice for automated image pipelines.

### `GET /api/status`
Returns detected compute hardware, precision mode, recommended preset, and local offline cache status for each model tier.

### `POST /api/remove-bg`
Processes an image and returns a binary `image/png` stream along with performance telemetry headers.

```bash
curl -X POST "http://127.0.0.1:7860/api/remove-bg" \
  -F "file=@portrait.jpg" \
  -F "tier=mid" \
  -F "defringe=true" \
  -D - -o portrait-cutout.png
```

**Response Telemetry Headers:**
- `X-Inference-Time-Ms`: Pure pipeline execution time in milliseconds
- `X-Tier-Used`: Active preset and backbone configuration
- `X-Device`: Compute backend and floating-point precision (`CUDA • FP16`, `MPS • FP16`, `CPU • FP32`)
- `X-Image-Width` / `X-Image-Height`: Output PNG pixel dimensions

---

## Project Structure

```text
removebg/
├── app.py               # FastAPI server, ModelManager, FP16 inference & edge decontamination
├── static/
│   └── index.html       # Zero-dependency studio UI (split comparator, clipboard & matte tools)
├── requirements.txt     # Pinned production dependencies
├── start.sh             # One-command bootstrapper for macOS & Linux
├── start.bat            # One-command bootstrapper for Windows
└── LICENSE              # MIT License
```

---

## License

Released under the [MIT License](./LICENSE).
