# Cutline Studio

A private real-time video maker with a director that writes the next scene while the current scene plays. Set a brief, go live, and let the director draft. Enable Auto-cut to move to each ready shot; if a draft is late, the monitor holds on the last frame. Switch Auto-cut off for approval, or edit the prompt and hit **Take next** to cut immediately. **Shot log** downloads the prompts and timeline as JSON.

## Try the studio without a GPU

Open `START-HERE.html` in your browser for a standalone preview with no installation.

Requires Node.js 20.10 or later. From the extracted project:

```bash
npm start
```

Open **http://127.0.0.1:8765**. Start with the included film brief. The preview draws an illustrated test scene; the sample cues are scripted. These make the UI and timing usable without external calls and do not produce generated video.

## Add the actual AI director

The director is independent from the renderer. It sends the brief, the current shot, up to three recent shots, and your latest note to a chat model, and expects one JSON draft. The prose continuity notes help preserve the look; the renderer does not share shot history or guarantee the same character design.

Example with [Ollama](https://docs.ollama.com/api/openai-compatibility) running locally. Pick a model that's already installed, set its exact name, and run the app:

```bash
export DIRECTOR_URL=http://127.0.0.1:11434/v1
export DIRECTOR_MODEL='YOUR_LOCAL_MODEL_NAME'
npm start
```

Alternatively set your trusted OpenAI-compatible **base URL ending in /v1**, model, and any needed `DIRECTOR_API_KEY` in the server environment. The provider must support `/chat/completions` with JSON mode. The key stays on the server. A remote provider receives the creative context listed above. Preview mode can use the real director without a video GPU. If the AI director fails, the studio shows the error and lets you redraft or write the pending shot manually.

## Add FastFrames-S on a rented GPU

For **noncommercial scientific research only**. Review the [Apple weights license](https://huggingface.co/apple/FastFrames-S/blob/main/LICENSE) before downloading. The app includes neither Apple's code nor its weights. A commercial product needs a separately licensed renderer.

On a Linux x86-64 GPU machine, install Node.js, Git, and [uv](https://docs.astral.sh/uv/). Use an NVIDIA driver compatible with CUDA 12.8. The B200 is the hardware Apple used for its reported single-GPU latency; this repository does not benchmark minimum VRAM, a cheaper GPU, or end-to-end network performance.

```bash
git clone https://github.com/apple-aiml-research/ml-fastframes.git
cd ml-fastframes
git checkout a65c59240e01cf1de86197fa771ca09b38cf592a
uv sync --extra demo
uv run hf download apple/FastFrames-S --include 'fastframes-s/*' --local-dir checkpoints
uv run hf download zhuhz22/Causal-Forcing causal-forcing++/framewise-2step.pt --local-dir checkpoints
uv run hf download Wan-AI/Wan2.1-T2V-1.3B --include 'models_t5_umt5-xxl-enc-bf16.pth' --include 'google/umt5-xxl/*' --local-dir checkpoints/Wan2.1-T2V-1.3B
export FASTFRAMES_ROOT="$PWD"
cd ../cutline-studio
npm start
```

Keep the checkpoints and the upstream checkout on persistent storage if you want to reuse them. Override default locations with absolute `FASTFRAMES_PYTHON` and `FASTFRAMES_CHECKPOINTS` as needed.

For [Runpod direct SSH](https://docs.runpod.io/pods/configuration/use-ssh), open a tunnel from your computer using the host, username and port shown under **Connect** for the Pod:

```bash
ssh -N -L 8765:127.0.0.1:8765 -p YOUR_SSH_PORT YOUR_SSH_USER@YOUR_POD_HOST
```

Open **http://127.0.0.1:8765** on your computer. The app binds to loopback only. Don't expose it on the public HTTP proxy or give access to untrusted users. **Stop** pauses generation and leaves the model warm; stop the Node process to unload it and stop the Pod separately to end rental billing.

The inference worker streams 832×480 JPEG frames at a target of 16 FPS. It keeps the model resident and resets per-shot generation at each cut. Each shot is about five seconds. This is a silent, single-user prototype with hard cuts, no pixel-perfect identity persistence and no MP4 export. Startup, prompt encoding, GPU load and network latency can cause visible gaps. The browser shows the most recent frame it has received. Each live session is limited to 24 shots.

## Verification

```bash
npm test
```

Tests cover director requests and continuity context, auto advancement, manual override priority, and the HTTP preview. The GPU worker is checked for Python syntax and wired against Apple's documented checkpoint layout and upstream pipeline. Real CUDA inference and timing still need a test on a compatible GPU.

## Public Vercel preview and Runpod generation

Vercel hosts the interactive preview. It uses sample cues and an illustrated scene until a GPU is linked. Vercel does not run either video model. The actual public studio runs on the Runpod HTTPS proxy on port 8765 and uses [Helios Distilled](https://huggingface.co/BestWishYsh/Helios-Distilled), whose model card lists Apache 2.0. Apple FastFrames remains a private research option; public mode rejects it.

1. In Runpod, use a single H100 80 GB Linux pod with a driver compatible with CUDA 12.8 or later. Attach enough persistent storage for the model and environment; allow about 100 GB for the first install. Expose **8765/HTTP** and enable SSH as needed. This starts rental billing; stop the pod in Runpod when it is not needed.
2. Clone this repository under `/workspace` on the pod, enter the repo directory, and run `bash deploy/runpod-setup.sh`. The script installs the isolated Python environment and downloads the weights.
3. Before launching, set `PUBLIC_STUDIO_ORIGIN=https://YOURPOD-8765.proxy.runpod.net` (exact origin with no trailing slash), and configure `DIRECTOR_URL`, `DIRECTOR_MODEL`, and optionally `DIRECTOR_API_KEY` as above. Use a director endpoint suitable for public prompts. Keep keys in server environment variables only.
4. Set `PUBLIC_SHOT_BUDGET=40` or a smaller number and run `bash deploy/runpod-start.sh`. The first shot loads the model. On the proxy URL, verify `/health` and try a complete video session (including a manual override).
5. Set the public, non-secret `PUBLIC_GPU_URL` in the Vercel project to the pod proxy origin and redeploy. The web preview then includes an **Open live GPU** button. Remove the variable and redeploy to take that button offline.

Public mode uses one shared generation slot, limited to four shots and six drafts per visitor session, and a three-minute lease. Other visitors can see if the slot is busy; they do not receive the session's prompts, frames, or controls. The total shot budget resets if the server process restarts and it does not stop GPU rental billing. This is a small public demo, not a production moderation or abuse-prevention system. It renders a Helios shot before playing it; the AI director works in parallel with the current shot. There can be a wait at a cut. The Runpod worker setup has not yet been exercised on a paid GPU.
