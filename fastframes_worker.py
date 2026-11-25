"""Private, single-session FastFrames-S bridge. Apple code and weights are installed separately."""
import base64
import io
import json
import os
from pathlib import Path
import sys
import threading
import time
import traceback

# Keep third-party library output out of the JSON line protocol.
protocol = os.fdopen(os.dup(sys.stdout.fileno()), "w", buffering=1)
os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
lock = threading.Condition()
request = None


def emit(kind, **data):
    protocol.write(json.dumps({"type": kind, **data}, separators=(",", ":")) + "\n")


def read_commands():
    global request
    for line in sys.stdin:
        try:
            msg = json.loads(line)
            with lock:
                request = msg
                lock.notify_all()
        except ValueError:
            continue
    os._exit(0)


def is_current(msg):
    with lock:
        return request is msg


def stream(pipe, msg):
    import torch
    from PIL import Image
    from fastframes.pipeline import to_uint8
    from fastframes.wan.causal_model import allocate_kv_cache

    config = pipe.config
    emit_frame = 0
    started = None
    features, mods = [], []
    # Match Apple's reference rollout with bounded (one shot) state.
    with torch.inference_mode(), pipe.autocast():
        noise, transition = pipe._noise(msg["seed"])
        text = pipe.dit.text_cache(pipe.encode_prompt(msg["prompt"]))
        cache = allocate_kv_cache(pipe.dit, config.num_frames, pipe.frame_tokens, device=pipe.device)
        for n in range(config.num_frames):
            if not is_current(msg):
                return
            schedule = config.first_frame_timesteps if n == 0 else config.timesteps
            x = noise[:, n:n+1]
            for step, point in enumerate(schedule):
                x0, feat, mod = pipe._predict(x, point, n, text, cache)
                if step + 1 < len(schedule):
                    next_t = torch.full((1,), schedule[step + 1], device=pipe.device, dtype=torch.float32)
                    x = pipe.scheduler.add_noise(x0.flatten(0, 1), transition(step, n), next_t).unflatten(0, x0.shape[:2])
            if n == 0:
                pipe._predict(x0, 0., n, text, cache)
            else:
                pipe._refine(x0, n, cache)
            # Decode the current latent frame with the previous six as causal context.
            features = (features + [feat])[-7:]
            mods = (mods + [mod])[-7:]
            height, width = config.latent_size
            grid = torch.tensor([[len(features), height // 2, width // 2]], device=pipe.device, dtype=torch.long)
            with torch.autocast("cuda", dtype=torch.bfloat16):
                rgb = pipe.decoder(torch.cat(features, dim=1), torch.cat(mods, dim=1), grid)[0]
            rgb = rgb[-4:] if n else rgb[-1:]
            frames = to_uint8(rgb).cpu().numpy()
            for frame in frames:
                image = io.BytesIO()
                Image.fromarray(frame).save(image, format="JPEG", quality=78)
                if started is None:
                    started = time.monotonic()
                delay = started + emit_frame / 16 - time.monotonic()
                if delay > 0:
                    time.sleep(delay)
                if not is_current(msg):
                    return
                emit_frame += 1
                emit("frame", id=msg["id"], frame=emit_frame, jpeg=base64.b64encode(image.getvalue()).decode("ascii"))
    if is_current(msg):
        time.sleep(1 / 16)
        emit("ended", id=msg["id"])


def main():
    root, checkpoint_dir = map(Path, sys.argv[1:3])
    sys.path.insert(0, str(root))
    threading.Thread(target=read_commands, daemon=True).start()
    from fastframes.pipeline import MODELS, FastFrames, configure_backends
    spec = MODELS["ff-s"]
    configure_backends(spec.config)
    pipe = FastFrames.from_pretrained(
        spec.config, checkpoint_dir / spec.wan_dir, checkpoint_dir / spec.dit,
        checkpoint_dir / spec.refiner, checkpoint_dir / spec.decoder,
    )
    emit("ready")
    previous = None
    while True:
        with lock:
            lock.wait_for(lambda: request is not previous)
            previous = request
        if previous["type"] == "play":
            stream(pipe, previous)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        traceback.print_exc(file=sys.stderr)
        emit("error")
        sys.exit(1)
