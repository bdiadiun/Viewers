// Purpose: the single source of truth for the host-app <-> viewer postMessage contract
// (canon C-4.4.1, C-4.4.2, C-4.4.3, Q-7).
//
// This file lives in the `@scoring/contract` workspace package (packages/contract) and is
// consumed by host-app via that package. It must have no imports and no runtime dependencies,
// so the same file can also be copied verbatim into the OHIF extension at
// `viewer/extensions/scoring-bridge/src/contract/messages.ts`. That copy must stay
// byte-identical to this file; `npm run check:contract` (at the repo root) enforces this.
//
// Why a copy instead of a shared package import for the viewer side: `viewer/` is a git
// submodule and must stay a self-contained repository that can be built on its own, so its
// source cannot import files from outside the submodule (including this workspace package).
// Canon Q-7 explicitly allows a copied file with this explanation in place of a shared
// package for that side.

// CONTRACT_VERSION stays 1: F-15 (two-way deletion, S-5.2) only adds new message shapes
// (RemoveMeasurementCommand, MeasurementRemovedEvent) and new entries in the *_TYPES lists;
// no existing shape is changed, so wire-compatible peers do not need a version bump.
export const CONTRACT_VERSION = 1 as const;

// Normalised spelling used on the wire; the display layer renders mm² / px² for humans.
export type Unit = 'mm2' | 'px2' | 'mm' | 'px';

export interface Metric {
  value: number;
  unit: Unit;
}

// Known keys today: 'area', 'length'. A new measurement (e.g. perimeter, P-8) is a new key,
// not a new message shape.
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

export type HostCommand = ActivateToolCommand | DeactivateToolCommand | RemoveMeasurementCommand;

// viewer -> host

export interface ViewerReadyEvent {
  version: 1;
  type: 'VIEWER_READY';
  viewerVersion: string;
}

export interface MeasurementAddedEvent {
  version: 1;
  type: 'MEASUREMENT_ADDED';
  // null when the measurement was not drawn in response to an ACTIVATE_TOOL command
  // (e.g. drawn directly from the OHIF toolbar).
  rowId: string | null;
  measurementUid: string;
  toolName: string;
  metrics: Metrics;
  // Echoes the requestId of the command that caused this event, so the host can ignore
  // events it provoked itself (echo-loop protection, decision A-10).
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
  // Echoes the requestId of the REMOVE_MEASUREMENT command that caused this event, so the
  // host can ignore events it provoked itself (echo-loop protection, decision A-10). Absent
  // when the deletion originated in the viewer (e.g. via the OHIF toolbar), which is exactly
  // the case the host needs to hear about to clear the matching row (S-5.2).
  causedBy?: string;
}

export type ViewerEvent =
  | ViewerReadyEvent
  | MeasurementAddedEvent
  | MeasurementUpdatedEvent
  | MeasurementRemovedEvent;

export type BridgeMessage = HostCommand | ViewerEvent;

export const HOST_COMMAND_TYPES = ['ACTIVATE_TOOL', 'DEACTIVATE_TOOL', 'REMOVE_MEASUREMENT'] as const;

export const VIEWER_EVENT_TYPES = [
  'VIEWER_READY',
  'MEASUREMENT_ADDED',
  'MEASUREMENT_UPDATED',
  'MEASUREMENT_REMOVED',
] as const;

const UNIT_VALUES: readonly Unit[] = ['mm2', 'px2', 'mm', 'px'];
const TOOL_NAME_VALUES: readonly ToolName[] = ['EllipticalROI', 'RectangleROI', 'Length'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isUnit(value: unknown): value is Unit {
  return typeof value === 'string' && (UNIT_VALUES as readonly string[]).includes(value);
}

function isToolName(value: unknown): value is ToolName {
  return typeof value === 'string' && (TOOL_NAME_VALUES as readonly string[]).includes(value);
}

function isMetric(value: unknown): value is Metric {
  return (
    isRecord(value) &&
    typeof value.value === 'number' &&
    Number.isFinite(value.value) &&
    isUnit(value.unit)
  );
}

function isMetrics(value: unknown): value is Metrics {
  if (!isRecord(value)) {
    return false;
  }
  return Object.values(value).every(isMetric);
}

function hasVersion1(value: Record<string, unknown>): boolean {
  return value.version === 1;
}

// These return plain booleans rather than type predicates: interfaces without an index
// signature are not assignable to `Record<string, unknown>`, so a predicate here would not
// type-check. The narrowing to the concrete message type happens at the call site instead.

function isActivateToolCommand(value: Record<string, unknown>): boolean {
  return (
    value.type === 'ACTIVATE_TOOL' &&
    isNonEmptyString(value.requestId) &&
    isNonEmptyString(value.rowId) &&
    isToolName(value.toolName)
  );
}

function isDeactivateToolCommand(value: Record<string, unknown>): boolean {
  return (
    value.type === 'DEACTIVATE_TOOL' &&
    isNonEmptyString(value.requestId) &&
    isNonEmptyString(value.rowId)
  );
}

function isRemoveMeasurementCommand(value: Record<string, unknown>): boolean {
  return (
    value.type === 'REMOVE_MEASUREMENT' &&
    isNonEmptyString(value.requestId) &&
    isNonEmptyString(value.rowId) &&
    isNonEmptyString(value.measurementUid)
  );
}

function isViewerReadyEvent(value: Record<string, unknown>): boolean {
  return value.type === 'VIEWER_READY' && typeof value.viewerVersion === 'string';
}

function isMeasurementAddedEvent(value: Record<string, unknown>): boolean {
  return (
    value.type === 'MEASUREMENT_ADDED' &&
    (value.rowId === null || isNonEmptyString(value.rowId)) &&
    isNonEmptyString(value.measurementUid) &&
    typeof value.toolName === 'string' &&
    isMetrics(value.metrics) &&
    (value.causedBy === undefined || typeof value.causedBy === 'string')
  );
}

function isMeasurementUpdatedEvent(value: Record<string, unknown>): boolean {
  return (
    value.type === 'MEASUREMENT_UPDATED' &&
    isNonEmptyString(value.measurementUid) &&
    typeof value.toolName === 'string' &&
    isMetrics(value.metrics) &&
    (value.causedBy === undefined || typeof value.causedBy === 'string') &&
    // rowId is not part of this event; null is reserved to mean "unarmed" on ADDED only, so a
    // null rowId here is rejected rather than silently accepted as a harmless extra field.
    value.rowId !== null
  );
}

function isMeasurementRemovedEvent(value: Record<string, unknown>): boolean {
  return (
    value.type === 'MEASUREMENT_REMOVED' &&
    isNonEmptyString(value.measurementUid) &&
    (value.causedBy === undefined || typeof value.causedBy === 'string')
  );
}

export function isHostCommand(value: unknown): value is HostCommand {
  if (!isRecord(value) || !hasVersion1(value)) {
    return false;
  }
  if (!(HOST_COMMAND_TYPES as readonly string[]).includes(value.type as string)) {
    return false;
  }
  return (
    isActivateToolCommand(value) || isDeactivateToolCommand(value) || isRemoveMeasurementCommand(value)
  );
}

export function isViewerEvent(value: unknown): value is ViewerEvent {
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
}
