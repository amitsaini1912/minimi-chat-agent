import * as chrono from 'chrono-node';

/** A calendar-day range in the user's local time zone, inclusive, as YYYY-MM-DD. */
export interface DayRange {
  phrase: string;
  from: string;
  to: string;
  /** Set when the phrase has more than one plausible reading (e.g. "last Tuesday"). */
  alternatives?: { from: string; to: string; label: string }[];
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** YYYY-MM-DD of an instant in a given IANA time zone. */
export function localDate(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** Minutes east of UTC for a time zone at a given instant (what chrono expects). */
export function tzOffsetMinutes(d: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - d.getTime()) / 60000);
}

/** Pure calendar arithmetic on YYYY-MM-DD strings (no time zones involved). */
export function addDays(day: string, n: number): string {
  const d = new Date(day + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function weekday(day: string): number {
  return new Date(day + 'T00:00:00Z').getUTCDay();
}
/** Monday of the ISO week containing `day`. */
function weekStart(day: string): string {
  return addDays(day, -((weekday(day) + 6) % 7));
}

export function prettyDay(day: string): string {
  return new Date(day + 'T12:00:00Z').toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
}

/**
 * Resolve past-time references in a message to concrete local-day ranges.
 * Deterministic, so the model never has to do calendar arithmetic itself.
 * Future dates are dropped: in this agent a date reference is almost always a recall cue.
 */
export function resolveTimeReferences(text: string, now: Date, timeZone: string): DayRange[] {
  const today = localDate(now, timeZone);
  const out: DayRange[] = [];
  const lower = text.toLowerCase();

  // Ranges chrono collapses to a single day.
  const rangeRules: [RegExp, () => [string, string]][] = [
    [/\blast week\b/, () => { const s = addDays(weekStart(today), -7); return [s, addDays(s, 6)]; }],
    [/\b(earlier )?this week\b/, () => [weekStart(today), today]],
    [/\blast month\b/, () => { const first = today.slice(0, 8) + '01'; const prevLast = addDays(first, -1); return [prevLast.slice(0, 8) + '01', prevLast]; }],
    [/\b(earlier )?this month\b/, () => [today.slice(0, 8) + '01', today]],
    [/\b(past|last) (few|couple of) days\b/, () => [addDays(today, -4), today]],
  ];
  const consumed: string[] = [];
  for (const [re, fn] of rangeRules) {
    const m = lower.match(re);
    if (m) {
      const [from, to] = fn();
      out.push({ phrase: m[0], from, to });
      consumed.push(m[0]);
    }
  }

  const results = chrono.parse(text, { instant: now, timezone: tzOffsetMinutes(now, timeZone) }, { forwardDate: false });
  for (const r of results) {
    const phrase = r.text.trim();
    if (consumed.some((c) => c.includes(phrase.toLowerCase()) || phrase.toLowerCase().includes(c))) continue;
    // Bare times ("at 5pm") are not day references.
    if (!r.start.isCertain('day') && !r.start.isCertain('weekday')) continue;

    let from = localDate(r.start.date(), timeZone);
    let to = r.end ? localDate(r.end.date(), timeZone) : from;
    if (from > today) {
      // Absolute date without a year that landed in the future ("on 20 December") -> last year's.
      if (!r.start.isCertain('year') && r.start.isCertain('month')) {
        from = (Number(from.slice(0, 4)) - 1) + from.slice(4);
        to = (Number(to.slice(0, 4)) - 1) + to.slice(4);
      } else continue;
    }
    if (to > today) to = today;

    const range: DayRange = { phrase, from, to };

    // "last Tuesday" said on a Wednesday: chrono says yesterday, many people mean the week before.
    const m = phrase.toLowerCase().match(/^(?:on )?last (\w+day)$/);
    if (m && WEEKDAYS.includes(m[1])) {
      const thisWeeks = from;
      const priorWeeks = addDays(from, -7);
      if (thisWeeks >= weekStart(today)) {
        range.alternatives = [
          { from: thisWeeks, to: thisWeeks, label: 'most recent ' + m[1] },
          { from: priorWeeks, to: priorWeeks, label: m[1] + ' of the previous week' },
        ];
      }
    }
    out.push(range);
  }
  return out;
}

/** Phrases that signal the user is referring back to earlier exchanges even without a date. */
export const RECALL_CUE = /\b(you (said|told|suggested|recommended|answered|mentioned)|i (asked|told|mentioned|said)|we (discussed|talked|shortlisted|decided|compared|looked)|earlier|previous(ly)?|last time|before|since then|that list|your (answer|recommendation)|remember)\b/i;
