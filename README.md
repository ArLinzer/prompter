# Scripter

AI presentation teleprompter — tracks your spot in a script via mic + offline embeddings, auto-scrolls + advances slides.

## Status (v1 MVP)

- ✅ Offline STT — whisper.cpp via `nodejs-whisper` (auto-downloads model on first run)
- ✅ Offline matcher — MiniLM embeddings + locality-prior cosine
- ✅ Slide viewer — PDF (rendered via `pdfjs-dist`) or PNG/JPG folder
- ✅ Auto-scroll + auto slide-advance
- ✅ Manual override — `↑`/`↓` jump chunk, `Space` start/stop, click chunk to jump

## Layout

```
src/
  nlp/              chunk.ts · embed.ts · matcher.ts        used by Electron renderer AND prototype
  prototype/        run.ts · sample-script.txt              standalone matcher test (no UI)
  main/             main.ts · preload.ts · stt.ts           Electron main + whisper.cpp wrapper
  renderer/         App.tsx · useTracker.ts · useMicCapture.ts · pdfRender.ts · audio-worklet.ts
  shared/           ipc.ts                                  IPC channel names + types
```

## Pipeline

```
mic → AudioWorklet (Float32 @ 48kHz)
    → ring buffer (2.5s chunks, 0.5s overlap)
    → resample to 16kHz mono + Int16 PCM
    → IPC → main → wavefile → whisper.cpp (base.en) → text
    → renderer rolling-window (last 32 tokens)
    → MiniLM embedding → matcher.match()
    → setState(activeId) → script scrolls + slide updates
```

## Run

### Matcher prototype (no UI, simulated transcript)

```
npm install
npm run proto
```

First run downloads MiniLM (~80MB) into `node_modules/@xenova/transformers/.cache`.

### Electron dev app

```
npm run electron:dev
```

First whisper init downloads `ggml-base.en.bin` (~140MB) into `nodejs-whisper`'s model dir. Subsequent runs are offline. Override model:

```
SCRIPTER_WHISPER_MODEL=small.en npm run electron:dev
```

Valid: `tiny.en` (39MB, fastest), `base.en` (140MB, default), `small.en` (460MB, accurate).

### Script format

Plain text. Embed slide markers anywhere — every chunk after a marker inherits that slide number:

```
[[slide:1]]
Welcome to the presentation.

[[slide:2]]
First topic: revenue.
```

### Slides

Either:
- **Load PDF** — renders each page to a high-res image in-process (no LibreOffice needed)
- **Load image folder** — sorted PNG/JPG/WebP, one per slide

Slides indexed 1-based to match `[[slide:N]]` markers.

## Hotkeys

- `Space` — start/stop tracking
- `↓` / `↑` — manual next/prev chunk
- click a chunk — set cursor

## Tuning

In `src/nlp/matcher.ts`:

| Option            | Default | Effect                                          |
|-------------------|---------|-------------------------------------------------|
| `localitySigma`   | 6       | Bigger = matcher willing to jump farther        |
| `backwardPenalty` | 0.6     | Lower = harder to scroll back                   |
| `minConfidence`   | 0.35    | Raw cosine threshold to commit a jump           |
| `stickiness`      | 0.05    | Bias toward staying on current chunk            |

In `src/renderer/useMicCapture.ts`:

| Constant       | Default | Effect                                          |
|----------------|---------|-------------------------------------------------|
| `CHUNK_SEC`    | 2.5     | Smaller = lower latency, less context per pass  |
| `OVERLAP_SEC`  | 0.5     | Prevents word loss at chunk boundary            |

## Known limitations (v1)

- PPTX not supported — convert to PDF first (PowerPoint: File → Export → PDF)
- Single language: English only (`base.en`)
- CPU-only whisper — Metal/CUDA accel possible by rebuilding whisper.cpp with flags (later)
- Single mic chunk in-flight at a time. If whisper latency > chunk size, audio queues. Watch the `Xms/chunk` readout.

## v2 ideas

- Cloud STT toggle (Deepgram/Azure) for low latency
- PPTX direct import via LibreOffice or pptxjs
- Auto-align script to slides via embedding clustering (no `[[slide:N]]` markers needed)
- Speaker notes overlay
- Multi-language
