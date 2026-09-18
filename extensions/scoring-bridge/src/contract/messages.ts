// Single source of truth for the host-app <-> viewer postMessage contract. No imports, no
// runtime dependencies, so it can be copied byte-identical into
// `viewer/extensions/scoring-bridge/src/contract/messages.ts` (the submodule must build
// standalone); `npm run check:contract` enforces the copies match (Q-7).

// Adding a message shape stays within version 1; only a breaking change bumps it.
export const CONTRACT_VERSION = 1 as const;

// Normalised spelling used on the wire; the display layer renders mm² / px² for humans.
export type Unit = 'mm2' | 'px2' | 'mm' | 'px';

export interface Metric {
  value: number;
  unit: Unit;
}

// A new measurement (e.g. perimeter, P-8) is a new key, not a new message shape.
export type Metrics = Record<string, Metric>;

export type ToolName = 'EllipticalROI' | 'RectangleROI' | 'Length';

// host -> viewer

export interface ActivateToolCommand {
  version: 1;
  type: 'ACTIVATE_TOOL';
  requestId: string;
  rowId: string;
  toolName: ToolName;
}

export interface DeactivateToolCommand {
  version: 1;
  type: 'DEACTIVATE_TOOL';
  requestId: string;
  rowId: string;
}

export interface RemoveMeasurementCommand {
  version: 1;
  type: 'REMOVE_MEASUREMENT';
  requestId: string;
  rowId: string;
  measurementUid: string;
}

export interface FocusMeasurementCommand {
  version: 1;
  type: 'FOCUS_MEASUREMENT';
  requestId: string;
  rowId: string;
  measurementUid: string;
}

// One row's worth of what the viewer needs to re-add an annotation on restore (A-14).
export interface RestoreMeasurementRequest {
  rowId: string;
  measurementUid: string;
  toolName: ToolName;
  geometry: MeasurementGeometry;
}

export interface RestoreMeasurementsCommand {
  version: 1;
  type: 'RESTORE_MEASUREMENTS';
  requestId: string;
  studyInstanceUid: string;
  measurements: RestoreMeasurementRequest[];
}

export type HostCommand =
  | ActivateToolCommand
  | DeactivateToolCommand
  | RemoveMeasurementCommand
  | FocusMeasurementCommand
  | RestoreMeasurementsCommand;

// viewer -> host

export interface ViewerReadyEvent {
  version: 1;
  type: 'VIEWER_READY';
  viewerVersion: string;
}

// What the viewer needs to rebuild an annotation after a reload (A-14, S-5.6).
export interface MeasurementGeometry {
  frameOfReferenceUid: string;
  referencedImageId: string;
  points: number[][];
  label?: string;
}

export interface MeasurementAddedEvent {
  version: 1;
  type: 'MEASUREMENT_ADDED';
  // null when drawn without an ACTIVATE_TOOL command (e.g. from the OHIF toolbar).
  rowId: string | null;
  measurementUid: string;
  toolName: string;
  metrics: Metrics;
  // requestId of the command that caused this event, for echo-loop protection (A-10).
  causedBy?: string;
  // Present so the form can persist enough to rebuild the annotation later (A-14).
  geometry?: MeasurementGeometry;
}

export interface MeasurementUpdatedEvent {
  version: 1;
  type: 'MEASUREMENT_UPDATED';
  measurementUid: string;
  toolName: string;
  metrics: Metrics;
  causedBy?: string;
  geometry?: MeasurementGeometry;
}

export interface MeasurementRemovedEvent {
  version: 1;
  type: 'MEASUREMENT_REMOVED';
  measurementUid: string;
  // Absent when the deletion originated in the viewer, which is the case the host needs to
  // hear about to clear the matching row (S-5.2, A-10).
  causedBy?: string;
}

// Reason a single row's restore failed (A-14); string literals so the form can render a
// per-row explanation without a lookup table.
export type RestoreFailureReason =
  'already-present' | 'unknown-study' | 'invalid-geometry' | 'viewer-error';

export interface RestoreFailure {
  rowId: string;
  reason: RestoreFailureReason;
}

export interface MeasurementsRestoredEvent {
  version: 1;
  type: 'MEASUREMENTS_RESTORED';
  causedBy?: string;
  restored: string[];
  failed: RestoreFailure[];
}

export type ViewerEvent =
  | ViewerReadyEvent
  | MeasurementAddedEvent
  | MeasurementUpdatedEvent
  | MeasurementRemovedEvent
  | MeasurementsRestoredEvent;

export type BridgeMessage = HostCommand | ViewerEvent;

export const HOST_COMMAND_TYPES = [
  'ACTIVATE_TOOL',
  'DEACTIVATE_TOOL',
  'REMOVE_MEASUREMENT',
  'FOCUS_MEASUREMENT',
  'RESTORE_MEASUREMENTS',
] as const;

export const VIEWER_EVENT_TYPES = [
  'VIEWER_READY',
  'MEASUREMENT_ADDED',
  'MEASUREMENT_UPDATED',
  'MEASUREMENT_REMOVED',
  'MEASUREMENTS_RESTORED',
] as const;

const UNIT_VALUES: readonly Unit[] = ['mm2', 'px2', 'mm', 'px'];
const TOOL_NAME_VALUES: readonly ToolName[] = ['EllipticalROI', 'RectangleROI', 'Length'];
const RESTORE_FAILURE_REASON_VALUES: readonly RestoreFailureReason[] = [
  'already-present',
  'unknown-study',
  'invalid-geometry',
  'viewer-error',
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

const isUnit = (value: unknown): value is Unit =>
  typeof value === 'string' && (UNIT_VALUES as readonly string[]).includes(value);

const isToolName = (value: unknown): value is ToolName =>
  typeof value === 'string' && (TOOL_NAME_VALUES as readonly string[]).includes(value);

const isMetric = (value: unknown): value is Metric =>
  isRecord(value) &&
  typeof value.value === 'number' &&
  Number.isFinite(value.value) &&
  isUnit(value.unit);

const isMetrics = (value: unknown): value is Metrics => {
  if (!isRecord(value)) {
    return false;
  }
  return Object.values(value).every(isMetric);
};

const isFiniteNumberArray = (value: unknown): value is number[] =>
  Array.isArray(value) &&
  value.every((entry) => typeof entry === 'number' && Number.isFinite(entry));

const isPoints = (value: unknown): value is number[][] =>
  Array.isArray(value) && value.length > 0 && value.every(isFiniteNumberArray);

const isMeasurementGeometry = (value: unknown): value is MeasurementGeometry =>
  isRecord(value) &&
  isNonEmptyString(value.frameOfReferenceUid) &&
  isNonEmptyString(value.referencedImageId) &&
  isPoints(value.points) &&
  (value.label === undefined || typeof value.label === 'string');

const isRestoreFailureReason = (value: unknown): value is RestoreFailureReason =>
  typeof value === 'string' && (RESTORE_FAILURE_REASON_VALUES as readonly string[]).includes(value);

const isRestoreFailure = (value: unknown): value is RestoreFailure =>
  isRecord(value) && isNonEmptyString(value.rowId) && isRestoreFailureReason(value.reason);

const isRestoreMeasurementRequest = (value: unknown): value is RestoreMeasurementRequest =>
  isRecord(value) &&
  isNonEmptyString(value.rowId) &&
  isNonEmptyString(value.measurementUid) &&
  isToolName(value.toolName) &&
  isMeasurementGeometry(value.geometry);

const hasVersion1 = (value: Record<string, unknown>): boolean => value.version === 1;

// Plain booleans, not type predicates: interfaces without an index signature are not
// assignable to `Record<string, unknown>`, so a predicate here would not type-check.

const isActivateToolCommand = (value: Record<string, unknown>): boolean =>
  value.type === 'ACTIVATE_TOOL' &&
  isNonEmptyString(value.requestId) &&
  isNonEmptyString(value.rowId) &&
  isToolName(value.toolName);

const isDeactivateToolCommand = (value: Record<string, unknown>): boolean =>
  value.type === 'DEACTIVATE_TOOL' &&
  isNonEmptyString(value.requestId) &&
  isNonEmptyString(value.rowId);

const isRemoveMeasurementCommand = (value: Record<string, unknown>): boolean =>
  value.type === 'REMOVE_MEASUREMENT' &&
  isNonEmptyString(value.requestId) &&
  isNonEmptyString(value.rowId) &&
  isNonEmptyString(value.measurementUid);

const isFocusMeasurementCommand = (value: Record<string, unknown>): boolean =>
  value.type === 'FOCUS_MEASUREMENT' &&
  isNonEmptyString(value.requestId) &&
  isNonEmptyString(value.rowId) &&
  isNonEmptyString(value.measurementUid);

const isRestoreMeasurementsCommand = (value: Record<string, unknown>): boolean =>
  value.type === 'RESTORE_MEASUREMENTS' &&
  isNonEmptyString(value.requestId) &&
  isNonEmptyString(value.studyInstanceUid) &&
  Array.isArray(value.measurements) &&
  value.measurements.every(isRestoreMeasurementRequest);

const isViewerReadyEvent = (value: Record<string, unknown>): boolean =>
  value.type === 'VIEWER_READY' && typeof value.viewerVersion === 'string';

const isMeasurementAddedEvent = (value: Record<string, unknown>): boolean =>
  value.type === 'MEASUREMENT_ADDED' &&
  (value.rowId === null || isNonEmptyString(value.rowId)) &&
  isNonEmptyString(value.measurementUid) &&
  typeof value.toolName === 'string' &&
  isMetrics(value.metrics) &&
  (value.causedBy === undefined || typeof value.causedBy === 'string') &&
  (value.geometry === undefined || isMeasurementGeometry(value.geometry));

const isMeasurementUpdatedEvent = (value: Record<string, unknown>): boolean =>
  value.type === 'MEASUREMENT_UPDATED' &&
  isNonEmptyString(value.measurementUid) &&
  typeof value.toolName === 'string' &&
  isMetrics(value.metrics) &&
  (value.causedBy === undefined || typeof value.causedBy === 'string') &&
  (value.geometry === undefined || isMeasurementGeometry(value.geometry)) &&
  // null rowId means "unarmed" on ADDED only; reject it here rather than accept it silently.
  value.rowId !== null;

const isMeasurementRemovedEvent = (value: Record<string, unknown>): boolean =>
  value.type === 'MEASUREMENT_REMOVED' &&
  isNonEmptyString(value.measurementUid) &&
  (value.causedBy === undefined || typeof value.causedBy === 'string');

const isMeasurementsRestoredEvent = (value: Record<string, unknown>): boolean =>
  value.type === 'MEASUREMENTS_RESTORED' &&
  (value.causedBy === undefined || typeof value.causedBy === 'string') &&
  Array.isArray(value.restored) &&
  value.restored.every(isNonEmptyString) &&
  Array.isArray(value.failed) &&
  value.failed.every(isRestoreFailure);

export const isHostCommand = (value: unknown): value is HostCommand => {
  if (!isRecord(value) || !hasVersion1(value)) {
    return false;
  }
  if (!(HOST_COMMAND_TYPES as readonly string[]).includes(value.type as string)) {
    return false;
  }
  return (
    isActivateToolCommand(value) ||
    isDeactivateToolCommand(value) ||
    isRemoveMeasurementCommand(value) ||
    isFocusMeasurementCommand(value) ||
    isRestoreMeasurementsCommand(value)
  );
};

export const isViewerEvent = (value: unknown): value is ViewerEvent => {
  if (!isRecord(value) || !hasVersion1(value)) {
    return false;
  }
  if (!(VIEWER_EVENT_TYPES as readonly string[]).includes(value.type as string)) {
    return false;
  }
  return (
    isViewerReadyEvent(value) ||
    isMeasurementAddedEvent(value) ||
    isMeasurementUpdatedEvent(value) ||
    isMeasurementRemovedEvent(value) ||
    isMeasurementsRestoredEvent(value)
  );
};
