/**
 * S-5.5: show the OHIF version in a corner of every viewport.
 *
 * The version string is injected at build time: `.webpack/webpack.base.js:32,46` reads
 * `version.txt` (the value `lerna`/release tooling keeps in sync with the package versions) and
 * defines `process.env.VERSION_NUMBER` through webpack's DefinePlugin. Nothing is read at runtime.
 *
 * X-5: no OHIF component is patched. `CustomizableViewportOverlay`
 * (extensions/cornerstone/src/Viewport/Overlays/CustomizableViewportOverlay.tsx:80-86,257-264)
 * renders the four `viewportOverlay.*` customizations for *every* viewport, so appending one item
 * to that list puts the version in all viewports of any layout, 2x2 included.
 *
 * Merging: CustomizationService.init() walks the registered extensions in registration order and
 * feeds each `customizationModule.default` value through `setDefaultCustomization`, which applies
 * immutability-helper commands on top of what earlier extensions registered
 * (platform/core/src/services/CustomizationService/CustomizationService.ts:118-131,346-358,381-397).
 * `@ohif/extension-cornerstone` is registered before us (platform/app/pluginConfig.json), so
 * `$push` appends to its array instead of replacing it.
 */

/** Build-time constant; falsy only if the bundle was built without the DefinePlugin config. */
const VERSION_NUMBER = process.env.VERSION_NUMBER ?? '';

const versionOverlayItem = {
  id: 'scoringBridgeVersion',
  inheritsFrom: 'ohif.overlayItem',
  title: 'OHIF viewer version',
  // Rendered by OverlayItem (CustomizableViewportOverlay.tsx:380-397). The whole string is
  // returned from contentF (instead of using `label`) so it stays a single text node.
  contentF: () => (VERSION_NUMBER ? `OHIF ${VERSION_NUMBER}` : null),
};

function getCustomizationModule() {
  return [
    {
      name: 'default',
      value: {
        // Bottom-right is the least crowded corner in the longitudinal mode: cornerstone puts
        // StudyDate + SeriesDescription top-left, W/L + zoom bottom-left and only InstanceNumber
        // bottom-right (extensions/cornerstone/src/customizations/viewportOverlayCustomization.tsx).
        // Top-right is empty in that list but is where the viewport action corner menus live, so
        // the version would sit under them.
        'viewportOverlay.bottomRight': {
          $push: [versionOverlayItem],
        },
      },
    },
  ];
}

export default getCustomizationModule;
