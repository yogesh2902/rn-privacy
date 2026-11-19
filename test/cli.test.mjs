import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findApiSymbols } from '../dist/apis.js';
import { mergeManifest } from '../dist/manifest.js';
import { analyze } from '../dist/analyze.js';
import { scanProject } from '../dist/scanner.js';
import { formatMarkdown } from '../dist/report.js';
import { findRule } from '../dist/rules.js';
import { satisfies } from '../dist/semver.js';
import { validateManifest } from '../dist/validate.js';
import { fillPlayCsv, parseCsv } from '../dist/play.js';
import withRnPrivacy from '../app.plugin.js';
import * as api from '../dist/index.js';
import { audit } from '../dist/audit.js';
import { issuesUrl } from '../dist/scanner.js';
import { isAppleBinary, scanBinary } from '../dist/binary.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');
const run = (cwd, ...args) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });

function write(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
}

const manifestXml = (apis) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>NSPrivacyAccessedAPITypes</key><array>${apis
  .map(([t, r]) => `<dict><key>NSPrivacyAccessedAPIType</key><string>${t}</string><key>NSPrivacyAccessedAPITypeReasons</key><array><string>${r}</string></array></dict>`)
  .join('')}</array></dict></plist>`;

function fixture(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `rn-privacy-${name}-`));
}

test('finds required reason API symbols and ignores comments', () => {
  const hits = findApiSymbols(`
    // [NSUserDefaults standardUserDefaults];
    /* mach_absolute_time() */
    NSDictionary *a = [fm attributesOfFileSystemForPath:p error:nil][NSFileSystemFreeSize];
    struct stat st; stat(path, &st);
  `);
  const cats = hits.map((h) => h.category).sort();
  assert.deepEqual(cats, ['NSPrivacyAccessedAPICategoryDiskSpace', 'NSPrivacyAccessedAPICategoryFileTimestamp']);
});

test('mergeManifest only adds and is idempotent', () => {
  const existing = {
    NSPrivacyAccessedAPITypes: [{ NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryUserDefaults', NSPrivacyAccessedAPITypeReasons: ['1C8F.1'] }],
    NSPrivacyTracking: true,
    Custom: 'keep me',
  };
  const apis = [{ category: 'NSPrivacyAccessedAPICategoryUserDefaults', reasons: ['CA92.1'] }];
  const collected = [{ type: 'crash-data', purposes: ['app-functionality'], linked: false, tracking: false }];
  const first = mergeManifest(existing, apis, collected);
  assert.deepEqual(first.manifest.NSPrivacyAccessedAPITypes[0].NSPrivacyAccessedAPITypeReasons, ['1C8F.1', 'CA92.1']);
  assert.equal(first.manifest.NSPrivacyTracking, true, 'never switches tracking off');
  assert.equal(first.manifest.Custom, 'keep me');
  assert.equal(existing.NSPrivacyAccessedAPITypes[0].NSPrivacyAccessedAPITypeReasons.length, 1, 'input not mutated');
  const second = mergeManifest(first.manifest, apis, collected);
  assert.deepEqual(second.added, []);
});

test('bare app: scan, ios --write, check', () => {
  const dir = fixture('bare');
  write(dir, {
    'package.json': { name: 'App', dependencies: { 'native-lib': '1.0.0', 'sdk-lib': '1.0.0', '@sentry/react-native': '1.0.0', 'js-only': '1.0.0' } },
    'node_modules/native-lib/package.json': { name: 'native-lib', version: '1.2.3' },
    'node_modules/native-lib/native-lib.podspec': '',
    'node_modules/native-lib/ios/Thing.m': 'uint64_t t = mach_absolute_time();\n[NSUserDefaults standardUserDefaults];',
    'node_modules/native-lib/example/ios/Ignored.m': 'NSFileSystemFreeSize',
    // A library whose own manifest uses an SDK-only reason: must not leak into the app manifest.
    'node_modules/sdk-lib/package.json': { name: 'sdk-lib', version: '2.0.0' },
    'node_modules/sdk-lib/ios/PrivacyInfo.xcprivacy': manifestXml([['NSPrivacyAccessedAPICategoryFileTimestamp', '0A2A.1']]),
    'node_modules/@sentry/react-native/package.json': { name: '@sentry/react-native', version: '6.0.0' },
    'node_modules/js-only/package.json': { name: 'js-only', version: '1.0.0' },
    'ios/App.xcodeproj/project.pbxproj': '',
    'ios/App/AppDelegate.mm': '',
  });

  const scan = scanProject(dir);
  assert.equal(scan.projectType, 'bare');
  const a = analyze(scan);
  const byCat = Object.fromEntries(a.apis.map((x) => [x.category.replace('NSPrivacyAccessedAPICategory', ''), x]));
  assert.deepEqual(Object.keys(byCat).sort(), ['FileTimestamp', 'SystemBootTime', 'UserDefaults'], 'example/ folder is skipped');
  assert.deepEqual(byCat.FileTimestamp.reasons, ['C617.1'], 'SDK-only reason replaced by the default');
  assert.equal(byCat.FileTimestamp.defaultReason, true);

  assert.equal(run(dir, 'check').status, 1, 'check fails without a manifest');

  const dry = run(dir, 'ios');
  assert.equal(dry.status, 0);
  assert.match(dry.stdout, /new file/);
  assert.ok(!fs.existsSync(path.join(dir, 'ios/App/PrivacyInfo.xcprivacy')), 'dry run writes nothing');

  const wrote = run(dir, 'ios', '--write');
  assert.equal(wrote.status, 0, wrote.stderr);
  const xml = fs.readFileSync(path.join(dir, 'ios/App/PrivacyInfo.xcprivacy'), 'utf8');
  assert.match(xml, /NSPrivacyAccessedAPICategorySystemBootTime/);
  assert.match(xml, /NSPrivacyCollectedDataTypeCrashData/, 'Sentry crash data declared');
  assert.doesNotMatch(xml, /0A2A\.1/);
  assert.doesNotMatch(xml, /NSPrivacyCollectedDataTypeUserID/, 'conditional data not declared by default');
  assert.match(wrote.stdout, /add it to your app target/);

  const check = run(dir, 'check');
  assert.equal(check.status, 0, check.stderr);
  assert.match(run(dir, 'ios').stdout, /Already up to date/);
});

test('expo managed app: merges into app.json and keeps other settings', () => {
  const dir = fixture('expo');
  write(dir, {
    'package.json': { name: 'ExpoApp', dependencies: { expo: '52.0.0', 'expo-location': '18.0.0', 'expo-notifications': '0.29.0' } },
    'app.json': { expo: { name: 'ExpoApp', ios: { bundleIdentifier: 'com.example.app' } } },
    'node_modules/expo/package.json': { name: 'expo', version: '52.0.0', dependencies: { 'expo-file-system': '18.0.0' } },
    'node_modules/expo-file-system/package.json': { name: 'expo-file-system', version: '18.0.0' },
    'node_modules/expo-file-system/expo-module.config.json': { platforms: ['apple', 'android'] },
    'node_modules/expo-file-system/ios/FileSystem.swift': 'let free = values.volumeAvailableCapacityForImportantUsage // URLResourceKey\nlet k: URLResourceKey = .volumeAvailableCapacityForImportantUsageKey',
    'node_modules/expo-location/package.json': { name: 'expo-location', version: '18.0.0' },
    'node_modules/expo-location/ios/Location.swift': '',
    'node_modules/expo-notifications/package.json': { name: 'expo-notifications', version: '0.29.0' },
  });

  const scan = scanProject(dir);
  assert.equal(scan.projectType, 'expo-managed');
  assert.ok(scan.packages.some((p) => p.name === 'expo-file-system'), 'transitive Expo module scanned');
  const a = analyze(scan);
  assert.ok(a.access.some((x) => x.type === 'precise-location'));
  assert.ok(!a.data.some((x) => x.type === 'precise-location'), 'device access is not reported as collection');

  const res = run(dir, 'ios', '--write');
  assert.equal(res.status, 0, res.stderr);
  const json = JSON.parse(fs.readFileSync(path.join(dir, 'app.json'), 'utf8'));
  assert.equal(json.expo.ios.bundleIdentifier, 'com.example.app');
  const types = json.expo.ios.privacyManifests.NSPrivacyAccessedAPITypes.map((t) => t.NSPrivacyAccessedAPIType);
  assert.deepEqual(types, ['NSPrivacyAccessedAPICategoryDiskSpace']);
  assert.equal(run(dir, 'check').status, 0);
});

test('expo app.config.js: writes app.json when the config spreads it, otherwise prints a snippet', () => {
  const base = {
    'package.json': { name: 'ExpoApp', dependencies: { expo: '52.0.0', 'lib-a': '1.0.0' } },
    'app.json': { expo: { name: 'ExpoApp' } },
    'node_modules/expo/package.json': { name: 'expo', version: '52.0.0' },
    'node_modules/lib-a/package.json': { name: 'lib-a', version: '1.0.0' },
    'node_modules/lib-a/ios/A.swift': 'UserDefaults.standard.set(1, forKey: "k")',
  };

  const spreads = fixture('expo-spread');
  write(spreads, { ...base, 'app.config.js': 'module.exports = ({ config }) => ({ ...config, name: "X" });' });
  const r1 = run(spreads, 'ios', '--write');
  assert.equal(r1.status, 0, r1.stderr);
  assert.match(r1.stdout, /spreads the app\.json config/);
  assert.ok(JSON.parse(fs.readFileSync(path.join(spreads, 'app.json'), 'utf8')).expo.ios.privacyManifests);
  assert.equal(run(spreads, 'check').status, 0);

  const standalone = fixture('expo-dynamic');
  write(standalone, { ...base, 'app.config.js': 'module.exports = { name: "X", ios: { privacyManifests: {} } };' });
  const r2 = run(standalone, 'ios', '--write');
  assert.match(r2.stdout, /cannot edit it/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(standalone, 'app.json'), 'utf8')).expo.ios, undefined, 'app.json untouched');
  const check = run(standalone, 'check');
  assert.equal(check.status, 1);
  assert.match(check.stderr, /cannot read/);
});

test('report groups conditionally linked data as linked', () => {
  const dir = fixture('report');
  write(dir, {
    'package.json': { name: 'App', dependencies: { '@sentry/react-native': '6.0.0' } },
    'node_modules/@sentry/react-native/package.json': { name: '@sentry/react-native', version: '6.0.0' },
  });
  const scan = scanProject(dir);
  const md = formatMarkdown(scan, analyze(scan));
  const linked = md.split('### Data linked to you')[1]?.split('###')[0] ?? '';
  assert.match(linked, /User ID .*@sentry\/react-native\*/);
  assert.match(md, /Google Play Console: Data safety/);
});

test('expo prebuild: check covers app.json and the generated ios folder', () => {
  const dir = fixture('prebuild');
  const apis = [['NSPrivacyAccessedAPICategoryUserDefaults', 'CA92.1'], ['NSPrivacyAccessedAPICategoryDiskSpace', 'E174.1']];
  const toEntries = (list) => list.map(([t, r]) => ({ NSPrivacyAccessedAPIType: t, NSPrivacyAccessedAPITypeReasons: [r] }));
  write(dir, {
    'package.json': { name: 'ExpoApp', dependencies: { expo: '52.0.0', 'lib-a': '1.0.0' } },
    'app.json': { expo: { name: 'ExpoApp', ios: { privacyManifests: { NSPrivacyAccessedAPITypes: toEntries(apis) } } } },
    'node_modules/expo/package.json': { name: 'expo', version: '52.0.0' },
    'node_modules/lib-a/package.json': { name: 'lib-a', version: '1.0.0' },
    'node_modules/lib-a/ios/A.swift': 'UserDefaults.standard.set(1, forKey: "k")\nlet k: URLResourceKey = .volumeAvailableCapacityKey',
    'ios/ExpoApp.xcodeproj/project.pbxproj': 'PrivacyInfo.xcprivacy',
  });
  assert.equal(scanProject(dir).projectType, 'expo-prebuild');

  // app.json is fine, but prebuild has not written the ios manifest yet.
  let res = run(dir, 'check');
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Not generated yet/);
  assert.match(res.stderr, /npx expo prebuild/);

  // ios manifest generated from an older app.json (missing Disk space).
  write(dir, { 'ios/ExpoApp/PrivacyInfo.xcprivacy': manifestXml(apis.slice(0, 1)) });
  res = run(dir, 'check');
  assert.equal(res.status, 1);
  assert.match(res.stdout, /app\.json[\s\S]*Covers all 2/);
  assert.match(res.stderr, /Missing required reason API: Disk space/);
  assert.match(res.stderr, /out of date/);

  // Both in sync.
  write(dir, { 'ios/ExpoApp/PrivacyInfo.xcprivacy': manifestXml(apis) });
  res = run(dir, 'check');
  assert.equal(res.status, 0, res.stderr);
});

test('semver ranges', () => {
  const cases = [
    ['6.1.0', '>=6.0.0', true], ['5.9.9', '>=6', false], ['6.4.2', '^6.1.0', true], ['7.0.0', '^6.1.0', false],
    ['0.2.9', '^0.2.3', true], ['0.3.0', '^0.2.3', false], ['6.1.9', '~6.1.0', true], ['6.2.0', '~6.1', false],
    ['6.9.0', '6.x', true], ['7.0.0', '6', false], ['5.0.0', '<5 || >=6', false], ['6.0.0-beta.1', '>=6.0.0', true],
    ['4.0.0', '>=3 <5', true], ['5.1.0', '<=5', true], ['6.0.0', '<=5', false], ['1.2.3', '*', true], ['?', '*', false],
  ];
  for (const [v, range, want] of cases) assert.equal(satisfies(v, range), want, `${v} in ${range}`);
});

test('findRule picks the rule for the installed version', () => {
  const rules = [
    { packages: ['sdk'], name: 'new', versions: '>=6', sources: [] },
    { packages: ['sdk'], name: 'old', versions: '<6', sources: [] },
    { packages: ['sdk'], name: 'any', sources: [] },
  ];
  assert.equal(findRule('sdk', '6.2.0', rules).name, 'new');
  assert.equal(findRule('sdk', '5.0.0', rules).name, 'old');
  assert.equal(findRule('sdk', '?', rules).name, 'any');
  assert.equal(findRule('sdk', undefined, rules).name, 'any');
  assert.equal(findRule('@sentry/react-native', '6.0.0').name, 'Sentry');
});

test('validateManifest catches what App Store Connect rejects (ITMS-91056)', () => {
  const ok = {
    NSPrivacyTracking: false,
    NSPrivacyTrackingDomains: [],
    NSPrivacyAccessedAPITypes: [{ NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryDiskSpace', NSPrivacyAccessedAPITypeReasons: ['E174.1'] }],
    NSPrivacyCollectedDataTypes: [{
      NSPrivacyCollectedDataType: 'NSPrivacyCollectedDataTypeCrashData', NSPrivacyCollectedDataTypeLinked: false,
      NSPrivacyCollectedDataTypeTracking: false, NSPrivacyCollectedDataTypePurposes: ['NSPrivacyCollectedDataTypePurposeAnalytics'],
    }],
  };
  assert.deepEqual(validateManifest(ok), []);

  const errors = (m) => validateManifest(m).filter((p) => p.level === 'error').map((p) => p.message).join('\n');
  assert.match(errors({ NSPrivacyAccessedAPITypes: [{ NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryUserDefaults', NSPrivacyAccessedAPITypeReasons: ['C56D.1'] }] }), /only allowed in third-party SDKs/);
  assert.match(errors({ NSPrivacyAccessedAPITypes: [{ NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryDiskSpace', NSPrivacyAccessedAPITypeReasons: ['CA92.1'] }] }), /not a valid reason/);
  assert.match(errors({ NSPrivacyAccessedAPITypes: [{ NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryDiskSpace', NSPrivacyAccessedAPITypeReasons: [] }] }), /at least one reason/);
  assert.match(errors({ NSPrivacyAccessedAPITypes: [{ NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryCamera', NSPrivacyAccessedAPITypeReasons: ['X'] }] }), /not a required reason API category/);
  assert.match(errors({ NSPrivacyTracking: 'NO' }), /must be a boolean/);
  assert.match(errors({ NSPrivacyTrackingDomains: ['https://ads.example.com/x'] }), /domain name only/);
  assert.match(errors({ NSPrivacyCollectedDataTypes: [{ ...ok.NSPrivacyCollectedDataTypes[0], NSPrivacyCollectedDataType: 'NSPrivacyCollectedDataTypeIDFA' }] }), /not a valid collected data type/);
  assert.match(errors({ NSPrivacyCollectedDataTypes: [{ ...ok.NSPrivacyCollectedDataTypes[0], NSPrivacyCollectedDataTypePurposes: ['Analytics'] }] }), /not a valid purpose/);
  assert.match(errors({ NSPrivacyAccessedAPITypes: 'oops' }), /must be an array/);
  const warnings = validateManifest({ ...ok, NSPrivacyTrackingDomain: [] }).map((p) => p.message).join('\n');
  assert.match(warnings, /Unknown key "NSPrivacyTrackingDomain"/);
});

test('check fails on an invalid manifest and ios refuses to edit it', () => {
  const dir = fixture('invalid');
  write(dir, {
    'package.json': { name: 'App', dependencies: { 'lib-a': '1.0.0' } },
    'node_modules/lib-a/package.json': { name: 'lib-a', version: '1.0.0' },
    'node_modules/lib-a/ios/A.swift': 'UserDefaults.standard.set(1, forKey: "k")',
    'ios/App.xcodeproj/project.pbxproj': 'PrivacyInfo.xcprivacy',
    'ios/App/PrivacyInfo.xcprivacy': manifestXml([['NSPrivacyAccessedAPICategoryUserDefaults', 'C56D.1']]),
  });
  const res = run(dir, 'check');
  assert.equal(res.status, 1);
  assert.match(res.stderr, /C56D\.1 is only allowed in third-party SDKs/);
  assert.match(res.stderr, /ITMS-91056/);

  const before = fs.readFileSync(path.join(dir, 'ios/App/PrivacyInfo.xcprivacy'), 'utf8');
  const ios = run(dir, 'ios', '--write');
  assert.equal(ios.status, 1);
  assert.match(ios.stderr, /will not change it/);
  assert.equal(fs.readFileSync(path.join(dir, 'ios/App/PrivacyInfo.xcprivacy'), 'utf8'), before, 'file untouched');

  write(dir, { 'ios/App/PrivacyInfo.xcprivacy': '<plist><dict><key>broken' });
  const broken = run(dir, 'check');
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /not a valid property list/);
});

const PLAY_HEADER = 'Question ID (machine readable),Response ID (machine readable),Response value,Answer requirement,Human-friendly question label';
const playRows = (type) => [
  `PSL_DATA_TYPES_APP_PERFORMANCE,${type},,MULTIPLE_CHOICE,App info and performance / x`,
  `PSL_DATA_USAGE_RESPONSES:${type}:PSL_DATA_USAGE_COLLECTION_AND_SHARING,PSL_DATA_USAGE_ONLY_COLLECTED,,MULTIPLE_CHOICE,"Data usage (x) / Is this data collected, shared, or both? / Collected"`,
  `PSL_DATA_USAGE_RESPONSES:${type}:PSL_DATA_USAGE_COLLECTION_AND_SHARING,PSL_DATA_USAGE_ONLY_SHARED,,MULTIPLE_CHOICE,Shared`,
  `PSL_DATA_USAGE_RESPONSES:${type}:PSL_DATA_USAGE_EPHEMERAL,,,MAYBE_REQUIRED,Ephemeral`,
  `PSL_DATA_USAGE_RESPONSES:${type}:DATA_USAGE_USER_CONTROL,PSL_DATA_USAGE_USER_CONTROL_OPTIONAL,,SINGLE_CHOICE,Optional`,
  `PSL_DATA_USAGE_RESPONSES:${type}:DATA_USAGE_USER_CONTROL,PSL_DATA_USAGE_USER_CONTROL_REQUIRED,,SINGLE_CHOICE,Required`,
  `PSL_DATA_USAGE_RESPONSES:${type}:DATA_USAGE_COLLECTION_PURPOSE,PSL_APP_FUNCTIONALITY,,MULTIPLE_CHOICE,Functionality`,
  `PSL_DATA_USAGE_RESPONSES:${type}:DATA_USAGE_COLLECTION_PURPOSE,PSL_ANALYTICS,FALSE,MULTIPLE_CHOICE,Analytics`,
];

test('play: fills the exported Data safety CSV without turning anything off', () => {
  const csv = [
    PLAY_HEADER,
    'PSL_DATA_COLLECTION_COLLECTS_PERSONAL_DATA,,,REQUIRED,Does your app collect or share any of the required user data types?',
    ...playRows('PSL_CRASH_LOGS'),
    'PSL_DATA_TYPES_PERSONAL,PSL_NAME,TRUE,MULTIPLE_CHOICE,Personal info / Name',
  ].join('\r\n') + '\r\n';

  const collected = [
    { type: 'crash-data', purposes: ['analytics', 'app-functionality'], linked: false, tracking: false },
    { type: 'device-id', purposes: ['analytics'], linked: false, tracking: false },
  ];
  const result = fillPlayCsv(csv, collected);
  assert.ok(result.content.includes('\r\n') && result.content.endsWith('\r\n'), 'keeps CRLF and the trailing newline');
  const rows = parseCsv(result.content);
  const value = (q, r = '') => rows.find((x) => x[0] === q && x[1] === r)?.[2];
  const usage = 'PSL_DATA_USAGE_RESPONSES:PSL_CRASH_LOGS';
  assert.equal(value('PSL_DATA_COLLECTION_COLLECTS_PERSONAL_DATA'), 'true');
  assert.equal(value('PSL_DATA_TYPES_APP_PERFORMANCE', 'PSL_CRASH_LOGS'), 'true');
  assert.equal(value(`${usage}:PSL_DATA_USAGE_COLLECTION_AND_SHARING`, 'PSL_DATA_USAGE_ONLY_COLLECTED'), 'true');
  assert.equal(value(`${usage}:PSL_DATA_USAGE_COLLECTION_AND_SHARING`, 'PSL_DATA_USAGE_ONLY_SHARED'), '', 'sharing left to the developer');
  assert.equal(value(`${usage}:PSL_DATA_USAGE_EPHEMERAL`), 'false');
  assert.equal(value(`${usage}:DATA_USAGE_COLLECTION_PURPOSE`, 'PSL_ANALYTICS'), 'true', 'FALSE is turned on when the SDK collects for analytics');
  assert.equal(value('PSL_DATA_TYPES_PERSONAL', 'PSL_NAME'), 'TRUE', 'existing answers are kept as they are');
  assert.equal(rows[3][4], 'Data usage (x) / Is this data collected, shared, or both? / Collected', 'quoted labels survive');
  assert.deepEqual(result.todo, ['Crash logs']);
  assert.ok(result.missingRows.some((m) => m.includes('PSL_DEVICE_ID')), 'reports rows the template does not have');

  const again = fillPlayCsv(result.content, collected);
  assert.deepEqual(again.changes, []);
  assert.equal(again.content, result.content, 'idempotent');
  assert.throws(() => fillPlayCsv('a,b\n1,2\n', collected), /not a Data safety CSV/);
});

test('play command: dry run by default, -o writes', () => {
  const dir = fixture('play');
  write(dir, {
    'package.json': { name: 'App', dependencies: { '@sentry/react-native': '6.0.0' } },
    'node_modules/@sentry/react-native/package.json': { name: '@sentry/react-native', version: '6.0.0' },
    'export.csv': [PLAY_HEADER, ...playRows('PSL_CRASH_LOGS')].join('\n') + '\n',
  });
  const dry = run(dir, 'play', 'export.csv');
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /\+ Crash logs: selected, collected/);
  assert.match(dry.stdout, /Dry run/);
  assert.ok(!fs.existsSync(path.join(dir, 'filled.csv')));
  const wrote = run(dir, 'play', 'export.csv', '-o', 'filled.csv');
  assert.equal(wrote.status, 0, wrote.stderr);
  assert.match(fs.readFileSync(path.join(dir, 'filled.csv'), 'utf8'), /PSL_CRASH_LOGS,true/);
  assert.equal(run(dir, 'play').status, 2, 'usage without a file');
});

test('expo config plugin merges into ios.privacyManifests and check trusts it', () => {
  const dir = fixture('plugin');
  write(dir, {
    'package.json': { name: 'ExpoApp', dependencies: { expo: '58.0.0', 'lib-a': '1.0.0', '@sentry/react-native': '6.0.0' } },
    'app.json': { expo: { name: 'ExpoApp', plugins: [['rn-privacy', {}]] } },
    'node_modules/expo/package.json': { name: 'expo', version: '58.0.0' },
    'node_modules/lib-a/package.json': { name: 'lib-a', version: '1.0.0' },
    'node_modules/lib-a/ios/A.swift': 'UserDefaults.standard.set(1, forKey: "k")\nlet k: URLResourceKey = .volumeAvailableCapacityKey',
    'node_modules/@sentry/react-native/package.json': { name: '@sentry/react-native', version: '6.0.0' },
  });

  const mine = { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryUserDefaults', NSPrivacyAccessedAPITypeReasons: ['1C8F.1'] };
  const input = { name: 'ExpoApp', ios: { bundleIdentifier: 'x', privacyManifests: { NSPrivacyAccessedAPITypes: [mine] } }, _internal: { projectRoot: dir } };
  const out = withRnPrivacy(input);
  assert.equal(out.ios.bundleIdentifier, 'x');
  const types = Object.fromEntries(out.ios.privacyManifests.NSPrivacyAccessedAPITypes.map((t) => [t.NSPrivacyAccessedAPIType, t.NSPrivacyAccessedAPITypeReasons]));
  assert.deepEqual(types.NSPrivacyAccessedAPICategoryUserDefaults, ['1C8F.1', 'CA92.1'], 'keeps your reason and adds the scanned one');
  assert.ok(types.NSPrivacyAccessedAPICategoryDiskSpace);
  assert.ok(out.ios.privacyManifests.NSPrivacyCollectedDataTypes.some((d) => d.NSPrivacyCollectedDataType === 'NSPrivacyCollectedDataTypeCrashData'));
  assert.deepEqual(input.ios.privacyManifests.NSPrivacyAccessedAPITypes, [mine], 'input config not mutated');

  const bad = { ios: { privacyManifests: { NSPrivacyTracking: 'yes' } }, _internal: { projectRoot: dir } };
  const warn = console.warn; let warned = '';
  console.warn = (m) => { warned += m; };
  try { assert.equal(withRnPrivacy(bad), bad, 'invalid manifest left unchanged'); } finally { console.warn = warn; }
  assert.match(warned, /invalid/);

  const check = run(dir, 'check');
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /Expo plugin adds all 2/);
  assert.match(run(dir, 'ios').stdout, /You do not need --write/);

  // With a stale ios folder, check points to prebuild.
  write(dir, { 'ios/ExpoApp.xcodeproj/project.pbxproj': '', 'ios/ExpoApp/PrivacyInfo.xcprivacy': manifestXml([['NSPrivacyAccessedAPICategoryUserDefaults', 'CA92.1']]) });
  const stale = run(dir, 'check');
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /Missing required reason API: Disk space/);
  assert.match(stale.stderr, /npx expo prebuild/);
});

const libManifest = (inner) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>${inner}</dict></plist>`;

test('audit: invalid, undeclared and incomplete library manifests', () => {
  const dir = fixture('audit');
  write(dir, {
    'package.json': { name: 'App', dependencies: { 'bad-sdk': '1.0.0', 'no-manifest': '1.0.0', 'partial': '1.0.0', 'good-sdk': '1.0.0', 'broken': '1.0.0' } },
    // Invalid data type and empty purpose, like Segment's manifest.
    'node_modules/bad-sdk/package.json': { name: 'bad-sdk', version: '2.0.0', repository: { url: 'git+https://github.com/acme/bad-sdk.git' } },
    'node_modules/bad-sdk/ios/PrivacyInfo.xcprivacy': libManifest('<key>NSPrivacyCollectedDataTypes</key><array><dict><key>NSPrivacyCollectedDataType</key><string>App Name</string><key>NSPrivacyCollectedDataTypeLinked</key><false/><key>NSPrivacyCollectedDataTypeTracking</key><false/><key>NSPrivacyCollectedDataTypePurposes</key><array><string></string></array></dict></array>'),
    'node_modules/no-manifest/package.json': { name: 'no-manifest', version: '1.0.0', bugs: { url: 'https://example.com/issues' } },
    'node_modules/no-manifest/ios/Fs.m': 'NSDictionary *a = [fm attributesOfFileSystemForPath:p error:nil][NSFileSystemFreeSize];',
    'node_modules/partial/package.json': { name: 'partial', version: '1.0.0' },
    'node_modules/partial/ios/P.swift': 'UserDefaults.standard.set(1, forKey: "k")\nlet t = ProcessInfo.processInfo.systemUptime',
    'node_modules/partial/ios/PrivacyInfo.xcprivacy': manifestXml([['NSPrivacyAccessedAPICategoryUserDefaults', 'CA92.1']]),
    // SDK-only reasons are fine in a library's own manifest.
    'node_modules/good-sdk/package.json': { name: 'good-sdk', version: '1.0.0' },
    'node_modules/good-sdk/ios/PrivacyInfo.xcprivacy': libManifest('<key>NSPrivacyTracking</key><true/><key>NSPrivacyTrackingDomains</key><array><string>t.good-sdk.com</string></array><key>NSPrivacyAccessedAPITypes</key><array><dict><key>NSPrivacyAccessedAPIType</key><string>NSPrivacyAccessedAPICategoryUserDefaults</string><key>NSPrivacyAccessedAPITypeReasons</key><array><string>C56D.1</string></array></dict></array>'),
    'node_modules/broken/package.json': { name: 'broken', version: '1.0.0' },
    'node_modules/broken/ios/PrivacyInfo.xcprivacy': '<plist><dict><key>oops',
  });

  const a = audit(scanProject(dir));
  const names = (list) => list.map((x) => x.pkg).sort();
  assert.deepEqual(names(a.invalid), ['bad-sdk', 'broken']);
  const bad = a.invalid.find((x) => x.pkg === 'bad-sdk');
  assert.match(bad.issues.map((i) => i.message).join('\n'), /"App Name" is not a valid collected data type/);
  assert.match(bad.issues.map((i) => i.message).join('\n'), /"" is not a valid purpose/);
  assert.equal(bad.issuesUrl, 'https://github.com/acme/bad-sdk/issues');
  assert.match(a.invalid.find((x) => x.pkg === 'broken').issues[0].message, /Not a valid property list/);
  assert.deepEqual(names(a.undeclared), ['no-manifest']);
  assert.equal(a.undeclared[0].issuesUrl, 'https://example.com/issues');
  assert.deepEqual(a.incomplete.map((x) => [x.pkg, x.missing]), [['partial', ['NSPrivacyAccessedAPICategorySystemBootTime']]]);
  assert.deepEqual(a.tracking.map((x) => [x.pkg, x.domains]), [['good-sdk', ['t.good-sdk.com']]]);

  const out = run(dir, 'audit');
  assert.equal(out.status, 0);
  assert.match(out.stdout, /Invalid privacy manifest \(2\)/);
  assert.match(out.stdout, /Report it: https:\/\/github.com\/acme\/bad-sdk\/issues/);
  assert.match(out.stdout, /Your app is still covered/);
  assert.equal(run(dir, 'audit', '--strict').status, 1);
  assert.equal(JSON.parse(run(dir, 'audit', '--format', 'json').stdout).invalid.length, 2);
  assert.match(run(dir, 'scan').stdout, /Library audit/);
});

test('tracking: --tracking declares SDK tracking domains, check spots missing ones', () => {
  const dir = fixture('tracking');
  write(dir, {
    'package.json': { name: 'App', dependencies: { 'ads-sdk': '1.0.0' } },
    'node_modules/ads-sdk/package.json': { name: 'ads-sdk', version: '1.0.0' },
    'node_modules/ads-sdk/ios/PrivacyInfo.xcprivacy': libManifest('<key>NSPrivacyTracking</key><true/><key>NSPrivacyTrackingDomains</key><array><string>track.ads.example</string></array>'),
    'ios/App.xcodeproj/project.pbxproj': 'PrivacyInfo.xcprivacy',
    'ios/App/AppDelegate.mm': '',
  });

  const plain = run(dir, 'ios', '--write');
  assert.match(plain.stdout, /run again with --tracking/);
  let xml = fs.readFileSync(path.join(dir, 'ios/App/PrivacyInfo.xcprivacy'), 'utf8');
  assert.match(xml, /<key>NSPrivacyTracking<\/key>\s*<false\/>/, 'tracking stays off without --tracking');

  const tracked = run(dir, 'ios', '--write', '--tracking');
  assert.equal(tracked.status, 0, tracked.stderr);
  xml = fs.readFileSync(path.join(dir, 'ios/App/PrivacyInfo.xcprivacy'), 'utf8');
  assert.match(xml, /<key>NSPrivacyTracking<\/key>\s*<true\/>/);
  assert.match(xml, /track\.ads\.example/);
  assert.equal(run(dir, 'check').status, 0);

  // Tracking on but the domain removed: check warns (it does not fail).
  write(dir, { 'ios/App/PrivacyInfo.xcprivacy': libManifest('<key>NSPrivacyTracking</key><true/><key>NSPrivacyTrackingDomains</key><array></array>') });
  const check = run(dir, 'check');
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /Tracking domain not declared: track\.ads\.example \(from ads-sdk\)/);

  const plugin = withRnPrivacy({ _internal: { projectRoot: dir } }, { tracking: true });
  assert.equal(plugin.ios.privacyManifests.NSPrivacyTracking, true);
  assert.deepEqual(plugin.ios.privacyManifests.NSPrivacyTrackingDomains, ['track.ads.example']);
});

test('check --format json', () => {
  const dir = fixture('check-json');
  write(dir, {
    'package.json': { name: 'App', dependencies: { 'lib-a': '1.0.0' } },
    'node_modules/lib-a/package.json': { name: 'lib-a', version: '1.0.0' },
    'node_modules/lib-a/ios/A.swift': 'UserDefaults.standard.set(1, forKey: "k")\nlet k: URLResourceKey = .volumeAvailableCapacityKey',
    'ios/App.xcodeproj/project.pbxproj': 'PrivacyInfo.xcprivacy',
    'ios/App/PrivacyInfo.xcprivacy': manifestXml([['NSPrivacyAccessedAPICategoryUserDefaults', 'C56D.1']]),
  });
  const res = run(dir, 'check', '--format', 'json');
  assert.equal(res.status, 1);
  assert.equal(res.stderr, '', 'JSON mode prints nothing else');
  const r = JSON.parse(res.stdout);
  assert.equal(r.ok, false);
  assert.equal(r.projectType, 'bare');
  assert.deepEqual(r.requiredApis.map((a) => a.label).sort(), ['Disk space', 'User defaults']);
  assert.equal(r.manifests.length, 1);
  const m = r.manifests[0];
  assert.equal(m.label, path.join('ios', 'App', 'PrivacyInfo.xcprivacy'));
  assert.equal(m.status, 'invalid');
  assert.match(m.errors[0], /C56D\.1 is only allowed in third-party SDKs/);
  assert.deepEqual(m.missingApis.map((a) => [a.label, a.packages]), [['Disk space', ['lib-a']]]);
  assert.match(r.hint, /Fix the invalid entries/);

  write(dir, { 'ios/App/PrivacyInfo.xcprivacy': manifestXml([['NSPrivacyAccessedAPICategoryUserDefaults', 'CA92.1'], ['NSPrivacyAccessedAPICategoryDiskSpace', 'E174.1']]) });
  const ok = run(dir, 'check', '--format', 'json');
  assert.equal(ok.status, 0);
  assert.equal(JSON.parse(ok.stdout).ok, true);
  assert.equal(JSON.parse(ok.stdout).manifests[0].status, 'ok');

  const none = fixture('check-json-none');
  write(none, { 'package.json': { name: 'App', dependencies: {} }, 'ios/App.xcodeproj/project.pbxproj': '' });
  const empty = JSON.parse(run(none, 'check', '--format', 'json').stdout);
  assert.equal(empty.manifests.length, 0);
});

test('android: library, app, merged manifest and removed permissions', () => {
  const dir = fixture('android');
  const manifest = (perms, tools = '') => `<manifest xmlns:android="http://schemas.android.com/apk/res/android" xmlns:tools="http://schemas.android.com/tools">\n${perms}\n</manifest>`;
  write(dir, {
    'package.json': { name: 'App', dependencies: { 'geo-lib': '1.0.0', 'plain-lib': '1.0.0' } },
    'node_modules/geo-lib/package.json': { name: 'geo-lib', version: '1.0.0' },
    'node_modules/geo-lib/android/src/main/AndroidManifest.xml': manifest('<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />\n<uses-permission android:name="android.permission.INTERNET"/>'),
    'node_modules/plain-lib/package.json': { name: 'plain-lib', version: '1.0.0' },
    'android/app/src/main/AndroidManifest.xml': manifest('<uses-permission android:name="android.permission.CAMERA"/>\n<!-- <uses-permission android:name="android.permission.READ_SMS"/> -->\n<uses-permission android:name="android.permission.RECORD_AUDIO" tools:node="remove"/>'),
    'android/app/build/intermediates/merged_manifest/release/processReleaseMainManifest/AndroidManifest.xml': manifest('<uses-permission android:name="com.google.android.gms.permission.AD_ID"/>\n<uses-permission android:name="android.permission.RECORD_AUDIO"/>\n<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION"/>'),
  });
  const a = analyze(scanProject(dir));
  const found = Object.fromEntries(a.android.map((p) => [p.permission.split('.').pop(), p.sources]));
  assert.deepEqual(found, { AD_ID: ['a Gradle dependency'], CAMERA: ['your app'], ACCESS_FINE_LOCATION: ['geo-lib'] }, 'INTERNET is not sensitive, READ_SMS is commented out, RECORD_AUDIO is removed');

  const scan = run(dir, 'scan');
  assert.match(scan.stdout, /Advertising ID\s+from a Gradle dependency/);
  assert.match(formatMarkdown(scanProject(dir), a), /### Android permissions/);

  write(dir, { 'app.json': { expo: { android: { blockedPermissions: ['com.google.android.gms.permission.AD_ID'], permissions: ['READ_CONTACTS'] } } } });
  const b = analyze(scanProject(dir));
  assert.ok(!b.android.some((p) => p.permission.endsWith('AD_ID')), 'blockedPermissions removes it');
  assert.ok(b.android.some((p) => p.permission === 'android.permission.READ_CONTACTS'), 'short names from app.json are understood');
});

test('rules: newly added SDKs are recognized', () => {
  for (const [pkg, name] of [['clevertap-react-native', 'CleverTap'], ['react-native-moengage', 'MoEngage'], ['@braze/react-native-sdk', 'Braze'], ['react-native-adjust', 'Adjust'], ['singular-react-native', 'Singular'], ['@intercom/intercom-react-native', 'Intercom'], ['@luciq/react-native', 'Luciq (Instabug)'], ['instabug-reactnative', 'Luciq (Instabug)'], ['@logrocket/react-native', 'LogRocket'], ['@microsoft/react-native-clarity', 'Microsoft Clarity'], ['klaviyo-react-native-sdk', 'Klaviyo']]) {
    const rule = findRule(pkg, '1.0.0');
    assert.equal(rule?.name, name, pkg);
    assert.ok(rule.sources.length, `${pkg} has a source`);
    for (const item of rule.collects ?? []) assert.ok(item.purposes.length, `${pkg} ${item.type} has purposes`);
  }
});

test('tracking domains from SDK manifests are normalized to domain names', () => {
  const dir = fixture('domains');
  write(dir, {
    'package.json': { name: 'App', dependencies: { 'attr-sdk': '1.0.0' } },
    'node_modules/attr-sdk/package.json': { name: 'attr-sdk', version: '1.0.0' },
    'node_modules/attr-sdk/ios/PrivacyInfo.xcprivacy': libManifest('<key>NSPrivacyTracking</key><true/><key>NSPrivacyTrackingDomains</key><array><string>https://Consent.Example.com/path</string><string>t.example.com</string></array>'),
  });
  const a = analyze(scanProject(dir));
  assert.deepEqual(a.tracking[0].domains, ['consent.example.com', 't.example.com']);
  assert.match(audit(scanProject(dir)).invalid[0].issues[0].message, /must be a domain name only/, 'audit still reports the URL in the SDK');
});

test('binary: finds required reason APIs in prebuilt frameworks', () => {
  // A 64-bit Mach-O header followed by a string table, and a static library (ar archive).
  const macho = Buffer.concat([Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), Buffer.alloc(28), Buffer.from('\0_mach_absolute_time\0_OBJC_CLASS_$_NSUserDefaults\0_strlen\0', 'latin1')]);
  const archive = Buffer.from('!<arch>\n...\0_statfs\0activeInputModes\0', 'latin1');
  const lookalike = Buffer.concat([Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), Buffer.from('\0_status\0_stat_helper\0', 'latin1')]);
  const dir = fixture('binary');
  write(dir, {
    'package.json': { name: 'App', dependencies: { 'bin-sdk': '1.0.0' } },
    'node_modules/bin-sdk/package.json': { name: 'bin-sdk', version: '1.0.0' },
    'node_modules/bin-sdk/bin-sdk.podspec': '',
    'node_modules/bin-sdk/ios/Sdk.xcframework/Info.plist': '<plist/>',
    // Simulator and macOS slices never ship in an iOS build, so they are skipped.
    'node_modules/bin-sdk/ios/Sdk.xcframework/ios-arm64_x86_64-simulator/Sdk.framework/Sdk': '\0_stat\0',
  });
  const put = (rel, buf) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), buf); };
  put('node_modules/bin-sdk/ios/Sdk.xcframework/ios-arm64/Sdk.framework/Sdk', macho);
  put('node_modules/bin-sdk/ios/libextra.a', archive);
  put('node_modules/bin-sdk/ios/Sdk.xcframework/ios-arm64/Sdk.framework/Lookalike', lookalike);

  assert.equal(isAppleBinary(path.join(dir, 'node_modules/bin-sdk/ios/libextra.a')), true);
  assert.equal(isAppleBinary(path.join(dir, 'node_modules/bin-sdk/package.json')), false);
  assert.deepEqual(scanBinary(path.join(dir, 'node_modules/bin-sdk/ios/Sdk.xcframework/ios-arm64/Sdk.framework/Lookalike')), [], 'exact names only');

  const a = analyze(scanProject(dir));
  assert.deepEqual(a.apis.map((x) => x.category.replace('NSPrivacyAccessedAPICategory', '')).sort(), ['ActiveKeyboards', 'DiskSpace', 'SystemBootTime', 'UserDefaults'], 'simulator slice (stat) skipped');
  const lib = audit(scanProject(dir)).undeclared.find((x) => x.pkg === 'bin-sdk');
  assert.ok(lib, 'binary-only use without a manifest is reported');
  assert.ok(lib.categories.includes('NSPrivacyAccessedAPICategorySystemBootTime'));
  const pkg = scanProject(dir).packages.find((p) => p.name === 'bin-sdk');
  const boot = pkg.apis.get('NSPrivacyAccessedAPICategorySystemBootTime').evidence;
  assert.deepEqual(boot, [{ kind: 'binary', file: path.join('ios', 'Sdk.xcframework', 'ios-arm64', 'Sdk.framework', 'Sdk'), symbol: 'mach_absolute_time' }]);
});

test('snapshot and diff, from a file and from a git ref', () => {
  const dir = fixture('snapshot');
  const git = (...args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' });
  write(dir, {
    'package.json': { name: 'App', dependencies: { storage: '1.0.0' } },
    'node_modules/storage/package.json': { name: 'storage', version: '1.0.0' },
    'node_modules/storage/storage.podspec': '',
    'node_modules/storage/ios/S.swift': 'UserDefaults.standard.set(1, forKey: "k")',
  });
  assert.equal(run(dir, 'diff').status, 1, 'no snapshot yet');
  assert.match(run(dir, 'diff').stderr, /Run `rn-privacy snapshot`/);
  assert.equal(run(dir, 'snapshot').status, 0);
  const first = fs.readFileSync(path.join(dir, 'privacy-snapshot.json'), 'utf8');
  assert.match(run(dir, 'snapshot').stdout, /up to date/, 'stable: no dates or paths');
  assert.equal(fs.readFileSync(path.join(dir, 'privacy-snapshot.json'), 'utf8'), first);
  git('init', '-q'); git('add', '.'); git('commit', '-qm', 'base');

  write(dir, {
    'package.json': { name: 'App', dependencies: { storage: '1.1.0', 'fs-lib': '2.0.0' } },
    'node_modules/storage/package.json': { name: 'storage', version: '1.1.0' },
    'node_modules/fs-lib/package.json': { name: 'fs-lib', version: '2.0.0' },
    'node_modules/fs-lib/fs-lib.podspec': '',
    'node_modules/fs-lib/ios/F.m': 'NSDictionary *a = x[NSFileSystemFreeSize];',
    'node_modules/fs-lib/android/src/main/AndroidManifest.xml': '<manifest><uses-permission android:name="android.permission.READ_MEDIA_IMAGES"/></manifest>',
  });
  const diff = run(dir, 'diff');
  assert.equal(diff.status, 0);
  assert.match(diff.stdout, /\+ Disk space\s+fs-lib/);
  assert.match(diff.stdout, /\+ Photos\s+fs-lib/);
  assert.match(diff.stdout, /~ storage\s+1\.0\.0 → 1\.1\.0/);
  assert.equal(run(dir, 'diff', '--strict').status, 1);

  const json = JSON.parse(run(dir, 'diff', '--base', 'HEAD', '--format', 'json').stdout);
  assert.equal(json.against, 'HEAD:privacy-snapshot.json');
  assert.deepEqual(json.apis, [{ kind: 'added', label: 'Disk space', detail: 'fs-lib' }]);

  run(dir, 'snapshot');
  assert.match(run(dir, 'diff').stdout, /No privacy changes/);
  assert.equal(run(dir, 'diff', '--base', 'no-such-ref').status, 1);
});

test('issuesUrl understands the usual package.json forms', () => {
  assert.equal(issuesUrl({ bugs: 'https://x.dev/bugs' }), 'https://x.dev/bugs');
  assert.equal(issuesUrl({ bugs: { url: 'https://x.dev/b' } }), 'https://x.dev/b');
  assert.equal(issuesUrl({ repository: 'git+https://github.com/a/b.git' }), 'https://github.com/a/b/issues');
  assert.equal(issuesUrl({ repository: { url: 'git@github.com:a/b.git' } }), 'https://github.com/a/b/issues');
  assert.equal(issuesUrl({ repository: 'github:a/b' }), 'https://github.com/a/b/issues');
  assert.equal(issuesUrl({ repository: 'a/b' }), 'https://github.com/a/b/issues');
  assert.equal(issuesUrl({ repository: 'gitlab:a/b' }), 'https://gitlab.com/a/b/issues');
  assert.equal(issuesUrl({ repository: 'https://example.com/repo' }), undefined);
  assert.equal(issuesUrl({}), undefined);
});

test('public API works from ESM imports', () => {
  for (const name of ['scanProject', 'analyze', 'mergeManifest', 'validateManifest', 'fillPlayCsv', 'findRule', 'DATA_TYPES']) {
    assert.ok(api[name], `${name} is exported`);
  }
});

test('--help and unknown command', () => {
  assert.match(execFileSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' }), /Commands/);
  assert.equal(run(os.tmpdir(), 'nope').status, 2);
});
