export type DataTypeKind = 'interval' | 'sample' | 'daily' | 'session' | 'sleep';

const DATA_TYPE_KINDS: Record<string, DataTypeKind> = {
  steps: 'interval',
  floors: 'interval',
  altitude: 'interval',
  distance: 'interval',
  'active-zone-minutes': 'interval',
  'sedentary-period': 'interval',
  'time-in-heart-rate-zone': 'interval',
  'active-minutes': 'interval',
  'swim-lengths-data': 'interval',
  'active-energy-burned': 'interval',
  'heart-rate': 'sample',
  weight: 'sample',
  'body-fat': 'sample',
  'heart-rate-variability': 'sample',
  'run-vo2-max': 'sample',
  'oxygen-saturation': 'sample',
  'vo2-max': 'sample',
  'respiratory-rate-sleep-summary': 'sample',
  height: 'sample',
  'core-body-temperature': 'sample',
  'blood-glucose': 'sample',
  'daily-resting-heart-rate': 'daily',
  'daily-heart-rate-variability': 'daily',
  'daily-sleep-temperature-derivations': 'daily',
  'daily-oxygen-saturation': 'daily',
  'activity-level': 'daily',
  'daily-vo2-max': 'daily',
  'daily-heart-rate-zones': 'daily',
  'daily-respiratory-rate': 'daily',
  sleep: 'sleep',
  exercise: 'session',
  'nutrition-log': 'session',
  'hydration-log': 'session',
};

export const knownReconcileDataTypes = Object.freeze(Object.keys(DATA_TYPE_KINDS));

export const dailyRollupDataTypes = Object.freeze([
  'steps',
  'floors',
  'heart-rate',
  'daily-resting-heart-rate',
  'daily-heart-rate-variability',
  'weight',
  'altitude',
  'distance',
  'body-fat',
  'total-calories',
  'active-zone-minutes',
  'sedentary-period',
  'run-vo2-max',
  'calories-in-heart-rate-zone',
  'activity-level',
  'nutrition-log',
  'hydration-log',
  'time-in-heart-rate-zone',
  'active-minutes',
  'swim-lengths-data',
  'core-body-temperature',
  'active-energy-burned',
  'blood-glucose',
]);

const SHORT_ROLLUP_RANGE_TYPES = new Set([
  'calories-in-heart-rate-zone',
  'heart-rate',
  'active-minutes',
  'total-calories',
]);

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseIsoDate(value: string): { year: number; month: number; day: number } {
  const match = ISO_DATE.exec(value);
  if (!match) throw new Error(`Invalid ISO date: ${value}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    throw new Error(`Invalid calendar date: ${value}`);
  }
  return { year, month, day };
}

export function addCivilDays(value: string, days: number): string {
  const { year, month, day } = parseIsoDate(value);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

export function civilDateTime(value: string): Record<string, unknown> {
  return { date: parseIsoDate(value) };
}

export function buildReconcileFilter(
  slug: string,
  startDate?: string,
  endDate?: string,
): string | undefined {
  const kind = DATA_TYPE_KINDS[slug];
  if (!kind || (!startDate && !endDate)) return undefined;

  const identifier = slug.replaceAll('-', '_');
  const field = kind === 'daily'
    ? `${identifier}.date`
    : kind === 'sample'
      ? `${identifier}.sample_time.civil_time`
      : kind === 'sleep'
        ? 'sleep.interval.civil_end_time'
        : `${identifier}.interval.civil_start_time`;
  const clauses: string[] = [];
  if (startDate) {
    parseIsoDate(startDate);
    clauses.push(`${field} >= "${startDate}"`);
  }
  if (endDate) clauses.push(`${field} < "${addCivilDays(endDate, 1)}"`);
  return clauses.join(' AND ');
}

function directCivilDate(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const candidate = isRecord(value.date) ? value.date : value;
  const year = candidate.year;
  const month = candidate.month;
  const day = candidate.day;
  if (typeof year === 'number' && typeof month === 'number' && typeof day === 'number') {
    return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  return undefined;
}

function recursiveCivilDate(value: unknown): string | undefined {
  const direct = directCivilDate(value);
  if (direct) return direct;
  if (!isRecord(value)) return undefined;
  for (const child of Object.values(value)) {
    const found = recursiveCivilDate(child);
    if (found) return found;
  }
  return undefined;
}

function timestampDate(timestamp: unknown, utcOffset: unknown): string | undefined {
  if (typeof timestamp !== 'string' || typeof utcOffset !== 'string') return undefined;
  const offsetMatch = /^([+-]?\d+(?:\.\d+)?)s$/.exec(utcOffset);
  if (!offsetMatch) return undefined;
  const instant = Date.parse(timestamp);
  const offsetSeconds = Number(offsetMatch[1]);
  if (!Number.isFinite(instant) || !Number.isFinite(offsetSeconds)) return undefined;
  return new Date(instant + offsetSeconds * 1000).toISOString().slice(0, 10);
}

function dataFieldName(slug: string): string {
  return slug.replace(/-([a-z0-9])/g, (_, character: string) => character.toUpperCase());
}

export function observationDate(point: unknown, slug: string): string | undefined {
  if (!isRecord(point)) return undefined;
  const payload = point[dataFieldName(slug)];
  if (isRecord(payload)) {
    const kind = DATA_TYPE_KINDS[slug];
    if (kind === 'daily') return directCivilDate(payload.date);
    if (kind === 'sample' && isRecord(payload.sampleTime)) {
      return directCivilDate(payload.sampleTime.civilTime)
        ?? timestampDate(payload.sampleTime.physicalTime, payload.sampleTime.utcOffset);
    }
    if ((kind === 'interval' || kind === 'session' || kind === 'sleep') && isRecord(payload.interval)) {
      if (kind === 'sleep') {
        return directCivilDate(payload.interval.civilEndTime)
          ?? timestampDate(payload.interval.endTime, payload.interval.endUtcOffset);
      }
      return directCivilDate(payload.interval.civilStartTime)
        ?? timestampDate(payload.interval.startTime, payload.interval.startUtcOffset);
    }
  }
  return recursiveCivilDate(point);
}

export function normalizeReconciledPoint(
  point: Record<string, unknown>,
  slug: string,
): { point: Record<string, unknown>; removedSleepStageDuplicates: number } {
  if (slug !== 'sleep' || !isRecord(point.sleep) || !isRecord(point.sleep.summary)) {
    return { point, removedSleepStageDuplicates: 0 };
  }
  const stagesSummary = point.sleep.summary.stagesSummary;
  if (!Array.isArray(stagesSummary)) {
    return { point, removedSleepStageDuplicates: 0 };
  }

  const seen = new Set<string>();
  const unique = stagesSummary.filter((stage) => {
    if (!isRecord(stage)) return true;
    const key = JSON.stringify([stage.type, stage.minutes, stage.count]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const removed = stagesSummary.length - unique.length;
  if (!removed) return { point, removedSleepStageDuplicates: 0 };

  return {
    point: {
      ...point,
      sleep: {
        ...point.sleep,
        summary: {
          ...point.sleep.summary,
          stagesSummary: unique,
        },
      },
    },
    removedSleepStageDuplicates: removed,
  };
}

export function maxReconcilePageSize(slug: string): number {
  return slug === 'sleep' || slug === 'exercise' ? 25 : 10_000;
}

export type DateRangeChunk = {
  startDate: string;
  endDate: string;
  exclusiveEndDate: string;
};

export function splitDailyRollupRange(
  slug: string,
  startDate: string,
  endDate: string,
): DateRangeChunk[] {
  parseIsoDate(startDate);
  parseIsoDate(endDate);
  if (startDate > endDate) throw new Error('startDate must not be later than endDate');
  const maxDays = SHORT_ROLLUP_RANGE_TYPES.has(slug) ? 14 : 90;
  const chunks: DateRangeChunk[] = [];
  let chunkStart = startDate;
  while (chunkStart <= endDate) {
    const candidateEnd = addCivilDays(chunkStart, maxDays - 1);
    const chunkEnd = candidateEnd < endDate ? candidateEnd : endDate;
    chunks.push({
      startDate: chunkStart,
      endDate: chunkEnd,
      exclusiveEndDate: addCivilDays(chunkEnd, 1),
    });
    chunkStart = addCivilDays(chunkEnd, 1);
  }
  return chunks;
}
