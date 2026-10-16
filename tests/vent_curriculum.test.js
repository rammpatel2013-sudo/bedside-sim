// node tests/vent_curriculum.test.js — every case is solvable and not pre-solved
const C = require('../static/vent/curriculum.js');
let fails = 0, n = 0;
const ok = (cond, msg) => { n++; if (!cond) fails++; console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); };
const ids = new Set();
for (const c of C.CASES) {
  ok(!ids.has(c.id), `${c.id}: unique id`); ids.add(c.id);
  ok(C.LESSONS.some(l => l.n === c.lesson), `${c.id}: lesson exists`);
  ok(c.explain && c.points && c.points.length === 3, `${c.id}: explanation + 3 teaching points`);
  if (c.type === 'interactive') {
    const s = C.startState(c), a = C.solutionState(c);
    const g0 = C.grade(c, s.settings, s.patient), g1 = C.grade(c, a.settings, a.patient);
    ok(!g0.pass, `${c.id}: start fails  [${g0.results.map(r => (r.ok ? '✓' : '✗') + ' ' + r.text + (r.got ? ' = ' + r.got : '')).join(' | ')}]`);
    ok(g1.pass, `${c.id}: model answer passes  [${g1.results.map(r => (r.ok ? '✓' : '✗') + ' ' + r.text + (r.got ? ' = ' + r.got : '')).join(' | ')}]`);
    const locked = (c.lock || []).filter(k => JSON.stringify(a.settings[k]) !== JSON.stringify(s.settings[k]));
    ok(locked.length === 0, `${c.id}: model answer leaves locked controls alone`);
  } else if (c.type === 'mcq') {
    ok(c.choices.filter(x => x.correct).length === 1, `${c.id}: exactly one correct choice`);
  } else if (c.type === 'numeric') {
    const t = C.truthFor(c);
    ok(t != null && isFinite(t), `${c.id}: numeric truth = ${t != null ? t.toFixed(2) : t} ${c.unit}`);
  }
}
for (const t of C.TUTORIALS) ok(t.steps.length >= 4 && t.steps.every(s => s.title && s.text), `tutorial ${t.id}: ${t.steps.length} steps`);
console.log(`\n${n - fails}/${n} passed — ${C.CASES.length} cases, ${C.TUTORIALS.length} tutorials`);
process.exit(fails ? 1 : 0);
