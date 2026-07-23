import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildReconcileFilter,
  normalizeReconciledPoint,
  observationDate,
  splitDailyRollupRange,
} from '../src/health-data.js';

test('builds closed-open civil filters for every data type shape', () => {
  assert.equal(
    buildReconcileFilter('steps', '2026-07-01', '2026-07-02'),
    'steps.interval.civil_start_time >= "2026-07-01" AND steps.interval.civil_start_time < "2026-07-03"',
  );
  assert.equal(
    buildReconcileFilter('heart-rate', '2026-07-01', '2026-07-02'),
    'heart_rate.sample_time.civil_time >= "2026-07-01" AND heart_rate.sample_time.civil_time < "2026-07-03"',
  );
  assert.equal(
    buildReconcileFilter('daily-resting-heart-rate', '2026-07-01', '2026-07-02'),
    'daily_resting_heart_rate.date >= "2026-07-01" AND daily_resting_heart_rate.date < "2026-07-03"',
  );
  assert.equal(
    buildReconcileFilter('sleep', '2026-07-01', '2026-07-02'),
    'sleep.interval.civil_end_time >= "2026-07-01" AND sleep.interval.civil_end_time < "2026-07-03"',
  );
});

test('assigns sleep to wake date and exercise to start date', () => {
  const sleepPoint = {
    sleep: {
      interval: {
        civilStartTime: { date: { year: 2026, month: 7, day: 1 } },
        civilEndTime: { date: { year: 2026, month: 7, day: 2 } },
      },
    },
  };
  const exercisePoint = {
    exercise: {
      interval: {
        startTime: '2026-07-01T23:30:00Z',
        startUtcOffset: '28800s',
        endTime: '2026-07-02T00:30:00Z',
        endUtcOffset: '28800s',
      },
    },
  };
  assert.equal(observationDate(sleepPoint, 'sleep'), '2026-07-02');
  assert.equal(observationDate(exercisePoint, 'exercise'), '2026-07-02');
});

test('removes only exact duplicate sleep stage summaries', () => {
  const input = {
    sleep: {
      summary: {
        stagesSummary: [
          { type: 'LIGHT', minutes: '180', count: '12' },
          { type: 'LIGHT', minutes: '180', count: '12' },
          { type: 'LIGHT', minutes: '181', count: '12' },
          { type: 'REM', minutes: '90', count: '4' },
        ],
      },
    },
  };
  const normalized = normalizeReconciledPoint(input, 'sleep');
  assert.equal(normalized.removedSleepStageDuplicates, 1);
  const sleep = normalized.point.sleep as typeof input.sleep;
  assert.equal(sleep.summary.stagesSummary.length, 3);
});

test('splits heart-rate daily rollups into API-safe 14-day chunks', () => {
  assert.deepEqual(
    splitDailyRollupRange('heart-rate', '2026-07-01', '2026-07-28'),
    [
      {
        startDate: '2026-07-01',
        endDate: '2026-07-14',
        exclusiveEndDate: '2026-07-15',
      },
      {
        startDate: '2026-07-15',
        endDate: '2026-07-28',
        exclusiveEndDate: '2026-07-29',
      },
    ],
  );
});
