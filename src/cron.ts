// Minimal hand-rolled 5-field cron parser + "next fire time" calculator —
// same "no black-box dependency" ethos as the rest of pkwn (hand-rolled
// OAuth flows, HTTP router, Telegram client). Standard fields, in order:
// minute(0-59) hour(0-23) day-of-month(1-31) month(1-12) day-of-week(0-7,
// 0 and 7 both mean Sunday). Supports `*`, lists (`a,b,c`), ranges
// (`a-b`), and steps (`*/n`, `a-b/n`) per field. All times are UTC —
// no timezone/DST config, by design (see README).
//
// Day-of-month and day-of-week combine with cron's traditional OR
// semantics when *both* are restricted (fires if either matches); if
// only one is restricted, that one alone gates the day.

export interface CronParts {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

const SEGMENT = /^(\*|\d+-\d+|\d+)(?:\/(\d+))?$/;

function parseField(raw: string, min: number, max: number): Set<number> {
  const values = new Set<number>();
  for (const part of raw.split(",")) {
    const match = SEGMENT.exec(part);
    if (!match) throw new Error(`invalid cron field segment "${part}" in "${raw}"`);
    const [, base, stepStr] = match;
    const step = stepStr ? Number(stepStr) : 1;
    if (step <= 0) throw new Error(`invalid cron step "${part}" — step must be positive`);
    let start = min;
    let end = max;
    if (base !== "*") {
      if (base!.includes("-")) {
        const [a, b] = base!.split("-").map(Number);
        start = a!;
        end = b!;
      } else {
        start = end = Number(base);
      }
    }
    if (start < min || end > max || start > end) {
      throw new Error(`cron field segment "${part}" out of range [${min},${max}]`);
    }
    for (let v = start; v <= end; v += step) values.add(v);
  }
  return values;
}

export function parseCron(expr: string): CronParts {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`cron expression must have exactly 5 fields (minute hour day-of-month month day-of-week), got "${expr}"`);
  }
  const [minuteRaw, hourRaw, domRaw, monthRaw, dowRaw] = fields as [string, string, string, string, string];
  const dowRaw07 = parseField(dowRaw, 0, 7);
  return {
    minute: parseField(minuteRaw, 0, 59),
    hour: parseField(hourRaw, 0, 23),
    dayOfMonth: parseField(domRaw, 1, 31),
    month: parseField(monthRaw, 1, 12),
    dayOfWeek: new Set([...dowRaw07].map((v) => (v === 7 ? 0 : v))),
    domRestricted: domRaw !== "*",
    dowRestricted: dowRaw !== "*",
  };
}

// A generous ceiling (~5 years of minutes) on the search below — an
// expression with no solution (e.g. day-of-month 30 combined with
// month February only) would otherwise spin forever; this throws
// instead once it's clearly impossible rather than hanging the caller.
const MAX_SEARCH_MINUTES = 5 * 366 * 24 * 60;

/** Smallest time strictly after `after` that `expr` matches, in UTC.
 * Jumps whole months/days/hours when a coarser field already rules out
 * the current candidate, so a sparse expression (e.g. once a year)
 * resolves in a handful of steps rather than a million 1-minute ticks. */
export function nextCronFire(expr: string, after: Date): Date {
  const cron = parseCron(expr);
  let candidate = new Date(Date.UTC(after.getUTCFullYear(), after.getUTCMonth(), after.getUTCDate(), after.getUTCHours(), after.getUTCMinutes() + 1, 0, 0));

  for (let i = 0; i < MAX_SEARCH_MINUTES; i++) {
    const month = candidate.getUTCMonth() + 1;
    if (!cron.month.has(month)) {
      candidate = new Date(Date.UTC(candidate.getUTCFullYear(), candidate.getUTCMonth() + 1, 1, 0, 0, 0, 0));
      continue;
    }

    const dayMatches = cron.domRestricted && cron.dowRestricted
      ? cron.dayOfMonth.has(candidate.getUTCDate()) || cron.dayOfWeek.has(candidate.getUTCDay())
      : cron.domRestricted
        ? cron.dayOfMonth.has(candidate.getUTCDate())
        : cron.dowRestricted
          ? cron.dayOfWeek.has(candidate.getUTCDay())
          : true;
    if (!dayMatches) {
      candidate = new Date(candidate.getTime() + 24 * 60 * 60 * 1000);
      candidate.setUTCHours(0, 0, 0, 0);
      continue;
    }

    if (!cron.hour.has(candidate.getUTCHours())) {
      candidate = new Date(candidate.getTime() + 60 * 60 * 1000);
      candidate.setUTCMinutes(0, 0, 0);
      continue;
    }

    if (!cron.minute.has(candidate.getUTCMinutes())) {
      candidate = new Date(candidate.getTime() + 60 * 1000);
      continue;
    }

    return candidate;
  }
  throw new Error(`cron expression "${expr}" has no matching fire time within the search horizon — check for an impossible date`);
}
