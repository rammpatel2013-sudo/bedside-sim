// node tests/vent_engine.test.js — physiology checks against hand calculations
const E = require('../static/vent/engine.js');
let fails = 0, n = 0;
function near(name, got, want, tol) {
  n++; const ok = got != null && Math.abs(got - want) <= tol;
  if (!ok) fails++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got == null ? 'null' : (+got).toFixed(2)} (want ${want} ±${tol})`);
}
function check(name, cond, info) { n++; if (!cond) fails++; console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${info ? ' — ' + info : ''}`); }
const passive = { c: 50, r: 10, rexp: 1, vd: 150, effort: { on: false } };

// 1. VC square: Ppeak = PEEP + VT/C + Q·R = 5 + 10 + 5
let r = E.simulate({ mode: 'VC', vt: 500, rr: 15, peep: 5, ti: 1.0, flow: 'square' }, passive);
near('VC Ppeak', r.metrics.ppeak, 20, 0.4);
near('VC Pplat (true)', r.metrics.pplat, 15, 0.3);
near('VC auto-PEEP', r.metrics.auto_peep, 0, 0.3);
near('VC VTe', r.metrics.vte, 500, 5);
near('VC Cstat', r.metrics.cstat, 50, 1.5);
near('VC actual RR', r.metrics.rr_actual, 15, 0.3);
near('ABG PaCO2 (VA = (500-150)*15)', r.metrics.paco2, 0.863 * 200 / 5.25, 1);

// 2. Holds measure plateau and total PEEP
let sim = E.createSim({ mode: 'VC', vt: 500, rr: 15, peep: 5, ti: 1.0 }, passive);
sim.advance(20); sim.queueHold('insp'); sim.advance(8);
let hb = sim.breaths.filter(b => b.pplat != null).pop();
near('Inspiratory hold Pplat', hb && hb.pplat, 15, 0.3);
sim.queueHold('exp'); sim.advance(10);
hb = sim.breaths.filter(b => b.ptot != null).pop();
near('Expiratory hold total PEEP', hb && hb.ptot, 5, 0.3);

// 3. PC: VT ≈ C·Pinsp·(1−e^(−Ti/τ)) minus rise-time loss
r = E.simulate({ mode: 'PC', pinsp: 15, rr: 15, peep: 5, ti: 1.0, rise: 0.05 }, passive);
near('PC VT', r.metrics.vt_patient, 750 * (1 - Math.exp(-2)), 30);
near('PC Ppeak', r.metrics.ppeak, 20, 0.3);

// 4. Obstruction → dynamic hyperinflation; slower rate fixes it
const copd = { c: 60, r: 28, rexp: 1.6, vd: 200, effort: { on: false } };
r = E.simulate({ mode: 'VC', vt: 500, rr: 22, peep: 5, ti: 1.0 }, copd);
check('COPD fast rate auto-PEEP > 4', r.metrics.auto_peep > 4, r.metrics.auto_peep.toFixed(1));
check('COPD end-expiratory flow not zero', r.metrics.end_exp_flow < -5, r.metrics.end_exp_flow.toFixed(1) + ' L/min');
const r2 = E.simulate({ mode: 'VC', vt: 450, rr: 10, peep: 5, ti: 0.8 }, copd);
check('COPD slow rate auto-PEEP < 1.5', r2.metrics.auto_peep < 1.5, r2.metrics.auto_peep.toFixed(1));
check('COPD peak-plateau gap large', r.metrics.ppeak - r.metrics.pplat > 10, (r.metrics.ppeak - r.metrics.pplat).toFixed(1));

// 5. Cardiac oscillation false triggers
const paralyzed = { c: 50, r: 10, cardiac: true, effort: { on: false } };
r = E.simulate({ mode: 'PC', pinsp: 10, rr: 14, peep: 5, ti: 1.0, trig: 'flow', trig_f: 1.5 }, paralyzed);
check('Cardiac + flow trig 1.5 → false triggers', r.metrics.false_trig_min > 4, r.metrics.false_trig_min.toFixed(1) + '/min, RR ' + r.metrics.rr_actual.toFixed(0));
r = E.simulate({ mode: 'PC', pinsp: 10, rr: 14, peep: 5, ti: 1.0, trig: 'flow', trig_f: 4 }, paralyzed);
check('Cardiac + flow trig 4 → none', r.metrics.false_trig_min === 0, 'RR ' + r.metrics.rr_actual.toFixed(1));
r = E.simulate({ mode: 'PC', pinsp: 10, rr: 14, peep: 5, ti: 1.0, trig: 'pressure', trig_p: -1 }, paralyzed);
check('Cardiac + pressure trig −1 → false triggers', r.metrics.false_trig_min > 4, r.metrics.false_trig_min.toFixed(1));
r = E.simulate({ mode: 'PC', pinsp: 10, rr: 14, peep: 5, ti: 1.0, trig: 'pressure', trig_p: -2 }, paralyzed);
check('Cardiac + pressure trig −2 → none', r.metrics.false_trig_min === 0);

// 6. Ineffective efforts with auto-PEEP
const copdBreathing = { ...copd, effort: { on: true, pmax: 4, rate: 24, ti: 0.8 } };
r = E.simulate({ mode: 'VC', vt: 550, rr: 18, peep: 0, ti: 1.2, trig: 'flow', trig_f: 3 }, copdBreathing);
check('COPD + weak effort → missed triggers', r.metrics.missed_min > 3, r.metrics.missed_min.toFixed(1) + '/min');

// 7. PSV with effort: every breath patient-triggered, reasonable VT
const awake = { c: 55, r: 9, effort: { on: true, pmax: 6, rate: 18, ti: 0.9 } };
r = E.simulate({ mode: 'PSV', psupport: 8, peep: 5, cycle: 25 }, awake);
check('PSV all patient-triggered', r.metrics.patient_trig_frac > 0.95, (r.metrics.patient_trig_frac * 100).toFixed(0) + '%');
near('PSV actual RR = effort rate', r.metrics.rr_actual, 18, 0.6);
check('PSV VT 350–650', r.metrics.vt_patient > 350 && r.metrics.vt_patient < 650, r.metrics.vt_patient.toFixed(0));

// 8. PSV apnea → backup
r = E.simulate({ mode: 'PSV', psupport: 8, peep: 5, backup: { pinsp: 15, rr: 12, ti: 1 } }, passive, { warmup: 30, seconds: 30 });
check('PSV apnea → backup breaths', r.metrics.rr_actual > 10, r.metrics.rr_actual.toFixed(1));

// 9. PRVC converges to target
r = E.simulate({ mode: 'PRVC', vt: 450, rr: 16, peep: 5, ti: 1.0 }, passive, { warmup: 40 });
near('PRVC VT ≈ target', r.metrics.vt_patient, 450, 25);

// 10. Leak and disconnection
r = E.simulate({ mode: 'PC', pinsp: 15, rr: 16, peep: 5, ti: 1.0 }, { ...passive, leak: 20 });
check('Leak → VTe < VTi, leak > 15%', r.metrics.leak_pct > 15, r.metrics.leak_pct.toFixed(0) + '%');
r = E.simulate({ mode: 'VC', vt: 500, rr: 16, peep: 5, ti: 1.0 }, { ...passive, disconnect: true });
check('Disconnect → VTe ~0', r.metrics.vte < 10, r.metrics.vte.toFixed(0));

// 11. ARDS recruitment: better compliance and SpO2 near popt
const ards = E.PRESETS.ards.patient;
const lo = E.simulate({ mode: 'VC', vt: 400, rr: 24, peep: 5, ti: 0.8, fio2: 0.8 }, ards, { warmup: 60 });
const mid = E.simulate({ mode: 'VC', vt: 400, rr: 24, peep: 14, ti: 0.8, fio2: 0.8 }, ards, { warmup: 60 });
check('ARDS PEEP 14 compliance > PEEP 5', mid.metrics.cstat > lo.metrics.cstat + 5, lo.metrics.cstat.toFixed(0) + ' → ' + mid.metrics.cstat.toFixed(0));
check('ARDS PEEP 14 SpO2 > PEEP 5', mid.metrics.spo2 > lo.metrics.spo2 + 3, lo.metrics.spo2.toFixed(0) + ' → ' + mid.metrics.spo2.toFixed(0));

// 12. Double triggering: long neural Ti vs short vent Ti
r = E.simulate({ mode: 'VC', vt: 400, rr: 12, peep: 5, ti: 0.6, trig: 'flow', trig_f: 2 }, { c: 50, r: 10, effort: { on: true, pmax: 10, rate: 18, ti: 1.6 } });
check('Long effort + short Ti → double triggers', r.metrics.double_min > 3, r.metrics.double_min.toFixed(1) + '/min');

console.log(`\n${n - fails}/${n} passed`);
process.exit(fails ? 1 : 0);
