/* Vent Lab UI — bedside-sim. Uses VentEngine (physiology) and VentCurriculum (cases, tutorials, grader).
   One display buffer feeds the waveforms, the live loops, the dynamic lung and the freeze cursor, so they stay in sync. */
(function () {
  'use strict';
  const E = window.VentEngine, CUR = window.VentCurriculum;
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (v, dp) => (v == null || !isFinite(v) ? '—' : (+v).toFixed(dp || 0));
  const clone = o => JSON.parse(JSON.stringify(o));
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
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
    view: 'curriculum', settings: null, patient: null, sim: null,
    aux: 'none', pmus: false, lock: [], patientLocked: false,
    caseObj: null, cs: null, tut: null, tutStep: 0, tutDone: {},
    hold: {}, pinned: null, lastBreath: null, preset: 'normal', freeBase: null,
    changedSettings: {}, lastPtpExp: null, lastPtpHold: null,
    snap: null, compare: false, autoCompare: false, ntab: 'main', cursor: null, frozen: false, m4: null, mg: null
  };
  const listeners = {};
  function emit(ev, v) { (listeners[ev] || []).forEach(fn => fn(v)); tutorialEvent(ev, v); }

  // ================================================================== display buffer
  const D = { W: 12, DT: 0.02, N: 600, head: 0, nextT: 0, pendingMark: 0 };
  const CH_KEYS = ['paw', 'flow', 'vol', 'pes', 'ptp', 'pmus', 'co2'];
  const MARK = { P: 1, B: 2, S: 3 };
  function resetBuffer(W) {
    D.W = W || D.W; D.N = Math.round(D.W / D.DT);
    for (const k of CH_KEYS) { D[k] = new Float32Array(D.N); D[k].fill(NaN); }
    D.mark = new Uint8Array(D.N); D.ins = new Uint8Array(D.N); D.bidx = new Int32Array(D.N).fill(-9);
    D.head = 0; D.nextT = 0; D.pendingMark = 0;
  }
  function onSample(s) {
    if (s.mark && MARK[s.mark]) D.pendingMark = MARK[s.mark];
    if (s.mark && s.mark !== 'M') App._lastTrigT = s.t;
    if (s.phase === 'insp' && App._prevSample && (App._prevPhase === 'exp' || App._prevPhase === 'ehold')) App.lastPtpExp = App._prevSample.ptp;
    if (s.phase === 'ihold') App._ptpHoldNow = s.ptp;
    if (App._prevPhase === 'ihold' && s.phase !== 'ihold' && App._ptpHoldNow != null) { App.lastPtpHold = App._ptpHoldNow; App._ptpHoldNow = null; }
    App._prevPhase = s.phase; App._prevSample = s;
    if (s.t < D.nextT) return;
    D.nextT = s.t + D.DT - 1e-9;
    const i = Math.floor((s.t % D.W) / D.DT) % D.N;
    D.paw[i] = s.paw; D.flow[i] = s.flow; D.vol[i] = s.vol; D.pes[i] = s.pes; D.ptp[i] = s.ptp; D.pmus[i] = s.pmus; D.co2[i] = s.co2;
    D.mark[i] = D.pendingMark; D.pendingMark = 0; D.bidx[i] = s.breath;
    D.ins[i] = (s.phase === 'insp' || s.phase === 'pause' || s.phase === 'ihold') ? 1 : 0;
    const gap = Math.round(0.35 / D.DT);
    for (let g = 1; g <= gap; g++) { const j = (i + g) % D.N; for (const k of CH_KEYS) D[k][j] = NaN; D.mark[j] = 0; D.ins[j] = 0; D.bidx[j] = -9; }
    D.head = i;
  }

  // ================================================================== simulator lifecycle
  function load(settings, patient, opts) {
    opts = opts || {};
    App.settings = E.normSettings(settings);
    App.patient = E.normPatient(patient);
    App.sim = E.createSim(App.settings, App.patient, { seed: 5 });
    App.sim.onBreath(b => { App.lastBreath = b; });
    App.sim.onHold(onHold);
    App.hold = {}; App.lastBreath = null; App.lastPtpExp = null; App.lastPtpHold = null; App.changedSettings = {};
    App._prevPhase = null; App._prevSample = null; App.pinned = null; $('#clearLoop').hidden = true;
    resetBuffer();
    App.sim.advance(opts.warm != null ? opts.warm : 24);
    App.sim.advance(D.W, onSample);
    setFrozen(false);
    renderControls(); renderPatient(); renderAlarmKnobs(); updateMonitor();
  }
  function onHold(h) {
    const H = App.hold;
    if (h.kind === 'insp') { H.pplat = h.p; H.pplatT = h.t; H.vt = h.vt; H.ppeak = h.ppeak; H.qEndIns = h.qEndIns; App._flash = 'pplat'; }
    else if (h.kind === 'exp') { H.ptot = h.p; H.ptotT = h.t; App._flash = 'ptot'; }
    else if (h.kind === 'p01') { H.p01 = h.none ? 0 : h.p; H.p01none = !!h.none; H.p01T = h.t; App._flash = 'p01'; }
    else if (h.kind === 'nif') { H.nif = h.p; H.nifnone = !!h.none; H.nifT = h.t; App._flash = 'nif'; }
    App._holdEvent = h.kind;
  }
  function setSetting(k, v) {
    App.settings[k] = v;
    App.changedSettings[k] = true;
    App.sim.setSettings(App.settings);
    if (k === 'mode') emit('mode', v);
    maybeAutoCompare();
    renderControls();
  }
  function setPatient(path, v) {
    const parts = path.split('.');
    let o = App.patient; for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]];
    o[parts[parts.length - 1]] = v;
    App.sim.setPatient(App.patient);
    renderPatient();
  }
  function maybeAutoCompare() {
    if (App.caseObj && App.snap && !App.compare && !App.autoCompare) { App.autoCompare = true; setCompare(true); toast('Side by side: case start vs live'); }
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
    cycle: { l: 'Exp. trigger (ET)', u: '% peak flow', st: 5, mn: 5, mx: 80 },
    trig_f: { l: 'Flow trigger', u: 'L/min', st: 0.5, mn: 0.5, mx: 15, dp: 1 },
    trig_p: { l: 'Pressure trigger', u: 'cmH₂O', st: 0.5, mn: -15, mx: -0.5, dp: 1 },
    phigh: { l: 'P-high', u: 'cmH₂O', st: 1, mn: 5, mx: 45 },
    plow: { l: 'P-low', u: 'cmH₂O', st: 1, mn: 0, mx: 25 },
    thigh: { l: 'T-high', u: 's', st: 0.1, mn: 0.5, mx: 15, dp: 1 },
    tlow: { l: 'T-low', u: 's', st: 0.05, mn: 0.2, mx: 3, dp: 2 }
  };
  const MODE_KNOBS = {
    VC: ['vt', 'rr', 'peep', 'fio2', 'ti', 'pause'],
    PC: ['pinsp', 'rr', 'peep', 'fio2', 'ti', 'rise'],
    PRVC: ['vt', 'rr', 'peep', 'fio2', 'ti', 'rise'],
    PSV: ['psupport', 'peep', 'fio2', 'cycle', 'rise'],
    VS: ['vt', 'peep', 'fio2', 'cycle', 'rise'],
    APRV: ['phigh', 'plow', 'thigh', 'tlow', 'fio2', 'rise']
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
    nif: { l: 'Max insp. pressure', u: 'cmH₂O (NIF)', st: 1, mn: 5, mx: 120 },
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

  // mode families, as on an NKV-550: A/CMV, SIMV, SPONT, APRV
  const familyOf = S => (S.mode === 'APRV' ? 'APRV' : (S.mode === 'PSV' || S.mode === 'VS') ? 'SPONT' : S.vtype === 'SIMV' ? 'SIMV' : 'AC');
  function setFamily(f) {
    const cur = App.settings.mode;
    if (f === 'AC' || f === 'SIMV') { App.settings.vtype = f; setSetting('mode', ['VC', 'PC', 'PRVC'].includes(cur) ? cur : 'VC'); }
    else if (f === 'SPONT') setSetting('mode', cur === 'VS' ? 'VS' : 'PSV');
    else setSetting('mode', 'APRV');
  }
  function renderControls() {
    const S = App.settings, L = App.lock, mlock = L.includes('mode'), fam = familyOf(S);
    const famBtns = [['AC', 'A/CMV'], ['SIMV', 'SIMV'], ['SPONT', 'SPONT'], ['APRV', 'APRV']];
    const ctl = fam === 'SPONT' ? [['PSV', S.psupport > 0 ? 'PS' : 'CPAP'], ['VS', 'VS']] : fam === 'APRV' ? [] : [['VC', 'VC'], ['PC', 'PC'], ['PRVC', 'PRVC']];
    $('#modeTabs').innerHTML = `<div class="mseg" role="group" aria-label="Mode family">${famBtns.map(([f, t]) => `<button data-fam="${f}" aria-pressed="${fam === f}" ${mlock && fam !== f ? 'disabled' : ''}>${t}</button>`).join('')}</div>`
      + (ctl.length ? `<div class="mseg" role="group" aria-label="Breath type">${ctl.map(([m, t]) => `<button data-mode="${m}" aria-pressed="${S.mode === m}" ${mlock && S.mode !== m ? 'disabled' : ''}>${t}</button>`).join('')}</div>` : '');
    $('#modeTag').textContent = E.modeLabel(S);
    const keys = MODE_KNOBS[S.mode].slice();
    if (fam === 'SIMV') keys.push('psupport');
    let h = keys.map(k => knobHTML(k, (S.mode === 'PRVC' || S.mode === 'VS') && k === 'vt' ? { ...K.vt, l: 'Target VT' } : K[k], S[k], { locked: L.includes(k), changed: App.changedSettings[k] })).join('');
    if (S.mode === 'VC') h += segHTML('flow', 'Flow pattern', [['square', 'Square'], ['decel', 'Decel']], S.flow, L.includes('flow'));
    if (S.mode !== 'APRV') {
      h += segHTML('trig', 'Trigger', [['flow', 'Flow'], ['pressure', 'Pressure']], S.trig, L.includes('trig'));
      h += S.trig === 'flow' ? knobHTML('trig_f', K.trig_f, S.trig_f, { locked: L.includes('trig_f'), changed: App.changedSettings.trig_f })
        : knobHTML('trig_p', K.trig_p, S.trig_p, { locked: L.includes('trig_p'), changed: App.changedSettings.trig_p });
    }
    $('#knobs').innerHTML = h;
    $('#knobs2').innerHTML = fam === 'SPONT'
      ? `<div class="subhead">Apnea backup (pressure control)</div><div class="knobs">${Object.keys(BK).map(k => knobHTML(k, BK[k], getPath(S, k), { locked: L.includes('backup') })).join('')}</div>`
      : '';
    updateQuickKeys();
  }
  function renderAlarmKnobs() {
    $('#alarmKnobs').innerHTML = Object.keys(AK).map(k => knobHTML(k, AK[k], getPath(App.settings, k), { g: 'a' })).join('');
  }
  function renderPatient() {
    const P = App.patient, lk = App.patientLocked;
    const knob = k => knobHTML(k, PK[k], getPath(P, k), { g: 'p', locked: lk });
    const tog = (path, label) => `<label class="tog"><input type="checkbox" data-pt="${path}" ${getPath(P, path) ? 'checked' : ''} ${lk ? 'disabled' : ''}> ${esc(label)}</label>`;
    const pbw = E.pbw(P);
    $('#ptTag').textContent = `${P.sex === 'F' ? 'Female' : 'Male'} · ${P.height_cm} cm · PBW ${fmt(pbw, 1)} kg`;
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
      <div class="knobs">${['effort.pmax', 'effort.rate', 'effort.ti', 'effort.push', 'nif'].map(knob).join('')}</div>
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
    if (g === 's') {
      if (k.startsWith('backup.')) { App.settings.backup[k.split('.')[1]] = v; App.sim.setSettings(App.settings); renderControls(); }
      else setSetting(k, v);
    } else if (g === 'a') { App.settings.alarms[k.split('.')[1]] = v; App.sim.setSettings(App.settings); renderAlarmKnobs(); }
    else if (g === 'p') setPatient(k, v);
  }
  function defFor(g, k) { return g === 's' ? (K[k] || BK[k]) : g === 'a' ? AK[k] : PK[k]; }
  function curFor(g, k) { return g === 'p' ? getPath(App.patient, k) : getPath(App.settings, k); }
  document.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b || b.disabled) return;
    const kn = b.closest('.knob');
    if (b.dataset.d && kn) { const g = kn.dataset.g, k = kn.dataset.k, def = defFor(g, k); applyKnob(g, k, stepValue(def, +curFor(g, k), +b.dataset.d)); return; }
    if (b.dataset.seg) { const g = b.dataset.g, k = b.dataset.seg, v = b.dataset.v; if (g === 'p') setPatient(k, v); else setSetting(k, v); return; }
    if (b.dataset.fam) { if (!App.lock.includes('mode')) setFamily(b.dataset.fam); return; }
    if (b.dataset.mode) { if (!App.lock.includes('mode')) setSetting('mode', b.dataset.mode); return; }
    if (b.dataset.nt) { App.ntab = b.dataset.nt; $$('.ntabs button').forEach(x => x.setAttribute('aria-selected', String(x.dataset.nt === App.ntab))); renderNumerics(); return; }
    if (b.dataset.aux) { setAux(b.dataset.aux); return; }
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

  // ================================================================== quick keys, freeze, snapshot, aux
  $('#iholdBtn').onclick = () => { App.sim.queueHold('insp'); updateQuickKeys(); };
  $('#eholdBtn').onclick = () => { App.sim.queueHold('exp'); updateQuickKeys(); };
  $('#manualBtn').onclick = () => { App.sim.manualBreath(); toast('Manual breath'); };
  $('#p01Btn').onclick = () => { App.sim.queueManeuver('p01'); updateQuickKeys(); };
  $('#nifBtn').onclick = () => { App.sim.queueManeuver('nif'); updateQuickKeys(); };
  function updateQuickKeys() {
    if (!App.sim) return;
    const q = App.sim.holdQueued, mq = App.sim.maneuverQueued, oc = App.sim.occlusion;
    const set = (id, on, txtOn, txtOff) => { const b = $(id); b.classList.toggle('queued', !!on); b.textContent = on ? txtOn : txtOff; };
    set('#iholdBtn', q === 'insp', 'Hold on next breath…', 'Inspiratory hold');
    set('#eholdBtn', q === 'exp', 'Hold at end-exhalation…', 'Expiratory hold');
    set('#p01Btn', mq === 'p01' || (oc && oc.kind === 'p01'), 'P0.1 on next effort…', 'P0.1');
    set('#nifBtn', mq === 'nif' || (oc && oc.kind === 'nif'), oc && oc.kind === 'nif' ? 'NIF — occluded…' : 'NIF on next exhalation…', 'NIF');
    const H = App.hold, parts = [];
    if (H.p01 != null) parts.push(`P0.1 <b>${H.p01none ? 'no effort' : fmt(H.p01, 1)}</b>${H.p01none ? '' : ' cmH₂O'}`);
    if (H.nif != null) parts.push(`NIF <b>${H.nifnone ? 'no effort' : fmt(H.nif, 0)}</b>${H.nifnone ? '' : ' cmH₂O'}`);
    $('#manRes').innerHTML = parts.join(' · ');
  }
  function setFrozen(f) { App.frozen = f; $('#freezeBtn').setAttribute('aria-pressed', String(f)); $('#freezeBtn').textContent = f ? 'Run' : 'Freeze'; if (!f && App.cursor && App.cursor.src === 'live') App.cursor = null; }
  $('#freezeBtn').onclick = () => setFrozen(!App.frozen);
  $('#pmusBtn').onclick = () => { App.pmus = !App.pmus; $('#pmusBtn').setAttribute('aria-pressed', String(App.pmus)); };
  $('#sweepBtn').onclick = () => { const W = D.W === 12 ? 20 : D.W === 20 ? 6 : 12; resetBuffer(W); $('#sweepBtn').textContent = W + ' s'; };
  function setAux(a) {
    App.aux = a; $$('#auxSel button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.aux === a)));
    $$('canvas.wv').forEach(c => c.classList.toggle('tall', a !== 'none'));
    $('#vscreen').classList.toggle('tallv', a !== 'none');
    sizeCanvases(); renderNumerics(); if (a === 'pes') emit('pes');
  }
  $('#snapBtn').onclick = () => { takeSnapshot('Snapshot'); setCompare(true); emit('snap'); };
  $('#cmpToggle').onclick = () => setCompare(!App.compare);
  function setCompare(on) {
    App.compare = !!on && !!App.snap;
    $('#cmpToggle').setAttribute('aria-pressed', String(App.compare)); $('#cmpToggle').disabled = !App.snap;
    $('#waveGrid').classList.toggle('cmp', App.compare); $('#snapCol').hidden = !App.compare; $('#liveHead').hidden = !App.compare;
    sizeCanvases(); renderNumerics();
  }
  $('#pinLoop').onclick = () => { const L = loopPoints(D, lastCompleteBreathSlots(D)); if (L.length) { App.pinned = L; $('#clearLoop').hidden = false; emit('pin'); } };
  $('#clearLoop').onclick = () => { App.pinned = null; $('#clearLoop').hidden = true; };
  $('#sideToggle').onclick = () => { const hide = !document.body.classList.contains('noside'); document.body.classList.toggle('noside', hide); $('#sideToggle').setAttribute('aria-pressed', String(hide)); $('#sideToggle').textContent = hide ? 'Show lesson panel' : 'Hide lesson panel'; requestAnimationFrame(sizeCanvases); };

  function settingsSummary(S) {
    const f = E.modeLabel(S);
    if (S.mode === 'APRV') return `${f} · ${S.phigh}/${S.plow} · ${S.thigh}/${S.tlow} s · FiO₂ ${S.fio2.toFixed(2)}`;
    const main = S.mode === 'VC' || S.mode === 'PRVC' || S.mode === 'VS' ? `VT ${S.vt}` : S.mode === 'PC' ? `Pinsp ${S.pinsp}` : `PS ${S.psupport}`;
    return `${f} · ${main}${S.mode === 'PSV' || S.mode === 'VS' ? '' : ` · RR ${S.rr} · Ti ${S.ti}`} · PEEP ${S.peep} · FiO₂ ${S.fio2.toFixed(2)}`;
  }
  function takeSnapshot(label) {
    const s = { label, N: D.N, W: D.W, head: D.head, info: settingsSummary(App.settings), at: App.sim.t };
    for (const k of CH_KEYS.concat(['mark', 'ins', 'bidx'])) s[k] = D[k].slice();
    s.ctx = ctxNow(); s.ctx.b = s.ctx.b ? { ...s.ctx.b, pts: null } : null;
    s.loop = loopPoints(s, lastCompleteBreathSlots(s));
    App.snap = s;
    $('#snapLabel').textContent = label; $('#snapInfo').textContent = s.info;
    $('#cmpToggle').disabled = false;
  }

  // ================================================================== numerics (NKV-550 parameter set)
  function ctxNow() {
    const S = App.settings, P = App.patient, H = App.hold, now = App.sim ? App.sim.t : 0;
    const fresh = (v, t) => (v != null && now - t < 120 ? v : null);
    return { m: App.m4 ? { ...App.m4 } : {}, g: App.mg ? { ...App.mg } : {}, b: App.lastBreath, S: clone(S), P: clone(P), pbw: E.pbw(P),
      pplat: fresh(H.pplat, H.pplatT), ptot: fresh(H.ptot, H.ptotT), hvt: H.vt, hppeak: H.ppeak, hq: H.qEndIns,
      p01: H.p01 != null ? (H.p01none ? 'none' : H.p01) : null, nif: H.nif != null ? (H.nifnone ? 'none' : H.nif) : null,
      ptpExp: App.lastPtpExp, ptpHold: App.lastPtpHold, prvc: App.sim ? (S.mode === 'VS' ? App.sim.vsPinsp : App.sim.prvcPinsp) : null };
  }
  const peepRefOf = c => (c.ptot != null ? c.ptot : E.peepOf(c.S));
  const cstatOf = c => (c.pplat != null && c.hvt ? c.hvt / Math.max(0.5, c.pplat - peepRefOf(c)) : null);
  // [tab, colour class, label, value(ctx), unit, decimals, flag]
  const TILES = [
    ['main', 'paw', 'Ppeak', c => c.b && c.b.ppeak, 'cmH₂O', 0],
    ['main', 'paw', 'Pmean', c => c.b && c.b.pmean, 'cmH₂O', 0],
    ['main', 'paw', 'PEEP', c => E.peepOf(c.S), 'cmH₂O', 0],
    ['main', 'paw', 'Pplat', c => (c.pplat != null ? c.pplat : c.m.pplat_est), 'cmH₂O', 1, c => (c.pplat != null ? 'hold' : 'EST')],
    ['main', 'vol', 'VTe', c => c.b && c.b.vte, 'mL', 0],
    ['main', 'vol', 'VTi', c => c.b && c.b.vti, 'mL', 0],
    ['main', 'vol', 'VT/kg', c => c.b && c.b.vte / c.pbw, 'mL/kg', 1],
    ['main', 'vol', 'MV', c => c.m.mv, 'L/min', 1],
    ['main', 'flw', 'RR tot', c => c.m.rr_actual, '/min', 0],
    ['main', 'flw', 'I:E', c => (c.b ? '1:' + fmt(c.b.ie, 1) : null), '', 0],
    ['main', 'flw', 'Ti', c => c.b && c.b.ti, 's', 2],
    ['main', 'gas', 'FiO₂', c => c.S.fio2 * 100, '%', 0],
    ['main', 'gas', 'SpO₂', c => c.g.spo2, '%', 0],
    ['main', 'gas', 'EtCO₂', c => c.g.etco2, 'mmHg', 0],
    ['main', 'paw', 'Pinsp in use', c => (c.S.mode === 'PRVC' || c.S.mode === 'VS' ? c.prvc : undefined), 'cmH₂O', 0],
    ['mech', 'paw', 'Pplat', c => c.pplat, 'cmH₂O', 1, () => 'hold'],
    ['mech', 'paw', 'Pplat', c => c.m.pplat_est, 'cmH₂O', 1, () => 'EST'],
    ['mech', 'paw', 'Pdriving', c => (c.pplat != null ? c.pplat - peepRefOf(c) : null), 'cmH₂O', 1, () => 'hold'],
    ['mech', 'paw', 'Pdriving', c => c.m.pdriving_est, 'cmH₂O', 1, () => 'EST'],
    ['mech', 'paw', 'PEEPtot', c => c.ptot, 'cmH₂O', 1, () => 'hold'],
    ['mech', 'paw', 'PEEPi', c => (c.ptot != null ? Math.max(0, c.ptot - E.peepOf(c.S)) : null), 'cmH₂O', 1, () => 'hold'],
    ['mech', 'paw', 'PEEPi', c => c.m.peepi_est, 'cmH₂O', 1, () => 'EST'],
    ['mech', 'vol', 'Cstat', c => cstatOf(c), 'mL/cmH₂O', 0, () => 'hold'],
    ['mech', 'vol', 'Cstat/kg', c => { const v = cstatOf(c); return v != null ? v / c.pbw : null; }, 'mL/cmH₂O/kg', 2],
    ['mech', 'vol', 'C', c => c.m.c_est, 'mL/cmH₂O', 0, () => 'EST'],
    ['mech', 'flw', 'Ri stat', c => (c.pplat != null && c.hppeak != null && c.hq > 3 && c.S.mode === 'VC' ? (c.hppeak - c.pplat) / (c.hq / 60) : null), 'cmH₂O/L/s', 0, () => 'hold'],
    ['mech', 'flw', 'R', c => c.m.r_est, 'cmH₂O/L/s', 0, () => 'EST'],
    ['mech', 'flw', 'Re', c => c.m.re_est, 'cmH₂O/L/s', 0, () => 'EST'],
    ['mech', 'flw', 'TCe', c => c.m.tce, 's', 2],
    ['mech', 'vol', 'C20/C', c => c.m.c20c, '', 2],
    ['mech', 'paw', 'Mech. power', c => c.m.mech_power, 'J/min', 1],
    ['mech', 'vol', 'Leak @PEEP', c => c.m.leak_peep, 'L/min', 1],
    ['mech', 'vol', 'Leak', c => c.m.leak_pct, '%', 0],
    ['mech', 'vol', 'V leak', c => c.m.vleak, 'mL', 0],
    ['spont', 'flw', 'RR spont', c => c.m.rr_spont, '/min', 0],
    ['spont', 'vol', 'MV spont', c => c.m.mv_spont, 'L/min', 1],
    ['spont', 'flw', 'Ti spont', c => c.m.ti_spont, 's', 2],
    ['spont', 'flw', 'Ti/Ttot', c => (c.m.duty != null ? c.m.duty * 100 : null), '%', 0],
    ['spont', 'flw', 'RSBI', c => c.m.rsbi, 'bpm/L', 0],
    ['spont', 'flw', 'RSBI/kg', c => c.m.rsbi_kg, '', 1],
    ['spont', 'paw', 'P0.1', c => (c.p01 === 'none' ? 'no effort' : c.p01), 'cmH₂O', 1, () => 'maneuver'],
    ['spont', 'paw', 'NIF', c => (c.nif === 'none' ? 'no effort' : c.nif), 'cmH₂O', 0, () => 'maneuver'],
    ['spont', 'pes', 'Pmus', c => c.m.pmus, 'cmH₂O', 1],
    ['spont', 'pes', 'WOB pt', c => c.m.wob_pt, 'J/min', 1],
    ['spont', 'paw', 'PH mean', c => (c.S.mode === 'APRV' ? c.m.ph_mean : undefined), 'cmH₂O', 1],
    ['spont', 'paw', 'PL mean', c => (c.S.mode === 'APRV' ? c.m.pl_mean : undefined), 'cmH₂O', 1],
    ['spont', 'flw', 'TH:TL', c => (c.S.mode === 'APRV' && c.m.th_tl != null ? fmt(c.m.th_tl, 1) + ':1' : undefined), '', 0],
    ['spont', 'pes', 'Ptp exp', c => (App.aux === 'pes' ? c.ptpExp : undefined), 'cmH₂O', 1],
    ['spont', 'pes', 'Ptp insp', c => (App.aux === 'pes' ? c.ptpHold : undefined), 'cmH₂O', 1, () => 'hold'],
    ['gas', 'gas', 'SpO₂', c => c.g.spo2, '%', 0],
    ['gas', 'gas', 'PR', c => c.P.hr, '/min', 0],
    ['gas', 'gas', 'PI', c => c.P.pi, '%', 1],
    ['gas', 'gas', 'EtCO₂', c => c.g.etco2, 'mmHg', 0],
    ['gas', 'gas', 'VCO₂', c => c.m.vco2, 'mL/min', 0],
    ['gas', 'gas', 'Vd/Vt', c => c.g.vdvt, '', 2],
    ['gas', 'gas', 'FiO₂', c => c.S.fio2 * 100, '%', 0],
    ['gas', 'gas', 'Alv. vent', c => c.g.va, 'L/min', 1]
  ];
  function renderNumerics() {
    if (!App.sim) return;
    const c = ctxNow(), sc = App.compare && App.snap ? App.snap.ctx : null;
    const html = TILES.filter(t => t[0] === App.ntab).map(t => {
      const v = t[3](c); if (v === undefined) return '';
      const flag = t[6] ? t[6](c) : '';
      const num = typeof v === 'number' ? v : null;
      const stale = (flag === 'hold' || flag === 'maneuver') && v == null;
      const shown = typeof v === 'string' ? v : (num != null && isFinite(num) ? fmt(num, t[5]) : '—');
      const fl = (App._flash === 'pplat' && t[2] === 'Pplat' && flag === 'hold') || (App._flash === 'ptot' && (t[2] === 'PEEPtot' || t[2] === 'PEEPi') && flag === 'hold') || (App._flash === 'p01' && t[2] === 'P0.1') || (App._flash === 'nif' && t[2] === 'NIF');
      let cm = '';
      if (sc) {
        const sv = t[3](sc);
        if (sv !== undefined) {
          const sn = typeof sv === 'number' && isFinite(sv) ? sv : null;
          const d = sn != null && num != null && isFinite(num) ? num - sn : null;
          const dTxt = d == null ? '' : Math.abs(d) < Math.pow(10, -t[5]) / 2 ? ' · Δ 0' : ` · <span class="${d > 0 ? 'up' : 'dn'}">Δ ${d > 0 ? '+' : ''}${fmt(d, t[5])}</span>`;
          cm = `<div class="cm"><span class="snapv">snap ${typeof sv === 'string' ? esc(sv) : fmt(sn, t[5])}</span>${dTxt}</div>`;
        }
      }
      return `<div class="mt ${t[1]}${stale ? ' stale' : ''}${fl ? ' flash' : ''}"${stale ? ` title="${flag === 'hold' ? 'Needs an inspiratory or expiratory hold' : 'Press the maneuver key'}"` : ''}><div class="k"><span>${esc(t[2])}</span>${flag ? `<em>${esc(flag)}</em>` : ''}</div><div class="v">${stale ? '—' : esc(shown)}${!stale && t[4] && typeof v === 'number' ? `<small>${esc(t[4])}</small>` : ''}</div>${cm}</div>`;
    }).join('');
    $('#numGrid').innerHTML = html;
    App._flash = null;
  }
  function rolling(n) {
    const bs = App.sim.breaths; if (bs.length < 2) return null;
    const from = bs[Math.max(0, bs.length - n)].t0 - 1e-6;
    return E.computeMetrics(App.sim, from, App.sim.t);
  }
  function updateMonitor() {
    const sim = App.sim; if (!sim) return;
    App.m4 = rolling(4); App.mg = rolling(12) || App.m4;
    renderNumerics(); renderGas(); renderReadiness(); updateQuickKeys();
    const S = App.settings, b = App.lastBreath, g = App.mg;
    if (g) {
      const apnea = E.isSpontMode(S) && b && b.type === 'B';
      const al = E.alarmsFor(App.m4 || g, S, App.patient, { apnea });
      $('#alarmBar').innerHTML = al.length ? al.map(a => `<span class="al ${a.level}">${esc(a.text)}</span>`).join('') : '<span class="al none">No active alarms</span>';
    }
  }
  function renderGas() {
    const g = App.mg; if (!g) return;
    const cls = (v, lo, hi) => (v < lo ? 'lo' : v > hi ? 'hi' : '');
    $('#abg').innerHTML = `<div class="vlhead">Blood gas <span>steady-state estimate</span></div><div class="gasg">
      <div><span>pH</span><b class="${cls(g.ph, 7.35, 7.45)}">${fmt(g.ph, 2)}</b></div>
      <div><span>PaCO₂ mmHg</span><b class="${cls(g.paco2, 35, 45)}">${fmt(g.paco2, 0)}</b></div>
      <div><span>HCO₃ mEq/L</span><b>${fmt(App.patient.hco3, 0)}</b></div>
      <div><span>PaO₂ mmHg</span><b class="${cls(g.pao2, 60, 999)}">${fmt(g.pao2, 0)}</b></div>
      <div><span>SpO₂ %</span><b class="${cls(g.spo2, 88, 100)}">${fmt(g.spo2, 0)}</b></div>
      <div><span>P/F</span><b class="${cls(g.pf, 300, 9999)}">${fmt(g.pf, 0)}</b></div>
      <div><span>EtCO₂ mmHg</span><b>${fmt(g.etco2, 0)}</b></div>
      <div><span>Alv. vent L/min</span><b>${fmt(g.va, 1)}</b></div>
      <div><span>VD/VT</span><b>${fmt(g.vdvt, 2)}</b></div></div>`;
  }
  // liberation readiness: six bedside criteria; the border turns green when all are met
  function renderReadiness() {
    const m = App.m4, S = App.settings; if (!m) return;
    const support = S.mode === 'PSV' ? S.psupport : S.mode === 'PC' ? S.pinsp : S.mode === 'PRVC' ? App.sim.prvcPinsp : S.mode === 'VS' ? App.sim.vsPinsp : null;
    const items = [
      ['FiO₂ ≤ 0.50', S.fio2 <= 0.5, fmt(S.fio2, 2)],
      ['PEEP ≤ 8', E.peepOf(S) <= 8, fmt(E.peepOf(S), 0)],
      ['RSBI < 105', m.rsbi != null && m.rsbi < 105 && m.patient_trig_frac > 0.5, fmt(m.rsbi, 0)],
      ['MV < 10 L/min', m.mv != null && m.mv < 10, fmt(m.mv, 1)],
      ['Support ≤ 10', support != null && support <= 10, support != null ? fmt(support, 0) : S.mode === 'APRV' ? 'APRV' : 'VC'],
      ['Spontaneous breathing', m.patient_trig_frac >= 0.9, fmt(m.patient_trig_frac * 100, 0) + '%']
    ];
    const all = items.every(x => x[1]);
    const el = $('#readiness'); el.classList.toggle('all', all);
    el.innerHTML = `<div class="vlhead">Liberation readiness <span class="rv">${all ? 'All met — consider an SBT' : items.filter(x => x[1]).length + ' of 6 met'}</span></div><ul>${items.map(x => `<li class="${x[1] ? 'ok' : ''}"><i aria-hidden="true"></i><span>${esc(x[0])}</span><b>${esc(x[2])}</b></li>`).join('')}</ul>`;
  }

  // ================================================================== drawing helpers
  const CSSV = {};
  function readColors() { const cs = getComputedStyle(document.documentElement); ['--scr', '--scr-grid', '--scr-axis', '--scr-text', '--scr-dim', '--scr-hi', '--scr-acc', '--c-paw', '--c-flow', '--c-vol', '--c-pes', '--c-ptp', '--c-pmus', '--c-co2', '--c-ref', '--c-snap', '--s-good', '--s-warn', '--s-bad'].forEach(k => { CSSV[k] = cs.getPropertyValue(k).trim(); }); }
  const NICE = [5, 10, 15, 20, 25, 30, 40, 50, 60, 80, 100, 120, 150, 200, 250, 300, 400, 500, 600, 800, 1000, 1200, 1500, 2000, 3000];
  const niceUp = x => NICE.find(n => n >= x) || Math.ceil(x / 1000) * 1000;
  const scales = { paw: [0, 30], flow: [-60, 60], vol: [0, 600], pes: [-5, 30], co2: [0, 50] };
  function autoscale(sc, key, lo, hi, minHi, sym) {
    let tl, th;
    if (sym) { const a = niceUp(Math.max(Math.abs(lo), Math.abs(hi), minHi) * 1.1); tl = -a; th = a; }
    else { th = niceUp(Math.max(hi * 1.12, minHi)); tl = lo < 0 ? -niceUp(-lo * 1.2) : 0; }
    const cur = sc[key];
    if (th > cur[1] || th < cur[1] * 0.55 || tl < cur[0] || (tl > cur[0] * 0.55 && cur[0] < 0)) sc[key] = [tl, th];
  }
  function rangeOf(arr, n) { let lo = Infinity, hi = -Infinity; for (let i = 0; i < n; i++) { const v = arr[i]; if (v === v) { if (v < lo) lo = v; if (v > hi) hi = v; } } return [lo === Infinity ? 0 : lo, hi === -Infinity ? 0 : hi]; }
  function channels(aux) {
    const ch = [
      { key: 'paw', name: 'Paw', unit: 'cmH₂O', col: CSSV['--c-paw'] },
      { key: 'flow', name: 'Flow', unit: 'L/min', col: CSSV['--c-flow'], zero: true },
      { key: 'vol', name: 'Volume', unit: 'mL', col: CSSV['--c-vol'] }
    ];
    if (aux === 'pes') ch.push({ key: 'pes', name: 'Pes', unit: 'cmH₂O', col: CSSV['--c-pes'], zero: true, extra: { key: 'ptp', name: 'Ptp', col: CSSV['--c-ptp'] } });
    if (aux === 'co2') ch.push({ key: 'co2', name: 'CO₂', unit: 'mmHg', col: CSSV['--c-co2'] });
    return ch;
  }
  const MARK_TXT = { 1: 'P', 2: 'B', 3: 'S' };
  // src: buffer-like {N, head, paw[], flow[], ..., mark[], ins[]}; opts: {aux, pmus, seconds, cursor, frozen, peep, co2scale}
  function drawWaves(ctx, w, h, src, sc, opts) {
    const chs = channels(opts.aux);
    ctx.fillStyle = CSSV['--scr']; ctx.fillRect(0, 0, w, h);
    const L = 40, R = 8, top = 4, gapY = 6, ph = (h - top - gapY * (chs.length - 1) - 16) / chs.length;
    const n = src.N, xOf = i => L + (i / (n - 1)) * (w - L - R);
    const val = (k, i) => (k === 'co2' ? src.co2[i] * opts.co2scale : src[k][i]);
    const out = [];
    chs.forEach((c, ci) => {
      const y0 = top + ci * (ph + gapY), lo = sc[c.key][0], hi = sc[c.key][1];
      const yOf = v => y0 + ph - ((v - lo) / (hi - lo)) * ph;
      ctx.fillStyle = 'rgba(255,255,255,0.035)';
      let run = -1;
      for (let i = 0; i <= n; i++) { const on = i < n && src.ins[i]; if (on && run < 0) run = i; if (!on && run >= 0) { ctx.fillRect(xOf(run), y0, xOf(i - 1) - xOf(run), ph); run = -1; } }
      ctx.strokeStyle = CSSV['--scr-grid']; ctx.lineWidth = 1; ctx.font = '11px "IBM Plex Sans", system-ui, sans-serif'; ctx.fillStyle = CSSV['--scr-dim']; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      const ticks = [lo, (lo + hi) / 2, hi]; if (lo < 0 && hi > 0) ticks.splice(1, 1, 0);
      ticks.forEach(t => { const y = yOf(t); ctx.beginPath(); ctx.moveTo(L, y + 0.5); ctx.lineTo(w - R, y + 0.5); ctx.stroke(); ctx.fillText(String(Math.round(t)), L - 5, Math.min(Math.max(y, y0 + 6), y0 + ph - 6)); });
      if (c.zero && lo < 0) { ctx.strokeStyle = CSSV['--scr-axis']; ctx.beginPath(); ctx.moveTo(L, yOf(0) + 0.5); ctx.lineTo(w - R, yOf(0) + 0.5); ctx.stroke(); }
      ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillStyle = c.col; ctx.font = '600 12px "IBM Plex Sans", system-ui, sans-serif';
      ctx.fillText(`${c.name} ${c.unit}`, L + 6, y0 + 2);
      if (c.extra) { ctx.fillStyle = c.extra.col; ctx.fillText(c.extra.name, L + 110, y0 + 2); }
      if (c.key === 'paw' && opts.peep != null) { ctx.setLineDash([3, 4]); ctx.strokeStyle = CSSV['--scr-axis']; ctx.beginPath(); ctx.moveTo(L, yOf(opts.peep) + 0.5); ctx.lineTo(w - R, yOf(opts.peep) + 0.5); ctx.stroke(); ctx.setLineDash([]); }
      const trace = (key, col, dash, width) => {
        ctx.strokeStyle = col; ctx.lineWidth = width || 1.8; ctx.setLineDash(dash || []); ctx.lineJoin = 'round'; ctx.beginPath(); let pen = false;
        for (let i = 0; i < n; i++) { const v = val(key, i); if (v !== v) { pen = false; continue; } const x = xOf(i), y = Math.min(y0 + ph, Math.max(y0, yOf(v))); if (!pen) { ctx.moveTo(x, y); pen = true; } else ctx.lineTo(x, y); }
        ctx.stroke(); ctx.setLineDash([]);
      };
      if (c.key === 'paw' && opts.pmus) trace('pmus', CSSV['--c-pmus'], [5, 4], 1.5);
      if (c.extra) trace(c.extra.key, c.extra.col, null, 1.5);
      trace(c.key, c.col);
      if (c.key === 'paw') {
        ctx.font = '700 11px "Barlow Condensed", system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        for (let i = 0; i < n; i++) { const mk = src.mark[i]; if (!mk) continue; const x = xOf(i); ctx.fillStyle = mk === 2 ? CSSV['--c-pmus'] : mk === 3 ? CSSV['--c-snap'] : '#e8f4fa'; ctx.beginPath(); ctx.arc(x, y0 + 22, 7, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#05131a'; ctx.fillText(MARK_TXT[mk], x, y0 + 22.5); }
        if (opts.pmus) { ctx.fillStyle = CSSV['--c-pmus']; ctx.font = '600 12px "IBM Plex Sans", system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText('Pmus (effort)', L + 120, y0 + 2); }
      }
      out.push({ c, y0, ph, yOf });
    });
    if (src.head != null && !opts.frozen) { const x = xOf(src.head); ctx.fillStyle = 'rgba(232,244,250,0.5)'; ctx.fillRect(x, top, 1.5, h - 20); }
    ctx.fillStyle = CSSV['--scr-dim']; ctx.font = '11px "IBM Plex Sans", system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    const secs = opts.seconds, stepS = secs > 14 ? 5 : secs > 7 ? 2 : 1;
    for (let s = 0; s <= secs + 1e-6; s += stepS) ctx.fillText(s + ' s', L + (s / secs) * (w - L - R) - (s >= secs ? 8 : 0), h - 1);
    if (opts.cursor != null) {
      const i = opts.cursor, x = xOf(i);
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x + 0.5, top); ctx.lineTo(x + 0.5, h - 16); ctx.stroke();
      out.forEach(({ c, y0, yOf }) => {
        const v = val(c.key, i); if (v !== v) return;
        const lbl = `${c.name} ${fmt(v, c.key === 'vol' || c.key === 'flow' || c.key === 'co2' ? 0 : 1)}` + (c.extra ? `  ${c.extra.name} ${fmt(val(c.extra.key, i), 1)}` : '') + (c.key === 'paw' && opts.pmus ? `  Pmus ${fmt(val('pmus', i), 1)}` : '');
        ctx.font = '600 12px "IBM Plex Sans", system-ui, sans-serif'; const tw = ctx.measureText(lbl).width + 10;
        const bx = Math.min(w - R - tw, x + 8), by = y0 + 18;
        ctx.fillStyle = 'rgba(5,10,14,0.88)'; ctx.fillRect(bx, by, tw, 18); ctx.fillStyle = c.col; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(lbl, bx + 5, by + 9.5);
        ctx.fillStyle = c.col; ctx.beginPath(); ctx.arc(x, yOf(v), 3, 0, Math.PI * 2); ctx.fill();
      });
    }
  }

  // ---------------------------------------------------------------- loops from the same buffer
  const valid = (src, i) => src.paw[i] === src.paw[i] && src.bidx[i] >= 0;
  // slots of one breath, in time order, ending at (or containing) slot `at`
  function breathSlots(src, at, whole) {
    const N = src.N; if (!valid(src, at)) return [];
    const b = src.bidx[at], back = []; let i = at, k = 0;
    while (k < N && valid(src, i) && src.bidx[i] === b) { back.push(i); i = (i - 1 + N) % N; k++; }
    back.reverse();
    if (whole) { let j = (at + 1) % N; while (k < N && valid(src, j) && src.bidx[j] === b) { back.push(j); j = (j + 1) % N; k++; } }
    return back;
  }
  function prevBreathSlots(src, slots) {
    if (!slots.length) return [];
    const N = src.N, j = (slots[0] - 1 + N) % N;
    return valid(src, j) && src.bidx[j] === src.bidx[slots[0]] - 1 ? breathSlots(src, j, false) : [];
  }
  function lastCompleteBreathSlots(src) { return prevBreathSlots(src, breathSlots(src, src.head, false)); }
  const loopPoints = (src, slots) => slots.map(i => [src.paw[i], src.flow[i], src.vol[i], src.ins[i]]);

  function sizeCanvas(c) { const dpr = window.devicePixelRatio || 1, r = c.getBoundingClientRect(); if (!r.width || !r.height) return null; c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr); const x = c.getContext('2d'); x.setTransform(dpr, 0, 0, dpr, 0, 0); return { w: r.width, h: r.height }; }
  const SZ = {};
  function sizeCanvases() { ['waveCv', 'waveSnap', 'pvLoop', 'fvLoop', 'lungCv', 'timingCv'].forEach(id => { const el = document.getElementById(id); SZ[id] = el && el.offsetParent !== null ? sizeCanvas(el) : null; }); }
  window.addEventListener('resize', () => requestAnimationFrame(sizeCanvases));
  if (window.ResizeObserver) new ResizeObserver(() => requestAnimationFrame(sizeCanvases)).observe($('#vscreen'));
  if (window.matchMedia) { const mq = window.matchMedia('(prefers-color-scheme: dark)'); if (mq.addEventListener) mq.addEventListener('change', readColors); }

  function drawLoop(id, kind, layers) {
    const sz = SZ[id]; if (!sz) return; const cv = document.getElementById(id), ctx = cv.getContext('2d'), w = sz.w, h = sz.h;
    ctx.fillStyle = CSSV['--scr']; ctx.fillRect(0, 0, w, h);
    const L = 34, B = 18, T = 8, R = 10;
    const [xlo, xhi] = kind === 'pv' ? [Math.min(0, scales.paw[0]), scales.paw[1]] : [Math.min(0, scales.vol[0]), scales.vol[1]];
    const [ylo, yhi] = kind === 'pv' ? [Math.min(0, scales.vol[0]), scales.vol[1]] : scales.flow;
    const X = v => L + ((v - xlo) / (xhi - xlo)) * (w - L - R), Y = v => T + (1 - (v - ylo) / (yhi - ylo)) * (h - T - B);
    ctx.strokeStyle = CSSV['--scr-grid']; ctx.lineWidth = 1; ctx.font = '11px "IBM Plex Sans", system-ui, sans-serif'; ctx.fillStyle = CSSV['--scr-dim'];
    const yt = [ylo, (ylo + yhi) / 2, yhi]; if (ylo < 0) yt.splice(1, 1, 0);
    yt.forEach(v => { ctx.beginPath(); ctx.moveTo(L, Y(v) + 0.5); ctx.lineTo(w - R, Y(v) + 0.5); ctx.stroke(); ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.fillText(String(Math.round(v)), L - 4, Math.min(Math.max(Y(v), T + 5), h - B - 5)); });
    [xlo, (xlo + xhi) / 2, xhi].forEach(v => { ctx.beginPath(); ctx.moveTo(X(v) + 0.5, T); ctx.lineTo(X(v) + 0.5, h - B); ctx.stroke(); ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillText(String(Math.round(v)), Math.min(Math.max(X(v), L + 8), w - R - 10), h - 1); });
    if (ylo < 0) { ctx.strokeStyle = CSSV['--scr-axis']; ctx.beginPath(); ctx.moveTo(L, Y(0) + 0.5); ctx.lineTo(w - R, Y(0) + 0.5); ctx.stroke(); }
    ctx.textAlign = 'right'; ctx.textBaseline = 'bottom'; ctx.fillStyle = CSSV['--scr-dim']; ctx.fillText(kind === 'pv' ? 'Paw cmH₂O' : 'Volume mL', w - R, h - B - 3);
    ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText(kind === 'pv' ? 'Volume mL' : 'Flow L/min', L + 4, T);
    const px = p => (kind === 'pv' ? X(p[0]) : X(p[2])), py = p => (kind === 'pv' ? Y(p[2]) : Y(p[1]));
    let legendY = T + 14;
    layers.forEach(Ly => {
      const P = Ly.pts; if (!P || P.length < 2) return;
      ctx.lineJoin = 'round';
      if (Ly.style === 'cur') {
        // inspiration in the channel colour, expiration in white, so the direction of travel reads at a glance
        for (let i = 1; i < P.length; i++) {
          ctx.strokeStyle = P[i][3] ? (kind === 'pv' ? CSSV['--c-vol'] : CSSV['--c-flow']) : 'rgba(232,244,250,0.85)';
          ctx.lineWidth = 2.2; ctx.beginPath(); ctx.moveTo(px(P[i - 1]), py(P[i - 1])); ctx.lineTo(px(P[i]), py(P[i])); ctx.stroke();
        }
        const d = P[Ly.dot != null && Ly.dot >= 0 ? Ly.dot : P.length - 1];
        if (d) { ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(px(d), py(d), 4.5, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = CSSV['--scr-acc']; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(px(d), py(d), 8, 0, Math.PI * 2); ctx.stroke(); }
      } else {
        ctx.strokeStyle = Ly.style === 'snap' ? CSSV['--c-snap'] : Ly.style === 'ref' ? CSSV['--c-ref'] : 'rgba(168,188,200,0.35)';
        ctx.lineWidth = Ly.style === 'prev' ? 1.4 : 1.8; ctx.setLineDash(Ly.style === 'prev' ? [] : [5, 4]);
        ctx.beginPath(); P.forEach((p, i) => { if (i) ctx.lineTo(px(p), py(p)); else ctx.moveTo(px(p), py(p)); }); ctx.stroke(); ctx.setLineDash([]);
        if (Ly.label) { ctx.fillStyle = ctx.strokeStyle; ctx.textAlign = 'right'; ctx.textBaseline = 'top'; ctx.font = '600 11px "IBM Plex Sans", system-ui, sans-serif'; ctx.fillText(Ly.label, w - R - 2, legendY); legendY += 14; ctx.font = '11px "IBM Plex Sans", system-ui, sans-serif'; }
      }
    });
  }
  function drawLoopsNow() {
    const cur = App.cursor;
    let src = D, at = D.head, whole = false;
    if (cur && cur.src === 'snap' && App.snap) { src = App.snap; at = cur.i; whole = true; }
    else if (cur && App.frozen) { at = cur.i; whole = true; }
    let slots = breathSlots(src, at, whole);
    if (!slots.length) { slots = lastCompleteBreathSlots(src); whole = true; at = slots[slots.length - 1]; }
    const prev = prevBreathSlots(src, slots);
    const pts = loopPoints(src, slots);
    const dot = whole ? slots.indexOf(at) : pts.length - 1;
    const layers = [];
    if (App.pinned) layers.push({ pts: App.pinned, style: 'ref', label: 'Pinned' });
    if (App.compare && App.snap && src !== App.snap) layers.push({ pts: App.snap.loop, style: 'snap', label: App.snap.label });
    if (!whole) layers.push({ pts: loopPoints(src, prev), style: 'prev' });
    layers.push({ pts, style: 'cur', dot });
    drawLoop('pvLoop', 'pv', layers);
    drawLoop('fvLoop', 'fv', layers);
  }

  // ---------------------------------------------------------------- dynamic lung
  function drawLung() {
    const sz = SZ.lungCv; if (!sz) return; const ctx = $('#lungCv').getContext('2d'), w = sz.w, h = sz.h;
    ctx.clearRect(0, 0, w, h);
    const i = App.frozen && App.cursor && App.cursor.src === 'live' ? App.cursor.i : D.head;
    const vol = D.vol[i] === D.vol[i] ? D.vol[i] : 0, pm = D.pmus[i] === D.pmus[i] ? D.pmus[i] : 0;
    const m = App.m4 || {}, P = App.patient;
    const C = m.c_est || P.c, R = m.r_est || P.r;
    const vref = Math.max(300, scales.vol[1]);
    const s = 0.72 + 0.28 * clamp(vol / vref, 0, 1.1);
    const cx = w / 2, cy = h * 0.5, lw = Math.min(w * 0.19, 76), lh = Math.min(h * 0.34, 74);
    const stiff = clamp((50 - C) / 35, 0, 1);       // 0 healthy → 1 very stiff
    const lungCol = stiff < 0.33 ? '78,195,138' : stiff < 0.66 ? '224,169,53' : '255,107,107';
    const rCol = R <= 15 ? CSSV['--s-good'] : R <= 25 ? CSSV['--s-warn'] : CSSV['--s-bad'];
    const bw = clamp(9 - R / 5, 2, 8);
    const dy = clamp(pm, -6, 14) * 1.6;           // diaphragm descends with patient effort
    ctx.strokeStyle = 'rgba(255,111,158,0.85)'; ctx.lineWidth = 3; ctx.beginPath();
    ctx.moveTo(cx - lw * 2.6, cy + lh * 1.08 + dy); ctx.quadraticCurveTo(cx, cy + lh * 0.58 + dy * 1.3, cx + lw * 2.6, cy + lh * 1.08 + dy); ctx.stroke();
    [-1, 1].forEach(side => {
      const x = cx + side * lw * 1.25;
      ctx.save(); ctx.translate(x, cy); ctx.scale(s, s);
      ctx.fillStyle = `rgba(${lungCol},${0.22 + 0.25 * stiff})`; ctx.strokeStyle = `rgba(${lungCol},0.95)`; ctx.lineWidth = 2 / s;
      ctx.beginPath(); ctx.ellipse(0, 0, lw, lh, side * 0.12, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.restore();
    });
    ctx.strokeStyle = rCol; ctx.lineCap = 'round'; ctx.lineWidth = bw;
    ctx.beginPath(); ctx.moveTo(cx, cy - lh * 1.25); ctx.lineTo(cx, cy - lh * 0.35);
    ctx.moveTo(cx, cy - lh * 0.35); ctx.lineTo(cx - lw * 0.95 * s, cy - lh * 0.05);
    ctx.moveTo(cx, cy - lh * 0.35); ctx.lineTo(cx + lw * 0.95 * s, cy - lh * 0.05); ctx.stroke();
    ctx.lineWidth = Math.max(1.5, bw * 0.55);
    [-1, 1].forEach(sd => { ctx.beginPath(); ctx.moveTo(cx + sd * lw * 0.95 * s, cy - lh * 0.05); ctx.lineTo(cx + sd * lw * 1.35 * s, cy + lh * 0.3); ctx.moveTo(cx + sd * lw * 0.95 * s, cy - lh * 0.05); ctx.lineTo(cx + sd * lw * 1.5 * s, cy - lh * 0.25); ctx.stroke(); });
    const since = App.sim ? App.sim.t - (App._lastTrigT || -99) : 99;
    if (since < 0.6 && !App.frozen) { ctx.fillStyle = `rgba(232,244,250,${1 - since / 0.6})`; ctx.font = '700 13px "Barlow Condensed", system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'; ctx.fillText('PATIENT TRIGGER', cx, Math.min(h - 16, cy + lh * 1.08 + dy + 18)); }
    if (P.disconnect) { ctx.strokeStyle = CSSV['--s-bad']; ctx.lineWidth = 3; const ty = cy - lh * 1.3; ctx.beginPath(); ctx.moveTo(cx - 12, ty - 10); ctx.lineTo(cx + 12, ty + 10); ctx.moveTo(cx + 12, ty - 10); ctx.lineTo(cx - 12, ty + 10); ctx.stroke(); }
    ctx.font = '11px "IBM Plex Sans", system-ui, sans-serif'; ctx.textBaseline = 'top';
    ctx.fillStyle = `rgb(${lungCol})`; ctx.textAlign = 'left'; ctx.fillText(`C ${fmt(C, 0)} mL/cmH₂O`, 2, 2);
    ctx.fillStyle = rCol; ctx.textAlign = 'right'; ctx.fillText(`R ${fmt(R, 0)} cmH₂O/L/s`, w - 2, 2);
    ctx.fillStyle = CSSV['--c-pmus']; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'; ctx.fillText(`Pmus ${fmt(Math.max(0, pm), 1)}`, 2, h - 2);
    ctx.fillStyle = CSSV['--c-vol']; ctx.textAlign = 'right'; ctx.fillText(`V ${fmt(vol, 0)} mL`, w - 2, h - 2);
    $('#lungNote').textContent = m.c_est ? 'sized by estimated C and R' : '';
  }
  // ---------------------------------------------------------------- breath timing bar
  function drawTiming() {
    const sz = SZ.timingCv; if (!sz) return; const ctx = $('#timingCv').getContext('2d'), w = sz.w, h = sz.h;
    ctx.clearRect(0, 0, w, h);
    const b = App.lastBreath; if (!b) return;
    const i = App.frozen && App.cursor && App.cursor.src === 'live' ? App.cursor.i : D.head;
    const slots = breathSlots(D, i, App.frozen);
    let elapsed = 0, insIdx = -1;
    if (slots.length) { const k = App.frozen ? slots.indexOf(i) : slots.length - 1; elapsed = k * D.DT; insIdx = slots.findIndex(j => !D.ins[j]); }
    const tTot = Math.max(b.ttot, elapsed + 0.05), ti = insIdx > 0 ? insIdx * D.DT : b.ti;
    const L = 4, R = 4, y = 4, bh = 18, X = t => L + (t / tTot) * (w - L - R);
    ctx.fillStyle = '#16232b'; ctx.fillRect(L, y, w - L - R, bh);
    ctx.fillStyle = 'rgba(70,195,230,0.8)'; ctx.fillRect(L, y, X(ti) - L, bh);
    ctx.fillStyle = 'rgba(232,244,250,0.16)'; ctx.fillRect(X(ti), y, X(tTot) - X(ti), bh);
    ctx.font = '600 11px "IBM Plex Sans", system-ui, sans-serif'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    ctx.fillStyle = '#04161d'; if (X(ti) - L > 52) ctx.fillText(`Ti ${fmt(ti, 2)} s`, L + 5, y + bh / 2 + 0.5);
    ctx.fillStyle = CSSV['--scr-text']; if (X(tTot) - X(ti) > 62) ctx.fillText(`Te ${fmt(tTot - ti, 2)} s`, X(ti) + 5, y + bh / 2 + 0.5);
    const xm = X(Math.min(elapsed, tTot)); ctx.fillStyle = '#ffffff'; ctx.fillRect(xm - 1, y - 3, 2, bh + 6);
    ctx.fillStyle = CSSV['--scr-dim']; ctx.textBaseline = 'top'; ctx.textAlign = 'left';
    ctx.fillText(`${b.type === 'P' ? 'Patient-triggered' : b.type === 'S' ? 'Spontaneous' : b.type === 'B' ? 'Backup' : 'Time-triggered'} · ${b.spont ? 'flow-cycled' : 'time-cycled'}`, L, y + bh + 8);
    ctx.textAlign = 'right'; ctx.fillText(`I:E 1:${fmt(b.ie, 1)}`, w - R, y + bh + 8);
    $('#timingNote').textContent = `last breath ${fmt(b.ttot, 2)} s`;
  }

  // ---------------------------------------------------------------- live waves (+ snapshot side by side)
  function drawScreens() {
    const co2scale = App.mg ? App.mg.etco2 : 35;
    const srcs = [D].concat(App.compare && App.snap ? [App.snap] : []);
    const R = k => { let lo = Infinity, hi = -Infinity; srcs.forEach(s => { const [a, b] = rangeOf(s[k], s.N); lo = Math.min(lo, a); hi = Math.max(hi, b); }); return [lo, hi]; };
    const [plo, phi] = R('paw'), [flo, fhi] = R('flow'), [vlo, vhi] = R('vol');
    autoscale(scales, 'paw', Math.min(plo, 0), Math.max(phi, App.pmus ? R('pmus')[1] : 0), 20, false);
    autoscale(scales, 'flow', flo, fhi, 40, true);
    autoscale(scales, 'vol', vlo < -60 ? vlo : 0, vhi, 300, false);
    if (App.aux === 'pes') { const [a, b] = R('pes'), [c2, d] = R('ptp'); autoscale(scales, 'pes', Math.min(a, c2, 0), Math.max(b, d), 20, false); }
    if (App.aux === 'co2') scales.co2 = [0, niceUp(Math.max(40, co2scale * 1.25))];
    const cur = App.cursor;
    if (SZ.waveCv) drawWaves($('#waveCv').getContext('2d'), SZ.waveCv.w, SZ.waveCv.h, D, scales, { aux: App.aux, pmus: App.pmus, seconds: D.W, cursor: cur && cur.src === 'live' && App.frozen ? cur.i : null, frozen: App.frozen, peep: E.peepOf(App.settings), co2scale });
    if (App.compare && App.snap && SZ.waveSnap) {
      const sn = App.snap;
      drawWaves($('#waveSnap').getContext('2d'), SZ.waveSnap.w, SZ.waveSnap.h, sn, scales, { aux: App.aux, pmus: App.pmus, seconds: sn.W, cursor: cur && cur.src === 'snap' ? cur.i : null, frozen: true, peep: E.peepOf(sn.ctx.S), co2scale: sn.ctx.g.etco2 || co2scale });
      $('#liveInfo').textContent = settingsSummary(App.settings);
    }
  }
  function cursorAt(e, cv, src) {
    const r = cv.getBoundingClientRect(), L = 40, Rr = 8;
    const x = Math.min(Math.max(e.clientX - r.left, L), r.width - Rr);
    let i = Math.round(((x - L) / (r.width - L - Rr)) * (src.N - 1));
    for (let k = 0; k < 40 && src.paw[i] !== src.paw[i]; k++) i = (i - 1 + src.N) % src.N;   // step out of the sweep gap
    return i;
  }
  ['pointermove', 'pointerdown'].forEach(ev => {
    $('#waveCv').addEventListener(ev, e => { if (App.frozen) App.cursor = { src: 'live', i: cursorAt(e, $('#waveCv'), D) }; });
    $('#waveSnap').addEventListener(ev, e => { if (App.snap) App.cursor = { src: 'snap', i: cursorAt(e, $('#waveSnap'), App.snap) }; });
  });
  $('#waveSnap').addEventListener('pointerleave', () => { if (App.cursor && App.cursor.src === 'snap') App.cursor = null; });

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
        updateMonitor();
        if (ev) emit(ev === 'insp' ? 'ihold' : ev === 'exp' ? 'ehold' : ev);
      }
      if (App.sim.maneuverQueued || App.sim.occlusion || App.sim.holdQueued) updateQuickKeys();
    }
    drawScreens(); drawLoopsNow(); drawLung(); drawTiming();
    $('#phaseTag').textContent = App.sim ? ({ insp: 'Inspiration', pause: 'Inspiratory pause', ihold: 'Inspiratory hold', ehold: 'Expiratory hold', exp: 'Expiration', occl: 'Airway occluded' }[App.sim.phase] || '') : '';
    requestAnimationFrame(frame);
  }

  // ================================================================== views
  $$('.views button').forEach(b => b.onclick = () => { if (b.dataset.view === 'tutorials') { App.tut = null; clearTutorial(); } setView(b.dataset.view); });
  function setView(v, opts) {
    App.view = v;
    $$('.views button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.view === v)));
    clearTutorial();
    if (!(opts && opts.keep)) { App.caseObj = null; App.lock = []; App.patientLocked = false; renderControls(); renderPatient(); }
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
    App.pmus = !!(c.view && c.view.pmus); $('#pmusBtn').setAttribute('aria-pressed', String(App.pmus));
    setAux(c.view && c.view.pes ? 'pes' : c.view && c.view.co2 ? 'co2' : 'none');
    const st = custom ? { settings: E.normSettings(c.start.settings), patient: E.normPatient(c.start.patient) } : CUR.startState(c);
    App.cs = { start: clone(st), submitted: false, result: null, answer: null, numeric: null, showTable: false };
    load(st.settings, st.patient);
    App.autoCompare = false; setCompare(false); takeSnapshot('Case start');
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
      if (cs.answer != null) body += `<div class="verdict ${c.choices[cs.answer].correct ? 'pass' : 'fail'}"><b>${c.choices[cs.answer].correct ? 'Correct' : 'Not quite'}</b>${c.then ? 'The change is now running. The screen shows the case start and the live patient side by side.' : ''}</div><div class="row"><button class="btn" id="resetCase">Try again</button></div>`;
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
    if ($('#cmpBtn')) $('#cmpBtn').onclick = openCompare;
    if ($('#modelBtn')) $('#modelBtn').onclick = () => { const a = CUR.solutionState(c); App.changedSettings = {}; App.settings = E.normSettings(a.settings); Object.keys(c.solution.settings || {}).forEach(k => { App.changedSettings[k] = true; }); App.sim.setSettings(App.settings); maybeAutoCompare(); renderControls(); toast('Model answer loaded on the ventilator'); };
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
      App.autoCompare = true; setCompare(true);
    }
    renderCase();
  }
  function checkNumeric() {
    const c = App.caseObj, cs = App.cs, v = parseFloat(String($('#numAns').value).replace(',', '.'));
    if (!isFinite(v)) { toast('Type a number first'); return; }
    const truth = CUR.truthFor(c), ok = CUR.checkNumeric(c, v, truth);
    cs.numeric = { value: v, truth, ok }; setProgress(c.id, ok ? 'pass' : 'tried'); renderCase();
  }

  // ---------------------------------------------------------------- comparison dialog (case start / yours / model answer)
  function openCompare() {
    const c = App.caseObj, cs = App.cs;
    const cols = [{ title: 'Case start', st: cs.start }, { title: 'Your settings', st: { settings: App.settings, patient: App.patient } }];
    if (c.solution && cs.submitted) cols.push({ title: 'Model answer', st: CUR.solutionState(c) });
    const runs = cols.map(col => ({ ...col, r: E.simulate(col.st.settings, col.st.patient, { warmup: 60, seconds: 12, sampleDt: 0.02 }) }));
    const sc = { paw: [0, 30], flow: [-60, 60], vol: [0, 600], pes: [-5, 30], co2: [0, 50] };
    runs.forEach(x => { const s = x.r.samples; autoscale(sc, 'paw', 0, Math.max(...s.map(p => p.paw), ...(c.view && c.view.pmus ? s.map(p => p.pmus) : [0])), 20, false); autoscale(sc, 'flow', Math.min(...s.map(p => p.flow)), Math.max(...s.map(p => p.flow)), 40, true); autoscale(sc, 'vol', 0, Math.max(...s.map(p => p.vol)), 300, false); });
    $('#cmpGrid').innerHTML = runs.map((x, i) => `<div class="cmpcol"><h3>${esc(x.title)}</h3><canvas id="cmp${i}" role="img" aria-label="${esc(x.title)} waveforms"></canvas></div>`).join('');
    $('#cmpDlg').hidden = false;
    runs.forEach((x, i) => {
      const cv = $('#cmp' + i), sz = sizeCanvas(cv); if (!sz) return;
      const s = x.r.samples, n = s.length;
      const src = { N: n, head: null, mark: new Uint8Array(n), ins: new Uint8Array(n), bidx: new Int32Array(n) };
      CH_KEYS.forEach(k => { src[k] = Float32Array.from(s.map(p => (p[k] == null ? NaN : p[k]))); });
      s.forEach((p, j) => { src.mark[j] = MARK[p.mark] || 0; src.ins[j] = (p.phase === 'insp' || p.phase === 'pause' || p.phase === 'ihold') ? 1 : 0; src.bidx[j] = p.breath; });
      drawWaves(cv.getContext('2d'), sz.w, sz.h, src, sc, { aux: 'none', pmus: c.view && c.view.pmus, seconds: 12, frozen: true, peep: E.peepOf(E.normSettings(x.st.settings)), co2scale: 35 });
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
    App.pmus = !!(t.setup.patient && t.setup.patient.effort && t.setup.patient.effort.on); $('#pmusBtn').setAttribute('aria-pressed', String(App.pmus));
    setAux(t.setup.view && t.setup.view.pes ? 'pes' : t.setup.view && t.setup.view.co2 ? 'co2' : 'none');
    load(st.settings, st.patient); App.snap = null; setCompare(false);
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
    const waitTxt = s.wait ? ({ ihold: 'Press "Inspiratory hold" and wait for the next breath.', ehold: 'Press "Expiratory hold" and wait for the end of the next exhalation.', mode: `Switch the mode to ${s.wait.v === 'PSV' ? 'SPONT (pressure support)' : s.wait.v}.`, pin: 'Press "Pin" on the P–V loop.', pes: 'Choose Aux → Pes.', snap: 'Press "Snapshot".', p01: 'Press "P0.1" and wait for the next effort.', nif: 'Press "NIF" and wait about 10 seconds.' }[s.wait.ev]) : '';
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
        m.onclick = () => { App.tutStep = k; App.tutWaitDone = false; setFrozen(true); renderTutorial(); };
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
      <p class="muted small">Pick a patient, change anything, break things on purpose. Events take a snapshot first, so you see before and after side by side.</p>
      <h3>Patients</h3><div class="cardlist">${Object.keys(E.PRESETS).map(k => `<button class="card" data-preset="${k}" ${App.preset === k ? 'aria-current="true"' : ''}><b>${esc(E.PRESETS[k].label)}</b><span>${esc(presetBlurb(k))}</span></button>`).join('')}</div>
      <h3>Events</h3><div class="grid2b">${QUICK.map((q, i) => `<button class="btn sm" data-q="${i}">${esc(q[0])}</button>`).join('')}</div>
      <div class="row" style="margin-top:8px"><button class="btn sm" id="resetPt">Reset patient</button><button class="btn sm" id="ff">Skip ahead 60 s</button></div>
      <h3>Share</h3><p class="muted small" style="margin:0 0 6px">Turn the current ventilator and patient into a scenario with a question and targets.</p>
      <button class="btn sm" id="toBuilder">Open in scenario builder</button>`;
    $$('[data-preset]').forEach(b => b.onclick = () => loadPreset(b.dataset.preset));
    $$('[data-q]').forEach(b => b.onclick = () => { const q = QUICK[+b.dataset.q]; takeSnapshot('Before: ' + q[0].toLowerCase()); setCompare(true); const P = clone(App.patient); q[1](P); App.patient = E.normPatient(P); App.sim.setPatient(App.patient); renderPatient(); toast(q[0] + ' — compare side by side'); });
    $('#resetPt').onclick = () => { App.patient = E.normPatient(clone(App.freeBase || E.PRESETS[App.preset].patient)); App.sim.setPatient(App.patient); renderPatient(); };
    $('#ff').onclick = () => { App.sim.advance(60, onSample); updateMonitor(); toast('60 seconds later'); };
    $('#toBuilder').onclick = () => setView('builder', { keep: true });
  }
  function presetBlurb(k) {
    return { normal: 'Sedated, normal lungs on volume control.', obstructive: 'High resistance, flow limitation, auto-PEEP.', ards: 'Stiff, recruitable lungs and shunt.', obese: 'Stiff chest wall; the Pes channel is on.', spont: 'Awake and triggering on pressure support.' }[k] || '';
  }
  function loadPreset(k) {
    const pr = E.PRESETS[k]; App.preset = k;
    App.freeBase = clone(E.normPatient(pr.patient));
    App.pmus = !!(pr.patient.effort && pr.patient.effort.on); $('#pmusBtn').setAttribute('aria-pressed', String(App.pmus));
    setAux(k === 'obese' ? 'pes' : 'none');
    load(pr.settings, pr.patient); App.snap = null; setCompare(false);
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
    const fb = () => { if (fallbackEl) { fallbackEl.hidden = false; fallbackEl.value = text; fallbackEl.select(); } };
    try { navigator.clipboard.writeText(text).then(() => toast('Link copied'), fb); } catch (e) { fb(); }
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
      ${list.length ? `<div class="cardlist">${list.map(sc => `<div class="card"><b>${esc(sc.name || 'Untitled')}</b><span>${esc(E.modeLabel(E.normSettings(sc.settings)))} · PEEP ${sc.settings.peep} · FiO₂ ${(+sc.settings.fio2).toFixed(2)} · ${sc.goal.length} target${sc.goal.length === 1 ? '' : 's'}</span>
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
