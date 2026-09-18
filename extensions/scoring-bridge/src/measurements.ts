import { LOG_PREFIX } from './config';
import type { Metrics, Unit } from './contract/messages';

// A-11: values are not rounded and travel with their unit; an unnameable unit is dropped.

// cachedStats keyed per render target, normally `imageId:<referencedImageId>`
// (measurementServiceMappings/EllipticalROI.ts:110); no top-level area.
type StatsEntry = Record<string, unknown>;

export interface OhifMeasurementLike {
  uid?: string;
  toolName?: string;
  referencedImageId?: string;
  data?: Record<string, StatsEntry> | null;
  // A-14 restore inputs; `metadata` is the cornerstone annotation metadata by reference.
  points?: unknown;
  label?: string;
  metadata?: { FrameOfReferenceUID?: string } | null;
}

// Spellings from cornerstone's getCalibratedUnits.js, plus ASCII in case the ² is dropped.
const AREA_UNITS: Record<string, Unit> = {
  'mm²': 'mm2',
  mm2: 'mm2',
  'px²': 'px2',
  px2: 'px2',
  'pixels²': 'px2',
  pixels2: 'px2',
};

const LENGTH_UNITS: Record<string, Unit> = {
  mm: 'mm',
  px: 'px',
  pixels: 'px',
};

// A calibration suffix (`'mm² ERMF'`) is provenance, not a different unit.
const baseUnitToken = (raw: string): string => raw.trim().split(/\s+/)[0] ?? '';

export interface MetricsOptions {
  quiet?: boolean;
}

const note = (quiet: boolean | undefined, message: string, detail?: unknown): void => {
  const log = quiet ? console.debug : console.warn;

  if (detail === undefined) {
    log(message);
  } else {
    log(message, detail);
  }
};

const normaliseUnit = (
  raw: unknown,
  table: Record<string, Unit>,
  context: string,
  quiet?: boolean
): Unit | null => {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    note(quiet, `${LOG_PREFIX} ${context}: missing unit`, raw);
    return null;
  }

  const unit = table[baseUnitToken(raw)];

  if (!unit) {
    note(quiet, `${LOG_PREFIX} ${context}: unsupported unit string "${raw}"`);
    return null;
  }

  return unit;
};

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const findStatsEntry = (measurement: OhifMeasurementLike, key: string): StatsEntry | null => {
  const data = measurement.data;

  if (!data || typeof data !== 'object') {
    return null;
  }

  const preferredKey = `imageId:${measurement.referencedImageId}`;
  const preferred = data[preferredKey];

  if (preferred && isFiniteNumber(preferred[key])) {
    return preferred;
  }

  for (const entry of Object.values(data)) {
    if (entry && isFiniteNumber(entry[key])) {
      return entry;
    }
  }

  return null;
};

const toAreaMetrics = (measurement: OhifMeasurementLike, quiet?: boolean): Metrics | null => {
  const stats = findStatsEntry(measurement, 'area');

  if (!stats) {
    note(
      quiet,
      `${LOG_PREFIX} no area in measurement.data for ${measurement.uid ?? '(no uid)'}`,
      measurement.data
    );
    return null;
  }

  const unit = normaliseUnit(
    stats.areaUnit,
    AREA_UNITS,
    `area of ${measurement.uid ?? '(no uid)'}`,
    quiet
  );

  if (!unit) {
    return null;
  }

  return { area: { value: stats.area as number, unit } };
};

// No `'mm'` default as in OHIF's Length.ts:118: mm on an uncalibrated image would break Q-6.
const toLengthMetrics = (measurement: OhifMeasurementLike, quiet?: boolean): Metrics | null => {
  const stats = findStatsEntry(measurement, 'length');

  if (!stats) {
    note(
      quiet,
      `${LOG_PREFIX} no length in measurement.data for ${measurement.uid ?? '(no uid)'}`,
      measurement.data
    );
    return null;
  }

  const unit = normaliseUnit(
    stats.unit,
    LENGTH_UNITS,
    `length of ${measurement.uid ?? '(no uid)'}`,
    quiet
  );

  if (!unit) {
    return null;
  }

  return { length: { value: stats.length as number, unit } };
};

export const toMetrics = (
  measurement: OhifMeasurementLike,
  { quiet }: MetricsOptions = {}
): Metrics | null => {
  switch (measurement?.toolName) {
    case 'EllipticalROI':
    case 'RectangleROI':
      return toAreaMetrics(measurement, quiet);
    case 'Length':
      return toLengthMetrics(measurement, quiet);
    default:
      note(
        quiet,
        `${LOG_PREFIX} no metric mapping for tool "${measurement?.toolName ?? '(none)'}"`
      );
      return null;
  }
};
