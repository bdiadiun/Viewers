// Injected by webpack DefinePlugin from version.txt (.webpack/webpack.base.js:32,46).
const VERSION_NUMBER = process.env.VERSION_NUMBER ?? '';

// Least crowded corner; top-right is empty but hosts the viewport action menus.
const VERSION_OVERLAY_CUSTOMIZATION_ID = 'viewportOverlay.bottomRight';

interface OverlayItemCustomization {
  id: string;
  inheritsFrom: string;
  title: string;
  contentF: () => string | null;
}

export interface CustomizationModuleEntry {
  name: string;
  value: Record<string, { $push: OverlayItemCustomization[] }>;
}

const versionOverlayItem: OverlayItemCustomization = {
  id: 'scoringBridgeVersion',
  inheritsFrom: 'ohif.overlayItem',
  title: 'OHIF viewer version',
  // contentF, not `label`: one text node (CustomizableViewportOverlay.tsx:380-397).
  contentF: () => (VERSION_NUMBER ? `OHIF ${VERSION_NUMBER}` : null),
};

const getCustomizationModule = (): CustomizationModuleEntry[] => [
  {
    // Merged in registration order after cornerstone, so $push appends to its overlay list
    // (CustomizationService.ts:118-131,381-397).
    name: 'default',
    value: {
      [VERSION_OVERLAY_CUSTOMIZATION_ID]: {
        $push: [versionOverlayItem],
      },
    },
  },
];

export default getCustomizationModule;
