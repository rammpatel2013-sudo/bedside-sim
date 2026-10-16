# HALO Tracker + Bedside Sim — NAS deployment

Repository: https://github.com/rammpatel2013-sudo/bedside-sim

Self-hosted session/scenario tracker for the ICU in-situ simulation program (cric, Blakemore, Swan-Ganz, and whatever procedure gets added next). Flask + SQLite, one container, no cloud dependency, no subscription.

## What's in this version (HALO Tracker + Bedside Sim)

- **Tracker** (unchanged screens): sessions, staff, procedures, attempts, debrief notes. Now behind a sign-in.
- **Bedside Sim** at `/sim`: a live two-screen ICU/ED monitor simulator. Learners open `/sim`, type the room code, tap **Bedside monitor** — no account. The instructor console needs the tracker sign-in.
- **Automatic logging**: loading a scenario creates a tracker session (procedure "ICU simulation case") with the timestamped sim log attached. Add participants and debrief notes on that session as usual.
- No AI service and no cloud account: live sync runs through this container. New cases are drafted in Claude and pasted in as scenario JSON.

## Installing and updating on the NAS (no SSH)

Updates are automatic: every change pushed to GitHub builds a new image, and the Watchtower helper on the NAS installs it within ~10 minutes. Your `data/` folder (database, sign-in, uploads) is never touched.

**One-time setup (Container Manager):**
1. In File Station, the project folder `/docker/halo-tracker/` only needs two things: `docker-compose.yml` (from this repo) and your existing `data/` folder. Other files can stay or go.
2. Container Manager → **Project** → `halo-tracker` → **Action → Stop**, then **Action → Clean**.
3. Select the project → **Edit** (YAML), paste this repo's `docker-compose.yml`, **Save**, then **Build** (it pulls instead of building — about 1 minute).
4. Open `http://<nas-ip>:5050`. Existing sign-in and sessions are kept.

**Updating by hand** (if you remove the watchtower block): Container Manager → **Image** → `ghcr.io/…/bedside-sim` → **Update**, or Project → **Action → Build** again.

**Building from source instead:** `docker compose -f docker-compose.build.yml up -d --build`.

Sign-in: the first screen after a fresh install asks you to create the educator username and password (stored hashed in `data/admin.json`). Change it under **Account**. Lost it? Delete `data/admin.json` and set it up again.

Set `HALO_SECURE_COOKIES=1` once it runs behind HTTPS.

## Running a simulation

1. On the instructor iPad: `http://<nas-ip>:5050/sim` → room code (e.g. MICU26) → **Instructor** → sign in with the educator sign-in.
2. On the monitor iPad: same address, same room code → **Bedside monitor** → tap **Start** (enables sound).
3. Scenarios tab → load a case. Steer it from Run; learners can send orders from the monitor's **Orders** button.
4. Afterwards: Tracker → Sessions → the "ICU simulation case" entry has the full log.

### Vent Lab (ventilator simulator)

- Open `http://<nas-ip>:5050/vent/` (or tap **Vent Lab** on `/sim`). No account, no room code.
- **Curriculum**: 40 cases in 10 lessons (trigger/target/cycle, modes, holds and mechanics, CO₂ and oxygen, auto-PEEP, ARDS, dyssynchrony, the crashing patient, liberation). Interactive cases are graded on what the learner's settings do to the patient (plateau, auto-PEEP, missed triggers, pH, SpO₂…), so any sound fix passes. Before/after/model-answer waveforms after each check.
- **Tutorials**: screen tour with numbered markers, normal VC breath, normal PC/PSV/PRVC waveforms, hold maneuvers, loops, weaning measurements (P0.1, NIF, RSBI), esophageal pressure.
- **Free play**: five patients (normal, COPD/asthma, ARDS, obesity, awake on PSV) and one-tap events (pneumothorax, plug, bronchospasm, mainstem, cuff leak, disconnect, wake-up, cardiac oscillations).
- **Scenario builder**: set up the vent and patient, add a question and optional targets, save. "Copy link" gives learners a URL that opens it as a gradable case. Export/import as JSON.
- **Console** modeled on an ICU ventilator (NKV-550 parameter set, Hamilton-style dynamic lung): waveforms, live-tracing P–V/F–V loops and numerics side by side; Snapshot/Compare puts a reference and the live screen side by side with Δ on every number (cases auto-compare against the case start). Modes: A/CMV and SIMV (VC/PC/PRVC), SPONT (PS/CPAP/VS), APRV. Numerics include estimated (no-hold) plateau, driving pressure, auto-PEEP, C, R, Re, TCe, C20/C, mechanical power, leak, RSBI(/kg), P0.1, NIF, Pmus, WOB, capnography. Quick keys: holds, manual breath, P0.1, NIF.
- Physics runs in the learner's browser (single-compartment equation of motion with flow limitation, recruitment, Pes/Ptp and steady-state gas exchange). Files: `static/vent/` — `engine.js`, `curriculum.js`, `app.js`, `index.html`.
- Tests: `node tests/vent_engine.test.js` (physiology vs hand calculations) and `node tests/vent_curriculum.test.js` (every case's starting state fails and its model answer passes).

### GitHub Pages web app (public link, no server)

- **https://rammpatel2013-sudo.github.io/bedside-sim/** — HALO Teaching Tools: Vent Lab at `/vent/`, Learn at `/learn/`. Anyone can open it — no Tailscale, no account — and it installs to a phone's home screen and works offline.
- Every push to `main` that touches `static/vent/`, `static/learn/`, `tests/` or `tools/publish_pages.py` runs the simulator tests, then `tools/publish_pages.py` copies Vent Lab and Learn onto the `gh-pages` branch and sets the offline cache version to the commit (`.github/workflows/pages.yml`). A failing test blocks the publish. The workflow commits on top of `gh-pages`, never replaces it.
- The web-app shell lives only on `gh-pages`: landing page `index.html`, `manifest.webmanifest`, `icons/`, `sw.js`. Edit those there (see the docstring in `tools/publish_pages.py`).
- Deep links work: `…/vent/?case=<case-id>`, `…/vent/?view=tutorials&tut=tour`, scenario-builder share links (`…/vent/?s=…`), `…/learn/fluid-check.html`.
- Only static pages live here. The two-screen bedside sim, student chart and tracker need the Flask server (live rooms, uploads, sign-in, database) and stay on the NAS.

### Student chart (orders, results, cost)

- Learners open `http://<nas-ip>:5050/chart?room=<CODE>` (or tap **Student chart** on `/sim`) on their own device. No account.
- They see the problem list, H&P and arrival results; they order by search, order sets, or plain text ("ABG, chest x-ray and start norepinephrine"). Results appear after a turnaround time; **Result speed** on the instructor's Run tab sets how fast.
- Orders the system can't match land in the instructor's **Orders** box as "needs you": write a result, mark done, or use it to pick the scenario path.
- Prices are approximate Medicare reference amounts for cost awareness, not hospital charges.
- **Debrief → Order report** compares orders against the case's expected actions and flags low-value tests.

### Learn (physiology and ultrasound chapters)

- `http://<nas-ip>:5050/learn` — open to learners with no sign-in, like `/sim` and `/chart`. Linked from the sim lobby and the tracker menu.
- **Chapter 01 · Heart–lung interactions** (`/learn/heart-lung`): live heart–lung model following Pinsky — pleural vs transpulmonary pressure, venous return, both ventricles, PPV and its limits, leg raise / tidal volume challenge / end-expiratory occlusion scored against a fluid bolus. For teaching before or after rounds.
- **Bedside card · Fluid check** (`/learn/fluid-check`): for rounds. Enter the real patient's vent and monitor numbers; it says whether PPV can be read, which test to run, scores the test, and gives three teaching questions. Nothing is saved. "Open this ventilator in the model" loads the patient's settings into Chapter 01.
- Pages are static files in `static/learn/` (one self-contained HTML file each, linked relatively). Add a chapter by dropping in `<slug>.html` and listing it in `static/learn/index.html`. The same files are published to the GitHub Pages web app (`gh-pages` branch, `learn/`). The chapter plan and verified sources are in the claude.ai project doc `icu-ultrasound-plan.md`.

### Content

- `content/catalog.json` — orderable catalog (built by `tools/build_catalog.py`; edit that file and re-run it).
- `content/cases/*.json` — case files: chart, stages, per-stage results, debrief targets. New case files are picked up without a restart. Cases marked "draft — needs clinical review" have not been reviewed.

Remote learners (not on your Wi-Fi): only through Tailscale today. For students without Tailscale, use a Cloudflare Tunnel to this container only, or move it to the droplet — never port-forward.

## 1. Storage: build docs & scenario library

Put the static stuff (build specs, shopping lists, scenario scripts, cost sheets, the cric-trainer design exports) on a Synology Drive–synced share, not in this app:

```
/ICU-Simulation-Project/
  01-build-docs/        (cric trainer, Blakemore, Swan-Ganz specs + shopping lists)
  02-scenario-library/  (per-procedure scenario scripts, debrief checklists)
  03-session-exports/   (periodic exports/backups of the tracker's SQLite db)
  04-assets/            (photos, diagrams)
```

Sync this folder with Synology Drive the way you already do for other shares — that's your durable, version-tracked copy, separate from the live app's database.

## 2. Compute: deploying the tracker on the NAS

Requires DSM 7.2+ with **Container Manager** (Synology's Docker GUI). If your model doesn't support Container Manager, this also runs fine under Portainer or a bare `docker compose` over SSH — same files.

**Steps (Container Manager GUI):**

1. Copy this whole folder (`app.py`, `templates/`, `Dockerfile`, `docker-compose.yml`, `requirements.txt`) into a share on the NAS, e.g. `/docker/halo-tracker/`.
2. Open **Container Manager → Project → Create**.
3. Project name: `halo-tracker`. Path: the folder from step 1.
4. Source: "Create docker-compose.yml" → choose "Use existing `docker-compose.yml`" and point it at the file you copied.
5. Build and run. First build takes a minute (pulls the Python base image, installs Flask).
6. Once it's up, browse to `http://<nas-ip>:5050` from any device on your network — including the tablets you're using for sessions, if you want to log a session right after running it.

**Steps (SSH / plain docker compose), if you'd rather not use the GUI:**

```bash
cd /volume1/docker/halo-tracker
docker compose up -d --build
```

### Persisting data

The `data/` folder (created next to `docker-compose.yml`) holds `halo.db`, the SQLite file. It's bind-mounted into the container, so rebuilding, updating, or restarting the container never touches it. Back it up by including `data/halo.db` in whatever Synology Hyper Backup / snapshot job already covers that share — or periodically copy it into `03-session-exports/` above.

### Keeping it NAS-only (no internet exposure)

Don't port-forward 5050 or put this behind Synology's QuickConnect/reverse proxy. There is now a sign-in, but it is a single shared password and there's no rate limiting yet — not enough for direct internet exposure of staff records. Access it over your local network (or hospital-approved WiFi) only; if you want access from outside the building later, put it behind the NAS's VPN server instead of exposing the port.

## 3. Extending it

The schema (`SCHEMA` in `app.py`, plus `SIM_SCHEMA` in `sim.py`) is four tables: `procedures`, `staff`, `sessions`, `session_participants`. Adding a new tracked field (e.g. "cartridge type used" or "difficult-airway variant") is a column addition + one template edit — ask me to extend it when you're ready to log that detail; didn't want to over-build before you've run a real session through it.
