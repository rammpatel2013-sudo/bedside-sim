"""
HALO Tracker — minimal self-hosted session/scenario tracker for the
ICU in-situ simulation program (cric, Blakemore, Swan-Ganz, etc.)

Flask + SQLite, single process, no external services. Includes Bedside Sim
(sim.py): the live two-screen monitor simulator, logged as tracker sessions. Designed to run
in a container on a Synology NAS (see README.md) with its data file on
a mounted volume so nothing is lost on container rebuild.
"""
import hmac
import json
import os
import secrets
import sqlite3
from datetime import date, timedelta
from flask import Flask, g, render_template, request, redirect, session, url_for
from werkzeug.security import check_password_hash, generate_password_hash

DB_PATH = os.environ.get("HALO_DB_PATH", os.path.join(os.path.dirname(__file__), "data", "halo.db"))

app = Flask(__name__)
app.config["DB_PATH"] = DB_PATH


def _secret_key():
    """Stable session key: env var, else a random key kept beside the database."""
    if os.environ.get("HALO_SECRET_KEY"):
        return os.environ["HALO_SECRET_KEY"]
    p = os.path.join(os.path.dirname(DB_PATH), ".secret_key")
    os.makedirs(os.path.dirname(p), exist_ok=True)
    if not os.path.exists(p):
        with open(p, "w") as f:
            f.write(secrets.token_hex(32))
    return open(p).read().strip()


app.secret_key = _secret_key()
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=os.environ.get("HALO_SECURE_COOKIES") == "1",
    PERMANENT_SESSION_LIFETIME=timedelta(hours=12),
)
# Educator sign-in. Normally created on screen the first time the app is opened and
# stored (hashed) in data/admin.json. HALO_ADMIN_USER / HALO_ADMIN_PASS env vars, if set,
# override it — useful only if you lose the password.
ENV_USER = os.environ.get("HALO_ADMIN_USER", "")
ENV_PASS = os.environ.get("HALO_ADMIN_PASS", "")
ADMIN_FILE = os.path.join(os.path.dirname(DB_PATH), "admin.json")


def load_admin():
    if ENV_USER and ENV_PASS:
        return {"username": ENV_USER, "env": True}
    try:
        with open(ADMIN_FILE) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def save_admin(username, password):
    os.makedirs(os.path.dirname(ADMIN_FILE), exist_ok=True)
    tmp = ADMIN_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump({"username": username, "hash": generate_password_hash(password)}, f)
    os.replace(tmp, ADMIN_FILE)


def check_login(username, password):
    a = load_admin()
    if not a:
        return False
    if a.get("env"):
        return hmac.compare_digest(username, ENV_USER) and hmac.compare_digest(password, ENV_PASS)
    return hmac.compare_digest(username, a["username"]) and check_password_hash(a["hash"], password)

# Open to learners without a login: the sim page, its live socket, read API, media.
PUBLIC_PREFIXES = ("/sim", "/chart", "/ws/", "/api/", "/media/", "/static/", "/login", "/setup")


@app.before_request
def require_login():
    if session.get("user") or request.path.startswith(PUBLIC_PREFIXES):
        return None
    if not load_admin():
        return redirect(url_for("setup"))
    return redirect(url_for("login", next=request.path))


def _password_problem(pw, pw2):
    if len(pw) < 10:
        return "Use at least 10 characters."
    if pw != pw2:
        return "The two passwords don't match."
    return None


@app.route("/setup", methods=["GET", "POST"])
def setup():
    """First run only: create the educator sign-in on screen."""
    if load_admin():
        return redirect(url_for("login"))
    error = None
    if request.method == "POST":
        u = request.form.get("username", "").strip()
        pw = request.form.get("password", "")
        error = None if u else "Choose a username."
        error = error or _password_problem(pw, request.form.get("password2", ""))
        if not error:
            save_admin(u, pw)
            session.clear()
            session["user"] = u
            session.permanent = True
            return redirect(url_for("dashboard"))
    return render_template("setup.html", error=error, mode="setup",
                           username=request.form.get("username", "") if request.method == "POST" else "")


@app.route("/account", methods=["GET", "POST"])
def account():
    """Change the educator username or password (signed in)."""
    a = load_admin() or {}
    error = done = None
    if a.get("env"):
        error = "The sign-in is set in docker-compose.yml (HALO_ADMIN_USER / HALO_ADMIN_PASS). Remove those two lines and rebuild to manage it here."
    elif request.method == "POST":
        if not check_login(a.get("username", ""), request.form.get("current", "")):
            error = "Current password is wrong."
        else:
            u = request.form.get("username", "").strip() or a["username"]
            pw = request.form.get("password", "")
            error = _password_problem(pw, request.form.get("password2", ""))
            if not error:
                save_admin(u, pw)
                session["user"] = u
                done = "Saved. Use the new password next time you sign in."
    return render_template("setup.html", error=error, done=done, mode="account", username=a.get("username", ""))


@app.route("/login", methods=["GET", "POST"])
def login():
    error = None
    if request.method == "POST":
        u = request.form.get("username", "")
        p = request.form.get("password", "")
        if not load_admin():
            return redirect(url_for("setup"))
        if check_login(u, p):
            session.clear()
            session["user"] = u
            session.permanent = True
            nxt = request.args.get("next", "/")
            return redirect(nxt if nxt.startswith("/") and not nxt.startswith("//") else "/")
        else:
            error = "Wrong username or password."
    if not load_admin():
        return redirect(url_for("setup"))
    return render_template("login.html", error=error)


@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))


def get_db():
    if "db" not in g:
        os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


SCHEMA = """
CREATE TABLE IF NOT EXISTS procedures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT
);

CREATE TABLE IF NOT EXISTS staff (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    role TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    procedure_id INTEGER NOT NULL REFERENCES procedures(id),
    location TEXT,
    notes TEXT
);

CREATE TABLE IF NOT EXISTS session_participants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    staff_id INTEGER NOT NULL REFERENCES staff(id),
    attempts INTEGER,
    time_to_landmark_sec INTEGER,
    outcome TEXT,
    debrief_notes TEXT
);
"""

SEED_PROCEDURES = [
    ("Cricothyroidotomy", "Surgical scalpel-finger-bougie and needle/jet-vent cric rig"),
    ("Sengstaken-Blakemore tube", "Balloon tamponade placement for variceal bleeding"),
    ("Swan-Ganz / PAC", "Pulmonary artery catheter floating and waveform recognition"),
]


def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.executescript(SCHEMA)
    existing = conn.execute("SELECT COUNT(*) FROM procedures").fetchone()[0]
    if existing == 0:
        conn.executemany(
            "INSERT INTO procedures (name, description) VALUES (?, ?)", SEED_PROCEDURES
        )
    conn.commit()
    conn.close()


@app.route("/")
def dashboard():
    db = get_db()
    procedures = db.execute("SELECT * FROM procedures ORDER BY name").fetchall()
    stats = []
    for proc in procedures:
        last = db.execute(
            "SELECT date FROM sessions WHERE procedure_id = ? ORDER BY date DESC LIMIT 1",
            (proc["id"],),
        ).fetchone()
        this_quarter_count = db.execute(
            """
            SELECT COUNT(DISTINCT sp.staff_id)
            FROM session_participants sp
            JOIN sessions s ON s.id = sp.session_id
            WHERE s.procedure_id = ?
              AND s.date >= date('now', 'start of month', '-2 months')
            """,
            (proc["id"],),
        ).fetchone()[0]
        stats.append({"procedure": proc, "last_date": last["date"] if last else None, "staff_this_quarter": this_quarter_count})
    recent_sessions = db.execute(
        """
        SELECT s.*, p.name AS procedure_name,
               (SELECT COUNT(*) FROM session_participants sp WHERE sp.session_id = s.id) AS n_participants
        FROM sessions s JOIN procedures p ON p.id = s.procedure_id
        ORDER BY s.date DESC LIMIT 10
        """
    ).fetchall()
    return render_template("dashboard.html", stats=stats, recent_sessions=recent_sessions)


@app.route("/procedures", methods=["GET", "POST"])
def procedures():
    db = get_db()
    if request.method == "POST":
        name = request.form["name"].strip()
        description = request.form.get("description", "").strip()
        if name:
            db.execute(
                "INSERT OR IGNORE INTO procedures (name, description) VALUES (?, ?)",
                (name, description),
            )
            db.commit()
        return redirect(url_for("procedures"))
    rows = db.execute("SELECT * FROM procedures ORDER BY name").fetchall()
    return render_template("procedures.html", procedures=rows)


@app.route("/staff", methods=["GET", "POST"])
def staff():
    db = get_db()
    if request.method == "POST":
        name = request.form["name"].strip()
        role = request.form.get("role", "").strip()
        if name:
            db.execute("INSERT INTO staff (name, role) VALUES (?, ?)", (name, role))
            db.commit()
        return redirect(url_for("staff"))
    rows = db.execute(
        """
        SELECT st.*,
               (SELECT COUNT(*) FROM session_participants sp WHERE sp.staff_id = st.id) AS total_reps,
               (SELECT MAX(s.date) FROM session_participants sp JOIN sessions s ON s.id = sp.session_id WHERE sp.staff_id = st.id) AS last_rep
        FROM staff st ORDER BY st.name
        """
    ).fetchall()
    return render_template("staff.html", staff=rows)


@app.route("/sessions")
def sessions_list():
    db = get_db()
    rows = db.execute(
        """
        SELECT s.*, p.name AS procedure_name
        FROM sessions s JOIN procedures p ON p.id = s.procedure_id
        ORDER BY s.date DESC
        """
    ).fetchall()
    return render_template("sessions_list.html", sessions=rows)


@app.route("/sessions/new", methods=["GET", "POST"])
def session_new():
    db = get_db()
    procedures_rows = db.execute("SELECT * FROM procedures ORDER BY name").fetchall()
    if request.method == "POST":
        cur = db.execute(
            "INSERT INTO sessions (date, procedure_id, location, notes) VALUES (?, ?, ?, ?)",
            (
                request.form.get("date") or str(date.today()),
                request.form["procedure_id"],
                request.form.get("location", "").strip(),
                request.form.get("notes", "").strip(),
            ),
        )
        db.commit()
        return redirect(url_for("session_detail", session_id=cur.lastrowid))
    return render_template("session_new.html", procedures=procedures_rows, today=str(date.today()))


@app.route("/sessions/<int:session_id>", methods=["GET", "POST"])
def session_detail(session_id):
    db = get_db()
    if request.method == "POST":
        db.execute(
            """
            INSERT INTO session_participants
                (session_id, staff_id, attempts, time_to_landmark_sec, outcome, debrief_notes)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                session_id,
                request.form["staff_id"],
                request.form.get("attempts") or None,
                request.form.get("time_to_landmark_sec") or None,
                request.form.get("outcome", "").strip(),
                request.form.get("debrief_notes", "").strip(),
            ),
        )
        db.commit()
        return redirect(url_for("session_detail", session_id=session_id))

    session_row = db.execute(
        "SELECT s.*, p.name AS procedure_name FROM sessions s JOIN procedures p ON p.id = s.procedure_id WHERE s.id = ?",
        (session_id,),
    ).fetchone()
    participants = db.execute(
        """
        SELECT sp.*, st.name AS staff_name
        FROM session_participants sp JOIN staff st ON st.id = sp.staff_id
        WHERE sp.session_id = ? ORDER BY sp.id
        """,
        (session_id,),
    ).fetchall()
    all_staff = db.execute("SELECT * FROM staff ORDER BY name").fetchall()
    sim_run = db.execute("SELECT * FROM sim_runs WHERE session_id = ?", (session_id,)).fetchone()
    sim_log = json.loads(sim_run["log"] or "[]") if sim_run else []
    return render_template(
        "session_detail.html", session=session_row, participants=participants, all_staff=all_staff,
        sim_run=sim_run, sim_log=sim_log,
    )


def _raw_conn():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    return sqlite3.connect(DB_PATH)


init_db()
from sim import init_sim  # noqa: E402  (needs get_db defined above)
init_sim(app, _raw_conn)

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, threaded=True)
