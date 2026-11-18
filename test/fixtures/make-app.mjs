// Creates a small React Native app for testing the GitHub Action.
// Usage: node test/fixtures/make-app.mjs <dir> <good|missing|invalid>
import fs from 'node:fs';
import path from 'node:path';

const [dir, kind = 'good'] = process.argv.slice(2);
if (!dir) throw new Error('Usage: make-app.mjs <dir> <good|missing|invalid>');

const write = (rel, content) => {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
};

const reasons = {
  good: [['NSPrivacyAccessedAPICategoryUserDefaults', 'CA92.1'], ['NSPrivacyAccessedAPICategoryDiskSpace', 'E174.1']],
  missing: [['NSPrivacyAccessedAPICategoryUserDefaults', 'CA92.1']],
  invalid: [['NSPrivacyAccessedAPICategoryUserDefaults', 'C56D.1'], ['NSPrivacyAccessedAPICategoryDiskSpace', 'E174.1']],
}[kind];

write('package.json', { name: 'FixtureApp', dependencies: { 'native-lib': '1.0.0' } });
write('node_modules/native-lib/package.json', { name: 'native-lib', version: '1.0.0' });
write('node_modules/native-lib/native-lib.podspec', '');
write('node_modules/native-lib/ios/Lib.swift', 'UserDefaults.standard.set(1, forKey: "k")\nlet k: URLResourceKey = .volumeAvailableCapacityKey\n');
write('ios/FixtureApp.xcodeproj/project.pbxproj', 'PrivacyInfo.xcprivacy');
write('ios/FixtureApp/PrivacyInfo.xcprivacy', `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>NSPrivacyAccessedAPITypes</key><array>${reasons
  .map(([t, r]) => `<dict><key>NSPrivacyAccessedAPIType</key><string>${t}</string><key>NSPrivacyAccessedAPITypeReasons</key><array><string>${r}</string></array></dict>`)
  .join('')}</array></dict></plist>
`);
console.log(`Created ${kind} app in ${dir}`);
