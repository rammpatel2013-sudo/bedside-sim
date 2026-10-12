/*
 * Vent Lab physiology engine — single-compartment respiratory system on a simulated ventilator.
 * Original implementation for bedside-sim. Runs in the browser and in Node (tests).
 *
 * Equation of motion:  Paw = Pel(V) + R·Q − Pmus      (V = volume above relaxation volume)
 *   Pel(V) = V / C  (+ optional overdistension term),  C = respiratory-system compliance
 *   Pes    = pes0 + V / Ccw − Pmus                      (chest wall / pleural)
 *   Ptp    = Paw − Pes  (static: lung recoil)
 *
 * Units inside the engine: volume L, flow L/s, pressure cmH2O, time s.
 * Samples and summaries expose mL and L/min, which is what clinicians read.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VentEngine = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ------------------------------------------------------------------ defaults
  const DEFAULT_SETTINGS = {
    mode: 'VC',            // VC | PC | PRVC (mandatory) · PSV | VS (spontaneous) · APRV
    vtype: 'AC',           // AC (A/CMV) | SIMV — how patient triggers are answered in VC/PC/PRVC
    vt: 450,               // mL — VC tidal volume, PRVC target
    rr: 16,                // set (minimum mandatory) rate
    peep: 5,
    ti: 0.9,               // s — inspiratory time (VC: includes pause)
    pause: 0,              // % of Ti held with zero flow (VC)
    flow: 'square',        // square | decel (VC)
    pinsp: 12,             // cmH2O above PEEP (PC)
    psupport: 10,          // cmH2O above PEEP (PSV, and spontaneous breaths in SIMV)
    phigh: 25, plow: 5, thigh: 4.0, tlow: 0.6,   // APRV
    rise: 0.15,            // s — pressure rise time (PC/PSV/PRVC)
    cycle: 25,             // % of peak flow (PSV expiratory trigger)
    trig: 'flow',          // flow | pressure
    trig_f: 2,             // L/min
    trig_p: -2,            // cmH2O (below PEEP)
    fio2: 0.4,
    backup: { pinsp: 15, rr: 12, ti: 1.0 },   // PSV apnea backup (PC breaths)
    alarms: { paw_hi: 40, paw_lo: 8, vte_hi: 900, vte_lo: 250, mv_hi: 15, mv_lo: 4, rr_hi: 35, apnea: 20 }
  };

  const DEFAULT_PATIENT = {
    sex: 'M', height_cm: 175,
    c: 50,                 // mL/cmH2O — total respiratory-system compliance (best, if recruitable)
    ccw: 200,              // mL/cmH2O — chest wall compliance
    r: 10,                 // cmH2O/L/s — inspiratory resistance (airway + tube)
    rexp: 1.0,             // expiratory resistance multiplier
    pcrit: 0,              // cmH2O — expiratory flow-limitation (critical closing) pressure; 0 = none
    vd: 150,               // mL — physiologic dead space
    hco3: 24, vco2: 200,   // mEq/L, mL/min
    shunt: 0.05,           // shunt fraction at the patient's current lung state
    hb: 13, vo2: 250, co: 5,
    pes0: 4,               // cmH2O — esophageal pressure offset at relaxation volume
    od_ml: 0, od_k: 40,    // overdistension: compliance falls above this lung volume (mL above relaxation); 0 = off
    recruit: { on: false, popt: 14, width: 6, shunt_min: 0.08 },  // PEEP-dependent compliance & shunt
    effort: { on: false, pmax: 6, rate: 16, ti: 0.9, push: 0 },     // push = active expiratory effort (cmH2O)
    leak: 0,               // L/min at 10 cmH2O
    nif: 45,               // cmH2O — maximal inspiratory pressure the patient can generate (NIF maneuver)
    pi: 3.5,               // perfusion index for the pulse oximeter
    disconnect: false, secretions: false, cardiac: false, hr: 88
  };

  const PRESETS = {
    normal: {
      label: 'Normal lungs',
      settings: { mode: 'VC', vt: 450, rr: 14, peep: 5, ti: 0.9, pause: 0, flow: 'square', fio2: 0.4, trig: 'flow', trig_f: 2 },
      patient: { c: 55, r: 8, rexp: 1, vd: 150, shunt: 0.05, effort: { on: false } }
    },
    obstructive: {
      label: 'COPD / asthma',
      settings: { mode: 'VC', vt: 450, rr: 20, peep: 5, ti: 1.0, pause: 0, flow: 'square', fio2: 0.4 },
      patient: { c: 60, r: 28, rexp: 1.6, pcrit: 6, vd: 200, shunt: 0.08, hco3: 30, effort: { on: false } }
    },
    ards: {
      label: 'ARDS',
      settings: { mode: 'VC', vt: 420, rr: 20, peep: 8, ti: 0.8, pause: 0, flow: 'square', fio2: 0.7 },
      patient: { c: 32, r: 11, rexp: 1, vd: 230, shunt: 0.40, od_ml: 900, recruit: { on: true, popt: 14, width: 6, shunt_min: 0.12 }, effort: { on: false } }
    },
    obese: {
      label: 'Obesity (stiff chest wall)',
      settings: { mode: 'VC', vt: 450, rr: 16, peep: 5, ti: 0.9, fio2: 0.5 },
      patient: { c: 38, ccw: 140, r: 12, pes0: 12, shunt: 0.32, recruit: { on: true, popt: 16, width: 7, shunt_min: 0.05 }, effort: { on: false } }
    },
    spont: {
      label: 'Awake, breathing on PSV',
      settings: { mode: 'PSV', psupport: 8, peep: 5, cycle: 25, rise: 0.15, fio2: 0.35, trig: 'flow', trig_f: 2 },
      patient: { c: 55, r: 9, effort: { on: true, pmax: 6, rate: 18, ti: 0.9, push: 0 } }
    }
  };

  // ------------------------------------------------------------------ helpers
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const isObj = o => o && typeof o === 'object' && !Array.isArray(o);
  function deepMerge(base, over) {
    const out = Array.isArray(base) ? base.slice() : { ...base };
    if (!isObj(over)) return out;
    for (const k of Object.keys(over)) {
      if (isObj(over[k]) && isObj(base && base[k])) out[k] = deepMerge(base[k], over[k]);
      else if (over[k] !== undefined) out[k] = isObj(over[k]) ? deepMerge({}, over[k]) : over[k];
    }
    return out;
  }
  const normSettings = s => deepMerge(DEFAULT_SETTINGS, s || {});
  const isSpontMode = S => S.mode === 'PSV' || S.mode === 'VS';
  const peepOf = S => (S.mode === 'APRV' ? S.plow : S.peep);
  function modeLabel(S) {
    if (S.mode === 'APRV') return 'APRV';
    if (S.mode === 'PSV') return S.psupport > 0 ? 'SPONT-PS' : 'SPONT-CPAP';
    if (S.mode === 'VS') return 'SPONT-VS';
    return S.vtype === 'SIMV' ? `SIMV-${S.mode}-PS` : `A/CMV-${S.mode}`;
  }
  // least squares: rows of regressors x[], targets y[] -> coefficients (null if singular)
  function lsq(X, y) {
    const n = X[0].length, A = [], b = new Array(n).fill(0);
    for (let a = 0; a < n; a++) A.push(new Array(n).fill(0));
    for (let i = 0; i < X.length; i++) { const x = X[i]; for (let a = 0; a < n; a++) { b[a] += x[a] * y[i]; for (let c = 0; c < n; c++) A[a][c] += x[a] * x[c]; } }
    for (let a = 0; a < n; a++) A[a][a] += 1e-9 + A[a][a] * 1e-9;
    const M = A.map((r, i) => r.concat([b[i]]));
    for (let c = 0; c < n; c++) {
      let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      if (Math.abs(M[p][c]) < 1e-12) return null;
      const tmp = M[c]; M[c] = M[p]; M[p] = tmp;
      for (let r = 0; r < n; r++) { if (r === c) continue; const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
    }
    return M.map((r, i) => r[n] / r[i]);
  }
  // muscle pressure 0.1 s after effort onset (what an occlusion at onset reads as P0.1)
  const p01Of = e => (e && e.on && e.pmax > 0 ? e.pmax * Math.sin(Math.PI / 2 * Math.min(1, 0.1 / (0.5 * Math.max(0.2, e.ti)))) : 0);
  const normPatient = p => deepMerge(DEFAULT_PATIENT, p || {});

  function pbw(p) {
    const h = (p && p.height_cm) || 170;
    return Math.max(20, ((p && p.sex) === 'F' ? 45.5 : 50) + 0.91 * (h - 152.4));
  }

  // Chest wall and lung compliances from total (series): 1/C = 1/CL + 1/Ccw
  function splitCompliance(cTotal, ccw) {
    const cw = Math.max(ccw, cTotal * 1.05);
    return { cl: 1 / (1 / cTotal - 1 / cw), ccw: cw };
  }

  // PEEP-dependent recruitment: compliance factor, shunt and extra dead space at a given total PEEP
  function recruitState(pt, ptot) {
    const rc = pt.recruit || {};
    if (!rc.on) return { cf: 1, shunt: pt.shunt, vdExtra: 0 };
    const w = Math.max(1, rc.width || 6);
    const cf = 0.5 + 0.5 * Math.exp(-Math.pow((ptot - rc.popt) / w, 2));
    const open = 1 / (1 + Math.exp(-(ptot - (rc.popt - 3)) / 1.6));
    const smin = rc.shunt_min != null ? rc.shunt_min : 0.08;
    const shunt = smin + Math.max(0, pt.shunt - smin) * (1 - open);
    const vdExtra = Math.max(0, ptot - (rc.popt + 2)) * 12;   // mL — overdistended, under-perfused units
    return { cf, shunt, vdExtra };
  }

  // ------------------------------------------------------------------ gas exchange (steady state)
  const sat = po2 => (po2 <= 0 ? 0 : 1 / (23400 / (po2 * po2 * po2 + 150 * po2) + 1));   // Severinghaus
  const o2c = (po2, hb) => 1.34 * hb * sat(po2) + 0.003 * po2;
  function po2FromContent(c, hb) {
    let lo = 0, hi = 800;
    for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (o2c(m, hb) < c) lo = m; else hi = m; }
    return (lo + hi) / 2;
  }
  function gasExchange(g) {
    const anat = 2.2 * (g.pbw || 70);                                   // mL anatomic dead space
    const vd = Math.max(anat, g.vd);
    const va = Math.max(0.15, ((g.vt - vd) / 1000) * g.rr);             // L/min alveolar ventilation
    const paco2 = clamp((0.863 * g.vco2) / va, 12, 160);
    const ph = 6.1 + Math.log10(g.hco3 / (0.0307 * paco2));
    const PAO2 = Math.max(0, g.fio2 * 713 - paco2 / 0.8);
    const s = clamp(g.shunt, 0, 0.85);
    const ca = o2c(PAO2, g.hb) - (g.vo2 / (g.co * 10)) * s / (1 - s);
    const pao2 = ca > 0 ? po2FromContent(ca, g.hb) : 0;
    const spo2 = sat(pao2) * 100;
    const alvVd = Math.max(0, vd - anat), alvVt = Math.max(1, g.vt - anat);
    const etco2 = clamp(paco2 * (1 - alvVd / alvVt) - 3, 0, paco2);
    return { va, paco2, ph, pao2, spo2, PAO2, pf: pao2 / g.fio2, etco2, vdvt: vd / Math.max(1, g.vt) };
  }

  // ------------------------------------------------------------------ deterministic noise
  function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

  // ------------------------------------------------------------------ simulator
  function createSim(settingsIn, patientIn, opts) {
    opts = opts || {};
    const dt = opts.dt || 0.004;
    let S = normSettings(settingsIn);
    let P = normPatient(patientIn);
    let pending = null;
    const rand = rng(opts.seed || 7);
    const listeners = [];
    const holdListeners = [];

    let t = 0;
    let rec = recruitState(P, peepOf(S));
    let cf = rec.cf;
    const C = () => (P.c / 1000) * cf;                                   // L/cmH2O
    const splitNow = () => splitCompliance(P.c * cf, P.ccw);
    const Rin = () => Math.max(0.5, P.r);
    const Rex = () => Math.max(0.5, P.r * (P.rexp || 1));
    const odV = () => (P.od_ml > 0 ? P.od_ml / 1000 : Infinity);
    const odTerm = v => (v > odV() ? (P.od_k || 40) * Math.pow(v - odV(), 2) : 0);
    const Pel = v => v / C() + odTerm(v);

    let V = peepOf(S) * C();                 // start at the set-PEEP equilibrium
    let phase = 'exp';
    let br = null;                           // current breath record
    let breathIdx = -1;
    let nextMandatory = 0.4;
    let lastBreathStart = -1e9;
    let inspEnd = -1e9;
    let backupActive = false;
    let prvcP = null;                        // PRVC adaptive Pinsp
    let vsP = null;                          // volume-support adaptive pressure
    let manualQ = false, maneuverQ = null, maneuverQT = 0, occl = null;
    let lastCo2 = 0, lastVt = 0.45;
    let simvCyc = 0, simvDone = false;        // SIMV: fixed cycles, one mandatory breath per cycle
    const anat = () => 2.2 * pbw(P) / 1000;  // L anatomic dead space
    let holdQueue = null, holdEnd = 0;
    let ppeakLimitHit = false;
    let lastSample = null;
    let vdisp = 0;                           // displayed volume (reset each breath)

    // patient effort clock (independent of the ventilator)
    const efforts = [];
    let effStart = 0.7, effIdx = -1, curEffort = null;

    function effortAt(tt) {
      const e = P.effort;
      if (!e || !e.on || !(e.pmax > 0)) return 0;
      const per = 60 / Math.max(2, e.rate);
      while (tt >= effStart) {               // start a new neural breath
        effIdx++;
        curEffort = { idx: effIdx, start: effStart, ti: e.ti, breaths: [], onsetPhase: phase };
        if (maneuverQ === 'p01' && phase === 'exp' && !P.disconnect) {   // occlude the airway for the first 100 ms of this effort
          maneuverQ = null; phase = 'occl'; occl = { kind: 'p01', t0: effStart, end: effStart + 0.1, p0: Pel(V), pmin: Pel(V) };
        }
        efforts.push(curEffort);
        if (efforts.length > 400) efforts.shift();
        effStart += per;
      }
      if (!curEffort) return 0;
      const tau = tt - curEffort.start, tin = Math.max(0.2, e.ti);
      let pm;
      // fast rise over the first half of neural inspiration, then a held drive, then relaxation
      if (tau < tin) pm = e.pmax * Math.sin(Math.PI / 2 * Math.min(1, tau / (0.5 * tin)));
      else pm = e.pmax * Math.exp(-(tau - tin) / 0.12);
      if (e.push > 0 && tau >= tin && tau < tin + 0.55) pm -= e.push * Math.sin(Math.PI * (tau - tin) / 0.55);
      return pm;
    }

    function artifacts(tt, flowAbsLpm) {
      let pa = 0, fa = 0;
      if (P.cardiac) {
        const w = 2 * Math.PI * (P.hr || 88) / 60;
        pa += 1.4 * Math.sin(w * tt);
        fa += (3.5 / 60) * Math.sin(w * tt + 0.7);
      }
      if (P.secretions) {
        const amp = (2.6 + 0.08 * flowAbsLpm) / 60;
        fa += amp * (Math.sin(2 * Math.PI * 7.3 * tt) + 0.6 * Math.sin(2 * Math.PI * 11.7 * tt + 1.1) + 0.5 * (rand() - 0.5));
        pa += 0.7 * (Math.sin(2 * Math.PI * 7.3 * tt + 0.4) + 0.4 * (rand() - 0.5));
      }
      return { pa, fa };
    }

    const leakK = () => (P.leak > 0 ? (P.leak / 60) / 10 : 0);         // L/s per cmH2O

    function startBreath(type) {
      if (br) finalizeBreath();
      if (pending) { S = pending; pending = null; }
      const peep = peepOf(S);
      // recruitment drifts toward the state set by the last breath's true total PEEP
      const ptotTrue = br ? br.endExpPel : peep;
      rec = recruitState(P, ptotTrue);
      cf = cf + (rec.cf - cf) * 0.35;
      breathIdx++;
      // what kind of breath this trigger gets
      let kind, ptarget = null, ti = S.ti, cycle = 'time', spont = false, rrFor = S.rr;
      if (type === 'B') { kind = 'PC'; ptarget = S.backup.pinsp; ti = S.backup.ti; rrFor = S.backup.rr; }
      else if (S.mode === 'APRV') { kind = 'APRV'; ptarget = Math.max(0, S.phigh - S.plow); ti = S.thigh; rrFor = 60 / Math.max(0.2, S.thigh + S.tlow); }
      else if (S.mode === 'PSV') { kind = 'PSV'; ptarget = S.psupport; cycle = 'flow'; spont = true; }
      else if (S.mode === 'VS') { kind = 'VS'; if (vsP == null) vsP = 10; ptarget = vsP; cycle = 'flow'; spont = true; }
      else if (type === 'S') { kind = 'PSV'; ptarget = S.psupport; cycle = 'flow'; spont = true; }
      else {
        kind = S.mode;
        if (kind === 'PC') ptarget = S.pinsp;
        if (kind === 'PRVC') { if (prvcP == null) prvcP = 10; ptarget = prvcP; }
      }
      br = {
        idx: breathIdx, start: t, type, mode: kind, cycle, spont, ti, ptarget, set: S, peep,
        pause: kind === 'VC' ? clamp(S.pause || 0, 0, 60) / 100 : 0,
        flowPattern: S.flow, vtSet: S.vt / 1000,
        qpk: 0, vtiDel: 0, vtiPt: 0, vte: 0, vex: 0, ppeak: -1e9, psum: 0, n: 0, pminIns: 1e9,
        inspEndT: null, endInspPel: null, pplat: null, ptot: null, holdType: null, qEndIns: null,
        endExpFlow: null, endExpPel: null, highP: false, pts: [], ptsK: 0,
        artifactTrigger: false, pmusMax: 0, wob: 0, hiSum: 0, hiN: 0, loSum: 0, loN: 0,
        fitX: [], fitY: [], insX: [], insY: [], fitK: 0, vmax: 0
      };
      if (curEffort && t - curEffort.start <= Math.max(0.2, P.effort.ti) + 0.25) curEffort.breaths.push(breathIdx);
      lastBreathStart = t;
      phase = 'insp';
      vdisp = 0;
      ppeakLimitHit = false;
      if (type !== 'S') nextMandatory = t + 60 / Math.max(1, rrFor);   // SIMV spontaneous breaths keep the mandatory clock
    }

    function endInspiration() {
      br.inspEndT = t;
      br.endInspPel = Pel(V);
      br.qEndIns = lastSample ? lastSample.flow : null;
      if (holdQueue === 'insp' && !P.disconnect) {
        holdQueue = null; phase = 'ihold'; holdEnd = t + 0.8; br.holdType = 'insp';
      } else { phase = 'exp'; inspEnd = t; }
      // adaptive pressure modes move toward the target volume (max ±3 cmH2O per breath)
      if (br.mode === 'PRVC' || br.mode === 'VS') {
        const vt = br.vtiPt;
        const cEst = vt > 0.02 ? vt / Math.max(1, br.ptarget) : C();
        const err = br.vtSet - vt;
        const pmax = Math.max(6, S.alarms.paw_hi - 5 - peepOf(S));
        const next = clamp(br.ptarget + clamp(err / cEst, -3, 3), br.mode === 'VS' ? 2 : 5, pmax);
        if (br.mode === 'PRVC') prvcP = next; else vsP = next;
      }
    }

    // breath-by-breath least-squares estimates (what the ventilator reports as "EST" without a hold)
    function estimates(b) {
      const out = {};
      if (b.fitX.length >= 25) {
        const th = lsq(b.fitX, b.fitY);   // Paw = E·V + Ri·Qinsp + Re·Qexp + P0
        if (th && th[0] > 2 && th[0] < 1000) {
          const vt = b.vmax;
          out.cEst = 1000 / th[0]; out.rEst = th[1] > 0 ? th[1] : null; out.reEst = th[2] > 0 ? th[2] : null;
          out.peepiEst = Math.max(0, th[3] - b.peep); out.pplatEst = th[3] + th[0] * vt; out.pdrivingEst = th[0] * vt;
        }
      }
      if (b.mode === 'VC' && b.insX.length >= 25) {
        const th = lsq(b.insX, b.insY);   // Paw = E1·V + E2·V² + R·Q + P0 (inspiration only)
        if (th && th[0] > 2) { const vt = b.vmax; out.c20c = (th[0] + th[1] * vt) / (th[0] + 1.8 * th[1] * vt); }
      }
      return out;
    }

    function finalizeBreath() {
      const b = br;
      if (b.inspEndT == null) { b.inspEndT = t; b.endInspPel = Pel(V); }
      b.endExpPel = Pel(V);
      b.endExpFlow = lastSample ? lastSample.flow : 0;
      b.ttot = t - b.start;
      b.tiActual = (b.inspEndT - b.start);
      b.te = Math.max(0.01, b.ttot - b.tiActual);
      const effOn = P.effort && P.effort.on;
      const est = estimates(b);
      const sum = {
        idx: b.idx, t0: b.start, type: b.type, mode: b.mode, spont: b.spont,
        ppeak: b.ppeak, pmean: b.n ? b.psum / b.n : 0,
        vti: b.vtiDel * 1000, vtiPt: b.vtiPt * 1000, vte: b.vte * 1000,
        ti: b.tiActual, te: b.te, ttot: b.ttot, ie: b.te / Math.max(0.01, b.tiActual),
        pinsp: b.ptarget, pplat: b.pplat, ptot: b.ptot, qEndIns: b.qEndIns,
        pplatTrue: b.endInspPel, ptotTrue: b.endExpPel, autoPeepTrue: b.endExpPel - b.peep,
        endExpFlow: b.endExpFlow, peep: b.peep, highP: b.highP,
        scoop: b.pminIns < 1e8 ? b.peep - b.pminIns : null,
        overshoot: b.ptarget != null && b.mode !== 'APRV' ? b.ppeak - (b.peep + b.ptarget) : null,
        falseTrigger: (b.type === 'P' || b.type === 'S') && (!effOn || !nearEffort(b.start)),
        artifactTrigger: b.artifactTrigger,
        pmusMax: b.pmusMax, wob: b.wob,
        phMean: b.hiN ? b.hiSum / b.hiN : null, plMean: b.loN ? b.loSum / b.loN : null,
        ...est,
        pts: b.pts, cf, rec
      };
      for (const fn of listeners) fn(sum);
      lastBreath = sum;
      breaths.push(sum);
      if (breaths.length > 400) breaths.shift();
    }

    function nearEffort(tt) {
      for (let i = efforts.length - 1; i >= 0 && i >= efforts.length - 4; i--) {
        const e = efforts[i], d = tt - e.start;
        if (d >= -0.05 && d <= Math.max(0.2, e.ti) + 0.25) return true;
      }
      return false;
    }

    const breaths = [];
    let lastBreath = null;
    const emitHold = h => { for (const fn of holdListeners) fn(h); };

    function step() {
      t += dt;
      const pmus = effortAt(t);
      const c = C(), peep = peepOf(S);
      const kL = leakK();
      const spontMode = isSpontMode(S);
      let paw, qp, qmeas;

      // ---- SIMV cycle clock (runs whatever the breath phase)
      const simv = S.vtype === 'SIMV' && !spontMode && S.mode !== 'APRV';
      if (simv) {
        const per = 60 / Math.max(1, S.rr);
        if (t >= simvCyc + per) { simvCyc += per * Math.max(1, Math.floor((t - simvCyc) / per)); simvDone = false; }
      }

      // ---- maneuvers that wait for the right moment
      if (maneuverQ === 'p01' && t - maneuverQT > 12) { maneuverQ = null; emitHold({ kind: 'p01', p: 0, none: true, t }); }

      // ---- triggering / breath scheduling during expiration
      if (phase === 'exp' || phase === 'ehold') {
        if (phase === 'ehold' && t >= holdEnd) {
          br.ptot = Pel(V) - pmus; phase = 'exp'; inspEnd = t - 0.3;
          emitHold({ kind: 'exp', p: br.ptot, t });
          if (!spontMode && !simv) startBreath('M');
        } else if (phase === 'exp') {
          const sinceIns = t - inspEnd;
          let fire = null;
          if (!P.disconnect && lastSample && sinceIns > 0.2 && S.mode !== 'APRV') {
            if (S.trig === 'flow' && lastSample.flow >= S.trig_f) fire = 'P';
            if (S.trig === 'pressure' && lastSample.paw <= peep + S.trig_p) fire = 'P';
          }
          if (maneuverQ === 'nif' && sinceIns > 0.6 && !P.disconnect) {
            maneuverQ = null; phase = 'occl'; occl = { kind: 'nif', t0: t, end: t + 8, p0: Pel(V), pmin: Pel(V) };
          } else if (manualQ && sinceIns > 0.3) {
            manualQ = false; startBreath(spontMode ? 'B' : 'M');
          } else if (fire) {
            const art = lastSample && lastSample.artTrig;
            if (spontMode) { backupActive = false; startBreath('P'); }
            else if (simv) { startBreath(simvDone ? 'S' : 'P'); simvDone = true; }
            else startBreath('P');
            br.artifactTrigger = !!art;
          } else if (simv) {
            if (holdQueue === 'exp' && !P.disconnect && sinceIns > 0.8) { holdQueue = null; phase = 'ehold'; holdEnd = t + 1.5; br.holdType = 'exp'; }
            // no effort in the cycle's mandatory window: deliver the mandatory breath on time
            else if (!simvDone && t >= simvCyc + 0.6 * (60 / Math.max(1, S.rr)) && sinceIns > 0.2) { simvDone = true; startBreath('M'); }
          } else if (!spontMode && t >= nextMandatory) {
            if (holdQueue === 'exp' && !P.disconnect) {
              holdQueue = null; phase = 'ehold'; holdEnd = t + 1.5; br.holdType = 'exp';
            } else startBreath('M');
          } else if (spontMode) {
            if (holdQueue === 'exp' && !P.disconnect && sinceIns > 0.8) { holdQueue = null; phase = 'ehold'; holdEnd = t + 1.5; br.holdType = 'exp'; }
            else if (!backupActive && t - lastBreathStart >= S.alarms.apnea) { backupActive = true; startBreath('B'); }
            else if (backupActive && t >= nextMandatory) startBreath('B');
          }
        }
      }

      const R = Rin(), Re = Rex();
      const tau = br ? t - br.start : 0;
      let fitPhase = null;

      if (P.disconnect) {
        // circuit open at the patient: airway at atmosphere; ventilator blows into the room
        const pPt = 0;
        const pal = Pel(V) - pmus;
        qp = (pPt - pal) / (pal > pPt ? Re : R);
        V = Math.max(0, V + qp * dt);
        let qv = 0;
        if (phase === 'insp' && br) {
          qv = br.mode === 'VC' ? br.vtSet / Math.max(0.2, br.ti) : 1.2;
          if (tau >= br.ti) endInspiration();
        } else if (phase === 'insp') phase = 'exp';
        paw = 0.4 + 0.6 * qv;
        qmeas = qv;
        if (phase === 'ihold' || phase === 'pause' || phase === 'occl') phase = 'exp';
      } else if (phase === 'insp') {
        fitPhase = 'i';
        const m = br.mode;
        if (m === 'VC') {
          const tflow = Math.max(0.15, br.ti * (1 - br.pause));
          let qset;
          if (br.flowPattern === 'decel') qset = (2 * br.vtSet / tflow) * Math.max(0, 1 - tau / tflow);
          else qset = br.vtSet / tflow;
          const pal = Pel(V) - pmus;
          qp = kL > 0 ? (qset - kL * pal) / (1 + kL * R) : qset;
          paw = pal + qp * R;
          V += qp * dt;
          qmeas = qset;
          if (tau >= tflow) { if (br.pause > 0) phase = 'pause'; else endInspiration(); }
        } else {
          // pressure-targeted: PC / PSV / PRVC / VS / APRV high / backup
          const rise = Math.max(0.01, S.rise || 0.01);
          const frac = clamp(tau / rise, 0, 1);
          let ptgt = peep + br.ptarget * (1 - Math.pow(1 - frac, 2));
          if (pmus < 0) ptgt += -pmus * 0.75;          // valve cannot vent an active expiratory push instantly
          paw = ptgt;
          // implicit Euler for V' = (paw - V/C - od + pmus)/R
          const od = odTerm(V);
          V = (V + dt * (paw - od + pmus) / R) / (1 + dt / (R * c));
          qp = (paw - Pel(V) + pmus) / R;
          if (m === 'APRV' && qp < 0) {                 // exhaling at P-high goes out through the active valve
            V = (V + dt * (paw - od + pmus) / Re) / (1 + dt / (Re * c)) ; qp = (paw - Pel(V) + pmus) / Re;
          }
          qmeas = qp + kL * paw;
          if (qp > br.qpk) br.qpk = qp;
          if (br.cycle === 'flow') {
            if (tau > 0.12 && br.qpk > 0.05 && qp <= (S.cycle / 100) * br.qpk) endInspiration();
            else if (tau > 0.12 && paw > peep + br.ptarget + 3) endInspiration();
            else if (tau >= 3.0) endInspiration();
          } else if (tau >= br.ti) endInspiration();
        }
      } else if (phase === 'pause' || phase === 'ihold' || phase === 'ehold' || phase === 'occl') {
        if (phase === 'pause') fitPhase = 'i';
        qp = 0;
        let pm = pmus;
        if (phase === 'occl' && occl && occl.kind === 'nif') pm = P.effort.on && P.effort.pmax > 0 ? (pmus / P.effort.pmax) * P.nif : 0;
        paw = Pel(V) - pm;
        qmeas = kL * paw;
        if (phase === 'pause' && tau >= br.ti) endInspiration();
        if (phase === 'ihold' && t >= holdEnd) {
          br.pplat = paw; phase = 'exp'; inspEnd = t;
          emitHold({ kind: 'insp', p: paw, vt: br.vtiPt * 1000, ppeak: br.ppeak, qEndIns: br.qEndIns, t });
        }
        if (phase === 'occl') {
          if (paw < occl.pmin) occl.pmin = paw;
          if (t >= occl.end) {
            const k = occl.kind;
            phase = 'exp'; inspEnd = t - 0.25;
            if (k === 'p01') emitHold({ kind: 'p01', p: Math.max(0, occl.p0 - paw), t });
            else { emitHold({ kind: 'nif', p: Math.min(0, occl.pmin - occl.p0), none: !(P.effort.on && P.effort.pmax > 0), t }); if (!spontMode && !simv) startBreath('M'); }
            occl = null;
          }
        }
      } else {
        // expiration — valve holds PEEP (APRV: P-low)
        fitPhase = 'e';
        const pal = Pel(V) - pmus;
        // expiratory flow limitation ("waterfall"): small airways close at pcrit, so the
        // alveolus empties toward max(PEEP, pcrit), not toward PEEP
        const dn = Math.max(peep, P.pcrit || 0);
        const od = odTerm(V);
        paw = peep;
        if (pal < peep && S.trig === 'pressure' && S.mode !== 'APRV') {
          // circuit closed (no bias flow): patient effort decompresses the circuit
          qp = 0; paw = pal;
        } else if (pal > dn) {
          V = (V + dt * (dn - od + pmus) / Re) / (1 + dt / (Re * c));
          qp = Math.min(0, (dn - Pel(V) + pmus) / Re);
        } else if (pal >= peep) {
          qp = 0;                                  // trapped behind closed airways
        } else {
          V = (V + dt * (peep - od + pmus) / R) / (1 + dt / (R * c));
          qp = Math.max(0, (peep - Pel(V) + pmus) / R);
        }
        qmeas = qp + kL * paw;
      }

      if (V < 0) V = 0;

      // ---- measured signals
      const art = artifacts(t, Math.abs(qmeas) * 60);
      const pawM = paw + art.pa;
      const flowM = (qmeas + art.fa) * 60;                 // L/min
      vdisp += (qmeas + art.fa) * dt * 1000;               // mL
      const cs = splitNow();
      const pplLike = V / (cs.ccw / 1000) - pmus;
      const pes = P.pes0 + pplLike;

      // ---- breath accounting
      let co2 = lastCo2;
      if (br) {
        const inIns = phase === 'insp' || phase === 'pause' || phase === 'ihold';
        if (inIns) {
          br.vtiDel += Math.max(0, qmeas) * dt;
          br.vtiPt += Math.max(0, qp) * dt;
          if (phase === 'insp' && pawM > br.ppeak) br.ppeak = pawM;
          if (phase === 'insp' && t - br.start > 0.1 && paw < br.pminIns) br.pminIns = paw;
          br.hiSum += pawM; br.hiN++;
          co2 = 0;
        } else if (!P.disconnect) {
          br.vte += Math.max(0, -qp) * dt;
          if (phase === 'exp') {
            br.vex += Math.max(0, -qp) * dt; br.loSum += pawM; br.loN++;
            const x = br.vex / anat(), vtRef = Math.max(anat() * 1.6, lastVt);
            co2 = x < 0.5 ? 0 : x < 1.3 ? 0.85 * (x - 0.5) / 0.8 : 0.85 + 0.15 * clamp((br.vex - 1.3 * anat()) / (vtRef - 1.3 * anat()), 0, 1);
          }
        } else co2 = 0;
        if (pmus > br.pmusMax) br.pmusMax = pmus;
        if (qp > 0 && pmus > 0) br.wob += pmus * qp * dt;
        if (vdisp / 1000 > br.vmax && inIns) br.vmax = vdisp / 1000;
        br.psum += pawM; br.n++;
        if ((br.mode === 'VC' || br.mode === 'PRVC') && phase === 'insp' && pawM >= S.alarms.paw_hi && !ppeakLimitHit) {
          ppeakLimitHit = true; br.highP = true; endInspiration();
        }
        if (++br.ptsK % 3 === 0 && br.pts.length < 1500) br.pts.push([pawM, flowM, vdisp]);
        if (fitPhase && !P.disconnect && (++br.fitK % 2 === 0) && br.fitX.length < 2000) {
          const q = flowM / 60, v = vdisp / 1000;
          br.fitX.push([v, fitPhase === 'i' ? q : 0, fitPhase === 'e' ? q : 0, 1]); br.fitY.push(pawM);
          if (fitPhase === 'i' && t - br.start > 0.1 && br.insX.length < 1000) { br.insX.push([v, v * v, q, 1]); br.insY.push(pawM); }
        }
      }
      if (br && phase === 'exp' && lastSample && lastSample.phase !== 'exp') lastVt = Math.max(0.05, br.vtiPt);
      lastCo2 = co2;

      const artTrig = (S.trig === 'flow' && qmeas * 60 < S.trig_f && flowM >= S.trig_f) ||
                      (S.trig === 'pressure' && paw > peep + S.trig_p && pawM <= peep + S.trig_p);
      lastSample = {
        t, paw: pawM, flow: flowM, vol: vdisp, pes, ptp: pawM - pes, pmus, co2,
        palv: Pel(V) - pmus, phase, breath: br ? br.idx : -1, artTrig
      };
      return lastSample;
    }

    // mark breath starts on the sample stream
    let markIdx = -1;
    function advance(seconds, onSample) {
      const n = Math.max(1, Math.round(seconds / dt));
      for (let i = 0; i < n; i++) {
        const s = step();
        if (br && br.idx !== markIdx) { markIdx = br.idx; s.mark = br.type; }
        if (onSample) onSample(s);
      }
      return lastSample;
    }

    return {
      dt,
      get t() { return t; },
      get settings() { return pending || S; },
      get activeSettings() { return S; },
      get patient() { return P; },
      get phase() { return phase; },
      get lastBreath() { return lastBreath; },
      get breaths() { return breaths; },
      get efforts() { return efforts; },
      get holdQueued() { return holdQueue; },
      get prvcPinsp() { return prvcP; },
      get vsPinsp() { return vsP; },
      get maneuverQueued() { return maneuverQ; },
      get occlusion() { return occl; },
      get recruit() { return { cf, ...rec }; },
      setSettings(s) { pending = normSettings(s); if (!br) { S = pending; pending = null; } },
      setSettingsNow(s) { S = normSettings(s); pending = null; },
      setPatient(p) {
        const prevC = C();
        P = normPatient(p);
        if (!P.effort.on) curEffort = null;
        // keep volume physically continuous when compliance changes
        void prevC;
      },
      queueHold(kind) { holdQueue = kind === 'exp' ? 'exp' : 'insp'; },
      cancelHold() { holdQueue = null; },
      manualBreath() { manualQ = true; },
      queueManeuver(kind) { maneuverQ = kind === 'nif' ? 'nif' : 'p01'; maneuverQT = t; },
      onBreath(fn) { listeners.push(fn); },
      onHold(fn) { holdListeners.push(fn); },
      advance,
      step
    };
  }

  // ------------------------------------------------------------------ metrics over a window
  function computeMetrics(sim, fromT, toT) {
    const S = sim.activeSettings, P = sim.patient;
    const bs = sim.breaths.filter(b => b.t0 >= fromT && b.t0 + b.ttot <= toT + 1e-6);
    const span = Math.max(1, toT - fromT) / 60;   // minutes
    const avg = (f, list) => { const L = (list || bs).map(f).filter(v => v != null && isFinite(v)); return L.length ? L.reduce((a, b) => a + b, 0) / L.length : null; };
    const max = f => { const L = bs.map(f).filter(v => v != null && isFinite(v)); return L.length ? Math.max(...L) : null; };
    const covered = bs.length ? (bs[bs.length - 1].t0 + bs[bs.length - 1].ttot - bs[0].t0) : 0;
    const rrActual = covered > 0 ? (bs.length / covered) * 60 : 0;
    const vte = avg(b => b.vte), vtPt = avg(b => b.vtiPt), vti = avg(b => b.vti);
    const ptot = avg(b => b.ptotTrue), pplat = avg(b => b.pplatTrue);
    const effs = sim.efforts.filter(e => e.start >= fromT && e.start + e.ti <= toT);
    const effOn = P.effort && P.effort.on;
    const missed = effOn ? effs.filter(e => e.breaths.length === 0 && (e.onsetPhase === 'exp' || e.onsetPhase === 'ehold')).length : 0;
    const dbl = effOn ? effs.filter(e => e.breaths.length >= 2).length : 0;
    const falseTrig = bs.filter(b => b.falseTrigger).length;
    const peepS = peepOf(S);
    const rec = recruitState(P, ptot != null ? ptot : peepS);
    const g = gasExchange({
      vt: vtPt || 0, rr: rrActual, vd: P.vd + rec.vdExtra, fio2: S.fio2, hco3: P.hco3, vco2: P.vco2,
      shunt: rec.shunt, hb: P.hb, vo2: P.vo2, co: P.co, pbw: pbw(P)
    });
    const w = pbw(P);
    const m = {
      breaths: bs.length, rr_actual: rrActual,
      vte, vti, vt_patient: vtPt, vt_per_kg: vtPt != null ? vtPt / w : null, pbw: w,
      ppeak: avg(b => b.ppeak), ppeak_max: max(b => b.ppeak), pmean: avg(b => b.pmean),
      pplat, peep_tot: ptot, auto_peep: ptot != null ? ptot - peepS : null,
      driving_p: pplat != null && ptot != null ? pplat - ptot : null,
      cstat: pplat != null && ptot != null && pplat - ptot > 0.5 ? vtPt / (pplat - ptot) : null,
      mv: vte != null ? (vte * rrActual) / 1000 : null,
      ti: avg(b => b.ti), te: avg(b => b.te), ie: avg(b => b.ie),
      end_exp_flow: avg(b => b.endExpFlow),
      leak_pct: vti ? clamp((1 - vte / vti) * 100, 0, 100) : 0,
      pinsp_used: avg(b => b.pinsp),
      scoop: avg(b => b.scoop), overshoot: avg(b => b.overshoot),
      false_trig_min: falseTrig / span, missed_min: missed / span, double_min: dbl / span,
      high_p_breaths: bs.filter(b => b.highP).length,
      patient_trig_frac: bs.length ? bs.filter(b => b.type === 'P' || b.type === 'S').length / bs.length : 0,
      fio2: S.fio2, peep: peepS, mode: S.mode, mode_label: modeLabel(S),
      rsbi: vtPt ? rrActual / (vtPt / 1000) : null,
      ...g
    };
    // spontaneous breathing, estimated mechanics and the rest of the monitored set
    const sp = bs.filter(b => b.spont);
    m.rr_spont = S.mode === 'APRV' ? (effOn ? P.effort.rate : 0) : (covered > 0 ? (sp.length / covered) * 60 : 0);
    m.mv_spont = covered > 0 ? (sp.reduce((a, b) => a + b.vte, 0) / covered) * 60 / 1000 : 0;
    m.ti_spont = avg(b => b.ti, sp);
    m.duty = avg(b => b.ti / b.ttot);
    m.c_est = avg(b => b.cEst); m.r_est = avg(b => b.rEst); m.re_est = avg(b => b.reEst);
    m.peepi_est = avg(b => b.peepiEst); m.pplat_est = avg(b => b.pplatEst); m.pdriving_est = avg(b => b.pdrivingEst);
    m.c20c = avg(b => b.c20c);
    m.tce = m.re_est != null && m.c_est != null ? (m.re_est * m.c_est) / 1000 : null;
    const dp = m.pdriving_est != null ? m.pdriving_est : m.driving_p;
    m.mech_power = vtPt != null && m.ppeak != null && dp != null ? 0.098 * rrActual * (vtPt / 1000) * (m.ppeak - 0.5 * dp) : null;
    m.pmus = effOn ? avg(b => b.pmusMax) : 0;
    m.wob_pt = effOn && covered > 0 ? 0.098 * (bs.reduce((a, b) => a + b.wob, 0) / covered) * 60 : 0;
    m.p01 = p01Of(P.effort);
    m.nif = effOn && P.effort.pmax > 0 ? -P.nif : 0;
    m.leak_peep = P.leak > 0 ? (P.leak / 10) * peepS : 0;
    m.vleak = vti != null && vte != null ? Math.max(0, vti - vte) : null;
    m.rsbi_kg = m.rsbi != null && m.vt_per_kg ? rrActual / m.vt_per_kg : null;
    m.ph_mean = S.mode === 'APRV' ? avg(b => b.phMean) : null;
    m.pl_mean = S.mode === 'APRV' ? avg(b => b.plMean) : null;
    m.th_tl = S.mode === 'APRV' ? S.thigh / Math.max(0.05, S.tlow) : null;
    m.vco2 = P.vco2; m.pr = P.hr; m.pi = P.pi;
    m.pinsp_adaptive = S.mode === 'PRVC' ? sim.prvcPinsp : S.mode === 'VS' ? sim.vsPinsp : null;
    return m;
  }

  // run a fresh simulation: warm up to steady state, then record a window
  function simulate(settings, patient, opts) {
    opts = opts || {};
    const warm = opts.warmup != null ? opts.warmup : 40, secs = opts.seconds || 20;
    const sim = createSim(settings, patient, { seed: opts.seed || 11 });
    sim.advance(warm);
    const samples = [];
    const every = Math.max(1, Math.round((opts.sampleDt || 0.01) / sim.dt));
    let k = 0;
    const t0 = sim.t;
    sim.advance(secs, s => {
      if (k++ % every === 0 || s.mark) samples.push({ t: s.t - t0, paw: s.paw, flow: s.flow, vol: s.vol, pes: s.pes, ptp: s.ptp, pmus: s.pmus, co2: s.co2, breath: s.breath, mark: s.mark || null, phase: s.phase });
    });
    const metrics = computeMetrics(sim, t0, sim.t);
    return { samples, metrics, breaths: sim.breaths.filter(b => b.t0 >= t0), sim };
  }

  // ------------------------------------------------------------------ alarms from a rolling window
  function alarmsFor(metrics, S, P, extra) {
    const a = [], L = S.alarms;
    extra = extra || {};
    if (P.disconnect) a.push({ level: 'high', text: 'CIRCUIT DISCONNECT' });
    if (metrics.ppeak_max != null && metrics.ppeak_max >= L.paw_hi) a.push({ level: 'high', text: 'HIGH PRESSURE' });
    if (!P.disconnect && metrics.ppeak != null && metrics.ppeak < L.paw_lo) a.push({ level: 'high', text: 'LOW PRESSURE' });
    if (metrics.vte != null && metrics.vte < L.vte_lo) a.push({ level: 'med', text: 'LOW VTe' });
    if (metrics.vte != null && metrics.vte > L.vte_hi) a.push({ level: 'med', text: 'HIGH VTe' });
    if (metrics.mv != null && metrics.mv < L.mv_lo) a.push({ level: 'high', text: 'LOW MINUTE VOLUME' });
    if (metrics.mv != null && metrics.mv > L.mv_hi) a.push({ level: 'med', text: 'HIGH MINUTE VOLUME' });
    if (metrics.rr_actual > L.rr_hi) a.push({ level: 'med', text: 'HIGH RESP RATE' });
    if (extra.apnea) a.push({ level: 'high', text: 'APNEA — BACKUP VENTILATION' });
    if (metrics.leak_pct > 20 && !P.disconnect) a.push({ level: 'med', text: 'LEAK' });
    return a;
  }

  return {
    DEFAULT_SETTINGS, DEFAULT_PATIENT, PRESETS,
    normSettings, normPatient, deepMerge, pbw, splitCompliance, recruitState, gasExchange, isSpontMode, peepOf, modeLabel, lsq, p01Of,
    createSim, simulate, computeMetrics, alarmsFor, clamp
  };
}));
