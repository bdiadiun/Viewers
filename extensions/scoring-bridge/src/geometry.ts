import { LOG_PREFIX } from './config';
import type { OhifMeasurementLike } from './measurements';
import type { MeasurementGeometry } from './contract/messages';

// A-14: the shape the host persists so the viewer can rebuild the annotation after a reload.
// Everything here comes from the measurement itself (EllipticalROI.ts:61-81); nothing is derived.

// Cornerstone handles are world Point3; a shorter tuple breaks worldToCanvas on the first render.
const WORLD_POINT_LENGTH = 3;

const isWorldPoint = (value: unknown): value is number[] =>
  Array.isArray(value) &&
  value.length === WORLD_POINT_LENGTH &&
  value.every(entry => typeof entry === 'number' && Number.isFinite(entry));

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

export const toGeometry = (measurement: OhifMeasurementLike): MeasurementGeometry | undefined => {
  const frameOfReferenceUid = measurement.metadata?.FrameOfReferenceUID;
  const referencedImageId = measurement.referencedImageId;
  const points = measurement.points;

  if (
    !isNonEmptyString(frameOfReferenceUid) ||
    !isNonEmptyString(referencedImageId) ||
    !Array.isArray(points) ||
    points.length === 0 ||
    !points.every(isWorldPoint)
  ) {
    console.debug(
      `${LOG_PREFIX} no restorable geometry for ${measurement.uid ?? '(no uid)'}`,
      measurement.metadata
    );
    return undefined;
  }

  return {
    frameOfReferenceUid,
    referencedImageId,
    points: points.map(point => [...point]),
    label: typeof measurement.label === 'string' ? measurement.label : undefined,
  };
};

// The contract validator accepts any non-empty number[][]; only Point3 rows can be rendered.
export const isRestorableGeometry = (geometry: MeasurementGeometry): boolean =>
  geometry.points.length > 0 && geometry.points.every(isWorldPoint);
