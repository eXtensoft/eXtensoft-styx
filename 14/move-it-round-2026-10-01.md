# Move It — real-environment round, 2026-10-01

What changed since the 09-21 round, what to do with it, and what to bring back. Design:
`features/move-it.md` §21–§25 (and §20 if the 09-24 build never reached the server).
Decisions made without you: `calls-made-for-you.md`, 2026-10-01 entries. The 09-21 round
(`move-it-round-2026-09-21.md`) was never run; its steps 3–7 still apply and can ride along.

**This round adds one table** (`moveit.BackfillRun`, created by `001`) and renames nothing
further — your `HealthReportId` → `ReportId` rename is already folded into `001`.

## What is in this round

| Change | Where | Real-side effect |
|---|---|---|
| `moveit.BackfillRun` — the backfill stamps each run and how far it looked | `001`, `backfill-deployment.sql` | **re-run 001 before the backfill** |
| `001` renames an old `HealthReportId` column to `ReportId` | `001` | silent if you already renamed it |
| **Calendar** tab — arrivals, rollbacks, events, targets, hold spans on a month grid | `/moveit/calendar` | new; reads `board/calendar.sql` |
| **The week** tab — seven days on one printable page | `/moveit/week` | new; sends nothing |
| **Needs a word from you** — what has not been recorded yet | top of History | History now runs 9 queries, was 6 |
| **Coverage line** — what the board cannot see | Division, under the numbers | new `board/coverage.sql` (11 without its slow part) |
| **Calendar rail** — controls down the left; the month fits the screen | `/moveit/calendar` (§26) | no data change |
| **The frame on every page** — thin page bar, one header line, applications in the rail, secondary things float over | all Move It pages (§26.1) | no data change |
| Hits-per-day trend fits 30+ days | Census classic dashboard | no data change |
| `tests/Test-MoveItQuestions.ps1` | here only | **never run it against the real server** — it reseeds |

Two new optional settings under `MoveIt` (defaults shown; leave them out to take the defaults):

```json
"StaleDays": 14,
"ComingDays": 60
```

## Steps

1. [ ] Get the code there and start the site.
2. [ ] **Run `apptrak/sql/001-create-deployment.sql` in SSMS.** It creates
       `moveit.BackfillRun`; on a `Deployment` that already has `ReportId` it changes nothing
       else. If the 09-24 build is not there yet, also run `002` (the §20 `WorkItem` change).
3. [ ] **Run `apptrak/sql/backfill-deployment.sql`.** Its last line now ends *looked through
       …*. Note that date, the rows added, and **how many minutes it took**.
4. [ ] **Time the pages.** Open each with the browser's network tab, or just a watch; note
       seconds to fully drawn: Division, Where is it, History, Calendar, The week.
5. [ ] **Calendar** (`/moveit/calendar`):
       - The banner says *Recorded through* the date step 3 printed. If it says *Last change
         recorded*, the stamp did not land — tell me.
       - The month your endpoints were first registered should **not** be crowded with
         arrivals on that first day (builds already there when watching began are left off).
       - A rollback you remember shows ↺ on the right day.
       - Stage filter PROD + one application: does the month read true?
       - **The rail (§26):** on your usual screen, does the month fit without scrolling?
         Find an application by typing; collapse the rail (« ) and check *Showing …* still
         says what is filtered. Note any day that shows only *+N more*.
6. [ ] **Needs a word** (History, top): how many lines? Is any line wrong, or any missing
       you would have expected? If it is flooded, note which kind dominates — the 14 / 60
       days are settings.
7. [ ] **Division coverage line:** does *the pings watch N of M* match the apps you know
       are blind? Are the named ones right?
7b. [ ] **The frame (§26.1)** on your usual screen: is each page's header one line? Do
       *Needs a word* (History) and *Pings watch N of M* (Division) say enough while closed?
       Where is it: are the lane-head counts where you would look?
8. [ ] **The week** (`/moveit/week`): read last week's page as if you were handing it to
       someone. Anything missing, misleading, or that you would not want them to see? Try
       *Print* once (preview is enough).
9. [ ] **Census dashboard trend** (`/classic`): 30 days / 90 days / All with real days.
       Do days with few machines collected make the bars misleading, even with the grey
       strip? That decides whether the chart should plot hits per machine instead.

## Bring back (from memory is fine)

1. `001`: ran clean? Backfill: rows added, minutes, the *looked through* date.
2. Seconds per page: Division, Where is it, History, Calendar, The week.
3. Calendar: banner wording; any false arrivals; a rollback on the right day (yes/no).
4. Needs a word: line count, and any wrong or missing line.
5. Coverage: N of M, and whether the named ones are right.
6. The week: anything you would change before someone else read it.
7. Dashboard: total hits or hits per machine?
8. Your reaction. It decides the next round.
