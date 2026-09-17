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

export type HostCommand =
  ActivateToolCommand | DeactivateToolCommand | RemoveMeasurementCommand | FocusMeasurementCommand;

// viewer -> host

export interface ViewerReadyEvent {
  version: 1;
  type: 'VIEWER_READY';
  viewerVersion: string;
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
}

export interface MeasurementUpdatedEvent {
  version: 1;
  type: 'MEASUREMENT_UPDATED';
  measurementUid: string;
  toolName: string;
  metrics: Metrics;
  causedBy?: string;
}

export interface MeasurementRemovedEvent {
  version: 1;
  type: 'MEASUREMENT_REMOVED';
  measurementUid: string;
  // Absent when the deletion originated in the viewer, which is the case the host needs to
  // hear about to clear the matching row (S-5.2, A-10).
  causedBy?: string;
}

export type ViewerEvent =
  ViewerReadyEvent | MeasurementAddedEvent | MeasurementUpdatedEvent | MeasurementRemovedEvent;

export type BridgeMessage = HostCommand | ViewerEvent;

export const HOST_COMMAND_TYPES = [
  'ACTIVATE_TOOL',
  'DEACTIVATE_TOOL',
  'REMOVE_MEASUREMENT',
  'FOCUS_MEASUREMENT',
] as const;

export const VIEWER_EVENT_TYPES = [
  'VIEWER_READY',
  'MEASUREMENT_ADDED',
  'MEASUREMENT_UPDATED',
  'MEASUREMENT_REMOVED',
] as const;

const UNIT_VALUES: readonly Unit[] = ['mm2', 'px2', 'mm', 'px'];
const TOOL_NAME_VALUES: readonly ToolName[] = ['EllipticalROI', 'RectangleROI', 'Length'];

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

const isViewerReadyEvent = (value: Record<string, unknown>): boolean =>
  value.type === 'VIEWER_READY' && typeof value.viewerVersion === 'string';

const isMeasurementAddedEvent = (value: Record<string, unknown>): boolean =>
  value.type === 'MEASUREMENT_ADDED' &&
  (value.rowId === null || isNonEmptyString(value.rowId)) &&
  isNonEmptyString(value.measurementUid) &&
  typeof value.toolName === 'string' &&
  isMetrics(value.metrics) &&
  (value.causedBy === undefined || typeof value.causedBy === 'string');

const isMeasurementUpdatedEvent = (value: Record<string, unknown>): boolean =>
  value.type === 'MEASUREMENT_UPDATED' &&
  isNonEmptyString(value.measurementUid) &&
  typeof value.toolName === 'string' &&
  isMetrics(value.metrics) &&
  (value.causedBy === undefined || typeof value.causedBy === 'string') &&
  // null rowId means "unarmed" on ADDED only; reject it here rather than accept it silently.
  value.rowId !== null;

const isMeasurementRemovedEvent = (value: Record<string, unknown>): boolean =>
  value.type === 'MEASUREMENT_REMOVED' &&
  isNonEmptyString(value.measurementUid) &&
  (value.causedBy === undefined || typeof value.causedBy === 'string');

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
    isFocusMeasurementCommand(value)
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
    isMeasurementRemovedEvent(value)
  );
};
