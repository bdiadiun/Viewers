import type { Types } from '@ohif/core';

import { id } from './id';
import { createBridge } from './bridge';
import getCustomizationModule from './getCustomizationModule';

const scoringBridgeExtension: Types.Extensions.Extension = {
  id,

  preRegistration: ({
    servicesManager,
    commandsManager,
  }: Types.Extensions.ExtensionParams): void => {
    const bridge = createBridge({ servicesManager, commandsManager });

    // Q-5: onModeExit is a mode transition the bridge must outlive, and extensions have no
    // unregister hook, so the bridge is disposed with the page.
    const onPageHide = (): void => {
      bridge.dispose();
      window.removeEventListener('pagehide', onPageHide);
    };

    window.addEventListener('pagehide', onPageHide);
  },

  getCustomizationModule,
};

export default scoringBridgeExtension;
