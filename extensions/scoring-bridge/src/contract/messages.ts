// Placeholder; replaced by a byte-identical copy of shared/contract/messages.ts.

/** Viewer -> host: the viewer is loaded and able to accept commands (C-4.4.1). */
export interface ViewerReadyEvent {
  version: 1;
  type: 'VIEWER_READY';
  viewerVersion: string;
}
