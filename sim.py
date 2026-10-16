"""
Bedside Sim — live two-screen ICU/ED simulator, built into the HALO Tracker.

Learners open /sim, type a room code and pick "Bedside monitor" (no login).
The instructor console needs the tracker login. One WebSocket per screen
carries live state; a small path-keyed document store (SQLite) keeps room
state, media, scenarios and the event log so a reload or a late joiner
picks up where the room is.

Every scenario the instructor loads becomes a normal tracker session
(procedure "ICU simulation case"), so participants and debrief notes use
the existing session screens; the timestamped sim log is attached to it.
"""
import json
import os
import content
import re
import secrets
import threading
import time
from datetime import date

from flask import (Blueprint, abort, current_app, jsonify, request,
                   send_from_directory, session)
from flask_sock import Sock

bp = Blueprint("sim", __name__)
sock = Sock()

SIM_PROCEDURE = ("ICU simulation case", "Two-screen bedside monitor simulation (Bedside Sim)")
CODE_RE = re.compile(r"^[A-Z0-9]{1,10}$")
PATH_RE = re.compile(r"^[A-Za-z0-9_.:@+~-]+(/[A-Za-z0-9_.:@+~-]+)*$")
MAX_DOC = 400_000          # bytes of JSON per document
MAX_UPLOAD = 12 * 1024 * 1024

SIM_SCHEMA = """
CREATE TABLE IF NOT EXISTS sim_docs (
    path TEXT PRIMARY KEY,
    room TEXT,
    data TEXT NOT NULL,
    updated REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS sim_docs_room ON sim_docs(room);
CREATE TABLE IF NOT EXISTS sim_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
    room TEXT NOT NULL,
    case_id TEXT,
    case_title TEXT,
    started TEXT NOT NULL,
    log TEXT
);
"""


# ---------------------------------------------------------------- helpers
def _db():
    from app import get_db  # late import: app imports this module
    return get_db()


def is_instructor():
    return bool(session.get("user"))


def media_dir():
    d = os.path.join(os.path.dirname(current_app.config["DB_PATH"]), "media")
    os.makedirs(d, exist_ok=True)
    return d


def room_of(path):
    m = re.match(r"^sims/([A-Z0-9]{1,10})(/|$)", path)
    return m.group(1) if m else None


def can_write(path):
    """Instructor writes anything; learners may only append bedside orders."""
    if is_instructor():
        return True
    return bool(re.match(r"^sims/[A-Z0-9]{1,10}/io/orders$", path))


def can_read(path):
    # scenario library and run logs are instructor-only
    if path.startswith("scenarios") or path.endswith("/io/log") or path.endswith("/io/chart"):
        return is_instructor()
    return True


# ---------------------------------------------------------------- live rooms
class Hub:
    """In-memory fan-out of WebSocket clients per room (single process)."""

    def __init__(self):
        self.lock = threading.Lock()
        self.rooms = {}  # code -> {client_id: client}

    def add(self, code, client):
        with self.lock:
            self.rooms.setdefault(code, {})[client["id"]] = client
        self.peers(code)

    def remove(self, code, client):
        with self.lock:
            self.rooms.get(code, {}).pop(client["id"], None)
        self.peers(code)

    def send(self, code, msg, skip=None):
        data = json.dumps(msg)
        with self.lock:
            targets = list(self.rooms.get(code, {}).values())
        for c in targets:
            if c is skip:
                continue
            try:
                with c["wlock"]:
                    c["ws"].send(data)
            except Exception:
                pass

    def peers(self, code):
        with self.lock:
            lst = [{"id": c["id"], "role": c["role"]} for c in self.rooms.get(code, {}).values()]
        self.send(code, {"t": "peers", "peers": lst})


hub = Hub()


# ---------------------------------------------------------------- doc store
def doc_get(path):
    row = _db().execute("SELECT data FROM sim_docs WHERE path = ?", (path,)).fetchone()
    return json.loads(row["data"]) if row else None


def doc_put(path, data):
    db = _db()
    db.execute(
        "INSERT INTO sim_docs (path, room, data, updated) VALUES (?, ?, ?, ?) "
        "ON CONFLICT(path) DO UPDATE SET data = excluded.data, updated = excluded.updated",
        (path, room_of(path), json.dumps(data), time.time()),
    )
    db.commit()
    _after_write(path, data)
    _notify(path, data)


def doc_delete(path):
    db = _db()
    db.execute("DELETE FROM sim_docs WHERE path = ?", (path,))
    db.commit()
    _notify(path, None)


def _notify(path, data):
    code = room_of(path)
    msg = {"t": "doc", "path": path, "data": data}
    if code:
        hub.send(code, msg)
    else:  # library docs (scenarios): every room's instructors
        with hub.lock:
            codes = list(hub.rooms.keys())
        for c in codes:
            hub.send(c, msg)


def _sim_procedure_id(db):
    row = db.execute("SELECT id FROM procedures WHERE name = ?", (SIM_PROCEDURE[0],)).fetchone()
    if row:
        return row["id"]
    cur = db.execute("INSERT INTO procedures (name, description) VALUES (?, ?)", SIM_PROCEDURE)
    return cur.lastrowid


def _after_write(path, data):
    """Tracker hooks: a newly loaded scenario opens a tracker session; the log follows it."""
    db = _db()
    m = re.match(r"^sims/([A-Z0-9]{1,10})$", path)
    if m and isinstance(data, dict) and data.get("scenarioId") and data.get("runKey"):
        code = m.group(1)
        exists = db.execute(
            "SELECT id FROM sim_runs WHERE room = ? AND started = ?",
            (code, str(data["runKey"])),
        ).fetchone()
        if not exists:
            title = str(data.get("scenarioTitle") or data["scenarioId"])[:120]
            cur = db.execute(
                "INSERT INTO sessions (date, procedure_id, location, notes) VALUES (?, ?, ?, ?)",
                (str(date.today()), _sim_procedure_id(db), f"Sim room {code}", f"Case: {title}"),
            )
            db.execute(
                "INSERT INTO sim_runs (session_id, room, case_id, case_title, started, log) VALUES (?, ?, ?, ?, ?, ?)",
                (cur.lastrowid, code, str(data["scenarioId"])[:60], title, str(data["runKey"]), "[]"),
            )
            db.commit()
    m = re.match(r"^sims/([A-Z0-9]{1,10})$", path)
    if m and isinstance(data, dict):
        code = m.group(1)
        with chart_lock:
            ch = chart_get(code)
            rk = str(data.get("runKey") or "")
            if data.get("scenarioId") and rk and (not ch or ch.get("runKey") != rk):
                ch = content.start_chart(data["scenarioId"], rk, data.get("stageId"))
                chart_put(code, ch)
            elif ch and data.get("stageId") and (not ch.get("stageLog") or ch["stageLog"][-1]["stage"] != data["stageId"]):
                ch.setdefault("stageLog", []).append({"stage": data["stageId"], "t": time.time()})
                chart_put(code, ch)
    m = re.match(r"^sims/([A-Z0-9]{1,10})/io/log$", path)
    if m and isinstance(data, dict):
        run = db.execute(
            "SELECT id FROM sim_runs WHERE room = ? ORDER BY id DESC LIMIT 1", (m.group(1),)
        ).fetchone()
        if run:
            db.execute("UPDATE sim_runs SET log = ? WHERE id = ?", (json.dumps(data.get("list", [])), run["id"]))
            db.commit()


# ---------------------------------------------------------------- patient chart + orders
chart_lock = threading.RLock()


def chart_get(code):
    row = _db().execute("SELECT data FROM sim_docs WHERE path = ?", (f"sims/{code}/io/chart",)).fetchone()
    return json.loads(row["data"]) if row else None


def chart_put(code, ch, notify=True):
    db = _db()
    db.execute(
        "INSERT INTO sim_docs (path, room, data, updated) VALUES (?, ?, ?, ?) "
        "ON CONFLICT(path) DO UPDATE SET data = excluded.data, updated = excluded.updated",
        (f"sims/{code}/io/chart", code, json.dumps(ch), time.time()),
    )
    db.commit()
    if notify:
        hub.send(code, {"t": "chart"})


def _code(code):
    code = code.upper()
    if not CODE_RE.match(code):
        abort(404)
    return code


def _room_chart(code):
    """Current chart for a room (created empty if no case is loaded), with timers applied."""
    with chart_lock:
        ch = chart_get(code)
        if not ch:
            st = doc_get(f"sims/{code}") or {}
            ch = content.start_chart(st.get("scenarioId"), str(st.get("runKey") or ""), st.get("stageId"))
            chart_put(code, ch, notify=False)
        if content.refresh(ch):
            chart_put(code, ch)
        return ch


_rate = {}


@bp.route("/chart")
def chart_page():
    return send_from_directory(os.path.join(current_app.root_path, "static"), "chart.html")


@bp.route("/api/content/catalog")
def api_catalog():
    return jsonify(content.public_catalog())


@bp.route("/api/content/cases")
def api_cases():
    if not is_instructor():
        abort(403)
    return jsonify({"cases": list(content.cases().values())})


@bp.route("/api/room/<code>/chart")
def api_chart(code):
    code = _code(code)
    ch = _room_chart(code)
    if request.args.get("full") and is_instructor():
        return jsonify({"chart": ch, "report": content.report(ch), "now": time.time()})
    return jsonify(content.learner_view(ch))


@bp.route("/api/room/<code>/order", methods=["POST"])
def api_order(code):
    code = _code(code)
    body = request.get_json(force=True, silent=True) or {}
    now = time.time()
    hist = [t for t in _rate.get(code, []) if now - t < 60]
    if len(hist) >= 40:
        return jsonify({"error": "Too many orders in a minute — slow down."}), 429
    text = str(body.get("text") or "")[:500]
    ids = [str(i) for i in (body.get("items") or [])][:30]
    ids = [i for i in ids if content.item(i)]
    matched, unmatched = content.match_text(text) if text else ([], [])
    for i in matched:
        if i not in ids:
            ids.append(i)
    if not ids and not unmatched:
        return jsonify({"placed": []})
    source = "monitor" if body.get("source") == "monitor" else "chart"
    st = doc_get(f"sims/{code}") or {}
    with chart_lock:
        ch = _room_chart(code)
        new = content.place(ch, ids, unmatched, st.get("stageId"), source, text or None)
        content.refresh(ch)
        chart_put(code, ch)
    _rate[code] = hist + [now]
    return jsonify({"placed": [{"id": o["id"], "name": o["name"], "status": o["status"]} for o in new]})


@bp.route("/api/room/<code>/orders/<oid>", methods=["POST"])
def api_order_action(code, oid):
    if not is_instructor():
        abort(403)
    code = _code(code)
    body = request.get_json(force=True, silent=True) or {}
    action = body.get("action")
    with chart_lock:
        ch = _room_chart(code)
        o = next((x for x in ch["orders"] if x["id"] == oid), None)
        if not o:
            abort(404)
        if action == "release":
            o["due"] = time.time() - 1
            if o["status"] == "queued":
                o["result"] = {"title": o["name"], "kind": "text", "text": "Done.", "src": "default"}
                o["status"] = "pending"
        elif action == "result":
            txt = str(body.get("text") or "").strip()[:4000]
            o["result"] = {"title": str(body.get("title") or o["name"])[:120], "kind": "text", "text": txt or "Normal.", "src": "instructor"}
            o["status"], o["due"] = "pending", time.time() - 1
        elif action == "cancel":
            o["status"] = "cancelled"
        else:
            abort(400)
        content.refresh(ch)
        chart_put(code, ch)
    return jsonify({"ok": True})


@bp.route("/api/room/<code>/speed", methods=["POST"])
def api_speed(code):
    if not is_instructor():
        abort(403)
    code = _code(code)
    body = request.get_json(force=True, silent=True) or {}
    speed = max(0.0, min(60.0, float(body.get("speed", 6))))
    with chart_lock:
        ch = _room_chart(code)
        old = ch.get("speed", 6)
        now = time.time()
        for o in ch["orders"]:  # rescale remaining waits
            if o["status"] == "pending" and o.get("due") and old:
                o["due"] = now + (o["due"] - now) * (speed / old)
        ch["speed"] = speed
        content.refresh(ch)
        chart_put(code, ch)
    return jsonify({"ok": True})


# ---------------------------------------------------------------- HTTP API
@bp.route("/sim")
def sim_page():
    return send_from_directory(os.path.join(current_app.root_path, "static"), "sim.html")


@bp.route("/vent/")
def vent_page():
    """Vent Lab — ventilator simulator, curriculum, tutorials and scenario builder (no sign-in)."""
    return send_from_directory(os.path.join(current_app.root_path, "static", "vent"), "index.html")


@bp.route("/vent/<path:fname>")
def vent_asset(fname):
    return send_from_directory(os.path.join(current_app.root_path, "static", "vent"), fname)


@bp.route("/api/version")
def version():
    return jsonify({"version": os.environ.get("HALO_VERSION", "local")[:7],
                    "built": os.environ.get("HALO_BUILD_DATE", "unknown")})


@bp.route("/api/whoami")
def whoami():
    return jsonify({"instructor": is_instructor()})


@bp.route("/api/doc/<path:path>", methods=["GET", "PUT", "DELETE"])
def api_doc(path):
    if not PATH_RE.match(path) or len(path) > 300:
        abort(400)
    if request.method == "GET":
        if not can_read(path):
            return jsonify({"exists": False})
        d = doc_get(path)
        return jsonify({"exists": d is not None, "data": d})
    if not can_write(path) or path.endswith("/io/chart"):
        abort(403)
    if request.method == "DELETE":
        doc_delete(path)
        return jsonify({"ok": True})
    raw = request.get_data()
    if len(raw) > MAX_DOC:
        abort(413)
    body = request.get_json(force=True, silent=True)
    if not isinstance(body, dict):
        abort(400)
    if path.endswith("/io/orders") and not is_instructor():
        # learners append; never overwrite others' orders
        cur = doc_get(path) or {"list": []}
        new = [o for o in body.get("list", []) if isinstance(o, dict)]
        seen = {o.get("id") for o in cur["list"]}
        for o in new:
            if o.get("id") not in seen:
                cur["list"].append({"id": str(o.get("id"))[:20], "text": str(o.get("text", ""))[:280], "ts": o.get("ts")})
        body = {"list": cur["list"][-60:]}
    doc_put(path, body)
    return jsonify({"ok": True})


@bp.route("/api/col/<path:path>")
def api_col(path):
    if not PATH_RE.match(path):
        abort(400)
    if not can_read(path + "/x"):
        return jsonify({"docs": []})
    rows = _db().execute(
        "SELECT path, data FROM sim_docs WHERE path LIKE ? ORDER BY path", (path + "/%",)
    ).fetchall()
    depth = path.count("/") + 1
    docs = [{"id": r["path"].rsplit("/", 1)[1], "data": json.loads(r["data"])}
            for r in rows if r["path"].count("/") == depth]
    return jsonify({"docs": docs})


@bp.route("/api/upload", methods=["POST"])
def api_upload():
    if not is_instructor():
        abort(403)
    raw = request.get_data()
    if not raw or len(raw) > MAX_UPLOAD:
        abort(413)
    ctype = request.headers.get("Content-Type", "")
    ext = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp",
           "video/mp4": "mp4", "image/gif": "gif"}.get(ctype)
    if not ext:
        abort(415)
    aid = secrets.token_hex(16)
    with open(os.path.join(media_dir(), f"{aid}.{ext}"), "wb") as f:
        f.write(raw)
    return jsonify({"id": f"{aid}.{ext}", "url": f"/media/{aid}.{ext}"})


@bp.route("/api/upload/<aid>", methods=["DELETE"])
def api_upload_delete(aid):
    if not is_instructor() or not re.match(r"^[0-9a-f]{32}\.[a-z0-9]{2,4}$", aid):
        abort(403)
    p = os.path.join(media_dir(), aid)
    if os.path.exists(p):
        os.remove(p)
    return jsonify({"ok": True})


@bp.route("/media/<aid>")
def media(aid):
    if not re.match(r"^[0-9a-f]{32}\.[a-z0-9]{2,4}$", aid):
        abort(404)
    return send_from_directory(media_dir(), aid, max_age=86400)


# ---------------------------------------------------------------- WebSocket
@sock.route("/ws/<code>")
def ws_room(ws, code):
    code = code.upper()
    if not CODE_RE.match(code):
        return
    role = request.args.get("role", "monitor")
    if role == "instructor" and not is_instructor():
        role = "monitor"
    client = {"id": secrets.token_hex(4), "role": role, "ws": ws, "wlock": threading.Lock()}
    with client["wlock"]:
        ws.send(json.dumps({"t": "hello", "id": client["id"], "role": role}))
    hub.add(code, client)
    try:
        while True:
            raw = ws.receive()
            if raw is None:
                break
            if len(raw) > 64_000:
                continue
            try:
                msg = json.loads(raw)
            except ValueError:
                continue
            t = msg.get("t")
            if t == "emit":
                topic = str(msg.get("topic", ""))[:40]
                if topic == "state" and role != "instructor":
                    continue
                if topic not in ("state", "order", "ping"):
                    continue
                hub.send(code, {"t": "emit", "topic": topic, "data": msg.get("data"), "from": client["id"]})
            elif t == "presence":
                pass  # role is fixed at connect; nothing else is tracked
    finally:
        hub.remove(code, client)


def init_sim(app, get_db_conn):
    app.config.setdefault("DB_PATH", os.environ.get("HALO_DB_PATH", "data/halo.db"))
    conn = get_db_conn()
    conn.executescript(SIM_SCHEMA)
    conn.commit()
    conn.close()
    sock.init_app(app)
    app.register_blueprint(bp)
