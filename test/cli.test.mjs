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
import { suggestFixes, suggestionIssue } from '../dist/suggest.js';

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

test('package layouts: pnpm symlinks, workspaces, Yarn Plug\'n\'Play', () => {
  // pnpm: node_modules/<pkg> is a symlink into .pnpm, and its dependencies are siblings there.
  const pnpm = fixture('pnpm');
  const store = 'node_modules/.pnpm';
  write(pnpm, {
    'package.json': { name: 'App', dependencies: { expo: '54.0.0' } },
    [`${store}/expo@54.0.0/node_modules/expo/package.json`]: { name: 'expo', version: '54.0.0', dependencies: { 'expo-file-system': '19.0.0' } },
    [`${store}/expo-file-system@19.0.0/node_modules/expo-file-system/package.json`]: { name: 'expo-file-system', version: '19.0.0' },
    [`${store}/expo-file-system@19.0.0/node_modules/expo-file-system/expo-module.config.json`]: { platforms: ['apple'] },
    [`${store}/expo-file-system@19.0.0/node_modules/expo-file-system/ios/F.swift`]: 'let k: URLResourceKey = .volumeAvailableCapacityKey',
  });
  fs.symlinkSync(path.join(pnpm, store, 'expo@54.0.0/node_modules/expo'), path.join(pnpm, 'node_modules/expo'), 'dir');
  fs.symlinkSync(path.join(pnpm, store, 'expo-file-system@19.0.0/node_modules/expo-file-system'), path.join(pnpm, store, 'expo@54.0.0/node_modules/expo-file-system'), 'dir');
  const a = analyze(scanProject(pnpm));
  assert.deepEqual(a.apis.map((x) => [x.category, x.packages]), [['NSPrivacyAccessedAPICategoryDiskSpace', ['expo-file-system']]], 'transitive module found through the pnpm store');

  // npm/yarn workspaces: dependencies hoisted to the monorepo root.
  const mono = fixture('mono');
  write(mono, {
    'package.json': { name: 'mono', private: true, workspaces: ['apps/*'] },
    'apps/mobile/package.json': { name: 'mobile', dependencies: { 'fs-lib': '1.0.0' } },
    'node_modules/fs-lib/package.json': { name: 'fs-lib', version: '1.0.0' },
    'node_modules/fs-lib/fs-lib.podspec': '',
    'node_modules/fs-lib/ios/F.m': 'NSDictionary *a = x[NSFileSystemFreeSize];',
  });
  const m = analyze(scanProject(path.join(mono, 'apps/mobile')));
  assert.deepEqual(m.apis.map((x) => x.packages), [['fs-lib']]);
  assert.equal(m.warnings.length, 0);

  // Yarn Plug'n'Play: one clear message instead of "not installed" for every package.
  const pnp = fixture('pnp');
  write(pnp, { 'package.json': { name: 'App', dependencies: { a: '1', b: '1' } }, '.pnp.cjs': '' });
  const w = analyze(scanProject(pnp)).warnings;
  assert.equal(w.length, 1);
  assert.match(w[0].message, /nodeLinker: node-modules/);
});

test('audit --suggest: valid fixed manifests and issue texts, nothing guessed', () => {
  const dir = fixture('suggest');
  write(dir, {
    'package.json': { name: 'App', dependencies: { '@segment/analytics-react-native': '2.0.0', 'fs-lib': '1.0.0', 'partial': '1.0.0' } },
    // Like Segment's real manifest: an empty purpose and a made-up data type.
    'node_modules/@segment/analytics-react-native/package.json': { name: '@segment/analytics-react-native', version: '2.0.0', repository: 'github:segmentio/analytics-react-native' },
    'node_modules/@segment/analytics-react-native/ios/PrivacyInfo.xcprivacy': libManifest('<key>NSPrivacyTrackingDomains</key><array><string>https://t.example.com/x</string></array><key>NSPrivacyCollectedDataTypes</key><array><dict><key>NSPrivacyCollectedDataType</key><string>NSPrivacyCollectedDataTypeDeviceID</string><key>NSPrivacyCollectedDataTypeLinked</key><true/><key>NSPrivacyCollectedDataTypeTracking</key><false/><key>NSPrivacyCollectedDataTypePurposes</key><array><string></string></array></dict><dict><key>NSPrivacyCollectedDataType</key><string>App Name</string><key>NSPrivacyCollectedDataTypeLinked</key><false/><key>NSPrivacyCollectedDataTypeTracking</key><false/><key>NSPrivacyCollectedDataTypePurposes</key><array><string>NSPrivacyCollectedDataTypePurposeAnalytics</string></array></dict></array>'),
    'node_modules/fs-lib/package.json': { name: 'fs-lib', version: '1.0.0' },
    'node_modules/fs-lib/fs-lib.podspec': '',
    'node_modules/fs-lib/ios/F.m': 'NSDictionary *a = x[NSFileSystemFreeSize];',
    'node_modules/partial/package.json': { name: 'partial', version: '1.0.0' },
    'node_modules/partial/ios/P.swift': 'let t = ProcessInfo.processInfo.systemUptime',
    'node_modules/partial/ios/PrivacyInfo.xcprivacy': manifestXml([['NSPrivacyAccessedAPICategoryUserDefaults', 'NOPE.1']]),
  });
  const sugs = Object.fromEntries(suggestFixes(scanProject(dir)).map((x) => [x.pkg, x]));
  assert.deepEqual(Object.keys(sugs).sort(), ['@segment/analytics-react-native', 'fs-lib', 'partial']);
  for (const sug of Object.values(sugs)) {
    assert.deepEqual(validateManifest(sug.manifest, { sdk: true }).filter((p) => p.level === 'error'), [], `${sug.pkg} suggestion is valid`);
  }
  const seg = sugs['@segment/analytics-react-native'];
  assert.deepEqual(seg.manifest.NSPrivacyCollectedDataTypes.map((d) => d.NSPrivacyCollectedDataType), ['NSPrivacyCollectedDataTypeDeviceID'], '"App Name" removed');
  assert.ok(seg.manifest.NSPrivacyCollectedDataTypes[0].NSPrivacyCollectedDataTypePurposes.length, 'purpose filled from the rule');
  assert.ok(seg.decide.some((d) => d.includes('confirm the purposes')), 'and the maintainer is asked to confirm');
  assert.deepEqual(seg.manifest.NSPrivacyTrackingDomains, ['t.example.com']);
  assert.deepEqual(sugs['fs-lib'].manifest.NSPrivacyAccessedAPITypes, [{ NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryDiskSpace', NSPrivacyAccessedAPITypeReasons: ['E174.1'] }]);
  const partial = sugs.partial.manifest.NSPrivacyAccessedAPITypes.map((t) => [t.NSPrivacyAccessedAPIType.replace('NSPrivacyAccessedAPICategory', ''), t.NSPrivacyAccessedAPITypeReasons]);
  assert.deepEqual(partial, [['UserDefaults', ['CA92.1']], ['SystemBootTime', ['35F9.1']]], 'invalid reason replaced (to decide), missing category added');

  const issue = suggestionIssue(seg);
  assert.match(issue.title, /needs a fix/);
  assert.match(issue.body, /"App Name" is not a valid collected data type/);
  assert.match(issue.body, /```xml\n<\?xml/);
  assert.match(suggestionIssue(sugs['fs-lib']).title, /Add an iOS privacy manifest/);

  const out = run(dir, 'audit', '--suggest', '-o', 'fixes');
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /post at https:\/\/github.com\/segmentio\/analytics-react-native\/issues/);
  assert.ok(fs.existsSync(path.join(dir, 'fixes/segment-analytics-react-native/PrivacyInfo.xcprivacy')));
  assert.ok(fs.existsSync(path.join(dir, 'fixes/fs-lib/ISSUE.md')));
});

test('android: Play answers come from vendors\' Play disclosures, else from iOS (marked)', () => {
  const dir = fixture('play-android');
  write(dir, {
    'package.json': { name: 'App', dependencies: { 'react-native-google-mobile-ads': '14.0.0', '@sentry/react-native': '6.0.0', '@braze/react-native-sdk': '24.0.0', 'react-native-onesignal': '5.0.0' } },
    'node_modules/react-native-google-mobile-ads/package.json': { name: 'react-native-google-mobile-ads', version: '14.0.0' },
    'node_modules/@sentry/react-native/package.json': { name: '@sentry/react-native', version: '6.0.0' },
    'node_modules/@braze/react-native-sdk/package.json': { name: '@braze/react-native-sdk', version: '24.0.0' },
    'node_modules/react-native-onesignal/package.json': { name: 'react-native-onesignal', version: '5.0.0' },
  });
  const a = analyze(scanProject(dir));
  const byType = Object.fromEntries(a.play.map((f) => [f.type, f]));
  // AdMob's Play page: shared, with fraud prevention (a purpose Apple does not have).
  assert.equal(byType['coarse-location'].shared, true);
  assert.ok(byType['coarse-location'].purposes.includes('fraud-prevention'));
  // OneSignal's Play page adds Developer communications; its device ID is iOS-only.
  assert.ok(byType['product-interaction'].purposes.includes('developer-communications'));
  // Sentry publishes no Play page: derived from iOS and marked.
  assert.ok(byType['crash-data'].derived.includes('@sentry/react-native'));
  assert.ok(!byType['device-id'].derived.includes('react-native-google-mobile-ads'));
  // Sharing purposes only come from the SDKs that share.
  assert.deepEqual(byType['device-id'].sharedPurposes.sort(), ['advertising', 'analytics', 'fraud-prevention']);

  const md = formatMarkdown(scanProject(dir), a);
  assert.match(md, /\| Shared \|/);
  assert.match(md, /@sentry\/react-native†/);
  assert.match(md, /comes from the iOS data/);

  // Braze states no purposes: play leaves them to the developer.
  const csv = [PLAY_HEADER, ...playRows('PSL_CRASH_LOGS')].join('\n') + '\n';
  const res = fillPlayCsv(csv, [{ type: 'crash-data', purposes: [] }]);
  assert.deepEqual(res.purposeTodo, ['Crash logs']);
  const shared = fillPlayCsv([PLAY_HEADER, ...playRows('PSL_CRASH_LOGS'),
    'PSL_DATA_USAGE_RESPONSES:PSL_CRASH_LOGS:DATA_USAGE_SHARING_PURPOSE,PSL_ANALYTICS,,MULTIPLE_CHOICE,Shared analytics',
    'PSL_DATA_USAGE_RESPONSES:PSL_CRASH_LOGS:DATA_USAGE_SHARING_PURPOSE,PSL_APP_FUNCTIONALITY,,MULTIPLE_CHOICE,Shared functionality'].join('\n') + '\n',
    [{ type: 'crash-data', purposes: ['analytics', 'app-functionality'], shared: true, sharedPurposes: ['analytics'] }]);
  const rows = parseCsv(shared.content);
  const v = (q, r) => rows.find((x) => x[0] === q && x[1] === r)?.[2];
  assert.equal(v('PSL_DATA_USAGE_RESPONSES:PSL_CRASH_LOGS:PSL_DATA_USAGE_COLLECTION_AND_SHARING', 'PSL_DATA_USAGE_ONLY_SHARED'), 'true');
  assert.equal(v('PSL_DATA_USAGE_RESPONSES:PSL_CRASH_LOGS:DATA_USAGE_SHARING_PURPOSE', 'PSL_ANALYTICS'), 'true');
  assert.equal(v('PSL_DATA_USAGE_RESPONSES:PSL_CRASH_LOGS:DATA_USAGE_SHARING_PURPOSE', 'PSL_APP_FUNCTIONALITY'), '', 'only the sharing SDK\'s purposes');
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

test('config: your own rules for unknown SDKs, pods and the app itself, replacing built-in ones', () => {
  const dir = fixture('config');
  write(dir, {
    'package.json': { name: 'App', dependencies: { '@acme/tracker': '1.0.0', '@sentry/react-native': '6.0.0' } },
    'node_modules/@acme/tracker/package.json': { name: '@acme/tracker', version: '2.1.0' },
    'node_modules/@sentry/react-native/package.json': { name: '@sentry/react-native', version: '6.0.0' },
    'ios/Pods/AcmeKit/AcmeKit.m': '',
    'rn-privacy.config.json': {
      $schema: './node_modules/rn-privacy/config.schema.json',
      rules: [
        { packages: ['@acme/tracker'], name: 'Acme Tracker', collects: [{ type: 'device-id', purposes: ['analytics'], linked: false, tracking: false }],
          android: { collects: [{ type: 'device-id', purposes: ['analytics'], shared: true }] }, sources: ['https://acme.example/privacy'] },
        { packages: ['@sentry/react-native'], name: 'Sentry (our setup)', collects: [] },
        { packages: ['AcmeKit'], name: 'AcmeKit', collects: [{ type: 'precise-location', purposes: ['app-functionality'], linked: true, tracking: false }] },
        { name: 'Sign-in', collects: [{ type: 'email', purposes: ['app-functionality'], linked: true, tracking: false }],
          android: { collects: [{ type: 'email', purposes: ['account-management'] }] } },
        { packages: ['not-installed'], name: 'Typo', collects: [] },
      ],
    },
  });
  const scan = scanProject(dir);
  const a = analyze(scan);
  const types = a.data.map((d) => d.type).sort();
  assert.deepEqual(types, ['device-id', 'email', 'precise-location'], 'Sentry\'s built-in rule is replaced');
  assert.deepEqual(a.data.find((d) => d.type === 'precise-location').packages, ['AcmeKit (CocoaPods)']);
  // A pod is not in the Android app; the app rule and the npm SDK are.
  assert.deepEqual(a.play.map((p) => p.type).sort(), ['device-id', 'email']);
  assert.equal(a.play.find((p) => p.type === 'device-id').shared, true);
  assert.deepEqual(a.play.find((p) => p.type === 'email').purposes, ['account-management']);
  assert.ok(a.warnings.some((w) => w.pkg === 'Typo' && /matches no installed package/.test(w.message)));
  const md = formatMarkdown(scan, a);
  assert.match(md, /\*\*Acme Tracker|@acme\/tracker@2\.1\.0\*\* \(your rule in rn-privacy\.config\.json\)/);
  assert.match(md, /\*\*Sign-in\*\* \(your rule in rn-privacy\.config\.json\)/);
  assert.match(run(dir, 'scan').stdout, /using your rules/);
});

test('config: every problem is reported with a fix, and the command fails', () => {
  const dir = fixture('config-bad');
  write(dir, {
    'package.json': { name: 'App', dependencies: {} },
    'rn-privacy.config.json': {
      rule: [],
      rules: [
        { name: 'A', collects: [{ type: 'emial', purposes: ['ads'], linked: true }] },
        { packages: [], name: 'B', versions: '>=1 <<2', collect: [] },
        { packages: ['c'], name: 'C', android: { collects: [{ type: 'email', purposes: ['analytic'] }] } },
      ],
    },
  });
  const r = run(dir, 'scan');
  assert.equal(r.status, 1);
  for (const msg of [
    /Unknown setting "rule"/,
    /"emial" is not a data type/,
    /"ads" is not a purpose/,
    /"tracking" must be true or false/,
    /"packages" must be a non-empty list/,
    /unknown field "collect"/,
    /"analytic" is not a Google Play purpose/,
  ]) assert.match(r.stderr, msg);
  assert.throws(() => api.parseConfig({ rules: [{ name: 'x', collects: [], versions: '^1' }] }), /"versions" only works with "packages"/);
  write(dir, { 'rn-privacy.config.json': '{ nope' });
  assert.match(run(dir, 'scan').stderr, /Not valid JSON/);
});

test('config schema lists the same data types and purposes as the code', () => {
  const schema = JSON.parse(fs.readFileSync(new URL('../config.schema.json', import.meta.url), 'utf8'));
  const d = schema.$defs;
  assert.deepEqual(d.dataType.enum.sort(), Object.keys(api.DATA_TYPES).sort());
  assert.deepEqual(d.purpose.enum.sort(), Object.keys(api.PURPOSES).sort());
  assert.deepEqual(d.playPurpose.enum.sort(), Object.keys(api.PLAY_PURPOSES).sort());
});

const resolvedV2 = (pins) => JSON.stringify({ pins: pins.map(([identity, location, version]) => ({ identity, kind: 'remoteSourceControl', location, state: { revision: 'abcdef1234567', version } })), version: 2 });

test('swift packages: Package.resolved, checkouts, binary artifacts and DerivedData', () => {
  const dir = fixture('spm');
  const dd = fixture('spm-dd');
  write(dir, {
    'package.json': { name: 'App', dependencies: {} },
    'ios/App.xcworkspace/xcshareddata/swiftpm/Package.resolved': resolvedV2([
      ['sdkkit', 'https://github.com/acme/SDKKit.git', '3.2.1'],
      ['binarysdk', 'https://github.com/acme/BinarySDK', '1.0.0'],
      ['plain', 'https://github.com/acme/plain.git', '0.1.0'],
    ]),
  });
  const sp = path.join(dd, 'App-xyz', 'SourcePackages');
  write(sp, {
    'checkouts/SDKKit/Sources/SDKKit/PrivacyInfo.xcprivacy': libManifest(
      '<key>NSPrivacyTracking</key><true/><key>NSPrivacyTrackingDomains</key><array><string>https://t.acme.example/x</string></array>',
    ),
    'checkouts/SDKKit/Sources/SDKKit/Store.swift': 'UserDefaults.standard.set(1, forKey: "k")',
    'checkouts/SDKKit/Tests/SDKKitTests/T.swift': 'mach_absolute_time()',
    'checkouts/BinarySDK/Package.swift': '// swift-tools-version:5.9',
    'checkouts/plain/Sources/Plain/P.swift': 'let x = 1',
  });
  const bin = path.join(sp, 'artifacts/binarysdk/BinarySDK/BinarySDK.xcframework/ios-arm64/BinarySDK.framework/BinarySDK');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, Buffer.concat([Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), Buffer.alloc(60), Buffer.from('\0_mach_absolute_time\0')]));
  write(dd, {
    'App-xyz/info.plist': `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>WorkspacePath</key><string>${path.join(dir, 'ios', 'App.xcworkspace')}</string></dict></plist>`,
  });
  const env = { ...process.env, RN_PRIVACY_DERIVED_DATA: dd };
  const old = process.env.RN_PRIVACY_DERIVED_DATA;
  process.env.RN_PRIVACY_DERIVED_DATA = dd;
  try {
    const scan = scanProject(dir);
    const names = scan.packages.map((p) => `${p.name}@${p.version}`);
    assert.deepEqual(names.sort(), ['BinarySDK (Swift Package)@1.0.0', 'SDKKit (Swift Package)@3.2.1'], 'a package with nothing to declare is left out');
    const kit = scan.packages.find((p) => p.name.startsWith('SDKKit'));
    assert.deepEqual([...kit.apis.keys()], ['NSPrivacyAccessedAPICategoryUserDefaults'], 'tests are not scanned');
    assert.deepEqual(kit.trackingDomains, ['t.acme.example']);
    assert.equal(kit.issuesUrl, 'https://github.com/acme/SDKKit/issues');
    const binary = scan.packages.find((p) => p.name.startsWith('BinarySDK'));
    assert.equal(binary.apis.get('NSPrivacyAccessedAPICategorySystemBootTime').evidence[0].kind, 'binary');
    const a = analyze(scan);
    assert.deepEqual(a.play, [], 'Swift packages are not in the Android app');
    assert.ok(audit(scan).undeclared.some((r) => r.pkg === 'BinarySDK (Swift Package)'));
    assert.deepEqual(scan.swiftPackagesNotDownloaded, []);
  } finally {
    if (old === undefined) delete process.env.RN_PRIVACY_DERIVED_DATA;
    else process.env.RN_PRIVACY_DERIVED_DATA = old;
  }

  // Not downloaded yet: say so instead of reporting nothing.
  const r = spawnSync(process.execPath, [CLI, 'scan'], { cwd: dir, encoding: 'utf8', env: { ...env, NO_COLOR: '1', RN_PRIVACY_DERIVED_DATA: path.join(dd, 'nothing') } });
  assert.match(r.stdout, /3 Swift packages are listed in Package\.resolved but not downloaded/);

  // A folder from -clonedSourcePackagesDirPath wins, and format 1 of Package.resolved works too.
  fs.rmSync(path.join(dir, 'ios/App.xcworkspace'), { recursive: true });
  write(dir, {
    'ios/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved': JSON.stringify({
      object: { pins: [{ package: 'SDKKit', repositoryURL: 'https://github.com/acme/SDKKit.git', state: { version: '3.0.0' } }] }, version: 1,
    }),
  });
  fs.cpSync(path.join(sp, 'checkouts'), path.join(dir, 'ios/SourcePackages/checkouts'), { recursive: true });
  const local = spawnSync(process.execPath, [CLI, 'scan', '--format', 'json'], { cwd: dir, encoding: 'utf8', env: { ...env, RN_PRIVACY_DERIVED_DATA: path.join(dd, 'nothing') } });
  assert.deepEqual(JSON.parse(local.stdout).packages.map((p) => `${p.name}@${p.version}`), ['SDKKit (Swift Package)@3.0.0']);
});

test('swift packages: names from the Xcode project when Package.resolved is missing', () => {
  const pins = api.pbxprojPackages(`
    A1 /* XCRemoteSwiftPackageReference "Kit" */ = {
      isa = XCRemoteSwiftPackageReference;
      repositoryURL = "https://github.com/acme/Kit.git";
    };`);
  assert.deepEqual(pins, [{ identity: 'kit', name: 'Kit', location: 'https://github.com/acme/Kit.git', version: '?' }]);
  assert.deepEqual(api.parsePackageResolved('not json'), []);
});

test('rules: Play disclosures for BugSnag, Clarity, Singular and Luciq', () => {
  for (const pkg of ['@bugsnag/react-native', '@microsoft/react-native-clarity', 'singular-react-native', '@luciq/react-native']) {
    const rule = findRule(pkg);
    assert.ok(rule.android?.collects.length, pkg);
    assert.ok(rule.android.sources.every((s) => s.startsWith('https://')), pkg);
  }
});

test('init: plans, writes once, and never overwrites', () => {
  const dir = fixture('init');
  write(dir, {
    'package.json': { name: 'App', dependencies: { expo: '52.0.0', '@sentry/react-native': '6.0.0' } },
    'package-lock.json': '{}',
    'app.json': { expo: { name: 'App', plugins: ['expo-router'] } },
    'node_modules/@sentry/react-native/package.json': { name: '@sentry/react-native', version: '6.0.0' },
    'node_modules/expo/package.json': { name: 'expo', version: '52.0.0' },
  });
  fs.mkdirSync(path.join(dir, '.git'));
  const dry = run(dir, 'init');
  assert.equal(dry.status, 0);
  assert.match(dry.stdout, /Dry run/);
  assert.ok(!fs.existsSync(path.join(dir, 'rn-privacy.config.json')), 'dry run writes nothing');

  const r = run(dir, 'init', '--write');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'app.json'), 'utf8')).expo.plugins, ['expo-router', 'rn-privacy']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'rn-privacy.config.json'), 'utf8')).rules, []);
  assert.ok(fs.existsSync(path.join(dir, 'privacy-snapshot.json')));
  const wf = fs.readFileSync(path.join(dir, '.github/workflows/privacy.yml'), 'utf8');
  assert.match(wf, /pull-requests: write/);
  assert.match(wf, /- run: npm ci/);
  assert.match(wf, /uses: yogesh2902\/rn-privacy@v\d+\.\d+\.\d+/);
  assert.match(r.stdout, /npm install --save-dev rn-privacy/, 'the Expo plugin needs the package installed');
  assert.equal(run(dir, 'check').status, 0, 'check passes right after init');

  // Second run: everything done, nothing changed.
  fs.writeFileSync(path.join(dir, 'rn-privacy.config.json'), '{ "rules": [] }\n');
  const again = run(dir, 'init', '--write');
  assert.match(again.stdout, /Already set up/);
  assert.equal(fs.readFileSync(path.join(dir, 'rn-privacy.config.json'), 'utf8'), '{ "rules": [] }\n');
});

test('init: bare app in a pnpm monorepo', () => {
  const repo = fixture('init-mono');
  const app = path.join(repo, 'apps', 'mobile');
  write(repo, { 'pnpm-lock.yaml': '', 'package.json': { name: 'root', private: true } });
  write(app, {
    'package.json': { name: 'mobile', dependencies: { 'react-native': '0.76.0', 'native-lib': '1.0.0' } },
    'node_modules/native-lib/package.json': { name: 'native-lib', version: '1.0.0' },
    'node_modules/native-lib/native-lib.podspec': '',
    'node_modules/native-lib/ios/A.m': '[NSUserDefaults standardUserDefaults];',
    'ios/Mobile.xcodeproj/project.pbxproj': '',
    'ios/Mobile/AppDelegate.mm': '',
  });
  fs.mkdirSync(path.join(repo, '.git'));
  const r = run(app, 'init', '--write');
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(path.join(app, 'ios/Mobile/PrivacyInfo.xcprivacy'), 'utf8'), /CA92\.1/);
  assert.match(r.stdout, /add ios\/Mobile\/PrivacyInfo\.xcprivacy to your app target/);
  const wf = fs.readFileSync(path.join(repo, '.github/workflows/privacy.yml'), 'utf8');
  assert.match(wf, /pnpm\/action-setup/);
  assert.match(wf, /pnpm install --frozen-lockfile/);
  assert.match(wf, /project-path: apps\/mobile/);
  assert.doesNotMatch(wf, /working-directory/, 'pnpm installs from the repository root');
});

const ascFixture = () => {
  const dir = fixture('asc');
  write(dir, {
    'package.json': { name: 'App', dependencies: { '@segment/analytics-react-native': '2.21.0', 'react-native-branch': '6.0.0', '@sentry/react-native': '6.0.0' } },
    'node_modules/@segment/analytics-react-native/package.json': { name: '@segment/analytics-react-native', version: '2.21.0' },
    'node_modules/react-native-branch/package.json': { name: 'react-native-branch', version: '6.0.0' },
    'node_modules/@sentry/react-native/package.json': { name: '@sentry/react-native', version: '6.0.0' },
    'rn-privacy.config.json': { rules: [{ name: 'Sign-in', collects: [{ type: 'email', purposes: ['app-functionality'], linked: true, tracking: false }] }] },
  });
  return dir;
};

test('report --format appstore: App Store Connect answers in order, with who makes each Yes', () => {
  const dir = ascFixture();
  const r = run(dir, 'report', '--format', 'appstore');
  assert.equal(r.status, 0, r.stderr);
  const md = r.stdout;
  assert.match(md, /collect data from this app\?" \*\*Yes\*\*/);
  assert.match(md, /- \*\*Contact Info\*\*: Email Address/);
  assert.match(md, /- \*\*Identifiers\*\*: Device ID/);
  assert.ok(md.indexOf('### Email Address') < md.indexOf('### Device ID'), 'App Store Connect order');
  const device = md.slice(md.indexOf('### Device ID'), md.indexOf('###', md.indexOf('### Device ID') + 4));
  // Segment links device IDs but does not track; Branch does both.
  assert.match(device, /Linked to the user's identity\? \*\*Yes\*\* \(because of @segment\/analytics-react-native, react-native-branch\)/);
  assert.match(device, /Used for tracking\? \*\*Yes\*\* \(because of react-native-branch\)/);
  assert.match(md, /## Only if you use these features[\s\S]*User ID/);
  assert.match(md, /App Tracking Transparency/);
  const all = run(dir, 'report', '-f', 'appstore', '--include-conditional').stdout;
  assert.match(all, /### User ID/);
  assert.doesNotMatch(all, /## Only if you use these features/);
  assert.equal(run(dir, 'report', '-f', 'nope').status, 2);
});

test('report --format inventory: data, services and purposes in plain words', () => {
  const md = run(ascFixture(), 'report', '--format', 'inventory').stdout;
  assert.match(md, /^# Data inventory/);
  assert.match(md, /\| Email address \| App features \| Sign-in \| iOS, Android \| Yes \| No \| No \|/);
  assert.match(md, /\| Segment \| `@segment\/analytics-react-native` \|/);
  assert.match(md, /## Collected by your own app[\s\S]*\*\*Sign-in\*\*: Email address/);
  assert.doesNotMatch(md, /\| Sign-in \| `/, 'the app itself is not a third party');
  assert.doesNotMatch(md, /Third-party advertising|Advertising or marketing/, 'one set of purpose words');
});

test('rule freshness: manifest summaries, tarballs and changes', async () => {
  const fresh = await import('../scripts/rule-freshness.mjs');
  const xml = libManifest('<key>NSPrivacyTracking</key><true/><key>NSPrivacyTrackingDomains</key><array><string>b.example</string><string>a.example</string></array>');
  const s = fresh.summarizeManifest(xml);
  assert.deepEqual(s, { tracking: true, domains: ['a.example', 'b.example'], collected: [] });
  assert.deepEqual(fresh.summarizeManifest('nope'), { invalid: true });
  assert.equal(fresh.rawGithubUrl('https://github.com/a/b/blob/main/x/PrivacyInfo.xcprivacy'), 'https://raw.githubusercontent.com/a/b/main/x/PrivacyInfo.xcprivacy');

  const dir = fixture('tgz');
  write(dir, { 'package/ios/PrivacyInfo.xcprivacy': xml, 'package/index.js': '' });
  execFileSync('tar', ['-czf', 'pkg.tgz', 'package'], { cwd: dir });
  const files = fresh.readTarGz(fs.readFileSync(path.join(dir, 'pkg.tgz')), (n) => path.basename(n) === 'PrivacyInfo.xcprivacy');
  assert.deepEqual(Object.keys(files), ['ios/PrivacyInfo.xcprivacy']);

  const base = { manifests: { k: { rule: 'X', source: 'npm:x', version: '1.0.0', summary: s } } };
  assert.deepEqual(fresh.compare(base, { manifests: { k: { ...base.manifests.k } }, checked: ['npm:x'] }), []);
  const changed = fresh.compare(base, { manifests: { k: { rule: 'X', source: 'npm:x', version: '2.0.0', summary: { ...s, domains: ['a.example'], tracking: false } } }, checked: ['npm:x'] });
  assert.equal(changed.length, 1);
  assert.match(changed[0].text, /NSPrivacyTracking: true → false/);
  assert.match(changed[0].text, /- tracking domain b\.example/);
  assert.deepEqual(fresh.compare(base, { manifests: {}, checked: ['npm:x'] }).map((c) => c.kind), ['removed']);
  assert.deepEqual(fresh.compare(base, { manifests: {}, checked: [] }), [], 'a failed download is not a removal');
  const baseline = JSON.parse(fs.readFileSync(fresh.BASELINE, 'utf8'));
  assert.ok(Object.keys(baseline.manifests).length >= 10, 'the committed baseline covers the vendor manifests');
});

const plistXml = (dict) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>${Object.entries(dict).map(([k, v]) => `<key>${k}</key>${typeof v === 'string' && !v.startsWith('<') ? `<string>${v}</string>` : v}`).join('')}</dict></plist>`;

test('purpose strings: requests in code and binaries need Info.plist keys (ITMS-90683)', () => {
  const hits = api.findPurposeUses(`
    [CLLocationManager new]; // requestAlwaysAuthorization in a comment does not count
    [self.manager requestWhenInUseAuthorization];
    [AVCaptureDevice requestAccessForMediaType:AVMediaTypeVideo completionHandler:^(BOOL g){}];
    let store = CNContactStore()
    UIImagePickerController *p; // only a class: no photo library request
  `).map((h) => h.key);
  assert.deepEqual(hits.sort(), ['NSCameraUsageDescription', 'NSContactsUsageDescription', 'NSLocationWhenInUseUsageDescription']);
  const bin = Buffer.concat([Buffer.from('\0requestAccessForMediaType:completionHandler:\0\0_AVMediaTypeAudio\0\0requestAlwaysAuthorization\0', 'latin1')]);
  assert.deepEqual(api.findPurposeUsesInBinary(bin).map((h) => h.key).sort(), ['NSLocationAlwaysAndWhenInUseUsageDescription', 'NSLocationWhenInUseUsageDescription', 'NSMicrophoneUsageDescription']);

  const dir = fixture('purpose');
  write(dir, {
    'package.json': { name: 'App', dependencies: { 'react-native': '0.76.0', 'cam-lib': '1.0.0', 'react-native-permissions': '5.0.0', 'face-lib': '1.0.0' } },
    'node_modules/cam-lib/package.json': { name: 'cam-lib', version: '1.0.0' },
    'node_modules/cam-lib/cam-lib.podspec': '',
    'node_modules/cam-lib/ios/Cam.m': '[AVCaptureDevice requestAccessForMediaType:AVMediaTypeVideo completionHandler:nil];\n[AVAudioSession.sharedInstance requestRecordPermission:^(BOOL g){}];',
    'node_modules/face-lib/package.json': { name: 'face-lib', version: '1.0.0' },
    'node_modules/face-lib/face-lib.podspec': '',
    'node_modules/face-lib/ios/F.m': '[ctx evaluatePolicy:LAPolicyDeviceOwnerAuthenticationWithBiometrics localizedReason:@"x" reply:nil];',
    'node_modules/react-native-permissions/package.json': { name: 'react-native-permissions', version: '5.0.0' },
    'node_modules/react-native-permissions/RNPermissions.podspec': '',
    'node_modules/react-native-permissions/ios/Contacts/RNPermissionHandlerContacts.mm': 'CNContactStore *s;',
    'node_modules/react-native-permissions/ios/Motion/RNPermissionHandlerMotion.mm': 'CMMotionActivityManager *m;',
    'ios/Podfile': "setup_permissions([\n  'Motion',\n  # 'Contacts',\n])\ntarget 'App' do\nend\n",
    'ios/App.xcodeproj/project.pbxproj': '',
    'ios/App/Info.plist': plistXml({ CFBundleExecutable: 'App', NSCameraUsageDescription: 'Scan receipts', NSMicrophoneUsageDescription: '' }),
  });
  const r = run(dir, 'check', '--format', 'json');
  const j = JSON.parse(r.stdout);
  const by = Object.fromEntries(j.purposeStrings.map((p) => [p.key, p]));
  assert.equal(by.NSCameraUsageDescription.status, 'ok');
  assert.equal(by.NSMicrophoneUsageDescription.status, 'empty');
  assert.equal(by.NSMotionUsageDescription.status, 'missing', 'enabled react-native-permissions handler');
  assert.equal(by.NSContactsUsageDescription, undefined, 'handler commented out in setup_permissions');
  assert.equal(by.NSFaceIDUsageDescription.runtimeOnly, true);
  assert.equal(j.ok, false);
  assert.equal(r.status, 1);
  const text = run(dir, 'check');
  assert.match(text.stderr, /NSMotionUsageDescription \(Motion and fitness\) is missing from ios\/App\/Info\.plist, asked for by react-native-permissions\. App Store Connect rejects this \(ITMS-90683\)/);
  assert.match(text.stderr, /NSMicrophoneUsageDescription .* is empty/);
  assert.match(text.stdout, /NSFaceIDUsageDescription .* iOS refuses the feature without it/);
  assert.match(text.stderr, /Add the missing purpose strings to Info\.plist/);

  // Fill them in: only Face ID (runtime only) is left, and it does not fail the check.
  write(dir, { 'ios/App/Info.plist': plistXml({ CFBundleExecutable: 'App', NSCameraUsageDescription: 'a', NSMicrophoneUsageDescription: 'b', NSMotionUsageDescription: 'c' }) });
  const ok = JSON.parse(run(dir, 'check', '--format', 'json').stdout);
  assert.ok(ok.purposeStrings.every((p) => p.status === 'ok' || p.runtimeOnly));
  assert.equal(ok.manifests.length, 0);
});

test('purpose strings in Expo: app.json infoPlist and the config plugins that add them', () => {
  const dir = fixture('purpose-expo');
  write(dir, {
    'package.json': { name: 'App', dependencies: { expo: '54.0.0', 'expo-camera': '17.0.0', 'expo-tracking-transparency': '6.0.0', 'ble-lib': '1.0.0', 'loc-lib': '1.0.0' } },
    'app.json': { expo: { name: 'App', plugins: ['rn-privacy', 'loc-lib'], ios: { infoPlist: { NSBluetoothAlwaysUsageDescription: 'Connect to your scale' } } } },
    'node_modules/expo/package.json': { name: 'expo', version: '54.0.0' },
    ...Object.fromEntries([
      ['expo-camera', '[AVCaptureDevice requestAccessForMediaType:AVMediaTypeVideo completionHandler:nil];'],
      ['expo-tracking-transparency', '[ATTrackingManager requestTrackingAuthorizationWithCompletionHandler:nil];'],
      ['ble-lib', 'CBCentralManager *m;'],
      ['loc-lib', '[m requestWhenInUseAuthorization];'],
    ].flatMap(([name, code]) => [
      [`node_modules/${name}/package.json`, { name, version: '1.0.0' }],
      [`node_modules/${name}/${name}.podspec`, ''],
      [`node_modules/${name}/ios/X.m`, code],
    ])),
  });
  const j = JSON.parse(run(dir, 'check', '--format', 'json').stdout);
  const by = Object.fromEntries(j.purposeStrings.map((p) => [p.key, p]));
  assert.equal(by.NSCameraUsageDescription.status, 'by-plugin', 'expo-camera adds it even when not listed');
  assert.equal(by.NSCameraUsageDescription.plugin, 'expo-camera');
  assert.equal(by.NSUserTrackingUsageDescription.status, 'missing', 'expo-tracking-transparency only adds it when listed');
  assert.equal(by.NSBluetoothAlwaysUsageDescription.status, 'ok');
  assert.equal(by.NSLocationWhenInUseUsageDescription.status, 'by-plugin', 'the library\'s own plugin is listed');
  assert.equal(j.ok, false);
});

test('app code, Expo local modules and app extensions are scanned', () => {
  const dir = fixture('native');
  write(dir, {
    'package.json': { name: 'App', dependencies: { 'react-native': '0.76.0' } },
    'modules/secure-store/expo-module.config.json': { platforms: ['apple'] },
    'modules/secure-store/ios/SecureStore.swift': 'let t = ProcessInfo.processInfo.systemUptime',
    'ios/App.xcodeproj/project.pbxproj': '',
    'ios/App/Info.plist': plistXml({ CFBundleExecutable: 'App' }),
    'ios/App/AppDelegate.swift': 'UserDefaults.standard.bool(forKey: "x")',
    'ios/App/PrivacyInfo.xcprivacy': manifestXml([['NSPrivacyAccessedAPICategoryUserDefaults', 'CA92.1'], ['NSPrivacyAccessedAPICategorySystemBootTime', '35F9.1']]),
    'ios/Widget/Info.plist': plistXml({ NSExtension: '<dict><key>NSExtensionPointIdentifier</key><string>com.apple.widgetkit-extension</string></dict>' }),
    'ios/Widget/Widget.swift': 'let free = try url.resourceValues(forKeys: [.volumeAvailableCapacityKey])',
    'ios/Widget/PrivacyInfo.xcprivacy': manifestXml([['NSPrivacyAccessedAPICategoryUserDefaults', 'CA92.1']]),
    'ios/Notify/Info.plist': plistXml({ NSExtension: '<dict><key>NSExtensionPointIdentifier</key><string>com.apple.usernotifications.service</string></dict>' }),
    'ios/Notify/N.swift': 'class N {}',
    'ios/Podfile': "target 'App' do\nend\ntarget 'Notify' do\n  pod 'PushKit'\nend\n",
    'ios/Pods/PushKit/PushKit.framework/PushKit': Buffer.concat([Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), Buffer.alloc(60), Buffer.from('\0_OBJC_CLASS_$_NSUserDefaults\0')]).toString('latin1'),
  });
  // write() stores strings as utf8: rewrite the binary as bytes.
  fs.writeFileSync(path.join(dir, 'ios/Pods/PushKit/PushKit.framework/PushKit'), Buffer.concat([Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), Buffer.alloc(60), Buffer.from('\0_OBJC_CLASS_$_NSUserDefaults\0')]));
  const scan = scanProject(dir);
  const names = scan.packages.map((p) => p.name);
  assert.ok(names.includes('modules/secure-store (local module)'));
  assert.ok(names.includes('your app (ios)'));
  assert.deepEqual(scan.extensions.map((e) => e.name).sort(), ['Notify', 'Widget']);
  const a = analyze(scan);
  assert.deepEqual(a.apis.find((x) => x.category === 'NSPrivacyAccessedAPICategorySystemBootTime').packages, ['modules/secure-store (local module)']);
  assert.ok(!a.apis.some((x) => x.category === 'NSPrivacyAccessedAPICategoryDiskSpace'), 'extension code is not in the app manifest');
  assert.equal(scan.packages.find((p) => p.name === 'your app (ios)').shipsManifest.length, 0, 'the app manifest is not read as a library manifest');

  const j = JSON.parse(run(dir, 'check', '--format', 'json').stdout);
  assert.equal(j.manifests[0].label, path.join('ios', 'App', 'PrivacyInfo.xcprivacy'), 'the app manifest, not an extension\'s');
  const ext = Object.fromEntries(j.extensions.map((e) => [e.name, e]));
  assert.equal(ext.Widget.status, 'missing-apis');
  assert.deepEqual(ext.Widget.missingApis.map((m) => m.label), ['Disk space']);
  assert.equal(ext.Notify.status, 'missing', 'its pod has no manifest and uses user defaults');
  assert.deepEqual(ext.Notify.missingApis[0].packages, ['PushKit (CocoaPods)']);

  const w = run(dir, 'ios', '--write');
  assert.equal(w.status, 0, w.stderr);
  assert.match(w.stdout, /add it to the Notify target/);
  assert.match(fs.readFileSync(path.join(dir, 'ios/Widget/PrivacyInfo.xcprivacy'), 'utf8'), /DiskSpace[\s\S]*E174\.1/);
  const after = JSON.parse(run(dir, 'check', '--format', 'json').stdout);
  assert.ok(after.extensions.every((e) => e.status === 'ok'));
  assert.equal(after.ok, true);
});

test('podfile parsing: targets and react-native-permissions', () => {
  const targets = api.podfileTargets("target 'App' do\n  pod 'A'\n  target 'AppTests' do\n    inherit! :search_paths\n  end\nend\ntarget 'Ext' do\n  pod 'B/Core', '1.0'\n  [1].each do |x|\n  end\n  pod 'C'\nend\n");
  assert.deepEqual(Object.fromEntries(targets), { App: ['A'], AppTests: [], Ext: ['B', 'C'] });
  assert.deepEqual([...api.podfilePermissions("setup_permissions(['Camera', \"Motion\"])")].sort(), ['Camera', 'Motion']);
  assert.equal(api.podfilePermissions('target "x" do end'), null);
});

test('why: explains APIs, purpose strings, data, permissions and packages', () => {
  const dir = fixture('why');
  write(dir, {
    'package.json': { name: 'App', dependencies: { 'native-lib': '1.0.0', '@sentry/react-native': '6.0.0' } },
    'node_modules/native-lib/package.json': { name: 'native-lib', version: '1.2.3' },
    'node_modules/native-lib/native-lib.podspec': '',
    'node_modules/native-lib/ios/A.m': 'struct statfs s; statfs("/", &s);\n[m requestWhenInUseAuthorization];',
    'node_modules/native-lib/android/src/main/AndroidManifest.xml': '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><uses-permission android:name="android.permission.CAMERA"/></manifest>',
    'node_modules/@sentry/react-native/package.json': { name: '@sentry/react-native', version: '6.0.0' },
  });
  const api1 = run(dir, 'why', 'Disk', 'space');
  assert.equal(api1.status, 0);
  assert.match(api1.stdout, /native-lib@1\.2\.3\n\s+code node_modules\/native-lib\/ios\/A\.m: statfs/);
  assert.match(run(dir, 'why', 'NSLocationWhenInUseUsageDescription').stdout, /ITMS-90683/);
  assert.match(run(dir, 'why', 'crash data').stdout, /@sentry\/react-native[\s\S]*rn-privacy's rule for Sentry/);
  assert.match(run(dir, 'why', 'CAMERA').stdout, /native-lib[\s\S]*AndroidManifest\.xml/);
  assert.match(run(dir, 'why', 'native-lib').stdout, /uses Disk space[\s\S]*needs NSLocationWhenInUseUsageDescription[\s\S]*adds the Android permission CAMERA/);
  const json = JSON.parse(run(dir, 'why', 'Disk space', '--format', 'json').stdout);
  assert.equal(json.matches[0].kind, 'api');
  const none = run(dir, 'why', 'nothing-like-this');
  assert.equal(none.status, 1);
  assert.match(none.stdout, /Nothing matches/);
  assert.equal(run(dir, 'why').status, 2);
});

test('snapshot and diff include purpose strings, and old snapshots do not flag them all', () => {
  const dir = fixture('snap-purpose');
  write(dir, {
    'package.json': { name: 'App', dependencies: { 'loc-lib': '1.0.0' } },
    'node_modules/loc-lib/package.json': { name: 'loc-lib', version: '1.0.0' },
    'node_modules/loc-lib/loc-lib.podspec': '',
    'node_modules/loc-lib/ios/L.m': '[m requestWhenInUseAuthorization];',
  });
  run(dir, 'snapshot');
  const snap = JSON.parse(fs.readFileSync(path.join(dir, 'privacy-snapshot.json'), 'utf8'));
  assert.deepEqual(snap.purposeStrings, { NSLocationWhenInUseUsageDescription: ['loc-lib'] });
  write(dir, { 'node_modules/loc-lib/ios/L.m': '[m requestWhenInUseAuthorization];\n[m requestAlwaysAuthorization];' });
  assert.match(run(dir, 'diff').stdout, /Info\.plist purpose strings[\s\S]*\+ NSLocationAlwaysAndWhenInUseUsageDescription/);
  delete snap.purposeStrings;
  fs.writeFileSync(path.join(dir, 'privacy-snapshot.json'), JSON.stringify(snap));
  assert.doesNotMatch(run(dir, 'diff').stdout, /purpose strings/);
});

test('rules: Firebase products, Stripe, Google Maps and Google Sign-In', () => {
  for (const pkg of ['@react-native-firebase/firestore', '@react-native-firebase/remote-config', '@react-native-firebase/app-check', '@react-native-firebase/in-app-messaging', '@react-native-firebase/storage', '@react-native-firebase/database', '@react-native-firebase/functions', '@stripe/stripe-react-native', 'react-native-maps', '@react-native-google-signin/google-signin']) {
    const rule = findRule(pkg);
    assert.ok(rule, pkg);
    assert.ok(rule.sources.length && rule.sources.every((s) => s.startsWith('https://')), pkg);
  }
  assert.ok(findRule('react-native-maps').collects.filter((c) => c.type !== 'precise-location').every((c) => c.conditional), 'Google data only with the Google provider');
  assert.equal(findRule('@stripe/stripe-react-native').android, undefined, 'no Play guidance from Stripe');
});
