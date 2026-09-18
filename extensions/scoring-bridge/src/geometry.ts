import { isMeasurementGeometry, type MeasurementGeometry } from '@bdiadiun/scoring-contract';

import { LOG_PREFIX } from './config';
import type { OhifMeasurementLike } from './measurements';

// A-14: the shape the host persists so the viewer can rebuild the annotation after a reload.
// Everything here comes from the measurement itself (EllipticalROI.ts:61-81); nothing is derived.

const copyPoints = (points: unknown): unknown =>
  Array.isArray(points) ? points.map(point => (Array.isArray(point) ? [...point] : point)) : points;

export const toGeometry = (measurement: OhifMeasurementLike): MeasurementGeometry | undefined => {
  const candidate = {
    frameOfReferenceUid: measurement.metadata?.FrameOfReferenceUID,
    referencedImageId: measurement.referencedImageId,
    // Copied so the event does not carry cornerstone's live handle arrays.
    points: copyPoints(measurement.points),
    label: typeof measurement.label === 'string' ? measurement.label : undefined,
  };

  if (!isMeasurementGeometry(candidate)) {
    console.debug(
      `${LOG_PREFIX} no restorable geometry for ${measurement.uid ?? '(no uid)'}`,
      measurement.metadata
    );
    return undefined;
  }

  return candidate;
};
