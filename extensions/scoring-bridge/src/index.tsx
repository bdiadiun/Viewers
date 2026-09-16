import { Types } from '@ohif/core';

import { id } from './id';
import { createBridge } from './bridge';

/**
 * Scoring bridge extension.
 *
 * C-3.4: the bridge obtains servicesManager and commandsManager in preRegistration, subscribes to
 * measurementService there and (from the next slice on) calls commandsManager.runCommand(...).
 * Nothing reaches into OHIF internals from outside the iframe.
 */
const scoringBridgeExtension: Types.Extensions.Extension = {
  /** Only required property. Unique across all extensions. */
  id,

  preRegistration: ({ servicesManager, commandsManager }: Types.Extensions.ExtensionParams) => {
    const bridge = createBridge({ servicesManager, commandsManager });

    // Lifetime (Q-5). Extensions may register onModeEnter / onModeExit
    // (platform/core/src/extensions/ExtensionManager.ts:287-293), but those are mode transitions:
    // the bridge must outlive them, because the host keeps talking to the same iframe while the
    // user moves between modes. There is no extension-level "unregister" hook, so the bridge lives
    // for the page lifetime and is disposed when the document goes away.
    const onPageHide = () => {
      bridge.dispose();
      window.removeEventListener('pagehide', onPageHide);
    };

    window.addEventListener('pagehide', onPageHide);
  },
};

export default scoringBridgeExtension;
