"""
Case content and order handling for Bedside Sim.

- content/catalog.json   orderable catalog (labs, imaging, meds, procedures...) with prices
- content/cases/*.json   case files: chart, stages, results bank, debrief targets

Orders are matched from free text (synonyms + typo-tolerant fallback) or picked by id.
Results come from the case's results bank (optionally per stage) or the catalog default,
and become visible after a turnaround time scaled by the room's speed setting.
Anything that can't be matched is queued for the instructor.
"""
import difflib
import glob
import json
import os
import re
import secrets
import time

HERE = os.path.dirname(os.path.abspath(__file__))
CONTENT = os.environ.get("HALO_CONTENT_DIR", os.path.join(HERE, "content"))

_cache = {"mtime": None, "catalog": None, "cases": None}


def _norm(s):
    s = s.lower().replace("&", " and ")
    s = re.sub(r"[^a-z0-9/+.%:-]+", " ", s)
    return f" {' '.join(s.split())} "


def _load():
    paths = [os.path.join(CONTENT, "catalog.json")] + glob.glob(os.path.join(CONTENT, "cases", "*.json"))
    mtime = max((os.path.getmtime(p) for p in paths if os.path.exists(p)), default=0)
    if _cache["mtime"] == mtime:
        return
    with open(os.path.join(CONTENT, "catalog.json")) as f:
        cat = json.load(f)
    by_id = {i["id"]: i for i in cat["items"]}
    phrases = []
    for it in cat["items"]:
        for p in {it["name"], *it.get("syn", [])}:
            n = _norm(p)
            if n.strip():
                phrases.append((n, it["id"]))
    phrases.sort(key=lambda x: -len(x[0]))
    single = {}
    for n, iid in phrases:
        w = n.strip()
        if " " not in w and len(w) >= 5:
            single.setdefault(w, iid)
    cases = {}
    for p in sorted(glob.glob(os.path.join(CONTENT, "cases", "*.json"))):
        try:
            with open(p) as f:
                c = json.load(f)
            cases[c["id"]] = c
        except (OSError, ValueError, KeyError) as e:
            print(f"[content] skipped {p}: {e}")
    _cache.update(mtime=mtime, catalog=cat, by_id=by_id, phrases=phrases, single=single, cases=cases)


def catalog():
    _load()
    return _cache["catalog"]


def item(iid):
    _load()
    return _cache["by_id"].get(iid)


def cases():
    _load()
    return _cache["cases"]


def case(cid):
    _load()
    return _cache["cases"].get(cid)


def public_catalog():
    """Catalog without results (learners must order to see them)."""
    c = catalog()
    return {"priceNote": c.get("priceNote"),
            "items": [{k: it[k] for k in ("id", "name", "cat", "syn", "price", "tat") if k in it} for it in c["items"]],
            "sets": c["sets"]}


# ---------------------------------------------------------------- matching
SPLIT = re.compile(r"[,;\n]+|\s+(?:and then|then|plus|also)\s+", re.I)
STOP = set("""a an the and or for of to please order orders get give start check send call him her patient pt stat now
iv po im sq x2 x1 units unit ml kg mg mcg g l liters liter with on in at left right bilateral repeat another some continue
dose push q q1h q2h q4h q6h each every also want would like i we lets let's let us let's do need needs an please also
increase decrease lower raise set change up down by per min hour hours more less stop hold""".split())


def _find_hits(n):
    taken = [False] * len(n)
    hits = []
    for phrase, iid in _cache["phrases"]:
        start = n.find(phrase)
        while start != -1:
            # phrase carries its own surrounding spaces -> whole-word match
            if not any(taken[start + 1:start + len(phrase) - 1]):
                for k in range(start + 1, start + len(phrase) - 1):
                    taken[k] = True
                hits.append((start, start + len(phrase), iid))
            start = n.find(phrase, start + 1)
    return hits, taken


def match_text(text):
    """Return (matched item ids in order, unmatched fragments for the instructor)."""
    _load()
    found, unmatched = [], []
    for part in SPLIT.split(text or ""):
        part = (part or "").strip()
        if not part:
            continue
        n = _norm(part)
        hits, taken = _find_hits(n)
        # split on " and " only where it is not inside a matched phrase ("type and cross")
        cuts, i = [0], n.find(" and ")
        while i != -1:
            if not any(taken[i + 1:i + 4]):
                cuts.append(i)
            i = n.find(" and ", i + 1)
        cuts.append(len(n))
        for a, b in zip(cuts, cuts[1:]):
            piece_hits = [h for h in hits if a <= h[0] < b]
            words = [w for w in n[a:b].replace(" and ", " ").split() if w not in STOP and not re.fullmatch(r"[0-9./%:-]+", w)]
            if not piece_hits:
                for w in words:  # typo-tolerant fallback on single words
                    if len(w) >= 5:
                        close = difflib.get_close_matches(w, _cache["single"].keys(), n=1, cutoff=0.84)
                        if close:
                            piece_hits.append((a, a, _cache["single"][close[0]]))
            if piece_hits:
                for _, _, iid in sorted(piece_hits):
                    if iid not in found:
                        found.append(iid)
            elif words:
                unmatched.append(n[a:b].replace(" and ", " ").strip()[:200] if len(cuts) > 2 else part[:200])
    return found, unmatched


# ---------------------------------------------------------------- results
def result_for(case_obj, iid, stage_id):
    it = item(iid)
    res = None
    if case_obj:
        r = (case_obj.get("results") or {}).get(iid)
        if isinstance(r, dict) and "by_stage" in r:
            res = r["by_stage"].get(stage_id) or r.get("default")
        elif r:
            res = r
    if res is None:
        res = {"kind": it["kind"], ("rows" if it["kind"] == "labs" else "text"): it["default"]}
    out = {"title": res.get("title") or it["name"], "kind": res.get("kind", it["kind"])}
    if out["kind"] == "labs":
        out["rows"] = res.get("rows") or it["default"]
    else:
        out["text"] = res.get("text") if res.get("text") is not None else it["default"]
    if res.get("image"):
        out["image"] = res["image"]
    if res.get("tat") is not None:
        out["tat"] = res["tat"]
    return out


def new_chart(case_id):
    return {"caseId": case_id, "started": time.time(), "speed": 6, "orders": []}


def place(chart, iids, unmatched, stage_id, source, raw_text=None):
    """Append orders to a room chart. Returns the new order records."""
    c = case(chart.get("caseId"))
    now = time.time()
    new = []
    for iid in iids:
        it = item(iid)
        if not it:
            continue
        res = result_for(c, iid, stage_id)
        tat = res.pop("tat", it.get("tat", 10))
        due = now + max(0, tat) * chart.get("speed", 6)
        new.append({"id": secrets.token_hex(4), "item": iid, "name": it["name"], "cat": it["cat"],
                    "price": it.get("price", 0), "act": bool(it.get("act")), "placed": now, "due": due,
                    "status": "pending", "result": res, "source": source, "text": raw_text, "stage": stage_id})
    for frag in unmatched:
        new.append({"id": secrets.token_hex(4), "item": None, "name": frag, "cat": "Needs instructor",
                    "price": 0, "act": True, "placed": now, "due": None, "status": "queued",
                    "result": None, "source": source, "text": raw_text, "stage": stage_id})
    chart["orders"] = (chart.get("orders", []) + new)[-400:]
    return new


def refresh(chart):
    """Turn pending orders whose time has come into results. Returns True if anything changed."""
    now, changed = time.time(), False
    for o in chart.get("orders", []):
        if o["status"] == "pending" and o.get("due") is not None and o["due"] <= now:
            o["status"] = "done" if o.get("act") and o["result"].get("kind") == "text" and o["cat"] in (
                "Medications", "Procedures", "Respiratory", "Nursing", "Consults") else "resulted"
            changed = True
    return changed


def learner_view(chart):
    c = case(chart.get("caseId"))
    orders = []
    for o in chart.get("orders", []):
        if o["status"] == "cancelled":
            continue
        v = {k: o[k] for k in ("id", "name", "cat", "price", "placed", "status", "source")}
        if o["status"] in ("resulted", "done"):
            v["result"] = o["result"]
        elif o["status"] == "pending":
            v["eta"] = max(0, round(o["due"] - time.time()))
        orders.append(v)
    out = {"caseId": chart.get("caseId"), "orders": orders, "speed": chart.get("speed", 6),
           "cost": round(sum(o["price"] for o in chart.get("orders", []) if o["status"] != "cancelled" and o.get("source") != "initial"))}
    if c and c.get("chart"):
        ch = c["chart"]
        out["chart"] = {k: ch[k] for k in ("patient", "problems", "hpi", "pmh", "meds", "allergies", "social", "exam", "notes") if k in ch}
        out["initial"] = ch.get("initial", [])
    out["title"] = (c or {}).get("learnerTitle") or "Patient chart"
    return out


def report(chart):
    """Debrief: expected actions vs what was ordered, low-value orders, cost."""
    c = case(chart.get("caseId")) or {}
    d = c.get("debrief") or {}
    started = chart.get("started", time.time())
    stage_t = {}
    for s in chart.get("stageLog", []):
        stage_t.setdefault(s["stage"], s["t"])
    orders = [o for o in chart.get("orders", []) if o.get("item") and o.get("source") != "initial"]
    expected = []
    for e in d.get("expected", []):
        t0 = stage_t.get(e.get("from_stage"), started) if e.get("from_stage") else started
        if e.get("from_stage") and e["from_stage"] not in stage_t:
            expected.append({"label": e["label"], "status": "not reached", "at": None, "within_min": e.get("within_min")})
            continue
        times = [o["placed"] - t0 for o in orders if o["item"] in e.get("items", []) and o["placed"] >= t0 - 1]
        t = min(times) if times else None
        lim = e.get("within_min")
        status = "missed" if t is None else ("late" if lim is not None and t > lim * 60 else "met")
        expected.append({"label": e["label"], "status": status, "at": None if t is None else round(t), "within_min": lim})
    low = [o["name"] for o in orders if o["item"] in set(d.get("low_value", []))]
    return {"expected": expected, "lowValue": sorted(set(low)), "teaching": d.get("teaching", []),
            "cost": round(sum(o["price"] for o in orders)), "nOrders": len(orders)}


def start_chart(case_id, run_key, stage_id):
    chart = new_chart(case_id)
    chart["runKey"] = run_key
    chart["stageLog"] = [{"stage": stage_id, "t": chart["started"]}] if stage_id else []
    c = case(case_id)
    if c and c.get("chart", {}).get("initial"):
        recs = place(chart, c["chart"]["initial"], [], stage_id, "initial")
        for r in recs:
            r["due"] = chart["started"] - 1
            r["price"] = 0
        refresh(chart)
    return chart
