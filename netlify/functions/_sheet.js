// Parses one "<Name> - TBD Guide" spreadsheet into the shape the app renders.
//
// Layout, verified against Austin / Cory / Josiah's sheets (2026-09-21). The
// check-in block sits at the SAME ROWS in every sheet but NOT on the same tab
// index — Cory and Josiah have it on tab 1, Austin on tab 4 — so the tab is
// found by probing for the "Weight Log" header rather than assumed.
//
//   row 21        header: B..D "Protocol Summary", E:F "Weight Log", G "Date",
//                         H:I "Cardio Log", J:K "Step Log", L+ varies by client
//   rows 22..28   one row per day, starting ON the client's check-in day:
//                         E day name, F fasted weight, G date, I cardio done,
//                         K steps
//   row 29        E "7-day AVG", F average weight, K average steps
//   row 33        header of the weekly timeline
//   rows 34..     one row per week, NEWEST FIRST:
//                         B week of, C phase, D avg weight, E activity,
//                         G food, I training, K supps, M coach notes
//
// Merged cells return their value in the top-left cell only, so each field
// above is read from the first column of its merge.

export const PROBE_CELL = 'E21';
export const PROBE_EXPECT = 'weight log';

const BLOCK = 'B21:R29';
const TIMELINE = 'B33:R60';

// Column letter -> index within a range starting at column B.
const C = { B: 0, C: 1, D: 2, E: 3, F: 4, G: 5, H: 6, I: 7, J: 8, K: 9, L: 10, M: 11, N: 12, O: 13 };

export const RANGES = (tab) => [`${q(tab)}!${BLOCK}`, `${q(tab)}!${TIMELINE}`];
export const probeRange = (tab) => `${q(tab)}!${PROBE_CELL}`;

/** A1 notation quoting: wrap in single quotes, double any internal quote. */
function q(tab) {
  return `'${String(tab).replace(/'/g, "''")}'`;
}

const cell = (rows, r, col) => {
  const row = rows[r];
  if (!row) return '';
  const v = row[C[col]];
  return v == null ? '' : String(v).trim();
};

/** "9,940.00" -> 9940 ; "#DIV/0!" / "" / "174lbs 5'7" -> null */
export function num(v) {
  if (v == null) return null;
  const s = String(v).replace(/,/g, '').trim();
  if (!s || s.startsWith('#')) return null;
  // Only accept a clean number, so free-text cells like the START row's
  // "174lbs 5'7.5 29 y/o" don't get read as a weight.
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function bool(v) {
  const s = String(v || '').trim().toUpperCase();
  if (s === 'TRUE') return true;
  if (s === 'FALSE') return false;
  return null;
}

/** Strips the naming convention off the file name: "Ty- TBD Guide" -> "Ty". */
export function clientName(fileName, match = 'TBD Guide') {
  const esc = match.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return String(fileName).replace(new RegExp(`\\s*[-–—]?\\s*${esc}\\s*$`, 'i'), '').trim() || fileName;
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * How many of the week's 7 slots have actually come around yet.
 * The log starts ON the client's check-in day, so a client who checks in
 * Thursday and has logged Thu-Mon is at 5/5, not 5/7 — the remaining rows are
 * days that haven't happened. Counting them as misses would make every client
 * look non-compliant for most of the week.
 */
function dueCount(firstDayName, today) {
  const start = DAYS.indexOf(firstDayName);
  if (start < 0) return 7;
  return ((today.getDay() - start + 7) % 7) + 1;
}

export function parse(blockRows, timelineRows, today = new Date()) {
  // --- protocol summary: label in B, value in C -----------------------------
  const protocol = {};
  for (let r = 1; r <= 8; r++) {
    const label = cell(blockRows, r, 'B').replace(/:\s*$/, '');
    const value = cell(blockRows, r, 'C');
    if (label) protocol[label.toLowerCase()] = value;
  }

  // --- this week's daily log (rows 22..28 => index 1..7) --------------------
  const days = [];
  for (let r = 1; r <= 7; r++) {
    const day = cell(blockRows, r, 'E');
    if (!day || /7-day/i.test(day)) continue;
    days.push({
      day,
      date: cell(blockRows, r, 'G'),
      weight: num(cell(blockRows, r, 'F')),
      steps: num(cell(blockRows, r, 'K')),
      cardio: bool(cell(blockRows, r, 'I')),
    });
  }

  // --- row 29: the sheet's own 7-day averages -------------------------------
  const sheetAvg = num(cell(blockRows, 8, 'F'));
  const stepAvg = num(cell(blockRows, 8, 'K'));

  const due = days.length ? Math.min(dueCount(days[0].day, today), days.length) : 0;
  days.forEach((d, i) => { d.due = i < due; });

  const logged = days.filter((d) => d.weight != null);
  const missed = days.filter((d, i) => i < due && d.weight == null).length;

  // How many due days have passed since the most recent weigh-in. 0 means they
  // logged on the latest day that has come around; `due` means nothing at all
  // this week. This is what drives the "gone quiet" alerts.
  let lastLogged = -1;
  for (let i = 0; i < due; i++) if (days[i]?.weight != null) lastLogged = i;
  const staleDays = lastLogged < 0 ? due : (due - 1) - lastLogged;
  // Prefer the sheet's own average so the app never disagrees with the sheet;
  // fall back to computing it when that cell is blank or errored.
  const currentAvg = sheetAvg != null
    ? sheetAvg
    : (logged.length ? round(logged.reduce((s, d) => s + d.weight, 0) / logged.length, 2) : null);

  // --- weekly timeline (row 34+), newest first ------------------------------
  const weeks = [];
  for (let r = 1; r < timelineRows.length; r++) {
    const weekOf = cell(timelineRows, r, 'B');
    if (!weekOf) continue;
    weeks.push({
      weekOf,
      phase: cell(timelineRows, r, 'C'),
      avg: num(cell(timelineRows, r, 'D')),
      activity: cell(timelineRows, r, 'E'),
      food: cell(timelineRows, r, 'G'),
      training: cell(timelineRows, r, 'I'),
      supps: cell(timelineRows, r, 'K'),
      notes: cell(timelineRows, r, 'M'),
    });
  }

  const lastWeek = weeks.find((w) => w.avg != null) || null;
  const delta = currentAvg != null && lastWeek ? round(currentAvg - lastWeek.avg, 2) : null;

  return {
    protocol: {
      checkInDay: protocol['check-in day'] || protocol['check in day'] || '',
      showDay: protocol['show day'] || '',
      weeksOut: protocol['weeks out'] || '',
      water: protocol['water intake'] || '',
      diet: protocol['baseline diet'] || '',
      freeMeal: protocol['free meal'] || '',
      nextPayment: protocol['next payment'] || '',
    },
    days,
    currentAvg,
    stepAvg,
    lastWeek,
    delta,
    deltaPct: delta != null && lastWeek?.avg ? round((delta / lastWeek.avg) * 100, 2) : null,
    phase: weeks[0]?.phase || '',
    loggedDays: logged.length,
    dueDays: due,
    missedDays: missed,
    staleDays,
    lastLoggedDay: lastLogged >= 0 ? days[lastLogged].day : null,
    expectedDays: days.length || 7,
    cardioDone: days.filter((d) => d.cardio === true).length,
    weeks: weeks.slice(0, 26),
  };
}

export function round(n, p) {
  const f = 10 ** p;
  return Math.round(n * f) / f;
}
