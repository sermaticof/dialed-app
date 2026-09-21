# Dialed

A phone-first reader for the `<Name> - TBD Guide` client sheets. It answers one
question fast, for every client at once:

> **How is this client's weight tracking this week against last week's average?**

Built to replace scrolling around Google Sheets hunting for a client. Same
visual language as the Ghost Setter console.

## What it shows

- **Clients** — every client as a card: current 7-day average, the change vs
  last week's average, a sparkline of this week's daily weigh-ins against last
  week's average, and how many weigh-ins have actually been logged. Grouped by
  check-in day with today's group first, or sorted by biggest move / gaining /
  dropping / missed logs. Instant search by name.
- **Today** — a **Needs attention** panel first: who has gone quiet, who is
  moving against their phase, who is changing faster than target, and which
  sheets failed to read. Each alert names the clients, and tapping a name opens
  them. Then whoever checks in today, and anyone else with missing weigh-ins.
- **Prep** — everyone with a show date, counting down by weeks out.
- **Client detail** — the week's daily chart with last week's average drawn as
  a reference line, compliance stats, the last coach note, a 16-week average
  trend, the protocol summary, a day-by-day table, and the full timeline.
  One tap to open the real sheet.

Installable to the home screen (PWA), and the app shell works offline —
client data never is cached on the device.

## How it reads the sheets

Verified against three live client sheets. The check-in block sits at the
**same rows** in every sheet but **not the same tab**, so the tab is found by
probing `E21` for the `Weight Log` header rather than being assumed:

| Where | What |
|---|---|
| `B22:C29` | protocol summary — water, diet, free meal, check-in day, show day, weeks out |
| `E22:G28` | one row per day starting **on** the check-in day: day name, weight, date |
| `I22:I28` / `K22:K28` | cardio done, steps |
| `F29` / `K29` | the sheet's own 7-day averages |
| `B33` | header of the weekly timeline |
| `B34:M…` | one row per week, **newest first**: week of, phase, avg weight, activity, food, training, supps, coach notes |

The app prefers the sheet's own `7-day AVG` cell over recomputing it, so it can
never disagree with the sheet. `#DIV/0!` and free-text cells (like the START
row's `174lbs 5'7.5 29 y/o`) are read as "no value" rather than as numbers.

**Compliance counts only days that have come around yet.** A client who checks
in Thursday and has logged Thu–Mon is 5/5, not 5/7.

**Change is coloured by intent, not direction.** A pound down is good in a CUT
and bad in GROWTH, so the phase decides the colour. An unrecognised phase stays
neutral instead of guessing, and the arrow and wording carry the meaning
regardless of colour.

**Rate is reported as %BW/week** — the number that actually decides whether to
move calories — and judged against a target band for the phase:

| Intent | Target |
|---|---|
| `down` (CUT, PREP, PRIMING, …) | −1.00 to −0.40 %BW/wk |
| `up` (GROWTH, BUILD, REVERSE, …) | +0.10 to +0.50 %BW/wk |
| `hold` (MAINTAIN, BRIDGE) | ±0.25 %BW/wk |

Outside the band reads as *slower/faster than target*; the wrong direction
entirely reads as *gaining in a cut* / *losing in a growth*.

### Tuning the coaching logic

Both of these live in one clearly marked `COACHING CONFIG` block at the top of
the script in `index.html`:

- `PHASE_INTENT` — what each phase is trying to do (`up`, `down`, `hold`).
  **`PRIMING` is set to `down`**, inferred from the pattern in the sheets
  (173 → 172 → 171 → 169 → 168 across priming weeks, then into GROWTH).
  Change it there if that isn't the intent.
- `RATE_BANDS` — the target %BW/week for each intent.

A phase that appears in neither stays neutral rather than being guessed at.

## Setup

1. **Create a Google service account** with the Drive and Sheets APIs enabled,
   and download its JSON key.
2. **Share the sheets with it.** Share the parent Drive folder (or each sheet)
   with the service account's `client_email` as a **Viewer**. It cannot see
   anything you don't share.
3. **Set the environment variables** in Netlify (see `.env.example`):

   | Variable | Required | What |
   |---|---|---|
   | `GOOGLE_SERVICE_ACCOUNT` | yes | the key JSON, on one line |
   | `DIALED_PASSCODE` | yes | the passcode to get into the app |
   | `DIALED_SESSION_SECRET` | yes | random string signing the session cookie; rotate to sign everyone out |
   | `ACTIVE_FOLDER_ID` | no | restrict discovery to one folder |
   | `SHEET_NAME_MATCH` | no | naming convention, default `TBD Guide` |

4. **Deploy to Netlify.** `publish = "."`, functions in `netlify/functions`.

### Access

The whole app is behind one shared passcode — anyone who has it can read every
client's data, so treat it like a password. This repository is public, so no
credentials belong in it; everything sensitive is an environment variable.

## Local development

```sh
npm install
npm run dev     # http://localhost:8787, passcode: dev
npm test
```

`dev/server.mjs` serves the app with **synthetic** client data, so the UI can be
worked on without Google credentials. No real client data is in this repo.

## Caching

Reading ~27 spreadsheets takes seconds, which is far too slow for every page
load on a phone, so results go in Netlify Blobs:

| Key | TTL |
|---|---|
| roster summaries | 10 min |
| one client's detail | 3 min |
| the client list from Drive | 1 hour |
| resolved tab name per sheet | until it stops matching |

Refresh forces a re-read. If a refresh fails, the last good data is served with
a "showing cached data" banner rather than an error screen, and one unreadable
sheet shows as a single bad card instead of blanking the roster.
