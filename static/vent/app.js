/* Vent Lab UI — bedside-sim. Uses VentEngine (physiology) and VentCurriculum (cases, tutorials, grader). */
(function () {
  'use strict';
  const E = window.VentEngine, CUR = window.VentCurriculum;
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (v, dp) => (v == null || !isFinite(v) ? '—' : (+v).toFixed(dp || 0));
  const clone = o => JSON.parse(JSON.stringify(o));
  const paras = t => String(t || '').split(/\n\n+/).map(p => `<p>${esc(p)}</p>`).join('');
  const store = {
    get(k, d) { try { const v = localStorage.getItem('ventlab.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('ventlab.' + k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } }
  };
  function toast(msg) {
    const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; t.setAttribute('role', 'status');
    document.body.appendChild(t); setTimeout(() => t.remove(), 2600);
  }

  // ================================================================== state
  const App = {
    view: 'curriculum', settings: null, patient: null, sim: null, running: true,
    show: { pes: false, pmus: false }, lock: [], patientLocked: false,
    caseObj: null, cs: null, tut: null, tutStep: 0, tutDone: {},
    hold: {}, pinned: null, lastBreath: null, preset: 'normal', freeBase: null,
    changedSettings: {}, lastPtpExp: null, lastPtpHold: null
  };
  const listeners = {};
  function emit(ev, v) { (listeners[ev] || []).forEach(fn => fn(v)); tutorialEvent(ev, v); }

  // ================================================================== display buffer
  const D = { W: 12, DT: 0.02, N: 600, head: 0, nextT: 0, pendingMark: 0 };
  const CH_KEYS = ['paw', 'flow', 'vol', 'pes', 'ptp', 'pmus'];
  function resetBuffer(W) {
    D.W = W || D.W; D.N = Math.round(D.W / D.DT);
    for (const k of CH_KEYS) { D[k] = new Float32Array(D.N); D[k].fill(NaN); }
    D.mark = new Uint8Array(D.N); D.ins = new Uint8Array(D.N);
    D.head = 0; D.nextT = 0; D.pendingMark = 0;
  }
  function onSample(s) {
    if (s.mark === 'P') D.pendingMark = 1; else if (s.mark === 'B') D.pendingMark = 2;
    if (s.phase === 'insp' && App._prevSample && (App._prevPhase === 'exp' || App._prevPhase === 'ehold')) App.lastPtpExp = App._prevSample.ptp;
    if (s.phase === 'ihold') App._ptpHoldNow = s.ptp;
    if (App._prevPhase === 'ihold' && s.phase !== 'ihold' && App._ptpHoldNow != null) { App.lastPtpHold = App._ptpHoldNow; App._ptpHoldNow = null; }
    App._prevPhase = s.phase; App._prevSample = s;
    if (s.t < D.nextT) return;
    D.nextT = s.t + D.DT - 1e-9;
    const i = Math.floor((s.t % D.W) / D.DT) % D.N;
    D.paw[i] = s.paw; D.flow[i] = s.flow; D.vol[i] = s.vol; D.pes[i] = s.pes; D.ptp[i] = s.ptp; D.pmus[i] = s.pmus;
    D.mark[i] = D.pendingMark; D.pendingMark = 0;
    D.ins[i] = (s.phase === 'insp' || s.phase === 'pause' || s.phase === 'ihold') ? 1 : 0;
    const gap = Math.round(0.35 / D.DT);
    for (let g = 1; g <= gap; g++) { const j = (i + g) % D.N; for (const k of CH_KEYS) D[k][j] = NaN; D.mark[j] = 0; D.ins[j] = 0; }
    D.head = i;
  }

  // ================================================================== simulator lifecycle
  function load(settings, patient, opts) {
    opts = opts || {};
    App.settings = E.normSettings(settings);
    App.patient = E.normPatient(patient);
    App.sim = E.createSim(App.settings, App.patient, { seed: 5 });
    App.sim.onBreath(onBreath);
    App.sim.onHold(onHold);
    App.hold = {}; App.lastBreath = null; App.lastPtpExp = null; App.lastPtpHold = null; App.changedSettings = {};
    App._prevPhase = null; App._prevSample = null;
    resetBuffer();
    App.sim.advance(opts.warm != null ? opts.warm : 24);
    App.sim.advance(D.W, onSample);
    App.frozen = false; $('#freezeBtn').setAttribute('aria-pressed', 'false');
    renderControls(); renderPatient(); renderAlarmKnobs(); updateMonitor(); drawLoops();
  }
  function onBreath(b) { App.lastBreath = b; }
  function onHold(h) {
    if (h.kind === 'insp') { App.hold.pplat = h.p; App.hold.pplatT = h.t; App.hold.vt = h.vt; App._flash = 'pplat'; }
    else { App.hold.ptot = h.p; App.hold.ptotT = h.t; App._flash = 'ptot'; }
    App._holdEvent = h.kind;
  }
  function setSetting(k, v) {
    App.settings[k] = v;
    App.changedSettings[k] = true;
    App.sim.setSettings(App.settings);
    App.hold.fresh = false;
    if (k === 'mode') emit('mode', v);
    renderControls();
  }
  function setPatient(path, v) {
    const parts = path.split('.');
    let o = App.patient; for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]];
    o[parts[parts.length - 1]] = v;
    App.sim.setPatient(App.patient);
    App.hold.fresh = false;
    renderPatient();
  }

  // ================================================================== control definitions
  const K = {
    vt: { l: 'Tidal volume', u: 'mL', st: 10, mn: 100, mx: 1200 },
    rr: { l: 'Rate', u: '/min', st: 1, mn: 4, mx: 40 },
    peep: { l: 'PEEP', u: 'cmH₂O', st: 1, mn: 0, mx: 25 },
    fio2: { l: 'FiO₂', u: '', st: 0.05, mn: 0.21, mx: 1, dp: 2 },
    ti: { l: 'Insp. time', u: 's', st: 0.05, mn: 0.3, mx: 3, dp: 2 },
    pause: { l: 'Pause', u: '% Ti', st: 5, mn: 0, mx: 50 },
    pinsp: { l: 'Pinsp', u: 'above PEEP', st: 1, mn: 2, mx: 50 },
    psupport: { l: 'Pressure support', u: 'above PEEP', st: 1, mn: 0, mx: 40 },
    rise: { l: 'Rise time', u: 's', st: 0.05, mn: 0.05, mx: 0.6, dp: 2 },
    cycle: { l: 'Exp. trigger', u: '% peak flow', st: 5, mn: 5, mx: 80 },
    trig_f: { l: 'Flow trigger', u: 'L/min', st: 0.5, mn: 0.5, mx: 15, dp: 1 },
    trig_p: { l: 'Pressure trigger', u: 'cmH₂O', st: 0.5, mn: -15, mx: -0.5, dp: 1 }
  };
  const MODE_KNOBS = {
    VC: ['vt', 'rr', 'peep', 'fio2', 'ti', 'pause'],
    PC: ['pinsp', 'rr', 'peep', 'fio2', 'ti', 'rise'],
    PSV: ['psupport', 'peep', 'fio2', 'cycle', 'rise'],
    PRVC: ['vt', 'rr', 'peep', 'fio2', 'ti', 'rise']
  };
  const BK = { 'backup.pinsp': { l: 'Backup Pinsp', u: 'above PEEP', st: 1, mn: 2, mx: 40 }, 'backup.rr': { l: 'Backup rate', u: '/min', st: 1, mn: 4, mx: 30 }, 'backup.ti': { l: 'Backup Ti', u: 's', st: 0.05, mn: 0.4, mx: 2, dp: 2 } };
  const AK = {
    'alarms.paw_hi': { l: 'High pressure', u: 'cmH₂O', st: 1, mn: 15, mx: 70 }, 'alarms.paw_lo': { l: 'Low pressure', u: 'cmH₂O', st: 1, mn: 1, mx: 30 },
    'alarms.vte_lo': { l: 'Low VTe', u: 'mL', st: 10, mn: 50, mx: 800 }, 'alarms.vte_hi': { l: 'High VTe', u: 'mL', st: 10, mn: 300, mx: 2000 },
    'alarms.mv_lo': { l: 'Low MV', u: 'L/min', st: 0.5, mn: 0.5, mx: 15, dp: 1 }, 'alarms.mv_hi': { l: 'High MV', u: 'L/min', st: 0.5, mn: 5, mx: 40, dp: 1 },
    'alarms.rr_hi': { l: 'High rate', u: '/min', st: 1, mn: 10, mx: 70 }, 'alarms.apnea': { l: 'Apnea time', u: 's', st: 5, mn: 10, mx: 60 }
  };
  const PK = {
    c: { l: 'Compliance (Crs)', u: 'mL/cmH₂O', st: 1, mn: 5, mx: 120 },
    r: { l: 'Resistance', u: 'cmH₂O/L/s', st: 1, mn: 2, mx: 60 },
    rexp: { l: 'Exp. resistance ×', u: 'of insp.', st: 0.1, mn: 1, mx: 3, dp: 1 },
    pcrit: { l: 'Airway closure', u: 'cmH₂O (0 = off)', st: 1, mn: 0, mx: 15 },
    vd: { l: 'Dead space', u: 'mL', st: 10, mn: 50, mx: 500 },
    hco3: { l: 'HCO₃', u: 'mEq/L', st: 1, mn: 10, mx: 45 },
    shunt: { l: 'Shunt', u: 'fraction', st: 0.01, mn: 0, mx: 0.7, dp: 2 },
    od_ml: { l: 'Overdistension above', u: 'mL (0 = off)', st: 50, mn: 0, mx: 2000 },
    ccw: { l: 'Chest wall C', u: 'mL/cmH₂O', st: 5, mn: 20, mx: 400 },
    pes0: { l: 'Pes at rest', u: 'cmH₂O', st: 1, mn: 0, mx: 25 },
    height_cm: { l: 'Height', u: 'cm', st: 1, mn: 130, mx: 210 },
    'effort.pmax': { l: 'Effort (Pmus)', u: 'cmH₂O', st: 1, mn: 0, mx: 20 },
    'effort.rate': { l: 'Effort rate', u: '/min', st: 1, mn: 4, mx: 45 },
    'effort.ti': { l: 'Neural Ti', u: 's', st: 0.1, mn: 0.3, mx: 2.5, dp: 1 },
    'effort.push': { l: 'Active exhalation', u: 'cmH₂O', st: 1, mn: 0, mx: 12 },
    leak: { l: 'Leak', u: 'L/min at 10 cmH₂O', st: 1, mn: 0, mx: 30 },
    hr: { l: 'Heart rate', u: '/min', st: 1, mn: 40, mx: 160 },
    'recruit.popt': { l: 'Best PEEP', u: 'cmH₂O', st: 1, mn: 4, mx: 24 }
  };
  const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);

  function knobHTML(id, def, val, opts) {
    opts = opts || {};
    const dp = def.dp != null ? def.dp : 0;
    const dis = opts.locked ? 'disabled' : '';
    return `<div class="knob${opts.changed ? ' changed' : ''}${opts.locked ? ' locked' : ''}" data-k="${esc(id)}" data-g="${opts.g || 's'}">
      <div class="kl"><span>${esc(def.l)}</span>${opts.locked ? '<span title="Fixed for this case">locked</span>' : ''}</div>
      <div class="kv"><button type="button" data-d="-1" aria-label="Decrease ${esc(def.l)}" ${dis}>−</button>
      <input id="k-${opts.g || 's'}-${esc(id)}" inputmode="decimal" value="${fmt(val, dp)}" aria-label="${esc(def.l)}" ${dis}>
      <button type="button" data-d="1" aria-label="Increase ${esc(def.l)}" ${dis}>+</button></div>
      <div class="kl"><span>${esc(def.u)}</span></div></div>`;
  }
  function segHTML(id, label, options, val, locked, g) {
    return `<div class="knob${locked ? ' locked' : ''}"><div class="kl"><span>${esc(label)}</span>${locked ? '<span>locked</span>' : ''}</div>
      <div class="seg" role="group" aria-label="${esc(label)}">${options.map(([v, t]) => `<button type="button" data-seg="${esc(id)}" data-g="${g || 's'}" data-v="${esc(v)}" aria-pressed="${String(v) === String(val)}" ${locked ? 'disabled' : ''}>${esc(t)}</button>`).join('')}</div></div>`;
  }

  function renderControls() {
    const S = App.settings, L = App.lock;
    $$('#modeTabs button').forEach(b => { b.setAttribute('aria-pressed', String(b.dataset.mode === S.mode)); b.disabled = L.includes('mode') && b.dataset.mode !== S.mode; });
    $('#modeTag').textContent = { VC: 'A/C · VC', PC: 'A/C · PC', PSV: 'PSV', PRVC: 'A/C · PRVC' }[S.mode];
    let h = MODE_KNOBS[S.mode].map(k => knobHTML(k, S.mode === 'PRVC' && k === 'vt' ? { ...K.vt, l: 'Target VT' } : K[k], S[k], { locked: L.includes(k), changed: App.changedSettings[k] })).join('');
    if (S.mode === 'VC') h += segHTML('flow', 'Flow pattern', [['square', 'Square'], ['decel', 'Decel']], S.flow, L.includes('flow'));
    h += segHTML('trig', 'Trigger', [['flow', 'Flow'], ['pressure', 'Pressure']], S.trig, L.includes('trig'));
    h += S.trig === 'flow' ? knobHTML('trig_f', K.trig_f, S.trig_f, { locked: L.includes('trig_f'), changed: App.changedSettings.trig_f })
      : knobHTML('trig_p', K.trig_p, S.trig_p, { locked: L.includes('trig_p'), changed: App.changedSettings.trig_p });
    $('#knobs').innerHTML = h;
    $('#knobs2').innerHTML = S.mode === 'PSV'
      ? `<div class="subhead">Apnea backup (pressure control)</div><div class="knobs">${Object.keys(BK).map(k => knobHTML(k, BK[k], getPath(S, k), { locked: L.includes('backup') })).join('')}</div>`
      : '';
    $('#eholdBtn').disabled = S.mode === 'PSV';
    $('#eholdBtn').title = S.mode === 'PSV' ? 'Expiratory hold needs a mandatory breath; use VC, PC or PRVC' : '';
  }
  function renderAlarmKnobs() {
    $('#alarmKnobs').innerHTML = Object.keys(AK).map(k => knobHTML(k, AK[k], getPath(App.settings, k), { g: 'a' })).join('');
  }
  function renderPatient() {
    const P = App.patient, lk = App.patientLocked;
    const knob = k => knobHTML(k, PK[k], getPath(P, k), { g: 'p', locked: lk });
    const tog = (path, label) => `<label class="tog"><input type="checkbox" data-pt="${path}" ${getPath(P, path) ? 'checked' : ''} ${lk ? 'disabled' : ''}> ${esc(label)}</label>`;
    const pbw = E.pbw(P);
    $('#patientBody').innerHTML = `
      ${lk ? '<p class="lockednote">The patient is fixed by this case. You change the ventilator.</p>' : ''}
      <div class="subhead">Size</div>
      <div class="knobs">${segHTML('sex', 'Sex', [['M', 'Male'], ['F', 'Female']], P.sex, lk, 'p')}${knob('height_cm')}
        <div class="knob"><div class="kl"><span>Predicted body weight</span></div><div class="kv"><input value="${fmt(pbw, 1)}" disabled aria-label="Predicted body weight"></div><div class="kl"><span>kg · 6 mL/kg = ${fmt(pbw * 6, 0)} mL</span></div></div></div>
      <div class="subhead">Mechanics</div>
      <div class="knobs">${['c', 'r', 'rexp', 'pcrit', 'od_ml', 'ccw', 'pes0'].map(knob).join('')}
        <div class="knob"><div class="kl"><span>Exp. time constant</span></div><div class="kv"><input value="${fmt(P.c / 1000 * P.r * (P.rexp || 1), 2)}" disabled aria-label="Expiratory time constant"></div><div class="kl"><span>s (R × C)</span></div></div></div>
      <div class="subhead">Gas exchange</div>
      <div class="knobs">${['vd', 'hco3', 'shunt'].map(knob).join('')}</div>
      <div class="subhead">Breathing effort</div>
      <div class="toggles">${tog('effort.on', 'Patient makes breathing efforts')}</div>
      <div class="knobs">${['effort.pmax', 'effort.rate', 'effort.ti', 'effort.push'].map(knob).join('')}</div>
      <div class="subhead">Problems</div>
      <div class="toggles">${tog('recruit.on', 'Recruitable lung (compliance changes with PEEP)')}${tog('cardiac', 'Cardiac oscillations')}${tog('secretions', 'Secretions / water in circuit')}${tog('disconnect', 'Circuit disconnected')}</div>
      <div class="knobs">${['leak', 'hr', 'recruit.popt'].map(knob).join('')}</div>`;
  }

  function stepValue(def, cur, dir) {
    const st = def.st; let v = Math.round((cur + dir * st) / st) * st;
    v = Math.min(def.mx, Math.max(def.mn, v));
    return +v.toFixed(def.dp != null ? def.dp : 2);
  }
  function applyKnob(g, k, v) {
    if (g === 's') { if (k.startsWith('backup.')) { App.settings.backup[k.split('.')[1]] = v; App.sim.setSettings(App.settings); renderControls(); } else setSetting(k, v); }
    else if (g === 'a') { App.settings.alarms[k.split('.')[1]] = v; App.sim.setSettings(App.settings); renderAlarmKnobs(); }
    else if (g === 'p') setPatient(k, v);
  }
  function defFor(g, k) { return g === 's' ? (K[k] || BK[k]) : g === 'a' ? AK[k] : PK[k]; }
  function curFor(g, k) { return g === 'p' ? getPath(App.patient, k) : getPath(App.settings, k); }
  document.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b || b.disabled) return;
    const kn = b.closest('.knob');
    if (b.dataset.d && kn) { const g = kn.dataset.g, k = kn.dataset.k, def = defFor(g, k); applyKnob(g, k, stepValue(def, +curFor(g, k), +b.dataset.d)); return; }
    if (b.dataset.seg) {
      const g = b.dataset.g, k = b.dataset.seg, v = b.dataset.v;
      if (g === 'p') setPatient(k, v); else setSetting(k, v);
      return;
    }
    if (b.dataset.mode) { if (!App.lock.includes('mode')) setSetting('mode', b.dataset.mode); return; }
  });
  document.addEventListener('change', e => {
    const i = e.target;
    if (i.matches('.kv input')) {
      const kn = i.closest('.knob'), g = kn.dataset.g, k = kn.dataset.k, def = defFor(g, k);
      let v = parseFloat(String(i.value).replace(',', '.'));
      if (!isFinite(v)) { i.value = fmt(curFor(g, k), def.dp || 0); return; }
      v = Math.min(def.mx, Math.max(def.mn, v));
      applyKnob(g, k, +v.toFixed(def.dp != null ? def.dp : 2));
    } else if (i.dataset.pt) setPatient(i.dataset.pt, i.checked);
  });

  // ================================================================== holds, freeze, toggles
  $('#iholdBtn').onclick = () => { App.sim.queueHold('insp'); App._holdQ = 'insp'; updateHoldBtns(); };
  $('#eholdBtn').onclick = () => { App.sim.queueHold('exp'); App._holdQ = 'exp'; updateHoldBtns(); };
  function updateHoldBtns() {
    const q = App.sim && App.sim.holdQueued;
    $('#iholdBtn').classList.toggle('queued', q === 'insp'); $('#eholdBtn').classList.toggle('queued', q === 'exp');
    $('#iholdBtn').textContent = q === 'insp' ? 'Hold on next breath…' : 'Inspiratory hold';
    $('#eholdBtn').textContent = q === 'exp' ? 'Hold at end of exhalation…' : 'Expiratory hold';
  }
  $('#freezeBtn').onclick = () => { App.frozen = !App.frozen; $('#freezeBtn').setAttribute('aria-pressed', String(App.frozen)); $('#freezeBtn').textContent = App.frozen ? 'Run' : 'Freeze'; App.cursor = null; };
  $('#pmusBtn').onclick = () => { App.show.pmus = !App.show.pmus; syncShow(); };
  $('#pesBtn').onclick = () => { App.show.pes = !App.show.pes; syncShow(); emit('pes'); };
  $('#sweepBtn').onclick = () => { const W = D.W === 12 ? 20 : D.W === 20 ? 6 : 12; resetBuffer(W); $('#sweepBtn').textContent = W + ' s'; };
  function syncShow() {
    $('#pmusBtn').setAttribute('aria-pressed', String(App.show.pmus));
    $('#pesBtn').setAttribute('aria-pressed', String(App.show.pes));
    $('#wave').classList.toggle('tall', App.show.pes);
    sizeCanvases(); App._monitorDirty = true;
  }
  $('#pinLoop').onclick = () => { if (App.lastBreath) { App.pinned = clone(App.lastBreath.pts); $('#clearLoop').hidden = false; drawLoops(); emit('pin'); } };
  $('#clearLoop').onclick = () => { App.pinned = null; $('#clearLoop').hidden = true; drawLoops(); };

  // ================================================================== monitor + ABG + alarms
  function rolling(n) {
    const bs = App.sim.breaths; if (bs.length < 2) return null;
    const from = bs[Math.max(0, bs.length - n)].t0 - 1e-6;
    return E.computeMetrics(App.sim, from, App.sim.t);
  }
  function updateMonitor() {
    const sim = App.sim; if (!sim) return;
    const b = App.lastBreath, S = App.settings, m = rolling(4), g = rolling(12) || m;
    const h = App.hold, now = sim.t;
    const ptot = h.ptot != null && now - h.ptotT < 120 ? h.ptot : null;
    const pplat = h.pplat != null && now - h.pplatT < 120 ? h.pplat : null;
    const peepRef = ptot != null ? ptot : S.peep;
    const cst = pplat != null && h.vt ? h.vt / Math.max(0.5, pplat - peepRef) : null;
    const pbw = E.pbw(App.patient);
    const tiles = [
      ['paw', 'Ppeak', fmt(b && b.ppeak, 0), 'cmH₂O'],
      ['paw', 'Pmean', fmt(b && b.pmean, 0), 'cmH₂O'],
      ['paw', 'PEEP set', fmt(S.peep, 0), 'cmH₂O'],
      ['paw' + (pplat == null ? ' stale' : '') + (App._flash === 'pplat' ? ' flash' : ''), 'Pplat (hold)', pplat != null ? fmt(pplat, 1) : 'hold', pplat != null ? 'cmH₂O' : ''],
      ['paw' + (ptot == null ? ' stale' : '') + (App._flash === 'ptot' ? ' flash' : ''), 'Total PEEP', ptot != null ? fmt(ptot, 1) : 'hold', ptot != null ? 'cmH₂O' : ''],
      ['paw' + (ptot == null ? ' stale' : ''), 'Auto-PEEP', ptot != null ? fmt(Math.max(0, ptot - S.peep), 1) : 'hold', ptot != null ? 'cmH₂O' : ''],
      ['vol', 'VTi', fmt(b && b.vti, 0), 'mL'],
      ['vol', 'VTe', fmt(b && b.vte, 0), 'mL'],
      ['vol', 'VTe / PBW', fmt(b && b.vte / pbw, 1), 'mL/kg'],
      ['vol', 'MVe', fmt(m && m.mv, 1), 'L/min'],
      ['flw', 'Rate total', fmt(m && m.rr_actual, 0), '/min'],
      ['flw', 'I:E', b ? '1:' + fmt(b.ie, 1) : '—', ''],
      ['flw', 'Ti', fmt(b && b.ti, 2), 's'],
      ['flw', 'Peak flow', fmt(b && Math.max(...b.pts.map(p => p[1]), 0), 0), 'L/min']
    ];
    if (S.mode === 'PRVC') tiles.push(['paw', 'Pinsp in use', fmt(sim.prvcPinsp, 0), 'cmH₂O']);
    if (cst != null) tiles.push(['vol', 'Cstat' + (ptot == null ? ' (set PEEP)' : ''), fmt(cst, 0), 'mL/cmH₂O'], ['paw', 'Driving P', fmt(pplat - peepRef, 1), 'cmH₂O']);
    if (m && m.leak_pct > 3) tiles.push(['vol', 'Leak', fmt(m.leak_pct, 0), '%']);
    if (App.show.pes) {
      tiles.push(['pes', 'Ptp end-exp', fmt(App.lastPtpExp, 1), 'cmH₂O']);
      tiles.push(['pes' + (App.lastPtpHold == null ? ' stale' : ''), 'Ptp end-insp (hold)', App.lastPtpHold != null ? fmt(App.lastPtpHold, 1) : 'hold', App.lastPtpHold != null ? 'cmH₂O' : '']);
    }
    $('#mon').innerHTML = tiles.map(t => `<div class="mt ${t[0]}"><div class="k">${esc(t[1])}</div><div class="v">${esc(t[2])}${t[3] ? `<small>${esc(t[3])}</small>` : ''}</div></div>`).join('');
    App._flash = null;
    // ABG
    if (g) {
      const cls = (v, lo, hi) => (v < lo ? 'lo' : v > hi ? 'hi' : '');
      $('#abg').innerHTML = `<h3>Gas exchange · steady-state estimate</h3><div class="abgg">
        <div><span>pH</span><b class="${cls(g.ph, 7.35, 7.45)}">${fmt(g.ph, 2)}</b></div>
        <div><span>PaCO₂ mmHg</span><b class="${cls(g.paco2, 35, 45)}">${fmt(g.paco2, 0)}</b></div>
        <div><span>HCO₃ mEq/L</span><b>${fmt(App.patient.hco3, 0)}</b></div>
        <div><span>PaO₂ mmHg</span><b class="${cls(g.pao2, 60, 999)}">${fmt(g.pao2, 0)}</b></div>
        <div><span>SpO₂ %</span><b class="${cls(g.spo2, 88, 100)}">${fmt(g.spo2, 0)}</b></div>
        <div><span>P/F</span><b class="${cls(g.pf, 300, 9999)}">${fmt(g.pf, 0)}</b></div>
        <div><span>EtCO₂ mmHg</span><b>${fmt(g.etco2, 0)}</b></div>
        <div><span>Alv. vent. L/min</span><b>${fmt(g.va, 1)}</b></div>
        <div><span>VD/VT</span><b>${fmt(g.vdvt, 2)}</b></div></div>`;
      const apnea = S.mode === 'PSV' && b && b.type === 'B';
      const al = E.alarmsFor(m || g, S, App.patient, { apnea });
      $('#alarmBar').innerHTML = al.length ? al.map(a => `<span class="al ${a.level}">${esc(a.text)}</span>`).join('') : '<span class="al none">No active alarms</span>';
    }
    updateHoldBtns();
  }

  // ================================================================== waveform drawing
  const CSSV = {};
  function readColors() { const cs = getComputedStyle(document.documentElement); ['--scr', '--scr-grid', '--scr-axis', '--scr-text', '--scr-dim', '--c-paw', '--c-flow', '--c-vol', '--c-pes', '--c-ptp', '--c-pmus', '--c-ref', '--accent'].forEach(k => { CSSV[k] = cs.getPropertyValue(k).trim(); }); }
  const NICE = [5, 10, 15, 20, 25, 30, 40, 50, 60, 80, 100, 120, 150, 200, 250, 300, 400, 500, 600, 800, 1000, 1200, 1500, 2000, 3000];
  const niceUp = x => NICE.find(n => n >= x) || Math.ceil(x / 1000) * 1000;
  const scales = { paw: [0, 30], flow: [-60, 60], vol: [0, 600], pes: [-5, 30] };
  function autoscale(sc, key, lo, hi, minHi, sym) {
    let tl, th;
    if (sym) { const a = niceUp(Math.max(Math.abs(lo), Math.abs(hi), minHi) * 1.1); tl = -a; th = a; }
    else { th = niceUp(Math.max(hi * 1.12, minHi)); tl = lo < 0 ? -niceUp(-lo * 1.2) : 0; }
    const cur = sc[key];
    if (th > cur[1] || th < cur[1] * 0.55 || tl < cur[0] || (tl > cur[0] * 0.55 && cur[0] < 0)) sc[key] = [tl, th];
  }
  function rangeOf(arr, n) { let lo = Infinity, hi = -Infinity; for (let i = 0; i < n; i++) { const v = arr[i]; if (v === v) { if (v < lo) lo = v; if (v > hi) hi = v; } } return [lo === Infinity ? 0 : lo, hi === -Infinity ? 0 : hi]; }
  function channels(showPes) {
    const ch = [
      { key: 'paw', name: 'Paw', unit: 'cmH₂O', col: CSSV['--c-paw'] },
      { key: 'flow', name: 'Flow', unit: 'L/min', col: CSSV['--c-flow'], zero: true },
      { key: 'vol', name: 'Volume', unit: 'mL', col: CSSV['--c-vol'] }
    ];
    if (showPes) ch.push({ key: 'pes', name: 'Pes', unit: 'cmH₂O', col: CSSV['--c-pes'], zero: true, extra: { key: 'ptp', name: 'Ptp', col: CSSV['--c-ptp'] } });
    return ch;
  }
  // data: {n, get(key,i), mark(i), ins(i), head}; sc: scales; opts: {pmus, cursor}
  function drawWaves(ctx, w, h, data, sc, opts) {
    const chs = channels(opts.pes);
    ctx.fillStyle = CSSV['--scr']; ctx.fillRect(0, 0, w, h);
    const L = 40, R = 8, top = 4, gapY = 6, ph = (h - top - gapY * (chs.length - 1) - 16) / chs.length;
    const n = data.n, xOf = i => L + (i / (n - 1)) * (w - L - R);
    chs.forEach((c, ci) => {
      const y0 = top + ci * (ph + gapY), lo = sc[c.key][0], hi = sc[c.key][1];
      const yOf = v => y0 + ph - ((v - lo) / (hi - lo)) * ph;
      // inspiration shading
      ctx.fillStyle = 'rgba(255,255,255,0.035)';
      let run = -1;
      for (let i = 0; i <= n; i++) { const on = i < n && data.ins(i); if (on && run < 0) run = i; if (!on && run >= 0) { ctx.fillRect(xOf(run), y0, xOf(i - 1) - xOf(run), ph); run = -1; } }
      // grid + axis labels
      ctx.strokeStyle = CSSV['--scr-grid']; ctx.lineWidth = 1; ctx.font = '11px "IBM Plex Sans", system-ui, sans-serif'; ctx.fillStyle = CSSV['--scr-dim']; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      const ticks = [lo, (lo + hi) / 2, hi]; if (lo < 0 && hi > 0 && !ticks.includes(0)) ticks.splice(1, 1, 0);
      ticks.forEach(t => { const y = yOf(t); ctx.beginPath(); ctx.moveTo(L, y + 0.5); ctx.lineTo(w - R, y + 0.5); ctx.stroke(); ctx.fillText(String(Math.round(t)), L - 5, Math.min(Math.max(y, y0 + 6), y0 + ph - 6)); });
      if (c.zero && lo < 0) { ctx.strokeStyle = CSSV['--scr-axis']; ctx.beginPath(); ctx.moveTo(L, yOf(0) + 0.5); ctx.lineTo(w - R, yOf(0) + 0.5); ctx.stroke(); }
      ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillStyle = c.col; ctx.font = '600 12px "IBM Plex Sans", system-ui, sans-serif';
      ctx.fillText(`${c.name} ${c.unit}`, L + 6, y0 + 2);
      if (c.extra) { ctx.fillStyle = c.extra.col; ctx.fillText(c.extra.name, L + 110, y0 + 2); }
      // PEEP reference on pressure
      if (c.key === 'paw' && opts.peep != null) { ctx.setLineDash([3, 4]); ctx.strokeStyle = CSSV['--scr-axis']; ctx.beginPath(); ctx.moveTo(L, yOf(opts.peep) + 0.5); ctx.lineTo(w - R, yOf(opts.peep) + 0.5); ctx.stroke(); ctx.setLineDash([]); }
      const trace = (key, col, dash, width) => {
        ctx.strokeStyle = col; ctx.lineWidth = width || 1.8; ctx.setLineDash(dash || []); ctx.beginPath(); let pen = false;
        for (let i = 0; i < n; i++) { const v = data.get(key, i); if (v !== v) { pen = false; continue; } const x = xOf(i), y = Math.min(y0 + ph, Math.max(y0, yOf(v))); if (!pen) { ctx.moveTo(x, y); pen = true; } else ctx.lineTo(x, y); }
        ctx.stroke(); ctx.setLineDash([]);
      };
      if (c.key === 'paw' && opts.pmus) trace('pmus', CSSV['--c-pmus'], [5, 4], 1.5);
      if (c.extra) trace(c.extra.key, c.extra.col, null, 1.5);
      trace(c.key, c.col);
      if (c.key === 'paw') {
        // breath markers
        ctx.font = '700 11px "Barlow Condensed", system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        for (let i = 0; i < n; i++) { const mk = data.mark(i); if (!mk) continue; const x = xOf(i); ctx.fillStyle = mk === 1 ? '#e8f4fa' : CSSV['--c-pmus']; ctx.beginPath(); ctx.arc(x, y0 + 22, 7, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#05131a'; ctx.fillText(mk === 1 ? 'P' : 'B', x, y0 + 22.5); }
        if (opts.pmus) { ctx.fillStyle = CSSV['--c-pmus']; ctx.font = '600 12px "IBM Plex Sans", system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText('Pmus (effort)', L + 120, y0 + 2); }
      }
      c._y0 = y0; c._ph = ph; c._yOf = yOf;
    });
    // write head
    if (data.head != null && !opts.frozen) { const x = xOf(data.head); ctx.fillStyle = 'rgba(232,244,250,0.5)'; ctx.fillRect(x, top, 1.5, h - 20); }
    // time axis
    ctx.fillStyle = CSSV['--scr-dim']; ctx.font = '11px "IBM Plex Sans", system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    const secs = opts.seconds; const stepS = secs > 14 ? 5 : secs > 7 ? 2 : 1;
    for (let s = 0; s <= secs + 1e-6; s += stepS) ctx.fillText(s + ' s', L + (s / secs) * (w - L - R), h - 1);
    // cursor
    if (opts.cursor != null) {
      const i = opts.cursor, x = xOf(i);
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x + 0.5, top); ctx.lineTo(x + 0.5, h - 16); ctx.stroke();
      chs.forEach(c => {
        const v = data.get(c.key, i); if (v !== v) return;
        const lbl = `${c.name} ${fmt(v, c.key === 'vol' || c.key === 'flow' ? 0 : 1)}` + (c.extra ? `  ${c.extra.name} ${fmt(data.get(c.extra.key, i), 1)}` : '') + (c.key === 'paw' && opts.pmus ? `  Pmus ${fmt(data.get('pmus', i), 1)}` : '');
        ctx.font = '600 12px "IBM Plex Sans", system-ui, sans-serif'; const tw = ctx.measureText(lbl).width + 10;
        const bx = Math.min(w - R - tw, x + 8), by = c._y0 + 18;
        ctx.fillStyle = 'rgba(5,10,14,0.88)'; ctx.fillRect(bx, by, tw, 18); ctx.fillStyle = c.col; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(lbl, bx + 5, by + 9.5);
        ctx.fillStyle = c.col; ctx.beginPath(); ctx.arc(x, c._yOf(v), 3, 0, Math.PI * 2); ctx.fill();
      });
      const t = i * (secs / (n - 1)); ctx.fillStyle = '#e8f4fa'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'; ctx.fillText(`t ${t.toFixed(2)} s`, Math.min(x + 6, w - 60), h - 1);
    }
  }

  const wave = $('#wave'), wctx = wave.getContext('2d');
  function sizeCanvas(c) { const dpr = window.devicePixelRatio || 1, r = c.getBoundingClientRect(); if (!r.width) return null; c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr); const x = c.getContext('2d'); x.setTransform(dpr, 0, 0, dpr, 0, 0); return { w: r.width, h: r.height }; }
  let WS = null, PV = null, FV = null;
  function sizeCanvases() { WS = sizeCanvas(wave); PV = sizeCanvas($('#pvLoop')); FV = sizeCanvas($('#fvLoop')); drawLoops(); }
  window.addEventListener('resize', () => requestAnimationFrame(sizeCanvases));
  if (window.matchMedia) { const mq = window.matchMedia('(prefers-color-scheme: dark)'); if (mq.addEventListener) mq.addEventListener('change', () => { readColors(); drawLoops(); }); }

  function liveData() {
    return {
      n: D.N, head: D.head,
      get: (k, i) => D[k][i], mark: i => D.mark[i], ins: i => D.ins[i]
    };
  }
  function drawLive() {
    if (!WS) return;
    const [plo, phi] = rangeOf(D.paw, D.N), [flo, fhi] = rangeOf(D.flow, D.N), [vlo, vhi] = rangeOf(D.vol, D.N);
    autoscale(scales, 'paw', Math.min(plo, 0), Math.max(phi, App.show.pmus ? rangeOf(D.pmus, D.N)[1] : 0), 20, false);
    autoscale(scales, 'flow', flo, fhi, 40, true);
    autoscale(scales, 'vol', vlo < -60 ? vlo : 0, vhi, 300, false);
    if (App.show.pes) { const [a, b] = rangeOf(D.pes, D.N), [c2, d] = rangeOf(D.ptp, D.N); autoscale(scales, 'pes', Math.min(a, c2, 0), Math.max(b, d), 20, false); }
    drawWaves(wctx, WS.w, WS.h, liveData(), scales, { pmus: App.show.pmus, pes: App.show.pes, seconds: D.W, cursor: App.frozen ? App.cursor : null, frozen: App.frozen, peep: App.settings.peep });
  }
  function cursorFromEvent(e) {
    const r = wave.getBoundingClientRect(), L = 40, R = 8;
    const x = Math.min(Math.max(e.clientX - r.left, L), r.width - R);
    let i = Math.round(((x - L) / (r.width - L - R)) * (D.N - 1));
    for (let k = 0; k < 40 && D.paw[i] !== D.paw[i]; k++) i = (i - 1 + D.N) % D.N;   // step out of the sweep gap
    return i;
  }
  wave.addEventListener('pointermove', e => { if (App.frozen) App.cursor = cursorFromEvent(e); });
  wave.addEventListener('pointerdown', e => { if (App.frozen) App.cursor = cursorFromEvent(e); });

  // ================================================================== loops
  function drawLoop(cv, sz, pts, ref, kind) {
    if (!sz) return; const ctx = cv.getContext('2d'), w = sz.w, h = sz.h;
    ctx.fillStyle = CSSV['--scr']; ctx.fillRect(0, 0, w, h);
    const L = 34, B = 18, T = 6, R = 8;
    const all = (pts || []).concat(ref || []);
    let xlo, xhi, ylo, yhi;
    if (kind === 'pv') { xlo = 0; xhi = niceUp(Math.max(20, ...all.map(p => p[0])) * 1.05); ylo = 0; yhi = niceUp(Math.max(300, ...all.map(p => p[2])) * 1.05); }
    else { xlo = 0; xhi = niceUp(Math.max(300, ...all.map(p => p[2])) * 1.05); const a = niceUp(Math.max(40, ...all.map(p => Math.abs(p[1]))) * 1.05); ylo = -a; yhi = a; }
    const X = v => L + ((v - xlo) / (xhi - xlo)) * (w - L - R), Y = v => T + (1 - (v - ylo) / (yhi - ylo)) * (h - T - B);
    ctx.strokeStyle = CSSV['--scr-grid']; ctx.lineWidth = 1; ctx.font = '11px "IBM Plex Sans", system-ui, sans-serif'; ctx.fillStyle = CSSV['--scr-dim'];
    [ylo, (ylo + yhi) / 2, yhi].forEach(v => { ctx.beginPath(); ctx.moveTo(L, Y(v) + 0.5); ctx.lineTo(w - R, Y(v) + 0.5); ctx.stroke(); ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.fillText(String(Math.round(v)), L - 4, Math.min(Math.max(Y(v), T + 5), h - B - 5)); });
    [xlo, (xlo + xhi) / 2, xhi].forEach(v => { ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillText(String(Math.round(v)), Math.min(Math.max(X(v), L + 8), w - R - 10), h - 1); });
    ctx.textAlign = 'right'; ctx.textBaseline = 'bottom'; ctx.fillText(kind === 'pv' ? 'Paw cmH₂O' : 'Volume mL', w - R, kind === 'pv' ? h - B - 3 : Y(0) - 3);
    ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText(kind === 'pv' ? 'Volume mL' : 'Flow L/min', L + 4, T);
    const line = (P, col, dash) => { if (!P || P.length < 2) return; ctx.strokeStyle = col; ctx.lineWidth = 1.8; ctx.setLineDash(dash || []); ctx.beginPath(); P.forEach((p, i) => { const x = kind === 'pv' ? X(p[0]) : X(p[2]), y = kind === 'pv' ? Y(p[2]) : Y(p[1]); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }); ctx.stroke(); ctx.setLineDash([]); };
    line(ref, CSSV['--c-ref'], [4, 4]);
    line(pts, kind === 'pv' ? CSSV['--c-vol'] : CSSV['--c-flow']);
  }
  function drawLoops() {
    const pts = App.lastBreath && App.lastBreath.pts;
    drawLoop($('#pvLoop'), PV, pts, App.pinned, 'pv');
    drawLoop($('#fvLoop'), FV, pts, App.pinned, 'fv');
  }

  // ================================================================== main loop
  let lastT = performance.now(), acc = 0;
  function frame(now) {
    const dt = Math.min(0.1, (now - lastT) / 1000); lastT = now;
    if (App.sim && !App.frozen && !document.hidden) {
      const nb = App.sim.breaths.length;
      acc += dt; const steps = Math.floor(acc / App.sim.dt); acc -= steps * App.sim.dt;
      if (steps > 0) App.sim.advance(steps * App.sim.dt, onSample);
      if (App.sim.breaths.length !== nb || App._holdEvent) {
        const ev = App._holdEvent; App._holdEvent = null;
        updateMonitor(); drawLoops();
        if (ev) emit(ev === 'insp' ? 'ihold' : 'ehold');
      }
    }
    drawLive();
    $('#phaseTag').textContent = App.sim ? ({ insp: 'inspiration', pause: 'pause', ihold: 'inspiratory hold', ehold: 'expiratory hold', exp: 'expiration' }[App.sim.phase] || '') : '';
    requestAnimationFrame(frame);
  }

  // ================================================================== views
  $$('.views button').forEach(b => b.onclick = () => { if (b.dataset.view === 'tutorials') { App.tut = null; clearTutorial(); } setView(b.dataset.view); });
  function setView(v, opts) {
    App.view = v;
    $$('.views button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.view === v)));
    clearTutorial();
    if (!(opts && opts.keep)) {
      App.caseObj = null; App.lock = []; App.patientLocked = false; renderControls(); renderPatient();
    }
    renderSide(); updateUrl();
  }
  function renderSide() {
    if (App.view === 'curriculum') return App.caseObj ? renderCase() : renderLessons();
    if (App.view === 'tutorials') return App.tut ? renderTutorial() : renderTutorialList();
    if (App.view === 'free') return renderFree();
    if (App.view === 'builder') return renderBuilder();
  }
  function updateUrl() {
    try {
      const p = new URLSearchParams();
      if (App.view === 'curriculum' && App.caseObj && !App.caseObj.custom) p.set('case', App.caseObj.id);
      else if (App.view === 'tutorials' && App.tut) { p.set('view', 'tutorials'); p.set('tut', App.tut.id); }
      else if (App.view !== 'curriculum') p.set('view', App.view);
      const q = p.toString();
      history.replaceState(null, '', location.pathname + (q ? '?' + q : ''));
    } catch (e) { /* sandboxed */ }
  }

  // ---------------------------------------------------------------- curriculum
  const progress = () => store.get('done', {});
  function setProgress(id, val) { const p = progress(); if (p[id] !== 'pass') p[id] = val; store.set('done', p); }
  function renderLessons() {
    const p = progress(), side = $('#side');
    const total = CUR.CASES.length, passed = CUR.CASES.filter(c => p[c.id] === 'pass').length;
    side.innerHTML = `<div class="eyebrow">Case-based curriculum</div><h2>Mechanical ventilation, one case at a time</h2>
      <p class="muted small">${total} cases in 10 lessons. Interactive cases are graded on what your settings do to the patient, so any sound fix passes. ${passed ? `You have completed ${passed} of ${total}.` : ''}</p>
      ${CUR.LESSONS.map(L => {
        const cs = CUR.CASES.filter(c => c.lesson === L.n), done = cs.filter(c => p[c.id] === 'pass').length;
        const open = App._openLesson === L.n || (App._openLesson == null && L.n === 0);
        return `<details class="lesson" ${open ? 'open' : ''} data-lesson="${L.n}"><summary><span class="ln">${L.n}</span><span class="lt">${esc(L.title)}</span><span class="lp">${done}/${cs.length}</span></summary>
        <div class="cases">${cs.map(c => `<button class="case-btn" data-case="${esc(c.id)}"><span class="ck ${p[c.id] || ''}">${p[c.id] === 'pass' ? '✓' : ''}</span><span>${esc(c.title)}</span><span class="ty">${{ interactive: 'Fix it', mcq: 'Choose', numeric: 'Measure' }[c.type]}</span></button>`).join('')}</div></details>`;
      }).join('')}`;
    $$('.case-btn', side).forEach(b => b.onclick = () => openCase(b.dataset.case));
    $$('details.lesson', side).forEach(d => d.addEventListener('toggle', () => { if (d.open) App._openLesson = +d.dataset.lesson; }));
  }
  function openCase(id, custom) {
    const c = custom || CUR.CASES.find(x => x.id === id); if (!c) return;
    App.caseObj = c; App._openLesson = c.lesson;
    App.lock = c.lock || []; App.patientLocked = true;
    App.show.pmus = !!(c.view && c.view.pmus); App.show.pes = !!(c.view && c.view.pes); syncShow();
    const st = custom ? { settings: E.normSettings(c.start.settings), patient: E.normPatient(c.start.patient) } : CUR.startState(c);
    App.cs = { start: clone(st), submitted: false, result: null, answer: null, numeric: null, showTable: false };
    load(st.settings, st.patient);
    if (App.view !== 'curriculum') { App.view = 'curriculum'; $$('.views button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.view === 'curriculum'))); clearTutorial(); }
    renderCase(); updateUrl();
    $('#side').scrollTop = 0;
  }
  function caseIndex() { return CUR.CASES.findIndex(x => x.id === App.caseObj.id); }
  function targetsHTML(results, goal) {
    const list = results || (goal || []).map(r => ({ ok: null, text: CUR.ruleText(r), got: null }));
    return `<ul class="targets">${list.map(r => `<li class="${r.ok == null ? '' : r.ok ? 'ok' : 'no'}"><i aria-hidden="true">${r.ok == null ? '' : r.ok ? '✓' : '✗'}</i><span>${esc(r.text)}</span>${r.got ? `<b>${esc(r.got)}</b>` : ''}</li>`).join('')}</ul>`;
  }
  function renderCase() {
    const c = App.caseObj, cs = App.cs, side = $('#side');
    const lesson = CUR.LESSONS.find(l => l.n === c.lesson);
    let body = `<button class="backlink" id="toLessons">← All lessons</button>
      <div class="eyebrow">${c.custom ? 'Shared scenario' : `Lesson ${c.lesson} · ${esc(lesson ? lesson.title : '')}`}</div>
      <h2>${esc(c.title)}</h2><div class="q">${paras(c.question)}</div>
      ${c.look && c.look.length ? `<h3>Look for</h3><ul class="look">${c.look.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}`;
    if (c.table === 'ardsnet') {
      body += `<button class="btn sm" id="tblBtn">${cs.showTable ? 'Hide' : 'Show'} PEEP–FiO₂ table</button>`;
      if (cs.showTable) body += `<div class="tablepop"><table><tr><th>FiO₂</th>${CUR.ARDSNET_LOW.map(r => `<td>${r[0].toFixed(1)}</td>`).join('')}</tr><tr><th>PEEP</th>${CUR.ARDSNET_LOW.map(r => `<td>${r[1]}</td>`).join('')}</tr></table><p class="muted small" style="margin:6px 0 0">ARDS Network lower-PEEP / higher-FiO₂ table (N Engl J Med 2000;342:1301-8).</p></div>`;
    }
    if (c.type === 'interactive' || (c.custom && c.goal && c.goal.length)) {
      body += `<h3>${cs.submitted ? 'Result' : 'Your targets'}</h3>${targetsHTML(cs.result && cs.result.results, c.goal)}`;
      if (cs.submitted) body += `<div class="verdict ${cs.result.pass ? 'pass' : 'fail'}"><b>${cs.result.pass ? 'Target met' : 'Not yet'}</b>${cs.result.pass ? 'Your settings did the job. Compare before and after, then read why.' : 'Adjust the settings and check again. Compare before and after to see what changed.'}</div>`;
      body += `<div class="row"><button class="btn pri" id="submitBtn">${cs.submitted ? 'Check again' : 'Check my settings'}</button><button class="btn" id="resetCase">Reset case</button>${cs.submitted ? '<button class="btn" id="cmpBtn">Before / after</button>' : ''}</div>`;
      if (cs.submitted && c.solution) body += `<div class="row" style="margin-top:8px"><button class="btn sm" id="modelBtn">Load the model answer</button></div>`;
    } else if (c.type === 'mcq') {
      body += `<div class="choices">${c.choices.map((ch, i) => {
        const st = cs.answer == null ? '' : ch.correct ? 'right' : i === cs.answer ? 'wrong' : '';
        return `<button class="choice ${st}" data-ch="${i}" ${cs.answer != null ? 'disabled' : ''}>${esc(ch.text)}${cs.answer != null && (ch.correct || i === cs.answer) ? `<small>${esc(ch.why)}</small>` : ''}</button>`;
      }).join('')}</div>`;
      if (cs.answer != null) body += `<div class="verdict ${c.choices[cs.answer].correct ? 'pass' : 'fail'}"><b>${c.choices[cs.answer].correct ? 'Correct' : 'Not quite'}</b>${c.then ? 'The change is now running on the ventilator. Watch what it does.' : ''}</div><div class="row"><button class="btn" id="resetCase">Try again</button></div>`;
    } else if (c.type === 'numeric') {
      body += `<div class="numin"><input id="numAns" inputmode="decimal" aria-label="Your answer" value="${cs.numeric ? esc(cs.numeric.value) : ''}"><span class="muted">${esc(c.unit)}</span><button class="btn pri" id="numBtn">Check</button></div>`;
      if (cs.numeric) body += `<div class="verdict ${cs.numeric.ok ? 'pass' : 'fail'}"><b>${cs.numeric.ok ? 'Correct' : 'Not quite'}</b>The simulated value is ${fmt(cs.numeric.truth, c.dp)} ${esc(c.unit)}.</div>`;
    } else if (c.custom) {
      body += `<p class="muted small">No targets were set for this scenario. Explore the ventilator and talk it through.</p>`;
    }
    const revealed = cs.submitted || cs.answer != null || cs.numeric;
    if (revealed && (c.explain || (c.points && c.points.length))) body += `<div class="explain"><h3 style="margin-top:0">Why</h3>${paras(c.explain)}${c.points && c.points.length ? `<h3>Teaching points</h3><ul class="points">${c.points.map(p => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}</div>`;
    if (!c.custom) {
      const i = caseIndex(), nx = CUR.CASES[i + 1], pv = CUR.CASES[i - 1];
      body += `<div class="row" style="margin-top:14px;justify-content:space-between">${pv ? `<button class="btn sm" data-go="${pv.id}">← Previous</button>` : '<span></span>'}${nx ? `<button class="btn sm" data-go="${nx.id}">Next: ${esc(nx.title)} →</button>` : ''}</div>`;
    }
    side.innerHTML = body;
    $('#toLessons').onclick = () => { App.caseObj = null; App.lock = []; App.patientLocked = false; renderControls(); renderPatient(); renderLessons(); updateUrl(); };
    $$('[data-go]', side).forEach(b => b.onclick = () => openCase(b.dataset.go));
    if ($('#tblBtn')) $('#tblBtn').onclick = () => { cs.showTable = !cs.showTable; renderCase(); };
    if ($('#submitBtn')) $('#submitBtn').onclick = submitCase;
    if ($('#resetCase')) $('#resetCase').onclick = () => openCase(c.id, c.custom ? c : null);
    if ($('#cmpBtn')) $('#cmpBtn').onclick = () => openCompare(false);
    if ($('#modelBtn')) $('#modelBtn').onclick = () => { const a = CUR.solutionState(c); App.changedSettings = {}; App.settings = E.normSettings(a.settings); Object.keys(c.solution.settings || {}).forEach(k => { App.changedSettings[k] = true; }); App.sim.setSettings(App.settings); renderControls(); toast('Model answer loaded on the ventilator'); };
    $$('[data-ch]', side).forEach(b => b.onclick = () => answerChoice(+b.dataset.ch));
    if ($('#numBtn')) { $('#numBtn').onclick = checkNumeric; $('#numAns').onkeydown = e => { if (e.key === 'Enter') checkNumeric(); }; }
  }
  function submitCase() {
    const c = App.caseObj, cs = App.cs;
    $('#submitBtn').disabled = true; $('#submitBtn').textContent = 'Checking…';
    setTimeout(() => {
      cs.result = CUR.grade(c, App.settings, App.patient);
      cs.submitted = true;
      if (!c.custom) setProgress(c.id, cs.result.pass ? 'pass' : 'tried');
      renderCase();
    }, 30);
  }
  function answerChoice(i) {
    const c = App.caseObj, cs = App.cs; cs.answer = i;
    setProgress(c.id, c.choices[i].correct ? 'pass' : 'tried');
    if (c.then) {
      if (c.then.patient) { App.patient = E.normPatient(E.deepMerge(App.patient, c.then.patient)); App.sim.setPatient(App.patient); renderPatient(); }
      if (c.then.settings) { App.settings = E.normSettings(E.deepMerge(App.settings, c.then.settings)); Object.keys(c.then.settings).forEach(k => { App.changedSettings[k] = true; }); App.sim.setSettings(App.settings); renderControls(); }
      App.pinned = App.lastBreath ? clone(App.lastBreath.pts) : null; $('#clearLoop').hidden = !App.pinned; drawLoops();
    }
    renderCase();
  }
  function checkNumeric() {
    const c = App.caseObj, cs = App.cs, v = parseFloat(String($('#numAns').value).replace(',', '.'));
    if (!isFinite(v)) { toast('Type a number first'); return; }
    const truth = CUR.truthFor(c), ok = CUR.checkNumeric(c, v, truth);
    cs.numeric = { value: v, truth, ok }; setProgress(c.id, ok ? 'pass' : 'tried'); renderCase();
  }

  // ---------------------------------------------------------------- comparison dialog
  function openCompare() {
    const c = App.caseObj, cs = App.cs;
    const cols = [{ title: 'Case start', st: cs.start }, { title: 'Your settings', st: { settings: App.settings, patient: App.patient } }];
    if (c.solution && cs.submitted) cols.push({ title: 'Model answer', st: CUR.solutionState(c) });
    const runs = cols.map(col => ({ ...col, r: E.simulate(col.st.settings, col.st.patient, { warmup: 60, seconds: 12, sampleDt: 0.02 }) }));
    const sc = { paw: [0, 30], flow: [-60, 60], vol: [0, 600], pes: [-5, 30] };
    runs.forEach(x => { const s = x.r.samples; autoscale(sc, 'paw', 0, Math.max(...s.map(p => p.paw), ...(c.view && c.view.pmus ? s.map(p => p.pmus) : [0])), 20, false); autoscale(sc, 'flow', Math.min(...s.map(p => p.flow)), Math.max(...s.map(p => p.flow)), 40, true); autoscale(sc, 'vol', 0, Math.max(...s.map(p => p.vol)), 300, false); });
    $('#cmpGrid').innerHTML = runs.map((x, i) => `<div class="cmpcol"><h3>${esc(x.title)}</h3><canvas id="cmp${i}" role="img" aria-label="${esc(x.title)} waveforms"></canvas></div>`).join('');
    $('#cmpDlg').hidden = false;
    runs.forEach((x, i) => {
      const cv = $('#cmp' + i), sz = sizeCanvas(cv); if (!sz) return;
      const s = x.r.samples, n = s.length;
      const marks = new Uint8Array(n); s.forEach((p, j) => { if (p.mark === 'P') marks[j] = 1; else if (p.mark === 'B') marks[j] = 2; });
      drawWaves(cv.getContext('2d'), sz.w, sz.h, { n, head: null, get: (k, j) => s[j][k], mark: j => marks[j], ins: j => (s[j].phase === 'insp' || s[j].phase === 'pause' || s[j].phase === 'ihold') ? 1 : 0 }, sc, { pmus: c.view && c.view.pmus, seconds: 12, frozen: true, peep: x.st.settings.peep });
    });
    const keys = Array.from(new Set((c.goal || []).filter(r => r.m).map(r => r.m).concat(['vt_per_kg', 'rr_actual', 'ppeak', 'pplat', 'auto_peep', 'ph', 'paco2', 'spo2'])));
    $('#cmpTable').innerHTML = `<thead><tr><th>Measure</th>${runs.map(x => `<th>${esc(x.title)}</th>`).join('')}</tr></thead><tbody>${keys.map(k => { const M = CUR.METRICS[k] || { label: k, unit: '', dp: 1 }; return `<tr><td>${esc(M.label)}${M.unit ? ` <span class="muted small">${esc(M.unit)}</span>` : ''}</td>${runs.map(x => `<td>${fmt(x.r.metrics[k] * (M.scale || 1), M.dp)}</td>`).join('')}</tr>`; }).join('')}</tbody>`;
    $('#cmpClose').focus();
  }
  $('#cmpClose').onclick = () => { $('#cmpDlg').hidden = true; };
  $('#cmpDlg').addEventListener('click', e => { if (e.target.id === 'cmpDlg') $('#cmpDlg').hidden = true; });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#cmpDlg').hidden) $('#cmpDlg').hidden = true; });

  // ---------------------------------------------------------------- tutorials
  function renderTutorialList() {
    $('#side').innerHTML = `<div class="eyebrow">Tutorials</div><h2>Learn the screen, then the physiology</h2>
      <p class="muted small">Guided walkthroughs. Some steps ask you to do something on the ventilator before you move on.</p>
      <div class="cardlist">${CUR.TUTORIALS.map(t => `<button class="card" data-tut="${esc(t.id)}"><b>${esc(t.title)}</b><span>${esc(t.blurb)}</span><span> · ${t.steps.length} steps${App.tutDone[t.id] ? ' · done' : ''}</span></button>`).join('')}</div>`;
    $$('[data-tut]').forEach(b => b.onclick = () => startTutorial(b.dataset.tut));
  }
  function startTutorial(id) {
    const t = CUR.TUTORIALS.find(x => x.id === id); if (!t) return;
    App.view = 'tutorials'; $$('.views button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.view === 'tutorials')));
    App.caseObj = null; App.lock = []; App.patientLocked = false;
    const st = CUR.startState({ start: t.setup });
    App.show.pes = !!(t.setup.view && t.setup.view.pes); App.show.pmus = !!(t.setup.patient && t.setup.patient.effort && t.setup.patient.effort.on); syncShow();
    load(st.settings, st.patient);
    App.tut = t; App.tutStep = 0; App.tutWaitDone = false;
    renderTutorial(); updateUrl();
  }
  function clearTutorial() {
    $$('.tut-target').forEach(el => el.classList.remove('tut-target'));
    $$('.mk').forEach(el => el.remove());
    if (App.view !== 'tutorials') App.tut = null;
  }
  function renderTutorial() {
    const t = App.tut, i = App.tutStep, s = t.steps[i];
    $$('.tut-target').forEach(el => el.classList.remove('tut-target'));
    const target = s.target && $(s.target);
    if (target) {
      target.classList.add('tut-target');
      if (target.tagName === 'DETAILS' && !target.open) target.open = true;
      const r = target.getBoundingClientRect();
      if (r.top < 60 || r.bottom > window.innerHeight) target.scrollIntoView({ block: 'center', behavior: 'auto' });
    }
    placeMarkers();
    if (s.setup) { const st = CUR.startState({ start: s.setup }); load(st.settings, st.patient); }
    const waitTxt = s.wait ? ({ ihold: 'Press "Inspiratory hold" and wait for the next breath.', ehold: 'Press "Expiratory hold" and wait for the end of the next exhalation.', mode: `Switch the mode to ${s.wait.v}.`, pin: 'Press "Pin as reference".', pes: 'Turn on the Pes channel.' }[s.wait.ev]) : '';
    const done = !s.wait || App.tutWaitDone;
    $('#side').innerHTML = `<button class="backlink" id="toTuts">← All tutorials</button><div class="eyebrow">${esc(t.title)}</div>
      <div class="tut-step">STEP ${i + 1} OF ${t.steps.length}</div><h2>${esc(s.title)}</h2><div class="q">${paras(s.text)}</div>
      ${s.wait ? `<div class="waiting ${done ? 'done' : ''}">${done ? 'Done — carry on.' : esc(waitTxt)}</div>` : ''}
      <div class="row" style="justify-content:space-between;margin-top:12px"><button class="btn" id="tPrev" ${i === 0 ? 'disabled' : ''}>Back</button>
      ${i < t.steps.length - 1 ? `<button class="btn pri" id="tNext" ${done ? '' : 'disabled'}>Next</button>` : `<button class="btn pri" id="tEnd">Finish</button>`}</div>
      ${t.markers ? '<p class="note">Numbers on the screen match these steps. Tap any number to jump to it; the screen freezes so you can look closely.</p>' : ''}`;
    $('#toTuts').onclick = () => { App.tut = null; clearTutorial(); renderTutorialList(); updateUrl(); };
    $('#tPrev').onclick = () => { App.tutStep--; App.tutWaitDone = false; renderTutorial(); };
    if ($('#tNext')) $('#tNext').onclick = () => { App.tutStep++; App.tutWaitDone = false; renderTutorial(); };
    if ($('#tEnd')) $('#tEnd').onclick = () => { App.tutDone[t.id] = true; App.tut = null; clearTutorial(); renderTutorialList(); updateUrl(); toast('Tutorial complete'); };
  }
  // numbered markers for the screen tour, laid over the page at each target's position
  function placeMarkers() {
    $$('.mk').forEach(el => el.remove());
    const t = App.tut; if (!t || !t.markers || App.view !== 'tutorials') return;
    const byTarget = {};
    t.steps.forEach((st, k) => { (byTarget[st.target] = byTarget[st.target] || []).push(k); });
    Object.keys(byTarget).forEach(sel => {
      const el = $(sel); if (!el) return;
      const r = el.getBoundingClientRect(); if (!r.width) return;
      byTarget[sel].forEach((k, j) => {
        const m = document.createElement('button'); m.className = 'mk'; m.type = 'button'; m.textContent = String(k + 1);
        m.style.left = Math.max(2, r.left + window.scrollX - 8 + j * 30) + 'px'; m.style.top = Math.max(2, r.top + window.scrollY - 10) + 'px';
        m.setAttribute('aria-label', `Step ${k + 1}: ${t.steps[k].title}`);
        if (k === App.tutStep) m.setAttribute('aria-current', 'true');
        m.onclick = () => { App.tutStep = k; App.tutWaitDone = false; App.frozen = true; $('#freezeBtn').setAttribute('aria-pressed', 'true'); $('#freezeBtn').textContent = 'Run'; renderTutorial(); };
        document.body.appendChild(m);
      });
    });
  }
  window.addEventListener('resize', () => requestAnimationFrame(placeMarkers));
  setInterval(() => { if (App.tut && App.tut.markers) placeMarkers(); }, 1500);

  function tutorialEvent(ev, v) {
    if (App.view !== 'tutorials' || !App.tut) return;
    const s = App.tut.steps[App.tutStep];
    if (!s || !s.wait || App.tutWaitDone || s.wait.ev !== ev) return;
    if (s.wait.v && s.wait.v !== v) return;
    App.tutWaitDone = true; renderTutorial();
  }

  // ---------------------------------------------------------------- free play
  const QUICK = [
    ['Pneumothorax', P => { P.c = Math.max(6, Math.round(P.c * 0.4)); P.shunt = Math.min(0.6, P.shunt + 0.15); }],
    ['Mucus plug', P => { P.r = Math.min(60, P.r * 3); }],
    ['Bronchospasm', P => { P.r = Math.max(P.r, 30); P.rexp = 1.7; }],
    ['Right mainstem', P => { P.c = Math.max(6, Math.round(P.c * 0.5)); P.shunt = Math.min(0.6, P.shunt + 0.2); }],
    ['Cuff leak', P => { P.leak = 8; }],
    ['Disconnect', P => { P.disconnect = !P.disconnect; }],
    ['Patient wakes up', P => { P.effort = { ...P.effort, on: true, pmax: 6, rate: 20, ti: 0.9 }; }],
    ['Paralyze', P => { P.effort = { ...P.effort, on: false }; }],
    ['Cardiac oscillations', P => { P.cardiac = !P.cardiac; }]
  ];
  function renderFree() {
    $('#side').innerHTML = `<div class="eyebrow">Free play</div><h2>Any patient, any setting</h2>
      <p class="muted small">Pick a patient, change anything, break things on purpose. Changes start on the next breath.</p>
      <h3>Patients</h3><div class="cardlist">${Object.keys(E.PRESETS).map(k => `<button class="card" data-preset="${k}" ${App.preset === k ? 'aria-current="true"' : ''}><b>${esc(E.PRESETS[k].label)}</b><span>${esc(presetBlurb(k))}</span></button>`).join('')}</div>
      <h3>Events</h3><div class="grid2b">${QUICK.map((q, i) => `<button class="btn sm" data-q="${i}">${esc(q[0])}</button>`).join('')}</div>
      <div class="row" style="margin-top:8px"><button class="btn sm" id="resetPt">Reset patient</button><button class="btn sm" id="ff">Skip ahead 60 s</button></div>
      <h3>Share</h3><p class="muted small" style="margin:0 0 6px">Turn the current ventilator and patient into a scenario with a question and targets.</p>
      <button class="btn sm" id="toBuilder">Open in scenario builder</button>`;
    $$('[data-preset]').forEach(b => b.onclick = () => loadPreset(b.dataset.preset));
    $$('[data-q]').forEach(b => b.onclick = () => { const P = clone(App.patient); QUICK[+b.dataset.q][1](P); App.patient = E.normPatient(P); App.sim.setPatient(App.patient); renderPatient(); toast(QUICK[+b.dataset.q][0] + ' — watch the screen'); });
    $('#resetPt').onclick = () => { App.patient = E.normPatient(clone(App.freeBase || E.PRESETS[App.preset].patient)); App.sim.setPatient(App.patient); renderPatient(); };
    $('#ff').onclick = () => { App.sim.advance(60, onSample); updateMonitor(); drawLoops(); toast('60 seconds later'); };
    $('#toBuilder').onclick = () => setView('builder', { keep: true });
  }
  function presetBlurb(k) {
    return { normal: 'Sedated, normal lungs on volume control.', obstructive: 'High resistance, flow limitation, auto-PEEP.', ards: 'Stiff, recruitable lungs and shunt.', obese: 'Stiff chest wall; try the Pes channel.', spont: 'Awake and triggering on pressure support.' }[k] || '';
  }
  function loadPreset(k) {
    const pr = E.PRESETS[k]; App.preset = k;
    App.freeBase = clone(E.normPatient(pr.patient));
    App.show.pmus = !!(pr.patient.effort && pr.patient.effort.on); App.show.pes = k === 'obese'; syncShow();
    load(pr.settings, pr.patient);
    if (App.view === 'free') renderFree();
  }

  // ---------------------------------------------------------------- scenario builder
  const GOAL_METRICS = ['vt_per_kg', 'pplat', 'driving_p', 'auto_peep', 'ph', 'paco2', 'spo2', 'rr_actual', 'false_trig_min', 'missed_min', 'double_min', 'scoop', 'overshoot', 'ppeak', 'mv'];
  const scenarios = () => store.get('scenarios', []);
  function saveScenarios(list) { store.set('scenarios', list); }
  function b64e(obj) { const s = unescape(encodeURIComponent(JSON.stringify(obj))); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  function b64d(str) { let s = str.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return JSON.parse(decodeURIComponent(escape(atob(s)))); }
  function scenarioToCase(sc) {
    return { id: 'custom', custom: true, type: sc.goal && sc.goal.length ? 'interactive' : 'free', title: sc.name || 'Untitled scenario', lesson: -1,
      question: sc.question || '', goal: sc.goal || [], start: { settings: sc.settings, patient: sc.patient }, explain: sc.notes || '', points: [], lock: sc.lock || [] };
  }
  function shareLink(sc) {
    const base = location.origin && location.origin !== 'null' ? location.origin + location.pathname : '';
    return base + '?s=' + b64e({ v: 1, name: sc.name, question: sc.question, notes: sc.notes, goal: sc.goal, settings: sc.settings, patient: sc.patient });
  }
  function copyText(text, fallbackEl) {
    const done = () => toast('Link copied');
    try { navigator.clipboard.writeText(text).then(done, () => { if (fallbackEl) { fallbackEl.hidden = false; fallbackEl.value = text; fallbackEl.select(); } }); }
    catch (e) { if (fallbackEl) { fallbackEl.hidden = false; fallbackEl.value = text; fallbackEl.select(); } }
  }
  function renderBuilder() {
    const draft = App.draft || (App.draft = { name: '', question: '', notes: '', goal: [] });
    const list = scenarios();
    $('#side').innerHTML = `<div class="eyebrow">Scenario builder</div><h2>Make a case from what is on the ventilator</h2>
      <p class="muted small">Set the ventilator and patient the way you want learners to find them, then save. Learners open your link — no account.</p>
      <div class="field"><label for="bName">Scenario name</label><input id="bName" value="${esc(draft.name)}" placeholder="e.g. Post-op asthma, night 2"></div>
      <div class="field"><label for="bQ">Question for the learner</label><textarea id="bQ" placeholder="What do you see, and what would you change?">${esc(draft.question)}</textarea></div>
      <div class="field"><label for="bNotes">Teaching notes (shown after they check)</label><textarea id="bNotes">${esc(draft.notes)}</textarea></div>
      <div class="field"><label>Targets (optional — makes it gradable)</label>
        <div id="goalRows">${draft.goal.map((g, i) => `<div class="goalrow"><select data-gi="${i}" data-f="m" aria-label="Measure">${GOAL_METRICS.map(m => `<option value="${m}" ${g.m === m ? 'selected' : ''}>${esc(CUR.METRICS[m].label)}</option>`).join('')}</select>
          <select data-gi="${i}" data-f="op" aria-label="Comparison"><option value="<=" ${g.op === '<=' ? 'selected' : ''}>≤</option><option value=">=" ${g.op === '>=' ? 'selected' : ''}>≥</option></select>
          <input data-gi="${i}" data-f="v" value="${esc(g.v)}" inputmode="decimal" aria-label="Value"><button type="button" data-gdel="${i}" aria-label="Remove target">×</button></div>`).join('')}</div>
        <button class="btn sm" id="addGoal" type="button">Add a target</button></div>
      <div class="row"><button class="btn pri" id="bSave">Save scenario</button><button class="btn" id="bTry">Try it as a learner</button></div>
      <input class="copybox" id="copyBox" hidden readonly aria-label="Share link">
      <h3>Saved on this device</h3>
      ${list.length ? `<div class="cardlist">${list.map(sc => `<div class="card"><b>${esc(sc.name || 'Untitled')}</b><span>${esc(sc.settings.mode)} · PEEP ${sc.settings.peep} · FiO₂ ${(+sc.settings.fio2).toFixed(2)} · ${sc.goal.length} target${sc.goal.length === 1 ? '' : 's'}</span>
        <div class="row" style="margin-top:6px"><button class="btn sm" data-sl="${sc.id}">Load</button><button class="btn sm" data-sp="${sc.id}">Play</button><button class="btn sm" data-ss="${sc.id}">Copy link</button><button class="btn sm" data-sx="${sc.id}">Export</button>${App._confirmDel === sc.id ? `<button class="btn sm" data-sdy="${sc.id}" style="border-color:var(--bad);color:var(--bad)">Delete for good</button><button class="btn sm" data-sdn="1">Keep</button>` : `<button class="btn sm" data-sd="${sc.id}">Delete</button>`}</div></div>`).join('')}</div>` : '<p class="muted small">Nothing saved yet. Saved scenarios stay in this browser; export them or copy a link to share.</p>'}
      <div class="field" style="margin-top:12px"><label for="bImport">Import scenarios (.json)</label><input type="file" id="bImport" accept="application/json,.json"></div>`;
    const sync = () => { draft.name = $('#bName').value; draft.question = $('#bQ').value; draft.notes = $('#bNotes').value; };
    ['#bName', '#bQ', '#bNotes'].forEach(s => $(s).addEventListener('input', sync));
    $$('#goalRows [data-gi]').forEach(el => el.addEventListener('change', () => { const g = draft.goal[+el.dataset.gi]; g[el.dataset.f] = el.dataset.f === 'v' ? parseFloat(el.value) : el.value; }));
    $$('[data-gdel]').forEach(b => b.onclick = () => { sync(); draft.goal.splice(+b.dataset.gdel, 1); renderBuilder(); });
    $('#addGoal').onclick = () => { sync(); draft.goal.push({ m: 'pplat', op: '<=', v: 30 }); renderBuilder(); };
    const current = () => ({ id: 's' + Date.now().toString(36), name: draft.name.trim() || 'Untitled scenario', question: draft.question.trim(), notes: draft.notes.trim(), goal: draft.goal.filter(g => isFinite(g.v)).map(g => ({ m: g.m, op: g.op, v: +g.v })), settings: clone(App.settings), patient: clone(App.patient), created: new Date().toISOString() });
    $('#bSave').onclick = () => { sync(); const sc = current(); const l = scenarios(); l.unshift(sc); saveScenarios(l); toast('Saved'); renderBuilder(); };
    $('#bTry').onclick = () => { sync(); openCase('custom', scenarioToCase(current())); };
    const find = id => scenarios().find(s => s.id === id);
    $$('[data-sl]').forEach(b => b.onclick = () => { const sc = find(b.dataset.sl); App.draft = { name: sc.name, question: sc.question, notes: sc.notes, goal: clone(sc.goal) }; load(sc.settings, sc.patient); renderBuilder(); });
    $$('[data-sp]').forEach(b => b.onclick = () => openCase('custom', scenarioToCase(find(b.dataset.sp))));
    $$('[data-ss]').forEach(b => b.onclick = () => copyText(shareLink(find(b.dataset.ss)), $('#copyBox')));
    $$('[data-sx]').forEach(b => b.onclick = () => { const sc = find(b.dataset.sx); const blob = new Blob([JSON.stringify([sc], null, 2)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = (sc.name || 'scenario').replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '.json'; document.body.appendChild(a); a.click(); a.remove(); });
    $$('[data-sd]').forEach(b => b.onclick = () => { App._confirmDel = b.dataset.sd; renderBuilder(); });
    $$('[data-sdn]').forEach(b => b.onclick = () => { App._confirmDel = null; renderBuilder(); });
    $$('[data-sdy]').forEach(b => b.onclick = () => { saveScenarios(scenarios().filter(s => s.id !== b.dataset.sdy)); App._confirmDel = null; toast('Deleted'); renderBuilder(); });
    $('#bImport').onchange = e => {
      const f = e.target.files && e.target.files[0]; if (!f) return;
      const rd = new FileReader();
      rd.onload = () => {
        try {
          let data = JSON.parse(rd.result); if (!Array.isArray(data)) data = [data];
          const ok = data.filter(s => s && typeof s === 'object' && s.settings && s.patient).map(s => ({ id: 's' + Math.random().toString(36).slice(2, 9), name: String(s.name || 'Imported scenario').slice(0, 120), question: String(s.question || ''), notes: String(s.notes || ''), goal: Array.isArray(s.goal) ? s.goal.filter(g => g && CUR.METRICS[g.m] && (g.op === '<=' || g.op === '>=') && isFinite(g.v)) : [], settings: E.normSettings(s.settings), patient: E.normPatient(s.patient) }));
          if (!ok.length) { toast('No scenarios found in that file'); return; }
          saveScenarios(ok.concat(scenarios())); toast(`Imported ${ok.length}`); renderBuilder();
        } catch (err) { toast('That file is not a Vent Lab scenario export'); }
      };
      rd.readAsText(f);
    };
  }

  // ================================================================== boot
  readColors();
  resetBuffer(12);
  sizeCanvases();
  const params = (() => { try { return new URLSearchParams(location.search); } catch (e) { return new URLSearchParams(); } })();
  const shared = params.get('s');
  let booted = false;
  if (shared) {
    try { const sc = b64d(shared); if (sc && sc.settings && sc.patient) { openCase('custom', scenarioToCase({ ...sc, goal: (sc.goal || []).filter(g => CUR.METRICS[g.m]) })); booted = true; } }
    catch (e) { toast('That scenario link is damaged'); }
  }
  if (!booted && params.get('case') && CUR.CASES.some(c => c.id === params.get('case'))) { openCase(params.get('case')); booted = true; }
  if (!booted && params.get('view') === 'tutorials' && params.get('tut')) { startTutorial(params.get('tut')); booted = !!App.tut; }
  if (!booted) {
    const v = params.get('view');
    loadPreset(params.get('preset') && E.PRESETS[params.get('preset')] ? params.get('preset') : 'normal');
    setView(['tutorials', 'free', 'builder'].includes(v) ? v : 'curriculum');
  }
  sizeCanvases();
  requestAnimationFrame(t => { lastT = t; frame(t); });
})();
