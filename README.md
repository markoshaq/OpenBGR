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
|  2. Adaptive Tensor Prep    Bilinear resize (1024x1024 or 2048x2048) + ImageNet   |
|  3. Hardware Dispatch       Auto-routed to CUDA (FP16) / Apple MPS (FP16) / CPU   |
|  4. BiRefNet Forward Pass   BiRefNet_lite (1K) | BiRefNet (1K) | BiRefNet_HR (2K) |
|  5. Native Upsampling       Sigmoid probability -> LANCZOS resize to (W_orig, H)  |
|  6. Edge Decontamination    Morphological foreground dilation into alpha fringe   |
|  7. Fast Lossless Encode    32-bit RGBA PNG (DEFLATE level 1 for 4x faster I/O)   |
+-----------------------------------------------------------------------------------+
```

---

## Three Distinct BiRefNet Model Architectures

Instead of relying on a single checkpoint, **REMOVEBG** maps each hardware preset to a dedicated official **BiRefNet** architecture trained at its native resolution (alpha masks are always upsampled back to 100% native source dimensions via `LANCZOS` interpolation):

| Preset | Hugging Face Checkpoint | Backbone | Native Tensor | Spatial Tokens | FP16 Memory | Target Hardware |
| :--- | :--- | :--- | :---: | :---: | :---: | :--- |
| **Low-End (`Lite 1K`)** | `ZhengPeng7/BiRefNet_lite` | Swin-T | `1024 × 1024` | `1.05M` | ~110 MB | CPU-only laptops, Integrated GPUs, Fast previews |
| **Mid-Range (`Full 1K`)** *(Default)* | `ZhengPeng7/BiRefNet` | Swin-L | `1024 × 1024` | `1.05M` | ~440 MB | Apple Silicon (M1–M4) & Consumer GPUs |
| **High-End (`Ultra 2K`)** | `ZhengPeng7/BiRefNet_HR` | Swin-L | `2048 × 2048` | `4.19M` (4×) | ~440 MB + activations | Workstation GPUs & 4K/8K Studio Photography |

### Architectural Breakdown
1. **Low-End (`BiRefNet_lite` — Swin-T @ `1024×1024`):** Uses a compact Swin-Tiny transformer backbone (~4× fewer parameters than Swin-L). Automatically selected on CPU-only machines so users without a discrete GPU still get fast, responsive cutouts.
2. **Mid-Range (`BiRefNet` — Swin-L @ `1024×1024`):** Uses the full Swin-Large architecture. Because weights are cast to **FP16 (`torch.float16`)** on Apple MPS and NVIDIA CUDA, the entire Swin-L model occupies only **~440 MB of memory** (down from ~885 MB in FP32)—making full studio-grade hair and fur matting the default on any GPU or Apple Silicon Mac.
3. **High-End (`BiRefNet_HR` — Swin-L @ `2048×2048`):** Uses the high-resolution Swin-L checkpoint trained natively on `2048 × 2048` images (**4× the spatial pixel density** of `1024 × 1024`), preserving single-pixel micro-strands, fine mesh/lace, and fur on high-megapixel commercial photography.

---

## Quick Start (Zero-Config Setup)

Works on **macOS, Windows, and Linux** — even if you do not have Python installed yet.

### Option A: Double-Click (No Terminal Required)
1. Click **Code → Download ZIP** on GitHub and extract the folder.
2. Double-click the launcher for your operating system:
   - **macOS:** Double-click **`Start Mac.command`** in Finder.
   - **Windows:** Double-click **`start.bat`** in File Explorer.

### Option B: One-Command Terminal Launch

```bash
# macOS & Linux
git clone https://github.com/markoshaq/removebg.git && cd removebg && ./start.sh
```

```bat
:: Windows (Command Prompt / PowerShell)
git clone https://github.com/markoshaq/removebg.git && cd removebg && start.bat
```

### What the Bootstrapper Does Automatically on First Run:
1. **Auto-Python Provisioning:** Uses your system Python 3.10+ if present, or automatically fetches a standalone Python 3.12 runtime via [`uv`](https://docs.astral.sh/uv/) if Python is not installed.
2. **Auto-CUDA GPU Detection:** On Windows and Linux, checks for `nvidia-smi` and automatically installs the **CUDA 12.4 GPU build of PyTorch** when an NVIDIA GPU is detected (or Apple Metal `MPS` on macOS).
3. **Instant Subsequent Launches:** Writes a `.venv/.installed` state marker so every future launch starts in **< 1 second** and opens `http://127.0.0.1:7860`.

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
├── app.py               # FastAPI engine, ModelManager, FP16 inference & edge decontamination
├── static/
│   ├── index.html       # Semantic studio layout (4-row grid workspace)
│   ├── styles.css       # Industrial high-contrast design system & split-plane styles
│   └── app.js           # Modular frontend controller, pointer physics & telemetry client
├── requirements.txt     # Pinned production dependencies
├── start.sh             # One-command bootstrapper for macOS & Linux
├── start.bat            # One-command bootstrapper for Windows
└── LICENSE              # MIT License
```

---

## License

Released under the [MIT License](./LICENSE).
