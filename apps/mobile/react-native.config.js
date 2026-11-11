/**
 * Project level React Native autolinking configuration.
 *
 * Expo ships its own `react-native.config.js` that declares the Android package import for
 * `expo`. With pnpm the package is resolved through a symlink into the virtual store, so that
 * config cannot resolve its own dependencies and expo-modules-autolinking silently falls back
 * to deriving the import from the Gradle namespace. That produces
 * `import expo.core.ExpoModulesPackage;` while Expo SDK 52 keeps the class in `expo.modules`,
 * and the Android build fails with "cannot find symbol: class ExpoModulesPackage".
 *
 * Declaring the import here keeps autolinking deterministic regardless of the store layout.
 */
module.exports = {
  dependencies: {
    expo: {
      platforms: {
        android: {
          packageImportPath: "import expo.modules.ExpoModulesPackage;",
          packageInstance: "new ExpoModulesPackage()",
        },
        ios: {},
      },
    },
  },
};
