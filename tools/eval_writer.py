"""Write an evaluation run that the Loop Console's Evaluate page can show.

Run your policy on the GPU machine (openpi + simulator), then:

    from eval_writer import EvalWriter
    w = EvalWriter("src/evals/pi05_v3_seed0-49", model="pi05_fr3_duo", checkpoint="ckpt/30000",
                   manifest="manifest-v3-2026-10-23", dataset="fr3_duo_rand500",
                   task="stack the three cubes", fps=6, simulator="MuJoCo", gpu="RTX 4090")

    # open loop: feed the demonstration's observations, record what the policy would command
    w.add_open_loop(episode=12, t=t, demo=demo_actions, pred=policy_actions)

    # closed loop: the policy drives the simulator from the same start as demonstration 12
    w.add_rollout(seed=0, episode=12, success=True, t=t, state=states, frames=rgb_frames,
                  failure=None)                  # or failure={"t": 31.5, "reason": "dropped the cube"}
    w.save()

Arrays can be numpy arrays or lists. `state` is the robot state per frame (same layout as observation.state,
16 values for the FR3 Duo). `frames` is a list of HxWx3 uint8 images; they're encoded as H.264 MP4
(needs ffmpeg on PATH) so every browser can play them. Put the folder in src/evals/ (or point EVALS_DIR at it).
"""
import json
import os
import subprocess
from datetime import datetime, timezone


def _list(a):
    return a.tolist() if hasattr(a, "tolist") else [list(map(float, r)) if hasattr(r, "__iter__") else float(r) for r in a]


def _round(rows, nd=5):
    return [[round(float(v), nd) for v in r] for r in _list(rows)]


def encode_h264(frames, path, fps):
    """Encode RGB frames (list of HxWx3 uint8) to an H.264 MP4 that browsers can play."""
    h, w = frames[0].shape[:2]
    w2, h2 = w - w % 2, h - h % 2  # yuv420p needs even sizes
    p = subprocess.Popen(
        ["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}", "-r", str(fps), "-i", "-",
         "-vf", f"crop={w2}:{h2}:0:0", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "23",
         "-movflags", "+faststart", path],
        stdin=subprocess.PIPE,
    )
    for f in frames:
        p.stdin.write(bytes(memoryview(f)) if not hasattr(f, "tobytes") else f.tobytes())
    p.stdin.close()
    if p.wait() != 0:
        raise RuntimeError("ffmpeg failed")


class EvalWriter:
    def __init__(self, out_dir, model, task, fps, checkpoint=None, manifest=None, dataset=None, simulator=None, gpu=None, notes=None):
        self.dir = out_dir
        os.makedirs(os.path.join(out_dir, "videos"), exist_ok=True)
        self.run = {
            "schema": "loop-console/eval@1",
            "name": os.path.basename(os.path.normpath(out_dir)),
            "model": model, "checkpoint": checkpoint, "manifest": manifest, "dataset": dataset,
            "task": task, "fps": fps, "simulator": simulator, "gpu": gpu, "notes": notes,
            "created": datetime.now(timezone.utc).isoformat(),
            "open_loop": [], "rollouts": [],
        }

    def add_open_loop(self, episode, t, demo, pred):
        self.run["open_loop"].append({"episode": int(episode), "t": [round(float(x), 4) for x in _list(t)], "demo": _round(demo), "pred": _round(pred)})

    def add_rollout(self, seed, success, t, state, episode=None, frames=None, failure=None, demo_state=None, video=None):
        r = {"seed": int(seed), "episode": None if episode is None else int(episode), "success": bool(success),
             "duration_s": round(float(_list(t)[-1]), 3), "failure": failure,
             "t": [round(float(x), 4) for x in _list(t)], "state": _round(state)}
        if demo_state is not None:
            r["demo_state"] = _round(demo_state)
        if frames is not None:
            name = f"videos/seed_{int(seed):03d}.mp4"
            encode_h264(frames, os.path.join(self.dir, name), self.run["fps"])
            r["video"] = name
        elif video:
            r["video"] = video
        self.run["rollouts"].append(r)

    def save(self):
        with open(os.path.join(self.dir, "eval.json"), "w") as f:
            json.dump(self.run, f)
        return os.path.join(self.dir, "eval.json")
