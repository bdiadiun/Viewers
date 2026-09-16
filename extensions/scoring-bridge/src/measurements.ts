import type { Metrics, Unit } from './contract/messages';

/**
 * OHIF measurement -> contract `metrics` mapping (C-4.3.5, Q-6, A-11, P-8).
 *
 * This is the ONE place where a viewer-side measurement becomes wire data. P-8 ("add one more
 * field to the row") is therefore a single-function change: adding perimeter or mean intensity
 * means adding a key to the object built below, not a new message type and not a second mapper.
 *
 * Two rules the whole slice rests on:
 * - Values are NOT rounded here. The host formats for display (C-4.3.6); the viewer ships the
 *   number OHIF computed, so the sum (C-4.3.8) is not built out of pre-rounded parts.
 * - Value and unit travel as one inseparable pair, so the host can refuse to add mm² to px²
 *   (Q-6). A metric whose unit we cannot name is dropped rather than guessed.
 */

/**
 * Where the numbers live.
 *
 * `measurement.data` is cornerstone's `cachedStats`, a record keyed per render target — normally
 * `imageId:<referencedImageId>` — each entry holding
 * `{ mean, stdDev, max, area, Modality, areaUnit, modalityUnit }`; see the destructuring in
 * `extensions/cornerstone/src/utils/measurementServiceMappings/EllipticalROI.ts:110`
 * (RectangleROI.ts is identical, Length.ts:118 uses `{ length, unit = 'mm' }`).
 * There is no top-level `area` field on the measurement.
 */
type StatsEntry = Record<string, unknown>;

export interface OhifMeasurementLike {
  uid?: string;
  toolName?: string;
  referencedImageId?: string;
  data?: Record<string, StatsEntry> | null;
}

/**
 * Unit strings as cornerstone3D actually produces them.
 *
 * Source: `@cornerstonejs/tools/.../utilities/getCalibratedUnits.js` — the base unit is `'mm'`
 * when the image has pixel spacing and `'px'` when it does not, and `areaUnit` is that base plus
 * U+00B2 SUPERSCRIPT TWO. Observed at runtime on the demo study
 * (1.3.6.1.4.1.25403.345050719074.3824.20170125113417.1): `areaUnit === 'mm²'`.
 *
 * A calibrated image appends the calibration type, e.g. `'mm² ERMF'` / `'mm² US Region'`
 * (same file: `areaUnit + (calibrationType ? \` ${calibrationType}\` : '')`). The calibration
 * type is provenance, not a different unit, so we match on the first token and keep the rest out
 * of the wire format. The ASCII spellings are accepted too because OHIF passes the string through
 * untouched and a future cornerstone version may drop the superscript.
 */
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

/** Drops the calibration-type suffix (`'mm² ERMF'` -> `'mm²'`) and trims. */
function baseUnitToken(raw: string): string {
  return raw.trim().split(/\s+/)[0] ?? '';
}

function normaliseUnit(raw: unknown, table: Record<string, Unit>, context: string): Unit | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    console.warn(`[scoring-bridge] ${context}: missing unit`, raw);
    return null;
  }

  const unit = table[baseUnitToken(raw)];

  if (!unit) {
    // Loud and specific: an unmapped unit means the wire format would lie about what the number
    // is, and a wrong unit poisons the per-unit sum on the host (Q-6). Dropping is the safe side.
    console.warn(`[scoring-bridge] ${context}: unsupported unit string "${raw}"`);
    return null;
  }

  return unit;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Picks the stats entry to read. Preference order:
 * 1. the entry keyed `imageId:<referencedImageId>` — the target the annotation was drawn on;
 * 2. the first entry that carries a finite value under `key`.
 *
 * A stack viewport produces exactly one entry, so (2) is the normal path for volume/mpr setups
 * and a safety net when the key spelling changes.
 */
function findStatsEntry(measurement: OhifMeasurementLike, key: string): StatsEntry | null {
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
}

/** EllipticalROI / RectangleROI: `{ area: { value, unit } }`. */
function toAreaMetrics(measurement: OhifMeasurementLike): Metrics | null {
  const stats = findStatsEntry(measurement, 'area');

  if (!stats) {
    console.warn(
      `[scoring-bridge] no area in measurement.data for ${measurement.uid ?? '(no uid)'}`,
      measurement.data
    );
    return null;
  }

  const unit = normaliseUnit(
    stats.areaUnit,
    AREA_UNITS,
    `area of ${measurement.uid ?? '(no uid)'}`
  );

  if (!unit) {
    return null;
  }

  return { area: { value: stats.area as number, unit } };
}

/**
 * Length: `{ length: { value, unit } }`. Best effort — the ellipse path is the one the slice
 * verifies. Note OHIF's own `'mm'` default at Length.ts:118; we do not copy that default, because
 * guessing millimetres on an uncalibrated image is exactly the mistake Q-6 guards against.
 */
function toLengthMetrics(measurement: OhifMeasurementLike): Metrics | null {
  const stats = findStatsEntry(measurement, 'length');

  if (!stats) {
    console.warn(
      `[scoring-bridge] no length in measurement.data for ${measurement.uid ?? '(no uid)'}`,
      measurement.data
    );
    return null;
  }

  const unit = normaliseUnit(
    stats.unit,
    LENGTH_UNITS,
    `length of ${measurement.uid ?? '(no uid)'}`
  );

  if (!unit) {
    return null;
  }

  return { length: { value: stats.length as number, unit } };
}

/**
 * Maps one OHIF measurement to the contract `metrics`, or null when nothing can be reported
 * honestly (unknown tool, missing stats, unmappable unit). The caller does not post on null.
 */
export function toMetrics(measurement: OhifMeasurementLike): Metrics | null {
  switch (measurement?.toolName) {
    case 'EllipticalROI':
    case 'RectangleROI':
      return toAreaMetrics(measurement);
    case 'Length':
      return toLengthMetrics(measurement);
    default:
      console.warn(
        `[scoring-bridge] no metric mapping for tool "${measurement?.toolName ?? '(none)'}"`
      );
      return null;
  }
}
