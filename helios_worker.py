"""Private subprocess for the licensed public renderer; stdout is a JSONL protocol."""
import base64
import io
import json
import os
import sys
import threading
import time
import traceback

protocol = os.fdopen(os.dup(sys.stdout.fileno()), "w", buffering=1)
os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
gate = threading.Condition()
request = None


def emit(kind, **fields):
    print(json.dumps({"type": kind, **fields}, separators=(",", ":")), file=protocol, flush=True)


def read():
    global request
    for line in sys.stdin:
        try:
            message = json.loads(line)
        except ValueError:
            continue
        with gate:
            request = message
            gate.notify_all()
    os._exit(0)


def current(message):
    with gate:
        return request is message


class Cancelled(Exception):
    pass


def render(pipe, message):
    import torch

    def callback(_pipe, _step, _time, kwargs):
        if not current(message):
            raise Cancelled()
        return kwargs

    try:
        with torch.inference_mode():
            result = pipe(
                prompt=message["prompt"], height=384, width=640, num_frames=99,
                guidance_scale=1.0, pyramid_num_inference_steps_list=[2, 2, 2],
                generator=torch.Generator(device="cuda").manual_seed(message["seed"]),
                output_type="pil", callback_on_step_end=callback,
            ).frames[0]
    except Cancelled:
        return
    start = time.monotonic()
    for index, frame in enumerate(result[:80], 1):
        if not current(message):
            return
        wait = start + (index - 1) / 16 - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        if not current(message):
            return
        jpeg = io.BytesIO()
        frame.save(jpeg, format="JPEG", quality=78)
        emit("frame", id=message["id"], frame=index,
             jpeg=base64.b64encode(jpeg.getvalue()).decode("ascii"))
    time.sleep(1 / 16)
    if current(message):
        emit("ended", id=message["id"])


def main():
    threading.Thread(target=read, daemon=True).start()
    import torch
    from diffusers import HeliosPyramidPipeline
    model = sys.argv[2]
    pipe = HeliosPyramidPipeline.from_pretrained(model, torch_dtype=torch.bfloat16).to("cuda")
    emit("ready")
    previous = None
    while True:
        with gate:
            gate.wait_for(lambda: request is not previous)
            previous = request
        if previous["type"] == "play":
            render(pipe, previous)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        traceback.print_exc(file=sys.stderr)
        emit("error")
        sys.exit(1)
