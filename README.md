# HALO Tracker + Bedside Sim — NAS deployment

Repository: https://github.com/rammpatel2013-sudo/bedside-sim

Self-hosted session/scenario tracker for the ICU in-situ simulation program (cric, Blakemore, Swan-Ganz, and whatever procedure gets added next). Flask + SQLite, one container, no cloud dependency, no subscription.

## What's in this version (HALO Tracker + Bedside Sim)

- **Tracker** (unchanged screens): sessions, staff, procedures, attempts, debrief notes. Now behind a sign-in.
- **Bedside Sim** at `/sim`: a live two-screen ICU/ED monitor simulator. Learners open `/sim`, type the room code, tap **Bedside monitor** — no account. The instructor console needs the tracker sign-in.
- **Automatic logging**: loading a scenario creates a tracker session (procedure "ICU simulation case") with the timestamped sim log attached. Add participants and debrief notes on that session as usual.
- No AI service and no cloud account: live sync runs through this container. New cases are drafted in Claude and pasted in as scenario JSON.

## Upgrading from the old HALO Tracker

Replace the files in `/docker/halo-tracker/` with these, **keep the `data/` folder**, then rebuild the project in Container Manager (or `docker compose up -d --build`). Existing sessions, staff and procedures are kept; new tables are added on first start.

**Sign-in:** open `http://<nas-ip>:5050` right after the rebuild. The first screen asks you to create the educator username and password (stored hashed in `data/admin.json`). Change it later under **Account**. Lost it? Add `HALO_ADMIN_USER` and `HALO_ADMIN_PASS` lines under `environment:` in `docker-compose.yml`, rebuild, sign in with those, then remove them again — or delete `data/admin.json` and set it up afresh.

Set `HALO_SECURE_COOKIES=1` once it runs behind HTTPS.

## Running a simulation

1. On the instructor iPad: `http://<nas-ip>:5050/sim` → room code (e.g. MICU26) → **Instructor** → sign in with the educator sign-in.
2. On the monitor iPad: same address, same room code → **Bedside monitor** → tap **Start** (enables sound).
3. Scenarios tab → load a case. Steer it from Run; learners can send orders from the monitor's **Orders** button.
4. Afterwards: Tracker → Sessions → the "ICU simulation case" entry has the full log.

### Student chart (orders, results, cost)

- Learners open `http://<nas-ip>:5050/chart?room=<CODE>` (or tap **Student chart** on `/sim`) on their own device. No account.
- They see the problem list, H&P and arrival results; they order by search, order sets, or plain text ("ABG, chest x-ray and start norepinephrine"). Results appear after a turnaround time; **Result speed** on the instructor's Run tab sets how fast.
- Orders the system can't match land in the instructor's **Orders** box as "needs you": write a result, mark done, or use it to pick the scenario path.
- Prices are approximate Medicare reference amounts for cost awareness, not hospital charges.
- **Debrief → Order report** compares orders against the case's expected actions and flags low-value tests.

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
