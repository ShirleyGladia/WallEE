# Loop Console

Frontend for the Siemens Healthineers Physical AI challenge: one console for the whole learning loop.
The layout follows the team whiteboard: each stage has the colour of its sticky note, and each
decision diamond is a gate shown at the top of its page.

```
Ingest ─◇ Good data? ─ Intelligent data ─◇ Checks passed? ─ Select data ─ Train ─ Evaluate ─◇ Good enough? ─ Version & serve → S1 S2 S3
          └ No: data gaps                                                                    └ No → Diagnose ──→ back to Intelligent data
```

## Run it

```bash
npm install
npm run dev            # http://localhost:5173, runs on mock data
npm run build          # production build in dist/
npm run build:single   # one self-contained HTML file in dist-single/ (easy to share)
```

## Pages

| Route | Stage | What it shows |
|---|---|---|
| `#/` | Overview | The whiteboard loop as a live, clickable diagram; activity; next-cycle callout |
| `#/ingest` | 01 Ingest | Upload/sync, conversion steps, per-file validity, schema, data gaps |
| `#/dataset` | 02 Dataset intelligence | Tabs: **Episodes** (camera, reach, table, prediction, speed/acceleration/gripper-speed charts with thresholds and a time window), **Clip review**, **Ready for a VLA?** (checks, behaviour map, lighting) |
| `#/select` | 03 Select data | Dataset groups: automatic eligibility, VLM review, human Train/Validation/Test/Exclude decision, rules, versioned training manifest |
| `#/train` | 04 Train | The manifest it trains on; live loss curve, new-run form, runs table (example data) |
| `#/evaluate` | 05 Evaluate | Real runs from `src/evals`: success, rollout video next to its demonstration, path comparison, open-loop error. Example data when there are none |
| `#/serve` | 06 Version & serve | Model registry, model card with lineage (incl. the manifest), endpoints S1–S3 with deploy |
| `#/diagnose` | ↺ Diagnose | What failed by phase, recommendations, start next cycle |

## Datasets and Ingest

Put LeRobot datasets in `src/datasets/<name>/` (each with `meta/`, `data/`, `videos/`). They are git-ignored.
While `npm run dev` runs, the Ingest page lists them under "Datasets in this project"; **Load** reads them through
`/__datasets/...` with HTTP Range requests (see `vite-datasets.ts`), so only the needed bytes are fetched, not gigabytes.
Use `DATASETS_DIR=/path/to/datasets npm run dev` to point somewhere else.

You can also load any dataset folder with **Choose folder** / drag-and-drop, or loose `.parquet` + `.mp4` files.
Everything is read in the browser; nothing is uploaded.

Per episode it checks missing values, frame numbering, timestamp gaps, length, state/action size, whether the robot
moves, the `success` flag, and whether every camera's video covers it. It cross-checks the episode index
(`meta/episodes`) against the data and the video files, flags missing files, and warns about `splits` in `info.json`.
Click an episode to watch all cameras in sync. Code: `src/ingest/`; the result is kept in `src/ingest/store.ts`.

The episode table also shows peak joint velocity, peak acceleration and maximum reach. Velocity/acceleration are read
from `observation.velocity` / `observation.acceleration` when the data has them (see `src/datasets/fr3_duo_rand500_kinematics`),
otherwise worked out from joint angles and timestamps. Reach uses FR3 forward kinematics (`src/ingest/kinematics.ts`).
Data intelligence then shows the loaded dataset: per episode, the camera, both arms inside the FR3 maximum space (855 mm),
and joint speed/acceleration over time, all on one scrubber.

## Data intelligence

**Episodes.** One scrubber drives the camera, both arms inside the FR3 maximum space, and the charts.
- *Table level* (mm below the robot base) marks frames where any part of an arm is under the table (red).
- *Look ahead*: the dotted arm is where the arm will be in that many seconds if speed and acceleration stay the same
  (q + v·t + ½·a·t²). Orange in the strip = the prediction says the arm is about to go under the table; the caption says how
  many seconds of warning it gave.
- *Joint speed* (% of the FR3 limit), *joint acceleration* (rad/s²) and *gripper speed* (mm/s, fingertip point, 250 mm/s is
  the ISO 10218 reduced speed) each have an adjustable limit: red above it, plus the dataset's 99th percentile (dashed).
  Thresholds are shared by the whole app (`src/review/settings.ts`).
- *Time window*: drag across any chart (or type from/to), **Zoom in**, **Show all**, and **Add to clip review**.
- *Do the speed columns add up?* For datasets with `observation.velocity`/`acceleration`: integrates them over 1 s and
  compares with how far the joints actually moved.

**Clip review** (`src/components/ClipReview.tsx`). Every suspicious moment becomes a 3–10 s clip: what the checks found
(spike, stuck joint, past a limit, gripper out of range, missing values, arms out of sync, rotated camera, noisy readings) and
stretches over the thresholds (fast joint, fast gripper, near reach limit, below the table), plus clips picked by hand.
All cameras and the arm view loop together; a person answers **OK**, **Wrong — cut these seconds**, **Wrong — drop
episode** or **Unsure** (keys 1, 2, D, 3). Verdicts are kept per dataset in the browser and exported as an edit list
(JSON/CSV: episode, start, end, verdict, action, reason, note, reviewer). Selection applies them: drops leave the episode out,
cuts go into the manifest as `trims` (the episode is split there, single frames are never removed).

**Ready for a VLA?** Clean data (checks, camera coverage, clips reviewed), ready to train (`meta/stats.json` frame count vs
the dataset, `info.json` splits), variety (number of instructions, how different episodes are and near-copies from the
gripper paths, start-pose spread, lighting from one frame per episode), safe motion (reach, joint speed, gripper speed).
The behaviour map is a 2-D projection of the gripper paths: close dots did similar things.

## Select data and the training manifest

Each dataset in `src/datasets/` is a group. **Check all groups** reads them; a group is *not eligible* with broken video
files, no joint angles/cameras, or more than 2% failed episodes (something systematic). Failed episodes, clip-review drops and
episodes typed by hand are left out. Rules: something is trained on, nothing ineligible is trained on, **test and validation
never share a demonstration with training** (episodes are matched by the fingerprint of their first 60 frames, across
datasets: `fr3_duo_rand500_kinematics` is the same demonstrations as `fr3_duo_rand500`, so using one to test the other is
caught), and each demonstration has one role. Without a validation group, a share of the training episodes is held out.

**Save manifest** stores a versioned `manifest-vN-<date>.json` (who, when, why, groups, `splits.train/validation/test` as
dataset + episode lists, trims, checks). Train shows it; Version & serve links to it. With LeRobot:
`LeRobotDataset(part["dataset"], episodes=part["episodes"])` for each part of `splits.train`, then recompute the norm stats.

**VLM review.** Samples a few episodes per group, grabs 4 frames from the external camera and asks a vision-language model
whether the task was done and the camera looks right. It talks to any OpenAI-compatible server. On the GPU machine:

```bash
vllm serve Qwen/Qwen2.5-VL-3B-Instruct --port 8001 --max-model-len 8192 --gpu-memory-utilization 0.35
VLM_TARGET=http://<gpu-host>:8001 npm run dev      # the dev server proxies /vlm to it
```

The URL, model and number of episodes can be changed under "Connect the VLM" on a group card.

## Evaluate: runs from the GPU machine

Write each evaluation with `tools/eval_writer.py` (needs numpy-like arrays and ffmpeg) into `src/evals/<run>/`
(or set `EVALS_DIR`). Each run is `eval.json` plus H.264 videos:

```python
w = EvalWriter("src/evals/pi05_v3", model="pi05_fr3_duo", checkpoint="30000", manifest="manifest-v3-2026-10-23",
               dataset="fr3_duo_rand500", task="stack the three cubes", fps=6, simulator="MuJoCo", gpu="RTX 4090")
w.add_open_loop(episode=12, t=t, demo=demo_actions, pred=policy_actions)       # policy on the demo's observations
w.add_rollout(seed=0, episode=12, success=True, t=t, state=states, frames=rgb_frames,
              demo_state=demo_states, failure=None)                            # or {"t": 31.5, "reason": "dropped the cube"}
w.save()
```

The page shows success (the score), time vs the demonstration, path difference (dynamic time warping of the gripper paths,
timing ignored), the rollout video next to the demonstration that started the same way on one scrubber with the failure
marked, gripper height over time, and open-loop error per joint and over time. `src/evals/example_pi05_seeds0-7` is an
**example** made from demonstrations (no policy was run; videos are stick-figure renders) and says so on the page.

## Connecting the backend

All data goes through `src/data/api.ts`. With `VITE_API_URL` unset the app uses `src/data/mock.ts`.

```bash
cp .env.example .env
# VITE_API_URL=/api                          # dev server proxies /api to API_TARGET (default http://localhost:8000)
API_TARGET=http://localhost:8000 npm run dev
```

The response shapes are in `src/data/types.ts`. Agree them with whoever builds the backend, and keep
the mock in sync so the demo never depends on a live GPU.

Suggested endpoints (rename freely in `api.ts`):

| Method | Path | Returns |
|---|---|---|
| GET | `/loop` | `LoopStatus` |
| GET | `/ingest/report` | `IngestReport` |
| GET | `/dataset/report` | `DatasetReport` |
| GET | `/train/runs` | `TrainRun[]` |
| GET | `/train/runs/:id/loss` | `LossPoint[]` (swap for WebSocket/SSE for live updates) |
| POST | `/train/runs` | `{ id }` |
| GET | `/eval/:version` | `EvalReport` |
| GET | `/models` | `ModelVersion[]` |
| GET | `/serve/endpoints` | `Endpoint[]` |
| POST | `/serve/deploy` | `{ ok }` |
| GET | `/diagnose/:version` | `Diagnosis` |
| POST | `/loop/next` | `{ cycle }` |

## Where to go next

- Stream training metrics over WebSocket in `Train.tsx` (`useLiveLoss`), and record the manifest id with each run.
- Let the training job write its runs next to the eval runs, so Train and Version & serve stop using example data.
- Stack: React 18, Vite, TypeScript, React Router (hash routing), Recharts. Styling is plain CSS with tokens in `src/styles.css`.
