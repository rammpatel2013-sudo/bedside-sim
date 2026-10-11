/*
 * Vent Lab curriculum, tutorials and grader. Original content for bedside-sim.
 * Every interactive case is graded on the physiologic result of the learner's settings,
 * so any clinically valid fix passes. tests/vent_curriculum.test.js proves each case's
 * starting state fails and its model answer passes.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine.js'));
  else root.VentCurriculum = factory(root.VentEngine);
}(typeof self !== 'undefined' ? self : this, function (E) {
  'use strict';

  // ------------------------------------------------------------------ metric labels
  const METRICS = {
    vt_patient: { label: 'Tidal volume', unit: 'mL', dp: 0 },
    vt_per_kg: { label: 'Tidal volume per kg PBW', unit: 'mL/kg', dp: 1 },
    rr_actual: { label: 'Total respiratory rate', unit: '/min', dp: 0 },
    mv: { label: 'Minute ventilation', unit: 'L/min', dp: 1 },
    ppeak: { label: 'Peak pressure', unit: 'cmH₂O', dp: 0 },
    pplat: { label: 'Plateau pressure', unit: 'cmH₂O', dp: 1 },
    peep_tot: { label: 'Total PEEP', unit: 'cmH₂O', dp: 1 },
    auto_peep: { label: 'Auto-PEEP', unit: 'cmH₂O', dp: 1 },
    driving_p: { label: 'Driving pressure', unit: 'cmH₂O', dp: 1 },
    cstat: { label: 'Static compliance', unit: 'mL/cmH₂O', dp: 0 },
    ph: { label: 'pH', unit: '', dp: 2 },
    paco2: { label: 'PaCO₂', unit: 'mmHg', dp: 0 },
    pao2: { label: 'PaO₂', unit: 'mmHg', dp: 0 },
    spo2: { label: 'SpO₂', unit: '%', dp: 0 },
    false_trig_min: { label: 'False-triggered breaths', unit: '/min', dp: 0 },
    missed_min: { label: 'Missed (ineffective) efforts', unit: '/min', dp: 0 },
    double_min: { label: 'Double-triggered breaths', unit: '/min', dp: 0 },
    scoop: { label: 'Airway pressure dip below PEEP during inspiration', unit: 'cmH₂O', dp: 1 },
    overshoot: { label: 'End-inspiratory pressure spike', unit: 'cmH₂O', dp: 1 },
    patient_trig_frac: { label: 'Patient-triggered breaths', unit: '%', dp: 0, scale: 100 },
    rsbi: { label: 'RSBI (RR ÷ VT in L)', unit: '', dp: 0 },
    ti: { label: 'Inspiratory time', unit: 's', dp: 2 },
    leak_pct: { label: 'Leak', unit: '%', dp: 0 }
  };

  const SETTING_LABELS = {
    mode: 'Mode', vt: 'Tidal volume', rr: 'Set rate', peep: 'PEEP', ti: 'Inspiratory time', fio2: 'FiO₂',
    pinsp: 'Inspiratory pressure', psupport: 'Pressure support', cycle: 'Expiratory trigger (cycle %)',
    trig: 'Trigger type', trig_f: 'Flow trigger', trig_p: 'Pressure trigger', flow: 'Flow pattern', pause: 'Pause'
  };

  // ARDS Network lower-PEEP / higher-FiO2 table (ARDS Network, N Engl J Med 2000;342:1301-8)
  const ARDSNET_LOW = [[0.3, 5], [0.4, 5], [0.4, 8], [0.5, 8], [0.5, 10], [0.6, 10], [0.7, 10], [0.7, 12], [0.7, 14],
    [0.8, 14], [0.9, 14], [0.9, 16], [0.9, 18], [1.0, 18], [1.0, 20], [1.0, 22], [1.0, 24]];

  // ------------------------------------------------------------------ rule evaluation
  const OPS = {
    '<=': (a, b) => a <= b + 1e-9, '>=': (a, b) => a >= b - 1e-9, '==': (a, b) => a === b,
    between: (a, b) => a >= b[0] - 1e-9 && a <= b[1] + 1e-9
  };
  function fmt(v, dp) { return v == null || !isFinite(v) ? '—' : (+v).toFixed(dp); }
  function ruleText(r) {
    if (r.label) return r.label;
    if (r.m) {
      const M = METRICS[r.m] || { label: r.m, unit: '', dp: 1 }, sc = M.scale || 1;
      const v = r.op === 'between' ? `${fmt(r.v[0] * sc, M.dp)}–${fmt(r.v[1] * sc, M.dp)}` : fmt(r.v * sc, M.dp);
      const opw = { '<=': '≤', '>=': '≥', '==': '=', between: '' }[r.op];
      return `${M.label} ${opw} ${v} ${M.unit}`.replace(/\s+/g, ' ').trim();
    }
    if (r.s) return `${SETTING_LABELS[r.s] || r.s} ${{ '==': 'is', '<=': '≤', '>=': '≥' }[r.op] || r.op} ${r.v}`;
    return 'Condition';
  }
  function evalRule(r, m, s) {
    if (r.any) { const parts = r.any.map(x => evalRule(x, m, s)); return { ok: parts.some(p => p.ok), text: ruleText(r), got: null }; }
    if (r.all) { const parts = r.all.map(x => evalRule(x, m, s)); return { ok: parts.every(p => p.ok), text: ruleText(r), got: null }; }
    if (r.table === 'ardsnet') {
      const ok = ARDSNET_LOW.some(([f, p]) => Math.abs(s.fio2 - f) < 0.026 && s.peep === p);
      return { ok, text: r.label || 'PEEP and FiO₂ are a pair on the ARDSNet table', got: `FiO₂ ${s.fio2.toFixed(2)} / PEEP ${s.peep}` };
    }
    if (r.m) {
      const M = METRICS[r.m] || { dp: 1, unit: '' }, sc = M.scale || 1;
      const v = m[r.m];
      const ok = v != null && isFinite(v) && OPS[r.op](v, r.v);
      return { ok, text: ruleText(r), got: `${fmt(v * sc, M.dp)}${M.unit ? ' ' + M.unit : ''}` };
    }
    if (r.s) {
      const v = s[r.s];
      return { ok: OPS[r.op](v, r.v), text: ruleText(r), got: String(v) };
    }
    return { ok: true, text: ruleText(r), got: null };
  }

  // ------------------------------------------------------------------ shared start states
  const MALE = { sex: 'M', height_cm: 175 };
  const FEMALE = { sex: 'F', height_cm: 165 };
  const TRIGGER_STILL_USABLE = {
    any: [
      { all: [{ s: 'trig', op: '==', v: 'flow' }, { s: 'trig_f', op: '<=', v: 6 }] },
      { all: [{ s: 'trig', op: '==', v: 'pressure' }, { s: 'trig_p', op: '>=', v: -5 }] }
    ],
    label: 'Trigger still reachable if the patient wakes up (flow ≤ 6 L/min or pressure ≥ −5 cmH₂O)'
  };

  // ------------------------------------------------------------------ lessons
  const LESSONS = [
    { n: 0, title: 'Orientation' },
    { n: 1, title: 'Anatomy of a breath: trigger, target, cycle' },
    { n: 2, title: 'Modes: what you set vs what you get' },
    { n: 3, title: 'Mechanics: peak, plateau and the holds' },
    { n: 4, title: 'Gas exchange: CO₂ and oxygen' },
    { n: 5, title: 'Obstruction and auto-PEEP' },
    { n: 6, title: 'ARDS: lung-protective ventilation' },
    { n: 7, title: 'Patient–ventilator dyssynchrony' },
    { n: 8, title: 'The decompensating ventilated patient' },
    { n: 9, title: 'Liberation' }
  ];

  const CASES = [
    // ---------------------------------------------------------------- Lesson 0
    {
      id: 'o-guarantee', lesson: 0, type: 'mcq', title: 'What volume control guarantees',
      start: { preset: 'normal', settings: { mode: 'VC', vt: 450, rr: 14, peep: 5, ti: 0.9 }, patient: { ...MALE } },
      question: 'This sedated patient is not breathing on their own. The ventilator is in volume control (VC). Watch a few breaths: flow is a flat-topped block and volume climbs in a straight line.\n\nIn volume control, which two things does the ventilator guarantee on every breath?',
      choices: [
        { text: 'The tidal volume and the inspiratory flow', correct: true, why: 'You set the volume and the flow (or inspiratory time). The ventilator delivers them whatever pressure it takes.' },
        { text: 'The peak pressure and the tidal volume', why: 'Peak pressure is the result in VC. It rises when the lungs get stiffer or the airways narrower.' },
        { text: 'The plateau pressure and the rate', why: 'Plateau pressure depends on the volume and the compliance. It is measured, not set.' },
        { text: 'The minute ventilation, whatever the patient does', why: 'The set rate is a minimum. A patient who triggers extra breaths raises minute ventilation.' }
      ],
      explain: 'Every ventilator mode is defined by what it controls. In VC the controlled variable is flow, so volume (flow × time) is guaranteed and airway pressure is the dependent variable. That is why pressure is the trace to watch in VC: it reports on the patient. In pressure control the roles swap.',
      points: ['VC sets flow and volume; pressure is the output.', 'Pressure modes set pressure; volume is the output.', 'Always read the dependent variable — it is the one telling you about the patient.']
    },
    {
      id: 'o-pbw', lesson: 0, type: 'numeric', title: 'Size the breath to the patient',
      start: { preset: 'normal', settings: { mode: 'VC', vt: 520, rr: 14, peep: 5, ti: 0.9 }, patient: { ...MALE } },
      question: 'The patient is a man, 175 cm tall. Predicted body weight (PBW) for men is 50 + 0.91 × (height in cm − 152.4).\n\nRead the exhaled tidal volume (VTe) on the monitor. What is it in mL per kg of PBW?',
      truth: m => m.vte / m.pbw, tol: 0.4, unit: 'mL/kg PBW', dp: 1,
      explain: 'PBW for this patient is about 70.6 kg, so a VTe of 520 mL is about 7.4 mL/kg. Tidal volume is scaled to the size of the lungs, which tracks height and sex, not actual weight. Most patients do well at 6–8 mL/kg PBW; ARDS targets 6.',
      points: ['Use predicted body weight from height and sex, never actual weight.', 'Men: 50 + 0.91 × (cm − 152.4). Women: 45.5 + 0.91 × (cm − 152.4).', 'Read VTe (exhaled), which is what actually came back out of the patient.']
    },

    // ---------------------------------------------------------------- Lesson 1
    {
      id: 't-who', lesson: 1, type: 'mcq', title: 'Who started that breath?',
      start: { preset: 'normal', settings: { mode: 'VC', vt: 450, rr: 10, peep: 5, ti: 0.9 }, patient: { ...MALE, effort: { on: true, pmax: 4, rate: 18, ti: 0.9 } } },
      question: 'The set rate is 10, but the monitor counts about 18 breaths a minute. Most breaths have a "P" above them.\n\nWhat is going on?',
      choices: [
        { text: 'The patient is triggering breaths above the set rate', correct: true, why: 'Each "P" marks a breath the patient started. The ventilator delivered a full set-volume breath each time.' },
        { text: 'The ventilator is malfunctioning', why: 'The rate difference is expected in assist-control: the set rate is only a floor.' },
        { text: 'Auto-PEEP is causing extra breaths', why: 'Auto-PEEP makes triggering harder, not easier.' },
        { text: 'The flow trigger is too insensitive', why: 'An insensitive trigger would cause missed efforts, not extra breaths.' }
      ],
      explain: 'Every breath has a trigger (what starts it), a target or limit (what is controlled during it) and a cycle (what ends it). Breaths start either on time (the set rate) or when the patient\'s effort meets the trigger threshold — a small drop in airway pressure or a small inspiratory flow. This simulator marks patient-triggered breaths with "P".',
      points: ['Set rate is a minimum in assist-control.', 'Patient effort is detected as a pressure drop or an inspiratory flow.', 'Count the total rate, not the set rate, when you think about CO₂ and auto-PEEP.']
    },
    {
      id: 't-cardiac', lesson: 1, type: 'interactive', title: 'Breaths with nobody behind them',
      start: { preset: 'normal', settings: { mode: 'PC', pinsp: 10, rr: 14, peep: 5, ti: 1.0, trig: 'flow', trig_f: 1.5, fio2: 0.4 }, patient: { ...MALE, c: 50, r: 10, cardiac: true, hr: 92, effort: { on: false } } },
      lock: ['mode'],
      question: 'This patient is paralyzed after cardiac surgery, yet the total rate is well above the set rate of 14 and some breaths carry a "P". Small regular ripples ride on the pressure and flow traces at the end of each expiration.\n\nStop the extra breaths without making the trigger impossible to reach if the paralytic wears off.',
      look: ['Count the ripples per minute — they match the heart rate (92).', 'Look at where the "P" breaths start: right on a ripple.'],
      goal: [{ m: 'false_trig_min', op: '<=', v: 0 }, { m: 'rr_actual', op: '<=', v: 15 }, TRIGGER_STILL_USABLE],
      solution: { settings: { trig_f: 4 } },
      explain: 'Each heartbeat pushes a little gas in and out of the airway. With a very sensitive trigger (1.5 L/min), those cardiac oscillations look like a patient effort and start a breath — a false trigger, also called auto-triggering. Making the trigger less sensitive (higher flow threshold, or a more negative pressure threshold) filters the ripples out while still letting a real effort through.',
      points: ['Auto-triggering: breaths with no effort behind them — cardiac oscillations, leaks, or water in the circuit.', 'Fix it with a less sensitive trigger, or fix the source (leak, water).', 'Do not overshoot: a trigger that is too insensitive causes missed efforts once the patient breathes.']
    },
    {
      id: 't-secretions', lesson: 1, type: 'mcq', title: 'A sawtooth on the screen',
      start: { preset: 'normal', settings: { mode: 'VC', vt: 450, rr: 14, peep: 5, ti: 0.9, trig: 'flow', trig_f: 2 }, patient: { ...MALE, secretions: true, effort: { on: false } } },
      question: 'The flow and pressure traces have developed an irregular sawtooth, worst during expiration, and the rate is creeping up with "P" breaths the sedated patient is not making.\n\nWhat is the best first move?',
      choices: [
        { text: 'Suction the airway and drain water from the circuit', correct: true, why: 'Secretions or condensate cause the sawtooth and the false triggers. Remove the cause.' },
        { text: 'Raise the flow trigger to 8 L/min', why: 'That hides the problem and would make real efforts hard to trigger.' },
        { text: 'Deepen sedation', why: 'The patient is not making these breaths; sedation will not stop them.' },
        { text: 'Lower the set rate', why: 'The extra breaths are not time-triggered, so the set rate does not drive them.' }
      ],
      explain: 'A coarse, irregular sawtooth in the flow (and often pressure) trace is the classic sign of secretions in the airway or water in the circuit. It can trigger breaths and it adds resistance. The fix is mechanical: suction, drain the tubing, check the heat-moisture exchanger.',
      points: ['Sawtooth on flow = secretions or condensate until proven otherwise.', 'Treat the cause before touching the trigger.', 'Recheck the waveform after suctioning — it should smooth out.']
    },
    {
      id: 't-cycle', lesson: 1, type: 'mcq', title: 'What ends this breath?',
      start: { preset: 'normal', settings: { mode: 'VC', vt: 450, rr: 14, peep: 5, ti: 1.1, pause: 25 }, patient: { ...MALE, effort: { on: false } } },
      question: 'This is volume control with a 25% inspiratory pause: flow stops before the breath ends, and pressure settles to a lower flat line before exhalation starts.\n\nWhat ends (cycles) inspiration here?',
      choices: [
        { text: 'The set inspiratory time running out', correct: true, why: 'Volume control with a pause is time-cycled: exhalation opens when the set Ti ends.' },
        { text: 'Flow falling to 25% of its peak', why: 'That is the flow-cycling rule of pressure support.' },
        { text: 'Airway pressure reaching a target', why: 'Pressure is not controlled in VC.' },
        { text: 'The patient stopping their effort', why: 'This patient is passive; the ventilator decides.' }
      ],
      explain: 'Cycling is the switch from inspiration to expiration. VC and PC cycle on time. Pressure support cycles on flow (a percentage of peak flow, the expiratory trigger). The flat segment during the pause is a plateau: with no flow, there is no resistive pressure, so airway pressure equals alveolar pressure.',
      points: ['Time-cycled: VC, PC, PRVC. Flow-cycled: PSV.', 'A pause gives you a plateau on every breath.', 'Peak − plateau is the resistive part; plateau − PEEP is the elastic part.']
    },

    // ---------------------------------------------------------------- Lesson 2
    {
      id: 'm-vc-stiff', lesson: 2, type: 'mcq', title: 'Stiff lungs in volume control',
      start: { preset: 'normal', settings: { mode: 'VC', vt: 450, rr: 14, peep: 5, ti: 0.9 }, patient: { ...MALE, c: 50, r: 10, effort: { on: false } } },
      question: 'This patient is about to develop a large pleural effusion, halving respiratory-system compliance from 50 to 25 mL/cmH₂O. The ventilator stays in volume control.\n\nPredict what happens. After you answer, the change is applied so you can watch.',
      choices: [
        { text: 'Peak and plateau pressures rise; tidal volume stays the same', correct: true, why: 'VC holds the volume; the pressure needed to deliver it goes up.' },
        { text: 'Tidal volume falls; pressures stay the same', why: 'That is what happens in pressure control.' },
        { text: 'Only the peak pressure rises', why: 'Plateau rises too: plateau − PEEP = VT ÷ compliance.' },
        { text: 'Nothing changes on the screen', why: 'Pressure is the dependent variable in VC, so it moves.' }
      ],
      then: { patient: { c: 25 } },
      explain: 'Plateau − PEEP (driving pressure) equals VT ÷ compliance. Halving compliance doubles the driving pressure. Peak pressure rises by the same amount because the resistive part (flow × resistance) did not change, so the peak–plateau gap stays the same.',
      points: ['In VC, falling compliance shows up as rising plateau and peak, with the same gap between them.', 'Driving pressure = VT ÷ Crs.', 'Set your high-pressure alarm so this change is noticed.']
    },
    {
      id: 'm-pc-stiff', lesson: 2, type: 'mcq', title: 'Stiff lungs in pressure control',
      start: { preset: 'normal', settings: { mode: 'PC', pinsp: 15, rr: 14, peep: 5, ti: 1.0 }, patient: { ...MALE, c: 50, r: 10, effort: { on: false } } },
      question: 'Same change, different mode: compliance is about to fall from 50 to 25 mL/cmH₂O while the ventilator is in pressure control (inspiratory pressure 15 above PEEP).\n\nPredict what happens.',
      choices: [
        { text: 'Tidal volume falls; peak pressure stays the same', correct: true, why: 'PC holds the pressure; less volume fits at that pressure.' },
        { text: 'Peak pressure rises; volume stays the same', why: 'That is volume control.' },
        { text: 'Both pressure and volume rise', why: 'Stiffer lungs take less volume at a given pressure.' },
        { text: 'Inspiratory time shortens', why: 'PC is time-cycled; Ti is set.' }
      ],
      then: { patient: { c: 25 } },
      explain: 'In pressure control the ventilator holds airway pressure at the target and lets flow find its own level. Flow is a decelerating curve that falls as the lung fills. With stiffer lungs, the lung fills faster and less, so flow decays sooner and tidal volume drops. The pressure trace barely changes — the volume and flow traces tell the story.',
      points: ['In PC, watch the tidal volume and the low-VTe alarm.', 'A shorter time constant (R × C) makes flow decay faster.', 'The same lung change looks completely different in VC vs PC.']
    },
    {
      id: 'm-pc-volume', lesson: 2, type: 'interactive', title: 'Get the volume back in pressure control',
      start: { preset: 'normal', settings: { mode: 'PC', pinsp: 10, rr: 16, peep: 5, ti: 0.6, rise: 0.1 }, patient: { ...MALE, c: 45, r: 15, effort: { on: false } } },
      lock: ['mode'],
      question: 'Pressure control at 10 cmH₂O above PEEP with a 0.6 s inspiratory time. The tidal volume is only about 250 mL and the PaCO₂ is climbing.\n\nAdjust the settings (stay in PC) to get a tidal volume of 5.5–7.5 mL/kg PBW without a driving pressure above 15.',
      look: ['Does inspiratory flow reach zero before the breath ends?'],
      goal: [{ m: 'vt_per_kg', op: 'between', v: [5.5, 7.5] }, { m: 'driving_p', op: '<=', v: 15 }, { s: 'mode', op: '==', v: 'PC' }],
      solution: { settings: { pinsp: 12, ti: 1.1 } },
      explain: 'Two levers set the volume in PC: the inspiratory pressure and the inspiratory time. When flow is still running at the end of inspiration, the lung has not finished filling, so lengthening Ti adds volume without raising pressure. Once flow reaches zero before the breath ends, more Ti adds nothing and only the pressure will help.',
      points: ['Flow still running at end-inspiration means longer Ti will add volume.', 'Flow already at zero means only more pressure adds volume.', 'Check driving pressure (plateau − PEEP) when you raise Pinsp.']
    },
    {
      id: 'm-prvc', lesson: 2, type: 'mcq', title: 'PRVC and a patient who wakes up',
      start: { preset: 'normal', settings: { mode: 'PRVC', vt: 450, rr: 14, peep: 5, ti: 0.9 }, patient: { ...MALE, effort: { on: false } } },
      question: 'PRVC is delivering 450 mL with an inspiratory pressure the ventilator chooses breath by breath ("Pinsp in use" on the monitor). The patient is about to wake up and start pulling hard on each breath.\n\nWhat will the ventilator do?',
      choices: [
        { text: 'Lower the inspiratory pressure, because the patient now helps fill the lung', correct: true, why: 'The patient\'s effort adds volume, so PRVC backs off to stay at the target.' },
        { text: 'Raise the inspiratory pressure to match the patient\'s demand', why: 'PRVC targets volume, not effort. More effort means less help.' },
        { text: 'Keep the pressure the same', why: 'PRVC adjusts pressure every breath to hit the volume target.' },
        { text: 'Switch to volume control', why: 'It stays in PRVC.' }
      ],
      then: { patient: { effort: { on: true, pmax: 9, rate: 18, ti: 1.0 } } },
      explain: 'Adaptive pressure modes (PRVC, VC+, autoflow) adjust the inspiratory pressure to reach a target volume. When the patient pulls harder, the same pressure produces more volume, so the ventilator lowers its pressure. A patient with high respiratory drive can end up doing most of the work while the ventilator gives almost none — sometimes called work shifting.',
      points: ['Adaptive modes reduce support when patient effort rises.', 'Watch "Pinsp in use" fall as a sign the patient is working hard.', 'High drive plus an adaptive mode can mean a tired patient.']
    },
    {
      id: 'm-psv', lesson: 2, type: 'interactive', title: 'Too much pressure support',
      start: { preset: 'spont', settings: { mode: 'PSV', psupport: 18, peep: 5, cycle: 25, fio2: 0.35 }, patient: { ...MALE, c: 55, r: 9, effort: { on: true, pmax: 5, rate: 14, ti: 1.0 } } },
      lock: ['mode'],
      question: 'This patient is awake on pressure support of 18. Every breath is patient-triggered, but tidal volumes are close to 1 litre and the PaCO₂ is very low.\n\nKeep the patient in PSV and bring tidal volume into 5–8 mL/kg PBW.',
      goal: [{ m: 'vt_per_kg', op: 'between', v: [5, 8] }, { s: 'mode', op: '==', v: 'PSV' }],
      solution: { settings: { psupport: 7 } },
      explain: 'In pressure support the patient sets the rate and the inspiratory time; you set the pressure that helps each breath. Tidal volume comes from the support plus the patient\'s own effort. Too much support gives huge breaths, low CO₂ and can suppress the patient\'s drive, leading to apneas and dyssynchrony.',
      points: ['PSV: patient-triggered, pressure-targeted, flow-cycled.', 'Titrate support to tidal volume and rate, and watch for signs of distress.', 'There is no backup rate unless the apnea alarm switches one on.']
    },

    // ---------------------------------------------------------------- Lesson 3
    {
      id: 'k-cstat', lesson: 3, type: 'numeric', title: 'Measure static compliance',
      start: { preset: 'normal', settings: { mode: 'VC', vt: 450, rr: 14, peep: 5, ti: 0.9 }, patient: { ...MALE, c: 38, r: 10, effort: { on: false } } },
      question: 'Press "Inspiratory hold" and read the plateau pressure. Then press "Expiratory hold" for total PEEP.\n\nWhat is the static compliance in mL/cmH₂O? (Compliance = VT ÷ (plateau − total PEEP).)',
      truth: m => m.cstat, tol: 0.1, tolKind: 'rel', unit: 'mL/cmH₂O', dp: 0,
      explain: 'During an inspiratory hold, flow stops and airway pressure falls from the peak to the plateau, which equals alveolar pressure at end-inspiration. Plateau minus total PEEP is the pressure needed to stretch the respiratory system by one tidal volume. Normal static compliance in ventilated adults is about 50–80 mL/cmH₂O; ARDS is often below 30.',
      points: ['Holds need a passive patient; effort distorts the plateau.', 'Use total PEEP (from an expiratory hold), not set PEEP, if there is auto-PEEP.', 'Compliance falls with edema, atelectasis, effusion, pneumothorax and abdominal distension.']
    },
    {
      id: 'k-raw', lesson: 3, type: 'numeric', title: 'Measure airway resistance',
      start: { preset: 'normal', settings: { mode: 'VC', vt: 500, rr: 14, peep: 5, ti: 0.5, flow: 'square' }, patient: { ...MALE, c: 50, r: 16, effort: { on: false } } },
      question: 'Square-wave flow: 500 mL delivered over 0.5 s, so flow is 1 L/s (60 L/min). Do an inspiratory hold.\n\nWhat is inspiratory resistance in cmH₂O/L/s? (Resistance = (peak − plateau) ÷ flow in L/s.)',
      truth: (m, st) => st.patient.r, tol: 0.15, tolKind: 'rel', unit: 'cmH₂O/L/s', dp: 0,
      explain: 'With constant flow, the jump from plateau up to peak is the pressure spent pushing gas through the tube and airways. Dividing it by the flow gives resistance. An intubated adult is usually 10–15 cmH₂O/L/s; much of that is the endotracheal tube. Bronchospasm, secretions, a kinked or bitten tube push it higher.',
      points: ['Measure resistance only with square (constant) flow.', 'Peak − plateau > 10 cmH₂O at 60 L/min suggests high resistance.', 'Plateau normal with a high peak points to the airway, not the lung.']
    },
    {
      id: 'k-highpeak', lesson: 3, type: 'mcq', title: 'High peak, normal plateau',
      start: { preset: 'normal', settings: { mode: 'VC', vt: 450, rr: 16, peep: 5, ti: 0.9 }, patient: { ...MALE, c: 50, r: 40, effort: { on: false } } },
      question: 'The high-pressure alarm is going off. Peak pressure is around 34, but an inspiratory hold shows a plateau of only about 14.\n\nWhich problem fits best?',
      choices: [
        { text: 'Increased airway resistance: secretions, bronchospasm, a kinked or bitten tube', correct: true, why: 'A big peak–plateau gap with a normal plateau means the pressure is lost in the airways.' },
        { text: 'Tension pneumothorax', why: 'A pneumothorax stiffens the respiratory system and raises the plateau.' },
        { text: 'Right mainstem intubation', why: 'All the volume going into one lung raises the plateau.' },
        { text: 'Worsening ARDS', why: 'ARDS lowers compliance and raises the plateau.' }
      ],
      explain: 'Split the peak pressure into its two parts. Resistive (peak − plateau) reflects the airways and the tube. Elastic (plateau − PEEP) reflects the lungs and chest wall. Here the resistive part is large and the elastic part is normal. Look in the mouth and along the tube, pass a suction catheter, listen for wheeze.',
      points: ['High peak + normal plateau = airway problem.', 'High peak + high plateau = lung or chest-wall problem.', 'A suction catheter that will not pass means the tube is blocked.']
    },
    {
      id: 'k-highplat', lesson: 3, type: 'mcq', title: 'High peak, high plateau',
      start: { preset: 'normal', settings: { mode: 'VC', vt: 450, rr: 16, peep: 5, ti: 0.9 }, patient: { ...MALE, c: 17, r: 10, effort: { on: false } } },
      question: 'Peak pressure is about 36 and the plateau is about 31. The gap between them is normal.\n\nWhich problem does this pattern point to?',
      choices: [
        { text: 'Low compliance: pneumothorax, mainstem intubation, effusion, edema or abdominal distension', correct: true, why: 'Both peak and plateau are up together; the resistive gap is normal.' },
        { text: 'Mucus plug in the endotracheal tube', why: 'A plug raises the peak much more than the plateau.' },
        { text: 'Bronchospasm', why: 'Bronchospasm widens the peak–plateau gap and causes auto-PEEP.' },
        { text: 'A cuff leak', why: 'A leak lowers pressures and exhaled volumes.' }
      ],
      explain: 'When the plateau rises with the peak, the problem is the stiffness of the lungs or the chest wall. Examine for asymmetry, check tube depth on the chest film, and use ultrasound for lung sliding and effusion. A plateau above 30 cmH₂O is also a lung-injury risk in its own right.',
      points: ['Plateau tracks the lungs and chest wall.', 'Keep plateau ≤ 30 cmH₂O.', 'Sudden plateau rise with hypotension is a tension pneumothorax until proven otherwise.']
    },

    // ---------------------------------------------------------------- Lesson 4
    {
      id: 'g-co2', lesson: 4, type: 'interactive', title: 'Fix the CO₂',
      start: { preset: 'normal', settings: { mode: 'VC', vt: 450, rr: 10, peep: 5, ti: 0.9, fio2: 0.4 }, patient: { ...MALE, c: 50, r: 10, vd: 180, vco2: 240, effort: { on: false } } },
      question: 'A febrile, septic patient is on VC 450 × 10. The arterial gas shows a respiratory acidosis (pH about 7.11).\n\nBring the pH to 7.32–7.45 without using a tidal volume above 8 mL/kg PBW or creating auto-PEEP.',
      goal: [{ m: 'ph', op: 'between', v: [7.32, 7.45] }, { m: 'vt_per_kg', op: '<=', v: 8 }, { m: 'auto_peep', op: '<=', v: 2 }],
      solution: { settings: { rr: 18 } },
      explain: 'PaCO₂ is set by alveolar ventilation: (VT − dead space) × rate, against the CO₂ the body is producing. Fever and sepsis raise CO₂ production, so the same settings that were fine yesterday can leave the patient acidotic today. Raising the rate is the usual lever because tidal volume is already appropriate.',
      points: ['PaCO₂ ∝ CO₂ production ÷ alveolar ventilation.', 'Alveolar ventilation = (VT − dead space) × RR.', 'Watch for auto-PEEP when you push the rate up.']
    },
    {
      id: 'g-deadspace', lesson: 4, type: 'mcq', title: 'Same minute ventilation, different CO₂',
      start: { preset: 'normal', settings: { mode: 'VC', vt: 250, rr: 32, peep: 5, ti: 0.6 }, patient: { ...MALE, vd: 150, effort: { on: false } } },
      question: 'Right now the patient gets 250 mL × 32 breaths = 8 L/min. Compare it with 500 mL × 16 breaths, also 8 L/min.\n\nWhich setting gives the lower PaCO₂, assuming 150 mL of dead space?',
      choices: [
        { text: '500 mL × 16', correct: true, why: 'Alveolar ventilation is (500 − 150) × 16 = 5.6 L/min versus (250 − 150) × 32 = 3.2 L/min.' },
        { text: '250 mL × 32', why: 'Each small breath wastes the same 150 mL of dead space, so more of the minute ventilation is wasted.' },
        { text: 'They are the same, because minute ventilation is the same', why: 'Minute ventilation includes dead-space ventilation, which removes no CO₂.' },
        { text: 'It cannot be predicted', why: 'It can, from the alveolar ventilation.' }
      ],
      then: { settings: { vt: 500, rr: 16, ti: 0.9 } },
      explain: 'Every breath first refills the dead space (airways, tube, circuit) before fresh gas reaches the alveoli. Small, fast breaths spend a larger share of each breath on dead space. This is why rapid shallow breathing fails, and why adding tubing between the Y-piece and the tube (extra dead space) raises PaCO₂.',
      points: ['Minute ventilation ≠ alveolar ventilation.', 'Dead-space fraction rises as VT falls.', 'Remove unneeded dead space (long connectors, HMEs) in severe hypercapnia.']
    },
    {
      id: 'g-oxygen', lesson: 4, type: 'interactive', title: 'FiO₂ is not enough',
      start: { preset: 'ards', settings: { mode: 'VC', vt: 420, rr: 22, peep: 5, ti: 0.8, fio2: 0.6 }, patient: { ...MALE, c: 40, shunt: 0.42, recruit: { on: true, popt: 13, width: 6, shunt_min: 0.08 } } },
      lock: ['mode'],
      question: 'Bilateral pneumonia. SpO₂ is in the mid 80s on FiO₂ 0.6 and PEEP 5. You are trying to keep FiO₂ at 0.6 or below.\n\nReach SpO₂ ≥ 90% with FiO₂ ≤ 0.6.',
      look: ['Try FiO₂ 1.0 first and see how little it helps.', 'Watch compliance and SpO₂ as you change PEEP.'],
      goal: [{ m: 'spo2', op: '>=', v: 90 }, { s: 'fio2', op: '<=', v: 0.6 }, { m: 'pplat', op: '<=', v: 30 }],
      solution: { settings: { peep: 12 } },
      explain: 'When hypoxemia comes from shunt — blood flowing past collapsed or flooded alveoli — extra oxygen barely reaches that blood, so FiO₂ helps little. PEEP holds collapsed alveoli open, turning shunt into ventilated lung. Compliance often improves at the same time, which is a sign of recruitment rather than overdistension.',
      points: ['Shunt responds to PEEP and recruitment much more than to FiO₂.', 'Better compliance after a PEEP increase suggests recruitment.', 'Keep the plateau ≤ 30 while you raise PEEP.']
    },

    // ---------------------------------------------------------------- Lesson 5
    {
      id: 'x-autopeep', lesson: 5, type: 'numeric', title: 'Find the hidden PEEP',
      start: { preset: 'obstructive', settings: { mode: 'VC', vt: 500, rr: 22, peep: 5, ti: 1.0, fio2: 0.4 }, patient: { ...MALE, c: 60, r: 28, rexp: 1.6, pcrit: 0, effort: { on: false } } },
      question: 'COPD exacerbation. Expiratory flow is still running when the next breath starts.\n\nDo an expiratory hold. How much auto-PEEP is there (total PEEP − set PEEP)?',
      truth: m => m.auto_peep, tol: 1.5, unit: 'cmH₂O', dp: 1,
      explain: 'Auto-PEEP (intrinsic PEEP) is pressure left in the alveoli when the next breath starts, because there was not enough time to exhale. It is invisible on the ventilator\'s PEEP display. An expiratory hold closes the valves at end-expiration so airway pressure can equilibrate with alveolar pressure, revealing total PEEP.',
      points: ['Flow that does not return to zero before the next breath = auto-PEEP.', 'Measure it with an expiratory hold in a passive patient.', 'Auto-PEEP raises plateau pressure, lowers venous return and makes triggering harder.']
    },
    {
      id: 'x-letitout', lesson: 5, type: 'interactive', title: 'Let it out',
      start: { preset: 'obstructive', settings: { mode: 'VC', vt: 500, rr: 24, peep: 5, ti: 1.0, fio2: 0.4 }, patient: { ...MALE, c: 60, r: 30, rexp: 1.7, pcrit: 0, vd: 180, hco3: 24, effort: { on: false } } },
      question: 'Status asthmaticus, sedated and paralyzed. Auto-PEEP is above 10, the plateau is climbing and the blood pressure is soft.\n\nGet auto-PEEP to 4 or less with a plateau ≤ 25, accepting a pH as low as 7.15.',
      look: ['Expiratory flow does not reach zero.', 'Which settings give the lung more time to empty?'],
      goal: [{ m: 'auto_peep', op: '<=', v: 4 }, { m: 'pplat', op: '<=', v: 25 }, { m: 'ph', op: '>=', v: 7.15 }],
      solution: { settings: { vt: 450, rr: 12, ti: 0.8 } },
      explain: 'Dynamic hyperinflation is a problem of expiratory time. Lowering the rate gives the biggest gain; shortening inspiratory time (higher flow) and a smaller tidal volume help further. The trade-off is a higher PaCO₂, which is usually tolerated (permissive hypercapnia) while the bronchospasm is treated. High peak pressure in asthma mostly reflects resistance and is less dangerous than a high plateau.',
      points: ['Treat auto-PEEP with time: lower rate, shorter Ti, smaller VT.', 'Accept hypercapnia; target plateau, not peak.', 'If the blood pressure crashes, disconnect briefly and let the patient exhale.']
    },
    {
      id: 'x-waterfall', lesson: 5, type: 'mcq', title: 'Adding PEEP to trapped gas',
      start: { preset: 'obstructive', settings: { mode: 'VC', vt: 480, rr: 14, peep: 0, ti: 1.0, fio2: 0.4 }, patient: { ...MALE, c: 60, r: 24, rexp: 1.5, pcrit: 8, effort: { on: false } } },
      question: 'COPD with expiratory flow limitation: the small airways collapse during exhalation. Set PEEP is 0; an expiratory hold shows total PEEP of about 10.\n\nYou raise set PEEP to 6. What happens to total PEEP?',
      choices: [
        { text: 'It stays about the same', correct: true, why: 'External PEEP below the closing pressure does not add to trapped pressure.' },
        { text: 'It rises to about 16', why: 'That would be true without flow limitation. Here the collapsed airways act like a waterfall.' },
        { text: 'It falls to 6', why: 'Applied PEEP does not reduce the trapped gas.' },
        { text: 'It falls to zero', why: 'Auto-PEEP is caused by the patient\'s airways, not by the set PEEP.' }
      ],
      then: { settings: { peep: 6 } },
      explain: 'With expiratory flow limitation, the airways close at a critical pressure. Gas upstream cannot empty faster whatever the pressure downstream is — like a waterfall, whose flow does not depend on the pool below it. Applied PEEP up to that critical pressure leaves total PEEP unchanged but narrows the gap the patient must overcome to trigger a breath. Do an expiratory hold after the change to prove it.',
      points: ['Measure total PEEP before and after adding PEEP.', 'If total PEEP rises with set PEEP, you have gone past the critical pressure.', 'Applied PEEP around 80% of auto-PEEP can help triggering in flow-limited patients.']
    },

    // ---------------------------------------------------------------- Lesson 6
    {
      id: 'a-vt', lesson: 6, type: 'interactive', title: 'Set a lung-protective volume',
      start: { preset: 'ards', settings: { mode: 'VC', vt: 550, rr: 16, peep: 10, ti: 0.8, fio2: 0.6 }, patient: { ...FEMALE, c: 30, r: 11, vd: 230, shunt: 0.25, recruit: { on: false } } },
      question: 'ARDS from aspiration in a woman who is 165 cm tall. She is on VC 550 mL.\n\nSet a lung-protective tidal volume (5.5–6.5 mL/kg PBW) with plateau ≤ 30 and pH ≥ 7.25.',
      look: ['PBW = 45.5 + 0.91 × (165 − 152.4) ≈ 57 kg.'],
      goal: [{ m: 'vt_per_kg', op: 'between', v: [5.5, 6.5] }, { m: 'pplat', op: '<=', v: 30 }, { m: 'ph', op: '>=', v: 7.25 }],
      solution: { settings: { vt: 340, rr: 30, ti: 0.7 } },
      explain: 'In ARDS the functional lung is small ("baby lung"), so a normal-sized breath overstretches what is left. Six mL/kg PBW with plateau ≤ 30 lowered mortality in the ARDS Network trial. Smaller breaths need a faster rate to clear CO₂, up to about 35/min, and some hypercapnia is accepted.',
      points: ['6 mL/kg PBW, plateau ≤ 30 cmH₂O.', 'Raise the rate to compensate; watch for auto-PEEP.', 'Women and short patients are the ones most often given too much volume.']
    },
    {
      id: 'a-dp', lesson: 6, type: 'numeric', title: 'Driving pressure',
      start: { preset: 'ards', settings: { mode: 'VC', vt: 400, rr: 26, peep: 10, ti: 0.7, fio2: 0.6 }, patient: { ...MALE } },
      question: 'Do an inspiratory hold and an expiratory hold.\n\nWhat is the driving pressure (plateau − total PEEP) in cmH₂O?',
      truth: m => m.driving_p, tol: 1.5, unit: 'cmH₂O', dp: 1,
      explain: 'Driving pressure is tidal volume divided by compliance: it scales the breath to the size of the lung that is actually open. Observational data link driving pressure above about 15 cmH₂O with higher mortality in ARDS, independent of tidal volume and plateau.',
      points: ['Driving pressure = plateau − total PEEP = VT ÷ Crs.', 'Aim for ≤ 15 cmH₂O.', 'If PEEP lowers driving pressure at the same VT, it recruited lung.']
    },
    {
      id: 'a-peep', lesson: 6, type: 'interactive', title: 'Titrate PEEP to the best compliance',
      start: { preset: 'ards', settings: { mode: 'VC', vt: 400, rr: 26, peep: 6, ti: 0.7, fio2: 0.6 }, patient: { ...MALE } },
      lock: ['mode', 'vt'],
      question: 'Recruitable ARDS on VC 400 mL (about 5.7 mL/kg). Driving pressure is above 20.\n\nKeeping the tidal volume fixed, find the PEEP that brings driving pressure to 13.5 or less with a plateau ≤ 30.',
      look: ['Change PEEP in steps of 2 and use the holds (or watch compliance on the monitor).', 'Compliance rises as lung is recruited, then falls with overdistension.'],
      goal: [{ m: 'driving_p', op: '<=', v: 13.5 }, { m: 'pplat', op: '<=', v: 30 }],
      solution: { settings: { peep: 14 } },
      explain: 'At low PEEP, part of the lung collapses each breath, so compliance is low. Raising PEEP recruits it and compliance rises, so driving pressure falls at the same tidal volume. Past the best point, extra PEEP overstretches open lung: compliance and driving pressure worsen and dead space rises. A decremental PEEP trial looks for that peak compliance.',
      points: ['Best-compliance PEEP is one way to individualize PEEP.', 'Overdistension: compliance falls, plateau and PaCO₂ rise.', 'Recruitability varies — some ARDS lungs do not recruit.']
    },
    {
      id: 'a-table', lesson: 6, type: 'interactive', title: 'Use the PEEP–FiO₂ table',
      start: { preset: 'ards', settings: { mode: 'VC', vt: 400, rr: 26, peep: 5, ti: 0.7, fio2: 0.4 }, patient: { ...MALE, shunt: 0.45, recruit: { on: true, popt: 14, width: 6, shunt_min: 0.16 } } },
      lock: ['mode', 'vt'],
      table: 'ardsnet',
      question: 'Your unit uses the ARDSNet lower-PEEP / higher-FiO₂ table (open it with "PEEP–FiO₂ table"). The goal is SpO₂ 88–95%.\n\nPick a FiO₂/PEEP pair from the table that meets the target.',
      goal: [{ table: 'ardsnet' }, { m: 'spo2', op: 'between', v: [88, 95] }, { m: 'pplat', op: '<=', v: 30 }],
      solution: { settings: { fio2: 0.6, peep: 10 } },
      explain: 'The PEEP–FiO₂ tables from the ARDS Network trials pair each FiO₂ with a PEEP range, so oxygenation is supported with both levers together. Move one row at a time and wait for the SpO₂ to settle. Target SpO₂ 88–95% (PaO₂ 55–80 mmHg).',
      points: ['Move up or down the table one step at a time.', 'Target SpO₂ 88–95%; more oxygen than that brings no benefit.', 'The table is a starting point; recruitability and hemodynamics individualize it.']
    },

    // ---------------------------------------------------------------- Lesson 7
    {
      id: 'd-missed', lesson: 7, type: 'interactive', title: 'Efforts the ventilator never sees',
      start: { preset: 'obstructive', settings: { mode: 'VC', vt: 550, rr: 14, peep: 0, ti: 1.2, trig: 'flow', trig_f: 3, fio2: 0.4 }, patient: { ...MALE, c: 60, r: 18, rexp: 1.5, pcrit: 8, vd: 200, hco3: 30, effort: { on: true, pmax: 5, rate: 18, ti: 0.8 } } },
      view: { pmus: true },
      question: 'COPD with expiratory flow limitation. The patient\'s breathing muscles (pink trace) are working about 18 times a minute, but many efforts only dent the expiratory flow — no breath follows.\n\nReduce missed efforts to 2 per minute or fewer with plateau ≤ 30.',
      look: ['Find the bumps on the expiratory flow trace with no "P" breath after them.', 'An expiratory hold shows how much trapped pressure each effort must overcome.'],
      goal: [{ m: 'missed_min', op: '<=', v: 2 }, { m: 'pplat', op: '<=', v: 30 }],
      solution: { settings: { vt: 420, ti: 0.8, peep: 7, trig_f: 2 } },
      explain: 'Before a breath can be triggered, the patient\'s effort must first cancel the trapped (auto-PEEP) pressure, then create the trigger signal. Weak efforts fail. It takes several moves together: less trapping (smaller VT, shorter Ti), applied PEEP just below the auto-PEEP to narrow the gap, and a more sensitive trigger. No single change fixes it here.',
      points: ['Ineffective efforts show as bumps on expiratory flow with no breath.', 'They come from auto-PEEP, weak muscles, an insensitive trigger or over-assistance.', 'Fewer missed efforts means less wasted work and better comfort.']
    },
    {
      id: 'd-double', lesson: 7, type: 'interactive', title: 'Two breaths for one effort',
      start: { preset: 'normal', settings: { mode: 'VC', vt: 400, rr: 12, peep: 5, ti: 0.6, fio2: 0.4 }, patient: { ...MALE, c: 50, r: 10, effort: { on: true, pmax: 10, rate: 18, ti: 1.6 } } },
      view: { pmus: true },
      question: 'The patient takes long, strong breaths (pink trace). The ventilator ends each breath after 0.6 s, the patient is still pulling, and a second breath stacks on top of the first.\n\nStop the double triggering while keeping tidal volume ≤ 8 mL/kg PBW.',
      look: ['Two inspirations back to back with almost no exhalation between them.', 'Compare the length of the pink effort with the length of the ventilator\'s breath.'],
      goal: [{ m: 'double_min', op: '<=', v: 1 }, { m: 'vt_per_kg', op: '<=', v: 8 }],
      solution: { settings: { ti: 1.5 } },
      explain: 'Double triggering happens when the ventilator\'s inspiratory time is shorter than the patient\'s neural inspiratory time. The second breath stacks volume, often doubling the real tidal volume and defeating lung protection. Match the ventilator\'s Ti to the patient, or use a mode where the patient sets inspiratory time, and treat the cause of high drive.',
      points: ['Look for two breaths with little or no exhalation between them.', 'Lengthen Ti or let the patient control it (PSV).', 'Stacked breaths can double the delivered volume.']
    },
    {
      id: 'd-starve', lesson: 7, type: 'interactive', title: 'Flow starvation',
      start: { preset: 'normal', settings: { mode: 'VC', vt: 450, rr: 14, peep: 5, ti: 1.3, flow: 'square', fio2: 0.4 }, patient: { ...MALE, c: 50, r: 10, effort: { on: true, pmax: 10, rate: 20, ti: 0.9 } } },
      view: { pmus: true },
      question: 'An anxious patient is pulling hard on every breath in volume control with a slow, square flow. The pressure trace sags into a scoop during inspiration, dipping below PEEP.\n\nGet rid of the scoop (no pressure below PEEP during inspiration) with tidal volume ≤ 8 mL/kg PBW.',
      look: ['A normal VC pressure trace climbs; here it sags.', 'The patient wants more flow than the ventilator is giving.'],
      goal: [{ m: 'scoop', op: '<=', v: 0 }, { m: 'vt_per_kg', op: '<=', v: 8 }],
      solution: { settings: { vt: 500, ti: 1.0, flow: 'decel' } },
      explain: 'In VC the flow is fixed. When the patient demands more, their effort pulls airway pressure down, giving a concave, scooped pressure trace. This is uncomfortable and wastes work. Give more flow (shorter Ti or a decelerating pattern with a higher peak flow), a slightly larger breath if lung protection allows, or a pressure mode where flow follows demand. Also look for the cause: pain, anxiety, acidosis.',
      points: ['Scooped inspiratory pressure in VC = flow starvation.', 'Raise flow, or switch to a pressure-targeted mode.', 'Treat the drive: pain, fear, acidosis, fever.']
    },
    {
      id: 'd-late', lesson: 7, type: 'interactive', title: 'The breath that will not end',
      start: { preset: 'spont', settings: { mode: 'PSV', psupport: 12, peep: 5, cycle: 5, fio2: 0.35 }, patient: { ...MALE, c: 60, r: 20, rexp: 1.5, vd: 200, effort: { on: true, pmax: 6, rate: 16, ti: 1.0, push: 7 } } },
      lock: ['mode'],
      view: { pmus: true },
      question: 'COPD on pressure support with the expiratory trigger (cycle) at 5% of peak flow. Inspiratory flow decays slowly, so the ventilator keeps pushing after the patient has finished. You can see a pressure spike at the end of inspiration where the patient actively blows out.\n\nRemove the end-inspiratory pressure spike while staying in PSV.',
      look: ['The pink effort trace goes negative (active exhalation) before the ventilator lets go.', 'The pressure trace bumps above the set support at the end of the breath.'],
      goal: [{ m: 'overshoot', op: '<=', v: 1 }, { s: 'mode', op: '==', v: 'PSV' }],
      solution: { settings: { cycle: 40 } },
      explain: 'Pressure support ends a breath when flow falls to the cycle percentage of its peak. In COPD the long time constant makes flow decay slowly, so a low cycle percentage keeps inspiration going after the patient wants to exhale. The patient then fights the ventilator, pushing a spike onto the pressure trace and cutting expiratory time. Raising the cycle threshold (often 40–60% in COPD) ends the breath sooner.',
      points: ['Late cycling: pressure spike at end-inspiration, patient actively exhaling.', 'In COPD, raise the expiratory trigger (cycle %).', 'Shorter inspiration leaves more time to exhale.']
    },
    {
      id: 'd-early', lesson: 7, type: 'interactive', title: 'The breath that ends too soon',
      start: { preset: 'spont', settings: { mode: 'PSV', psupport: 4, peep: 5, cycle: 70, fio2: 0.35 }, patient: { ...MALE, c: 55, r: 9, effort: { on: true, pmax: 12, rate: 14, ti: 2.0 } } },
      lock: ['mode'],
      view: { pmus: true },
      question: 'Pressure support with the expiratory trigger at 70%. The patient takes long breaths (pink trace), but the ventilator stops helping early and a second breath follows almost immediately.\n\nStop the double triggering while staying in PSV.',
      goal: [{ m: 'double_min', op: '<=', v: 1 }, { s: 'mode', op: '==', v: 'PSV' }],
      solution: { settings: { cycle: 25 } },
      explain: 'A high cycle percentage ends the breath while the patient is still inhaling. The patient keeps pulling, the ventilator sees it as a new trigger, and a second breath follows. Lower the cycle percentage so inspiration lasts as long as the patient\'s effort.',
      points: ['Early cycling: short ventilator Ti, ongoing effort, often double triggering.', 'Lower the expiratory trigger (cycle %).', 'Late and early cycling are opposite problems with opposite fixes.']
    },

    // ---------------------------------------------------------------- Lesson 8
    {
      id: 'c-ptx', lesson: 8, type: 'mcq', title: 'Sudden high pressure and hypotension',
      start: { preset: 'normal', settings: { mode: 'VC', vt: 450, rr: 16, peep: 8, ti: 0.9, fio2: 0.5 }, patient: { ...MALE, c: 15, r: 10, shunt: 0.3, effort: { on: false } } },
      question: 'Minutes after a central line, the high-pressure alarm sounds. Plateau has jumped from 17 to about 38, SpO₂ is falling and the blood pressure is 74/40.\n\nWhat do you do first?',
      choices: [
        { text: 'Disconnect, bag with 100% oxygen, examine and scan for lung sliding; decompress if tension pneumothorax', correct: true, why: 'Plateau up, hypotension, recent line: tension pneumothorax until proven otherwise.' },
        { text: 'Lower the tidal volume to bring the plateau down', why: 'That treats the number, not the patient.' },
        { text: 'Order a chest X-ray and wait', why: 'Tension physiology needs treatment before imaging.' },
        { text: 'Increase sedation', why: 'The patient is not fighting the ventilator; the respiratory system got stiffer.' }
      ],
      explain: 'Use DOPE for acute deterioration on the ventilator: Displacement of the tube, Obstruction, Pneumothorax, Equipment failure (and Stacked breaths). Taking the patient off the ventilator and bagging separates ventilator problems from patient problems and relieves stacked breaths.',
      points: ['DOPE(S): displacement, obstruction, pneumothorax, equipment, stacking.', 'When in doubt, disconnect and bag with 100% oxygen.', 'Plateau rise + hypotension + recent procedure = think pneumothorax.']
    },
    {
      id: 'c-leak', lesson: 8, type: 'mcq', title: 'Volume that never comes back',
      start: { preset: 'normal', settings: { mode: 'PC', pinsp: 14, rr: 16, peep: 5, ti: 1.0, trig: 'flow', trig_f: 2 }, patient: { ...MALE, leak: 6, effort: { on: false } } },
      question: 'The volume trace climbs on inspiration but does not come back to zero before the next breath, and VTe is much lower than VTi. You can hear gurgling from the mouth.\n\nWhat is the most likely problem?',
      choices: [
        { text: 'A leak around the cuff or a tube that has migrated up', correct: true, why: 'Gas goes in but does not all come back through the circuit.' },
        { text: 'Auto-PEEP', why: 'Auto-PEEP shows on the flow trace; exhaled volume still equals inhaled volume.' },
        { text: 'Bronchospasm', why: 'That raises resistance; it does not lose volume.' },
        { text: 'A falsely high flow trigger', why: 'Leaks cause auto-triggering, but the missing volume points to a leak.' }
      ],
      explain: 'Inhaled minus exhaled volume is gas lost somewhere: the cuff, a cuff that has moved above the cords, a bronchopleural fistula, or the circuit. Check cuff pressure, tube depth and the circuit connections. A large leak can also auto-trigger breaths.',
      points: ['VTi much greater than VTe = leak.', 'Volume trace not returning to baseline is the waveform sign.', 'Check cuff pressure (20–30 cmH₂O) and tube position.']
    },
    {
      id: 'c-plug', lesson: 8, type: 'mcq', title: 'Peak up, plateau unchanged, SpO₂ down',
      start: { preset: 'normal', settings: { mode: 'VC', vt: 450, rr: 16, peep: 5, ti: 0.9, fio2: 0.4 }, patient: { ...MALE, c: 50, r: 45, effort: { on: false } } },
      question: 'Thick secretions all night. Now the peak pressure is about 36 with a plateau near 14, and the expiratory flow is slow to return to zero.\n\nBest next step?',
      choices: [
        { text: 'Pass a suction catheter down the tube', correct: true, why: 'High resistance with a normal plateau: the tube or airways are narrowed. Suction is diagnostic and therapeutic.' },
        { text: 'Raise PEEP', why: 'PEEP does not open a plugged tube.' },
        { text: 'Increase tidal volume', why: 'That raises pressures further.' },
        { text: 'Start diuresis', why: 'Edema lowers compliance; this is a resistance problem.' }
      ],
      explain: 'A rising peak with an unchanged plateau means pressure is being lost across the tube and airways. If a suction catheter will not pass, the tube is obstructed and needs to be cleared or changed. If it passes easily, think bronchospasm or a large plug deeper down.',
      points: ['Resistance problems: biting, kinking, secretions, bronchospasm.', 'Suction catheter that will not pass = obstructed tube.', 'Slow expiratory flow can create auto-PEEP too.']
    },
    {
      id: 'c-disconnect', lesson: 8, type: 'mcq', title: 'Flat line',
      start: { preset: 'normal', settings: { mode: 'VC', vt: 450, rr: 16, peep: 5, ti: 0.9 }, patient: { ...MALE, disconnect: true, effort: { on: false } } },
      question: 'Alarms everywhere. The pressure trace is almost flat near zero, VTe is zero, and the ventilator is still delivering flow on schedule.\n\nWhat happened?',
      choices: [
        { text: 'The circuit is disconnected from the tube (or the patient self-extubated)', correct: true, why: 'Flow goes out into the room; no pressure builds and nothing comes back.' },
        { text: 'Severe bronchospasm', why: 'Bronchospasm raises peak pressure.' },
        { text: 'Tension pneumothorax', why: 'That raises pressures.' },
        { text: 'Apnea', why: 'The ventilator is still delivering breaths; they are not reaching the patient.' }
      ],
      explain: 'Low pressure plus near-zero exhaled volume is a disconnection or extubation until proven otherwise. Look at the patient first: is the tube still in, is the circuit attached, is there an end-tidal CO₂ trace? Reconnect and confirm the tube position.',
      points: ['Low pressure + low VTe = disconnect or extubation.', 'Look at the patient before the ventilator.', 'Set the low-pressure and low-VTe alarms close enough to catch it.']
    },

    // ---------------------------------------------------------------- Lesson 9
    {
      id: 'l-sbt', lesson: 9, type: 'interactive', title: 'Set up a spontaneous breathing trial',
      start: { preset: 'normal', settings: { mode: 'VC', vt: 450, rr: 14, peep: 5, ti: 0.9, fio2: 0.35 }, patient: { ...MALE, c: 55, r: 9, effort: { on: true, pmax: 5, rate: 18, ti: 1.0 } } },
      question: 'Pneumonia improving, awake, triggering every breath, FiO₂ 0.35, PEEP 5. Time for a spontaneous breathing trial.\n\nSet up a standard SBT: pressure support of 5–7 over PEEP 5 or less, FiO₂ ≤ 0.5, with the patient triggering every breath.',
      goal: [{ s: 'mode', op: '==', v: 'PSV' }, { s: 'psupport', op: '<=', v: 7 }, { s: 'peep', op: '<=', v: 5 }, { s: 'fio2', op: '<=', v: 0.5 }, { m: 'patient_trig_frac', op: '>=', v: 0.9 }],
      solution: { settings: { mode: 'PSV', psupport: 5, peep: 5 } },
      explain: 'A spontaneous breathing trial asks whether the patient can breathe with minimal help. Low-level pressure support (5–8) or a T-piece for 30–120 minutes are both standard. Watch rate, tidal volume, SpO₂, heart rate, blood pressure and signs of distress.',
      points: ['Daily screen: improving cause, FiO₂ ≤ 0.5, PEEP ≤ 8, hemodynamically stable, awake.', 'SBT: PSV 5–8 / PEEP ≤ 5, or T-piece, 30–120 min.', 'Pair with a daily sedation interruption.']
    },
    {
      id: 'l-rsbi', lesson: 9, type: 'numeric', title: 'Rapid shallow breathing',
      start: { preset: 'spont', settings: { mode: 'PSV', psupport: 5, peep: 5, fio2: 0.4 }, patient: { ...MALE, c: 50, r: 10, effort: { on: true, pmax: 3.5, rate: 32, ti: 0.6 } } },
      question: 'Two minutes into the SBT. Read the total rate and the tidal volume.\n\nWhat is the rapid shallow breathing index (RR ÷ VT in litres)?',
      truth: m => m.rsbi, tol: 0.12, tolKind: 'rel', unit: 'breaths/min/L', dp: 0,
      explain: 'The rapid shallow breathing index (Yang and Tobin) is rate divided by tidal volume in litres. Above about 105 predicts failure; below it, most patients pass. This patient is breathing fast and shallow, and the PaCO₂ is rising — a failed trial. Return to full support and look for the reason.',
      points: ['RSBI = RR ÷ VT (L). > 105 suggests failure.', 'Measure it on minimal support, early in the trial.', 'It is one data point; the whole patient decides.']
    }
  ];

  // ------------------------------------------------------------------ tutorials
  // target: a CSS selector on the Vent Lab page. setup is applied when the step opens.
  // wait: { ev: 'ihold' | 'ehold' | 'mode' | 'loops' | 'pes', v? } — the step completes when it happens.
  const TUTORIALS = [
    {
      id: 'tour', title: 'Screen tour', blurb: 'Every part of the screen, numbered. Tap a number to read what it does.',
      setup: { preset: 'normal', settings: { mode: 'VC', vt: 450, rr: 14, peep: 5, ti: 0.9 }, patient: { effort: { on: true, pmax: 3, rate: 16, ti: 0.9 } } },
      markers: true,
      steps: [
        { target: '#wave', title: 'Waveforms', text: 'Three live traces against time: airway pressure (cmH₂O), flow (L/min, inspiration up, expiration down) and volume (mL). The gap moving across the screen is "now".' },
        { target: '#wave', title: 'Breath markers', text: 'A "P" over a breath means the patient triggered it. A "B" means a backup breath during apnea in pressure support. Unmarked breaths were triggered by the set rate.' },
        { target: '#freezeBtn', title: 'Freeze and measure', text: 'Freeze stops the screen. Then move your pointer (or finger) across the traces to read exact values at any moment.' },
        { target: '#mon', title: 'Monitor', text: 'Measured values for each breath: peak and mean pressure, PEEP, tidal volumes in (VTi) and out (VTe), minute volume, total rate, I:E and inspiratory time. Plateau and total PEEP appear after a hold.' },
        { target: '#abg', title: 'Gas exchange', text: 'Estimated steady-state blood gas, SpO₂ and end-tidal CO₂ for the current breathing pattern, oxygen and lung state.' },
        { target: '#modeTabs', title: 'Modes', text: 'Volume control, pressure control, pressure support and PRVC (adaptive pressure). Changing the mode changes which settings appear below.' },
        { target: '#knobs', title: 'Settings', text: 'Use − and + or tap a value to type it. New settings start on the next breath, as on a real ventilator.' },
        { target: '#holdBtns', title: 'Holds', text: 'Inspiratory hold measures plateau pressure. Expiratory hold measures total PEEP and reveals auto-PEEP. Both happen on the next breath.' },
        { target: '#loops', title: 'Loops', text: 'Pressure–volume and flow–volume loops of the last breath. Pin one as a reference to compare before and after a change.' },
        { target: '#patientPanel', title: 'Patient', text: 'Lung mechanics, effort and problems such as leaks, secretions and disconnection. In cases these are fixed by the scenario.' },
        { target: '#alarmBar', title: 'Alarms', text: 'Active alarms appear here. Limits are under "Alarm limits".' }
      ]
    },
    {
      id: 'normal-vc', title: 'A normal breath in volume control', blurb: 'What each part of the pressure, flow and volume traces means, and what normal looks like.',
      setup: { preset: 'normal', settings: { mode: 'VC', vt: 450, rr: 12, peep: 5, ti: 1.0, pause: 0, flow: 'square', fio2: 0.4, trig: 'flow', trig_f: 2 }, patient: { c: 50, r: 10, effort: { on: false } } },
      steps: [
        { target: '#wave', title: 'Normal starting settings', text: 'A common starting point for a passive adult: VC, tidal volume 6–8 mL/kg PBW (here 450 mL ≈ 6.4 mL/kg), rate 12–16, PEEP 5, FiO₂ titrated to SpO₂ 92–96%, inspiratory time about 1 s (I:E 1:2 to 1:4), flow trigger 2 L/min.' },
        { target: '#wave', title: 'Flow: a square block', text: 'With square flow, the ventilator delivers a constant flow — here 450 mL over 1 s, about 27 L/min. Expiration is passive: flow jumps negative, then decays back to zero. Normal: it reaches zero before the next breath.' },
        { target: '#wave', title: 'Volume: a straight ramp', text: 'Constant flow fills the lung at a constant rate, so volume rises in a straight line, then falls back to zero during expiration.' },
        { target: '#wave', title: 'Pressure: a jump, then a ramp', text: 'At the start of inspiration pressure jumps by flow × resistance (the resistive part). It then climbs as the lung stretches (the elastic part) to the peak. Normal peak is under about 30 cmH₂O.' },
        { target: '#holdBtns', title: 'See the plateau', text: 'Press "Inspiratory hold". On the next breath flow stops at end-inspiration and pressure drops from the peak to a flat plateau. That drop is the resistive part; plateau − PEEP is the elastic part.', wait: { ev: 'ihold' } },
        { target: '#mon', title: 'Read the result', text: 'Plateau now shows on the monitor, about 14 cmH₂O. Static compliance = 450 ÷ (14 − 5) ≈ 50 mL/cmH₂O — normal for a ventilated adult.' },
        { target: '#knobs', title: 'Try decelerating flow', text: 'Switch the flow pattern to "Decel". Peak flow is higher at the start and falls through the breath. The peak pressure changes; the plateau does not, because the volume is the same.' }
      ]
    },
    {
      id: 'normal-modes', title: 'Normal waveforms in PC, PSV and PRVC', blurb: 'Square pressure and decelerating flow: how pressure-targeted breaths look.',
      setup: { preset: 'normal', settings: { mode: 'PC', pinsp: 12, rr: 12, peep: 5, ti: 1.0, rise: 0.15, fio2: 0.4 }, patient: { c: 50, r: 10, effort: { on: false } } },
      steps: [
        { target: '#wave', title: 'Pressure control', text: 'Pressure rises to PEEP + Pinsp (here 17) and holds flat for the set Ti. Flow is highest at the start and decays as the lung fills. Volume rises quickly, then flattens. Normal: flow reaches or nears zero before the breath ends.' },
        { target: '#knobs', title: 'Rise time', text: 'Rise time sets how fast pressure reaches its target. A faster rise gives a higher peak flow — useful for patients who want flow, but it can overshoot.' },
        { target: '#modeTabs', title: 'Switch to PRVC', text: 'Choose PRVC. The ventilator now adjusts Pinsp breath by breath to deliver the target volume. Watch "Pinsp in use" settle over several breaths.', wait: { ev: 'mode', v: 'PRVC' } },
        { target: '#modeTabs', title: 'Pressure support', text: 'Pressure support needs a breathing patient. Switch to PSV and turn on patient effort in the Patient panel. Each breath is patient-triggered, pressure-targeted and ends when flow falls to the cycle percentage of its peak.', wait: { ev: 'mode', v: 'PSV' } },
        { target: '#patientPanel', title: 'Typical PSV settings', text: 'Normal starting PSV: support 5–10 cmH₂O over PEEP 5, cycle 25%, aiming for VT 6–8 mL/kg PBW and rate under about 30. Without effort, the apnea alarm switches to backup breaths after 20 s.' }
      ]
    },
    {
      id: 'holds', title: 'Hold maneuvers', blurb: 'Plateau, total PEEP, compliance, resistance and auto-PEEP in practice.',
      setup: { preset: 'obstructive', settings: { mode: 'VC', vt: 500, rr: 20, peep: 5, ti: 1.0, flow: 'square' }, patient: { c: 60, r: 25, rexp: 1.5, pcrit: 0, effort: { on: false } } },
      steps: [
        { target: '#wave', title: 'An obstructed patient', text: 'High resistance: the peak pressure is high and expiratory flow is still running when the next breath starts.' },
        { target: '#holdBtns', title: 'Inspiratory hold', text: 'Press "Inspiratory hold". The big drop from peak to plateau is the resistive pressure. The plateau itself is modest.', wait: { ev: 'ihold' } },
        { target: '#holdBtns', title: 'Expiratory hold', text: 'Press "Expiratory hold". Airway pressure rises above set PEEP as trapped alveolar pressure equilibrates. That rise is auto-PEEP.', wait: { ev: 'ehold' } },
        { target: '#mon', title: 'Put it together', text: 'Compliance = VT ÷ (plateau − total PEEP). Resistance = (peak − plateau) ÷ flow (L/s). Driving pressure = plateau − total PEEP.' },
        { target: '#knobs', title: 'Fix the trapping', text: 'Lower the rate to 12 and repeat the expiratory hold. Auto-PEEP should fall because each breath now has more time to empty.' }
      ]
    },
    {
      id: 'loops', title: 'Loops', blurb: 'Pressure–volume and flow–volume loops: normal, obstruction and overdistension.',
      setup: { preset: 'normal', settings: { mode: 'VC', vt: 450, rr: 14, peep: 5, ti: 0.9 }, patient: { c: 50, r: 10, effort: { on: false } } },
      steps: [
        { target: '#loops', title: 'Pressure–volume loop', text: 'Inspiration runs up the right side, expiration down the left. The slope is dynamic compliance; the loop\'s width is mostly resistance.' },
        { target: '#pinLoop', title: 'Pin a reference', text: 'Press "Pin as reference" to keep this loop in grey for comparison.', wait: { ev: 'pin' } },
        { target: '#patientPanel', title: 'Make it obstructed', text: 'In the Patient panel raise resistance to 30. The pressure–volume loop widens, and the flow–volume loop\'s expiratory limb scoops inward — the signature of airflow obstruction.' },
        { target: '#patientPanel', title: 'Overdistension', text: 'Set resistance back to 10, lower compliance to 30 and set "Overdistension above" to 400 mL. The top of the pressure–volume loop flattens into a beak: pressure rises with little extra volume. Smaller VT or less PEEP removes the beak.' }
      ]
    },
    {
      id: 'pes', title: 'Esophageal pressure', blurb: 'Separate the lung from the chest wall with an esophageal balloon.',
      setup: { preset: 'obese', settings: { mode: 'VC', vt: 450, rr: 16, peep: 5, ti: 0.9, fio2: 0.5 }, patient: { effort: { on: false } }, view: { pes: true } },
      steps: [
        { target: '#wave', title: 'Two pressures', text: 'The extra panel shows esophageal pressure (Pes, an estimate of pleural pressure) and transpulmonary pressure (Ptp = airway − esophageal), the pressure that actually distends the lung.' },
        { target: '#mon', title: 'Stiff chest wall', text: 'This patient has obesity: the chest wall is stiff and Pes is high (about 13 cmH₂O). At PEEP 5, Ptp at end-expiration is negative — the lung is being squeezed shut every exhalation.' },
        { target: '#knobs', title: 'PEEP to a positive Ptp', text: 'Raise PEEP in steps of 2 until end-expiratory Ptp is about 0 to +2. Watch compliance and SpO₂ improve as collapsed lung opens.' },
        { target: '#mon', title: 'Why plateau misleads here', text: 'Plateau pressure may now look high, but much of it is spent stretching the chest wall, not the lung. End-inspiratory Ptp (lung stress) is the safer number to limit, usually below about 20 cmH₂O.' }
      ]
    }
  ];

  // ------------------------------------------------------------------ helpers for the app and tests
  function startState(c) {
    const pre = (c.start && c.start.preset && E.PRESETS[c.start.preset]) || { settings: {}, patient: {} };
    const settings = E.normSettings(E.deepMerge(pre.settings, (c.start && c.start.settings) || {}));
    const patient = E.normPatient(E.deepMerge(pre.patient, (c.start && c.start.patient) || {}));
    return { settings, patient };
  }
  function solutionState(c) {
    const s = startState(c);
    if (c.solution) {
      if (c.solution.settings) s.settings = E.normSettings(E.deepMerge(s.settings, c.solution.settings));
      if (c.solution.patient) s.patient = E.normPatient(E.deepMerge(s.patient, c.solution.patient));
    }
    return s;
  }
  function grade(c, settings, patient, opts) {
    const sim = E.simulate(settings, patient, { warmup: (opts && opts.warmup) || 60, seconds: (opts && opts.seconds) || 30 });
    const results = (c.goal || []).map(r => evalRule(r, sim.metrics, E.normSettings(settings)));
    return { pass: results.length > 0 && results.every(r => r.ok), results, metrics: sim.metrics, samples: sim.samples, breaths: sim.breaths };
  }
  function truthFor(c) {
    const st = startState(c);
    const sim = E.simulate(st.settings, st.patient, { warmup: 60, seconds: 30 });
    return c.truth(sim.metrics, st);
  }
  function checkNumeric(c, value, truth) {
    const tol = c.tolKind === 'rel' ? Math.abs(truth) * c.tol : c.tol;
    return Math.abs(value - truth) <= tol;
  }

  return { METRICS, SETTING_LABELS, ARDSNET_LOW, LESSONS, CASES, TUTORIALS, evalRule, ruleText, startState, solutionState, grade, truthFor, checkNumeric };
}));
