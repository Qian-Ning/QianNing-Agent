---
name: time-zones-and-dates
description: storing, comparing, scheduling, or displaying dates and times
---

# Time zones and dates

Almost every date bug comes from one confusion: **an instant is not a
wall-clock time**. An instant is a point on the timeline, the same for everyone.
A wall-clock time is what a clock on a wall reads in a particular place, and the
same instant maps to different wall-clock times in different places.

## Decide which one you have, before storing anything

- **An instant** — a payment, an event, a log line. Store UTC. One value, everyone
  agrees, comparisons work.
- **A wall-clock time** — 9:00 in the morning for a meeting, a birthday, a fiscal
  period, the start of a business day. This is **not** an instant and must not be
  stored as one, because its meaning depends on the zone it belongs to.
- **Store both** where they differ: the instant for ordering and comparison, and
  the wall-clock rule plus its zone for anything the user will see or expect to
  recur.
- **Do not put a date in the same type as an instant.** A birthday has no time and
  no zone; forcing it into a timestamp creates the classic off-by-one-day bug in
  which someone's birthday moves depending on who is looking.

## An offset is not a zone

This is the single most common mistake.

- `+02:00` describes one moment's offset. It does **not** describe a place, whose
  offset changes when daylight saving starts and stops, and sometimes when a
  government changes the rules with a few weeks' notice.
- Store the **zone identifier** — a region name — wherever you need the rule, and
  the instant wherever you need the point in time.
- *"The meeting is at 9:00"* stored as an offset breaks twice a year, in a way
  that users report as "the meeting moved".

## The daylight-saving traps

- **The hour that does not exist.** On the spring-forward day, some local times
  never happen. What does your code do with a job scheduled for one of them?
- **The hour that happens twice.** On the fall-back day, some local times occur
  twice. A daily midnight job can run twice, or a duplicate record can appear with
  the same local timestamp and different instants.
- Decide explicitly, per job: **skip it, shift it, or let it run twice** — and
  write the decision where the job is. There is no default that is correct for
  everything.
- Durations are not constants across these boundaries. *"24 hours later"* and
  *"tomorrow at the same time"* are different instants on those two days.

## Calendar arithmetic is not second arithmetic

- **Never implement date math by adding seconds.** Months have different lengths,
  years have a leap day, zones shift under you, and "one month later" has no single
  definition — is it the 31st becoming the 31st of a shorter month?
- Use the platform's or a well-tested library's calendar arithmetic, and say
  which convention you get: clamping to the last day of the month, or rolling
  over into the next month. They differ on the cases people care about.
- *"Every 30 days"* is a duration; *"every month on the 15th"* is a calendar
  rule. They diverge immediately.

## Scheduling: store the rule, compute the instant

The pattern that avoids most recurring-time bugs:

- Store **the wall-clock rule and its zone** — "every Monday at 09:00 in
  Asia/Shanghai" — not a list of instants, and not a UTC time that was correct
  when it was created.
- **Compute the next instant at run time** from the rule. Then a government
  changing its DST rules updates your schedule for free, and a user changing
  zones does not silently move everyone else's meeting.
- Store the instant too, once it is known, for the things that need to point at a
  specific moment: the run that happened, the reminder that fired.

## Parsing and formatting

- Accept **ISO 8601 with an explicit zone** and reject or flag anything without
  one. A date string with no zone is not a value; it is a question.
- **Never parse a date with a general-purpose parse function**: the accepted
  formats differ by platform and version, and it will happily read a
  locale-formatted string as a different date.
- Format for display in the viewer's time zone whenever the value is an instant,
  and in its original zone when it is a wall-clock time. Getting this backwards is
  why support tickets say "the meeting is at the wrong hour".
- "Today", "this week", and "yesterday" depend on the zone. Decide whether they
  mean the user's day or the server's, and say so — they differ for hours every
  day.

## Zones change, and your data does not

Governments alter DST rules and zone boundaries, sometimes with little notice.
Historical instants must keep their original meaning, which means the time zone
database is a **dependency you have to update** — treat a stale one as a bug, not
as a detail. Do not cache zone rules into your own storage forever.

## Testing

- **Run the suite in a non-UTC zone too.** Most date bugs are invisible in UTC
  because the offset is zero.
- Add a case in a zone with daylight saving, around both transitions.
- Test the boundaries explicitly: the spring-forward hour, the fall-back hour, a
  leap day, the last day of a 31-day month, year boundaries, and a date near
  midnight where the zone decides which day it is.
- Where a test depends on "now", inject the clock rather than reading the system
  time, or the test will be a different test tomorrow.

## Origin

QianNing Agent. Written in this repository; no third-party method, text, or document format is reproduced here.
