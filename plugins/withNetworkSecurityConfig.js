const { withDangerousMod } = require('@expo/config-plugins');
const { writeFileSync, mkdirSync, copyFileSync, existsSync, readFileSync } = require('fs');
const { resolve } = require('path');

// Bundle our self-signed MC CA so the app trusts the LAN HTTPS proxy without a
// manual cert install. The phone's device policy blocks cleartext HTTP, so MC is
// TLS proxy; this network-security-config makes the app trust the CA
// for <lan-host-ip>.
//
// NOTE: the android:networkSecurityConfig attribute is injected into the generated
// AndroidManifest.xml by STRING manipulation (not via the manifest AST). The attribute
// name is case-sensitive — it MUST be lowercase "networkSecurityConfig"; a capital N
// ("NetworkSecurityConfig") makes AAPT report "attribute ... not found". Injecting the
// literal attribute string works because xmlns:android is already declared on <manifest>.
const CONFIG = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config cleartextTrafficPermitted="true">
    <trust-anchors>
      <certificates src="system" />
      <certificates src="@raw/mc_ca" />
    </trust-anchors>
  </base-config>
  <domain-config cleartextTrafficPermitted="false">
    <domain includeSubdomains="false"><lan-host-ip></domain>
    <trust-anchors>
      <certificates src="@raw/mc_ca" />
    </trust-anchors>
  </domain-config>
  <debug-overrides>
    <trust-anchors>
      <certificates src="user" />
    </trust-anchors>
  </debug-overrides>
</network-security-config>
`;

module.exports = function withNetworkSecurityConfig(config) {
  config = withDangerousMod(config, ['android', async (cfg) => {
    const projectRoot = cfg.modRequest.projectRoot;
    const resDir = resolve(projectRoot, 'android/app/src/main/res');
    // 1) Network security config XML
    mkdirSync(resolve(resDir, 'xml'), { recursive: true });
    writeFileSync(resolve(resDir, 'xml/resource_name.xml'), CONFIG);
    // 2) Bundle the CA cert into res/raw so it ships inside the APK
    const caSrc = resolve(projectRoot, 'assets/mc_ca.crt');
    if (existsSync(caSrc)) {
      mkdirSync(resolve(resDir, 'raw'), { recursive: true });
      copyFileSync(caSrc, resolve(resDir, 'raw/mc_ca.crt'));
    }
    // 3) Inject the attribute into the generated manifest's <application> tag
    const mfPath = resolve(projectRoot, 'android/app/src/main/AndroidManifest.xml');
    if (existsSync(mfPath)) {
      let mf = readFileSync(mfPath, 'utf8');
      if (!mf.includes('NetworkSecurityConfig')) {
        mf = mf.replace(/(<application\b[^>]*?)(\/?>)/, (m, open, close) => {
          return `${open} android:networkSecurityConfig="@xml/resource_name"${close}`;
        });
        writeFileSync(mfPath, mf);
      }
    }
    return cfg;
  }]);

  return config;
};
