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

// ---------------- NKV-style additions
// 13. Breath-by-breath estimates (no hold) match the truth in a passive patient
r = E.simulate({ mode: 'VC', vt: 500, rr: 15, peep: 5, ti: 1.0, flow: 'square' }, passive);
near('C est (VC)', r.metrics.c_est, 50, 2.5);
near('R est (VC)', r.metrics.r_est, 10, 1);
near('Pplat est (VC)', r.metrics.pplat_est, 15, 0.6);
near('Driving P est (VC)', r.metrics.pdriving_est, 10, 0.6);
near('PEEPi est (VC)', r.metrics.peepi_est, 0, 0.5);
near('Exp. time constant', r.metrics.tce, 0.5, 0.08);
near('C20/C linear lung', r.metrics.c20c, 1.0, 0.05);
r = E.simulate({ mode: 'PC', pinsp: 15, rr: 15, peep: 5, ti: 1.0, rise: 0.1 }, passive);
near('C est (PC)', r.metrics.c_est, 50, 4);
r = E.simulate({ mode: 'VC', vt: 500, rr: 22, peep: 5, ti: 1.0 }, copd);
check('PEEPi est sees auto-PEEP', r.metrics.peepi_est > 3, r.metrics.peepi_est && r.metrics.peepi_est.toFixed(1));
r = E.simulate({ mode: 'VC', vt: 550, rr: 15, peep: 10, ti: 1.0 }, { c: 35, r: 10, od_ml: 600, effort: { on: false } });
check('C20/C < 0.8 with overdistension', r.metrics.c20c < 0.8, r.metrics.c20c && r.metrics.c20c.toFixed(2));

// 14. SIMV: mandatory at the set rate, extra efforts get pressure support
const breather = { c: 55, r: 9, effort: { on: true, pmax: 5, rate: 20, ti: 0.9 } };
r = E.simulate({ mode: 'VC', vtype: 'SIMV', vt: 450, rr: 8, peep: 5, ti: 0.9, psupport: 6 }, breather, { warmup: 40, seconds: 60 });
near('SIMV total RR = effort rate', r.metrics.rr_actual, 20, 1);
near('SIMV spontaneous RR ≈ 20 − 8', r.metrics.rr_spont, 12, 1.5);
check('SIMV spontaneous breaths get PS 6, mandatory get VC', (() => { const b = r.breaths; const sp = b.filter(x => x.spont), md = b.filter(x => !x.spont); return sp.length && md.length && sp.every(x => x.mode === 'PSV' && x.pinsp === 6) && md.every(x => x.mode === 'VC'); })());
near('SIMV mandatory rate = set rate', r.breaths.filter(x => !x.spont).length, 8, 1);
r = E.simulate({ mode: 'VC', vtype: 'SIMV', vt: 450, rr: 10, peep: 5, ti: 0.9 }, passive);
near('SIMV in a passive patient = set rate', r.metrics.rr_actual, 10, 0.5);

// 15. Volume support converges; CPAP label
r = E.simulate({ mode: 'VS', vt: 450, peep: 5 }, breather, { warmup: 50 });
near('VS VT ≈ target', r.metrics.vt_patient, 450, 40);
check('CPAP label at PS 0', E.modeLabel(E.normSettings({ mode: 'PSV', psupport: 0 })) === 'SPONT-CPAP');

// 16. APRV: time-cycled at P-high/P-low, mean pressures, spontaneous breathing on top
r = E.simulate({ mode: 'APRV', phigh: 26, plow: 0, thigh: 4.5, tlow: 0.5 }, { c: 40, r: 10, effort: { on: true, pmax: 4, rate: 20, ti: 0.8 } });
near('APRV release rate', r.metrics.rr_actual, 12, 0.5);
check('APRV P-high mean ≈ 26', Math.abs(r.metrics.ph_mean - 26) < 2, r.metrics.ph_mean.toFixed(1));
check('APRV P-low mean small', r.metrics.pl_mean < 6, r.metrics.pl_mean.toFixed(1));
check('APRV short release traps volume (auto-PEEP > 3)', r.metrics.auto_peep > 3, r.metrics.auto_peep.toFixed(1));

// 17. P0.1 and NIF maneuvers
sim = E.createSim({ mode: 'PSV', psupport: 8, peep: 5 }, awake); sim.advance(20);
let got = {}; sim.onHold(h => { got[h.kind] = h; });
sim.queueManeuver('p01'); sim.advance(6);
near('P0.1 maneuver = Pmus at 100 ms', got.p01 && got.p01.p, E.p01Of(E.normPatient(awake).effort), 0.3);
sim.queueManeuver('nif'); sim.advance(12);
near('NIF maneuver ≈ −patient NIF', got.nif && got.nif.p, -45, 4);
sim = E.createSim({ mode: 'VC', vt: 450, rr: 14, peep: 5 }, passive); sim.advance(15); got = {}; sim.onHold(h => { got[h.kind] = h; });
sim.queueManeuver('nif'); sim.advance(12);
check('NIF in a paralyzed patient reads ~0', got.nif && Math.abs(got.nif.p) < 0.5 && got.nif.none, got.nif && got.nif.p.toFixed(2));

// 18. Manual breath, expiratory hold in PSV, capnogram shape
sim = E.createSim({ mode: 'VC', vt: 450, rr: 6, peep: 5, ti: 1.0 }, passive); sim.advance(12);
const nb = sim.breaths.length; sim.manualBreath(); sim.advance(1.5);
check('Manual breath delivered now', sim.breaths.length === nb + 1 || sim.phase === 'insp' || sim.breaths.length > nb);
sim = E.createSim({ mode: 'PSV', psupport: 8, peep: 5 }, awake); sim.advance(15); got = {}; sim.onHold(h => { got[h.kind] = h; });
sim.queueHold('exp'); sim.advance(8);
check('Expiratory hold works in PSV', got.exp && got.exp.p > 3, got.exp && got.exp.p.toFixed(1));
sim = E.createSim({ mode: 'VC', vt: 500, rr: 12, peep: 5, ti: 1.0 }, passive); sim.advance(10);
let co2ins = 0, co2late = 0;
sim.advance(10, s => { if (s.phase === 'insp') co2ins = Math.max(co2ins, s.co2); if (s.phase === 'exp' && s.vol < 80) co2late = Math.max(co2late, s.co2); });
check('Capnogram: zero in inspiration, plateau late in expiration', co2ins === 0 && co2late > 0.85, co2late.toFixed(2));

// 19. Rest of the monitored set exists and is plausible
r = E.simulate({ mode: 'PSV', psupport: 8, peep: 5 }, { ...awake, leak: 5 });
for (const k of ['rr_spont', 'mv_spont', 'ti_spont', 'duty', 'pmus', 'wob_pt', 'p01', 'nif', 'rsbi', 'rsbi_kg', 'leak_peep', 'vleak', 'mech_power', 'vco2', 'etco2', 'spo2'])
  check(`metric ${k} present`, r.metrics[k] != null && isFinite(r.metrics[k]), r.metrics[k] != null ? (+r.metrics[k]).toFixed(2) : 'null');

console.log(`\n${n - fails}/${n} passed`);
process.exit(fails ? 1 : 0);
