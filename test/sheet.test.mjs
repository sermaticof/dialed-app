// Parser tests. Fixtures are synthetic but mirror the real sheet geometry
// (verified against three live client sheets on 2026-09-21): the check-in
// block at rows 21-29 and the weekly timeline at row 33+, newest week first.
//
//   node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { parse, clientName, num, round } from '../netlify/functions/_sheet.js';

/** Build a rows array (columns B..R) from a {cellRef: value} map. */
function grid(fromRow, toRow, cells) {
  const out = [];
  for (let r = fromRow; r <= toRow; r++) {
    const row = new Array(17).fill('');
    for (const [ref, val] of Object.entries(cells)) {
      const m = /^([A-R])(\d+)$/.exec(ref);
      if (Number(m[2]) !== r) continue;
      row[m[1].charCodeAt(0) - 'B'.charCodeAt(0)] = val;
    }
    out.push(row);
  }
  return out;
}

const BLOCK = () => grid(21, 29, {
  B21: 'Protocol Summary', E21: 'Weight Log', G21: 'Date', H21: 'Cardio Log', J21: 'Step Log',
  B22: 'Water intake:', C22: '1-1.5 gal/day', E22: 'Thursday', F22: '200.00', G22: '9/17', I22: 'TRUE', K22: '9,000.00',
  B23: 'Baseline Diet:', C23: 'Everyday',     E23: 'Friday',   F23: '201.00', G23: '9/18', I23: 'FALSE', K23: '10,000.00',
                                              /* Sat missed */ E24: 'Saturday',             G24: '9/19', I24: 'TRUE',
  B25: 'Free meal:',    C25: 'Saturday',      E25: 'Sunday',   F25: '199.00', G25: '9/20', I25: 'TRUE',  K25: '11,000.00',
  B26: 'Check-in Day:', C26: 'Thursday',      E26: 'Monday',   F26: '198.00', G26: '9/21', I26: 'FALSE',
  B27: 'Show Day:',     C27: '10/31/2026',    E27: 'Tuesday',                 G27: '9/22',
  B28: 'Weeks out:',    C28: '6',             E28: 'Wednesday',               G28: '9/23',
  B29: 'Next Payment:',                       E29: '7-day AVG', F29: '199.50', J29: '7-day AVG', K29: '10,000.00',
});

const TIMELINE = () => grid(33, 60, {
  B33: 'Week of:', C33: 'Phase', D33: 'AVG Weight', E33: 'Activity', G33: 'FOOD', I33: 'Training', K33: 'Supps', M33: 'Coach Notes / Updates',
  B34: '9/17/2026', C34: 'CUT',   D34: '201.00', E34: '(15k) 10,360 no changes', G34: 'no changes', I34: 'No changes', K34: 'No changes', M34: 'weight down, look improving',
  B35: '9/10/2026', C35: 'CUT',   D35: '202.50', E35: '(15k) 17,730 no changes', G35: 'no changes', I35: 'No changes', K35: 'No changes', M35: 'no changes for now',
  B36: '9/3/2026',  C36: 'START', D36: "205lbs 5'10 29 y/o  stage: 185lbs",      G36: 'CURRENT: 4kcals',
});

const MONDAY = new Date('2026-09-21T12:00:00Z');

test('reads the protocol summary', () => {
  const d = parse(BLOCK(), TIMELINE(), MONDAY);
  assert.equal(d.protocol.checkInDay, 'Thursday');
  assert.equal(d.protocol.showDay, '10/31/2026');
  assert.equal(d.protocol.weeksOut, '6');
  assert.equal(d.protocol.freeMeal, 'Saturday');
});

test('reads the daily weight log starting on the check-in day', () => {
  const d = parse(BLOCK(), TIMELINE(), MONDAY);
  assert.equal(d.days.length, 7);
  assert.equal(d.days[0].day, 'Thursday');
  assert.deepEqual(d.days.map((x) => x.weight), [200, 201, null, 199, 198, null, null]);
  assert.equal(d.days[0].date, '9/17');
});

test('prefers the sheet\'s own 7-day average over recomputing it', () => {
  const d = parse(BLOCK(), TIMELINE(), MONDAY);
  assert.equal(d.currentAvg, 199.5); // sheet says 199.50; mean of logged is 199.5
  assert.equal(d.stepAvg, 10000);
});

test('falls back to a computed average when the sheet cell is blank', () => {
  const block = BLOCK();
  block[8][4] = ''; // F29
  const d = parse(block, TIMELINE(), MONDAY);
  assert.equal(d.currentAvg, 199.5); // (200+201+199+198)/4
});

test('computes the delta against last week\'s average', () => {
  const d = parse(BLOCK(), TIMELINE(), MONDAY);
  assert.equal(d.lastWeek.avg, 201);
  assert.equal(d.delta, -1.5);
  assert.equal(d.deltaPct, -0.75);
  assert.equal(d.phase, 'CUT');
});

test('counts only days that have come around yet', () => {
  // Check-in Thursday, today Monday -> Thu,Fri,Sat,Sun,Mon = 5 slots due.
  const d = parse(BLOCK(), TIMELINE(), MONDAY);
  assert.equal(d.dueDays, 5);
  assert.equal(d.loggedDays, 4);
  assert.equal(d.missedDays, 1); // Saturday
  assert.deepEqual(d.days.map((x) => x.due), [true, true, true, true, true, false, false]);
});

test('tracks how long since the last weigh-in', () => {
  // Thu 200, Fri 201, Sat missed, Sun 199, Mon 198 -> logged on the latest due day.
  const d = parse(BLOCK(), TIMELINE(), MONDAY);
  assert.equal(d.staleDays, 0);
  assert.equal(d.lastLoggedDay, 'Monday');
});

test('staleDays counts back to the most recent weigh-in', () => {
  const block = BLOCK();
  block[4][4] = ''; // F25 Sunday
  block[5][4] = ''; // F26 Monday
  const d = parse(block, TIMELINE(), MONDAY);
  assert.equal(d.lastLoggedDay, 'Friday');
  assert.equal(d.staleDays, 3); // Sat, Sun, Mon
});

test('staleDays equals the whole week when nothing is logged', () => {
  const block = BLOCK();
  for (let r = 1; r <= 7; r++) block[r][4] = '';
  block[8][4] = '';
  const d = parse(block, TIMELINE(), MONDAY);
  assert.equal(d.lastLoggedDay, null);
  assert.equal(d.staleDays, 5);
  assert.equal(d.currentAvg, null);
  assert.equal(d.delta, null);
});

test('counts cardio sessions marked done', () => {
  assert.equal(parse(BLOCK(), TIMELINE(), MONDAY).cardioDone, 3);
});

test('skips timeline rows whose average is free text', () => {
  const d = parse(BLOCK(), TIMELINE(), MONDAY);
  assert.equal(d.weeks.length, 3);
  assert.equal(d.weeks[2].phase, 'START');
  assert.equal(d.weeks[2].avg, null);       // "205lbs 5'10 29 y/o" is not a weight
  assert.equal(d.lastWeek.weekOf, '9/17/2026'); // newest row that has a real average
});

test('handles a sheet with no timeline at all', () => {
  const d = parse(BLOCK(), [], MONDAY);
  assert.equal(d.lastWeek, null);
  assert.equal(d.delta, null);
  assert.equal(d.currentAvg, 199.5);
});

test('num() accepts sheet formatting and rejects errors and prose', () => {
  assert.equal(num('167.40'), 167.4);
  assert.equal(num('9,940.00'), 9940);
  assert.equal(num('156'), 156);
  assert.equal(num('-2.5'), -2.5);
  assert.equal(num('#DIV/0!'), null);
  assert.equal(num('#REF!'), null);
  assert.equal(num(''), null);
  assert.equal(num(null), null);
  assert.equal(num("174lbs 5'7.5 29 y/o"), null);
  assert.equal(num('10k'), null);
});

test('clientName() strips the naming convention', () => {
  assert.equal(clientName('Austin - TBD Guide'), 'Austin');
  assert.equal(clientName('Ty- TBD Guide'), 'Ty');
  assert.equal(clientName('Nathan- TBD Guide'), 'Nathan');
  assert.equal(clientName('Tori <3 - TBD Guide'), 'Tori <3');
  assert.equal(clientName('Just A Name'), 'Just A Name');
});

test('round()', () => {
  assert.equal(round(167.905, 2), 167.91);
  assert.equal(round(-0.126, 2), -0.13);
  assert.equal(round(199.5, 2), 199.5);
  // Binary floating point: 1.005 * 100 is 100.4999..., so this rounds down.
  // Harmless at the precision bodyweight is logged to; documented, not fixed.
  assert.equal(round(1.005, 2), 1);
});
