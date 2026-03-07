const { withAndroidManifest } = require('@expo/config-plugins');

function withAndroidCleartext(config) {
  return withAndroidManifest(config, (configWithManifest) => {
    const app = configWithManifest.modResults?.manifest?.application?.[0];
    if (!app) {
      return configWithManifest;
    }

    app.$ = app.$ || {};
    app.$['android:usesCleartextTraffic'] = 'true';

    return configWithManifest;
  });
}

module.exports = withAndroidCleartext;
