# rn-privacy

[![npm](https://img.shields.io/npm/v/rn-privacy)](https://www.npmjs.com/package/rn-privacy)
[![test](https://github.com/yogesh2902/rn-privacy/actions/workflows/test.yml/badge.svg)](https://github.com/yogesh2902/rn-privacy/actions/workflows/test.yml)
[![license](https://img.shields.io/npm/l/rn-privacy)](LICENSE)

**Privacy manifest and store privacy forms for React Native and Expo apps, generated from your dependencies.**

Every iOS release needs a correct `PrivacyInfo.xcprivacy`, and both stores ask what data your app collects
(App Store Connect **App Privacy**, Google Play **Data safety**). Most of that data is collected by your
libraries (Firebase, Sentry, AdMob...), not by your own code. `rn-privacy` scans them and tells you what to declare.

```bash
npx rn-privacy init --write  # set everything up: Expo plugin or manifest, snapshot, GitHub workflow
npx rn-privacy            # what your libraries collect and which Apple APIs they use
npx rn-privacy ios --write  # update PrivacyInfo.xcprivacy (bare) or app.json (Expo)
npx rn-privacy report -o store-privacy.md  # answers for both store forms
npx rn-privacy report -f appstore  # App Store Connect's App Privacy form, step by step
npx rn-privacy report -f inventory  # what is collected, by whom and why, for your privacy policy
npx rn-privacy play data_safety.csv -o filled.csv  # fill Google Play's Data safety CSV
npx rn-privacy check      # for CI: fails if the manifest is missing something or invalid
npx rn-privacy audit      # problems in the privacy manifests your libraries ship
npx rn-privacy diff       # privacy changes since your committed privacy-snapshot.json
```

**Expo?** Add the config plugin and the manifest is generated on every prebuild, so it never falls behind:

```json
{ "expo": { "plugins": ["rn-privacy"] } }
```

**GitHub?** Add the action and every pull request shows what its libraries need (see [GitHub Action](#github-action)).

## What it does

- **Finds Apple "required reason" APIs** (User defaults, File timestamps, System boot time, Disk space,
  Active keyboards) by scanning the iOS source code of every native dependency, the prebuilt binaries
  (`.xcframework`, `.framework`, `.a`) closed-source SDKs ship, and the privacy manifests libraries include.
  Missing these gets your upload rejected (`ITMS-91053`).
- **Knows what popular SDKs collect** (Firebase, Sentry, AdMob, Meta, Mixpanel, Amplitude, PostHog,
  Segment, RevenueCat, OneSignal, AppsFlyer, Branch, Adjust, Singular, CleverTap, MoEngage, Braze, Klaviyo,
  Intercom, Luciq/Instabug, LogRocket, Microsoft Clarity, BugSnag, Datadog...) and maps it to both Apple's
  and Google's categories. Rules come from each vendor's own privacy manifest or documentation.
- **Lists Android permissions** your libraries and your app add (location, camera, contacts, the Advertising
  ID...), including those from Gradle dependencies once you have built the app, for the Data safety form.
- **Shows privacy changes in pull requests.** Commit `privacy-snapshot.json` and `diff` tells reviewers when a
  dependency change needs a new declaration.
- **Reads `ios/Pods`** after `pod install`, so the native SDKs that CocoaPods downloads are covered too.
- **Reads Swift packages** you add in Xcode (from `Package.resolved` and the copies Xcode downloads).
- **Takes your own rules** for in-house or private SDKs and for data your app itself collects, in
  `rn-privacy.config.json`.
- **Merges, never overwrites.** Existing entries in your manifest are kept; it only adds what is missing.
  Dry run by default.
- **Catches invalid manifests.** `check` validates every key, value type, reason code and data type against
  Apple's lists, so you find problems before App Store Connect rejects them (`ITMS-91056`).
- **Fills in Google Play's Data safety form.** Export the form to CSV in Play Console, run `rn-privacy play`
  on it, and import the filled file.
- **Audits your libraries.** `audit` validates the privacy manifest every library ships, and finds libraries
  that use required reason APIs without declaring them, with a link to report each problem to the maintainer.
- **Handles tracking domains.** It collects the `NSPrivacyTrackingDomains` your SDKs declare, and
  `ios --write --tracking` declares them in your app when you use App Tracking Transparency.
- **Works with Expo.** In a managed project it updates `expo.ios.privacyManifests` in `app.json`
  (or prints the snippet if you use `app.config.js`).

## Example

```
$ npx rn-privacy
rn-privacy scan  (bare, 12 packages, 10 with iOS native code)

Required reason APIs (Apple privacy manifest)
  User defaults      CA92.1
                     used by @react-native-firebase/app, react-native, react-native-device-info
  File timestamps    3B52.1, C617.1
                     used by @react-native-async-storage/async-storage, react-native, react-native-fs
  Disk space         85F4.1
                     used by react-native-device-info, react-native-fs

Data collected by your libraries
  Device ID              Analytics, Third-party advertising (tracking)
                         by @react-native-firebase/analytics, react-native-google-mobile-ads
  Crash data             App functionality, Analytics
                         by @sentry/react-native, react-native-google-mobile-ads
  User ID                App functionality (linked to user)
                         @sentry/react-native: Only if you call Sentry.setUser()

Sensitive data your app can read
  Declare it only if your app sends it off the device.
  Photos or videos       via react-native-image-picker
```

## Commands

| Command | What it does |
| --- | --- |
| `init` | Sets a project up: adds the Expo plugin to `app.json` (or writes `PrivacyInfo.xcprivacy` in a bare app), creates `rn-privacy.config.json`, `privacy-snapshot.json` and a GitHub workflow. Dry run unless `--write`. It never overwrites a file: running it again only reports what is already set up. |
| `scan` (default) | Prints required reason APIs, collected data, sensitive device access and warnings. `--format json` for machines. |
| `ios` | Shows what it would add to your manifest. `--write` saves it. `--include-conditional` also declares data that is only collected in some setups (e.g. after `Sentry.setUser()`). `--tracking` sets `NSPrivacyTracking` and adds your libraries' tracking domains. |
| `report` | Markdown (or `--format json`) with tables for App Store Connect and Google Play. `--format appstore`: the App Privacy answers in the order App Store Connect asks for them. `--format inventory`: the data, services and purposes for your privacy policy. `-o file.md` to save. |
| `play <file.csv>` | Fills in the Data safety CSV exported from Play Console. Dry run unless `-o filled.csv`. `--include-conditional` as for `ios`. |
| `check` | `--format json` for CI tools. Exit code 1 if a required reason API category is missing from your manifest, or if the manifest is invalid (unknown reason codes, SDK-only reasons, wrong value types). Warns about undeclared data. In an Expo project with an `ios` folder, it checks both `app.json` and the generated `PrivacyInfo.xcprivacy`, so a stale prebuild is caught too. |
| `audit` | Checks the privacy manifests your libraries ship: invalid files, missing manifests, missing categories, tracking. `--suggest` writes a fixed manifest and an issue text for each library. `--strict` exits with code 1 on a problem. `--format json` for machines. |
| `snapshot` | Writes `privacy-snapshot.json`: required reason APIs, collected data, tracking domains, Android permissions and native library versions. Commit it. |
| `diff` | Privacy changes since the snapshot. `--base origin/main` compares with the snapshot on another branch. `--strict` exits with code 1 on a change. `--format json`. |

All commands accept `--project <dir>` (default: current folder).

### Audit your libraries

```
$ npx rn-privacy audit
rn-privacy audit  (18 native libraries, 6 ship a privacy manifest)

✗ Invalid privacy manifest (1)
  Apple may reject or ignore these files.
  some-analytics-sdk@2.4.0
    ios/PrivacyInfo.xcprivacy: "App Name" is not a valid collected data type.
    Report it: https://github.com/acme/some-analytics-sdk/issues

! Uses required reason APIs without a privacy manifest (1)
  some-file-library@2.20.0  File timestamps, Disk space
    found in FileManager.m (NSFileCreationDate), FileManager.m (NSFileSystemSize)
    Report it: https://github.com/acme/some-file-library/issues
```

rn-privacy already adds everything these libraries use to **your** app's manifest, so your upload is covered.
The audit is about the libraries themselves: reporting a problem fixes it for every app that uses them.
Results come from static analysis, so look at the file before you open an issue.

### Privacy changes in pull requests

```bash
npx rn-privacy snapshot   # writes privacy-snapshot.json: commit it
```

The snapshot lists what your dependencies need. It has no dates or paths, so it only changes when something
real changes. When a pull request adds or updates a library, run `rn-privacy diff`:

```
rn-privacy diff  (against privacy-snapshot.json)

Required reason APIs (Apple privacy manifest)
  + Disk space               react-native-fs

Android permissions
  + Photos                   react-native-image-picker

Native libraries
  ~ @sentry/react-native     6.0.0 → 6.1.0
  + react-native-fs          2.20.0
```

Update your manifest and store answers, then run `rn-privacy snapshot` again and commit it: reviewers see the
privacy impact in the snapshot's diff. `rn-privacy diff --base origin/main` compares with the snapshot on another
branch. The GitHub Action shows the diff in the job summary and warns when the snapshot is out of date.

### Google Play: Android SDKs collect different data

SDKs can collect different data on Android than on iOS. For example, ad and attribution SDKs read the Android
Advertising ID, and some vendors say their data is **shared** rather than only collected. Where the vendor
publishes a Google Play Data safety disclosure (Firebase, AdMob, AppsFlyer, Adjust, Branch, OneSignal, RevenueCat,
Braze, CleverTap, MoEngage, BugSnag, Microsoft Clarity, Singular, Luciq), the Play answers in `report` and `play` come from it, with Play's own purposes such as
Fraud prevention and Developer communications, and data the vendor calls shared is marked as shared. For the
others, the answer comes from the iOS disclosure and the report marks it with †. When a vendor does not say why it
collects something, rn-privacy leaves the purpose for you to choose instead of guessing.

As of November 2026, Sentry, Datadog, LogRocket, Segment (for the Kotlin SDK React Native uses), Mixpanel,
Amplitude, PostHog, Klaviyo, Meta, Intercom and Expo publish no Play Data safety guidance for their Android SDKs.
If you know what one of them collects in your setup, describe it in [your own rules](#your-own-rules).
CocoaPods and Swift packages are only in the iOS app, so they are left out of the Play answers.

### Your own rules

rn-privacy only knows public SDKs. Add `rn-privacy.config.json` next to your `package.json` to describe
anything else: in-house SDKs (npm packages, CocoaPods pods or Swift packages), a public SDK set up differently
from the default (your rule replaces the built-in one), and data your app itself collects, such as the email
address your sign-in sends to your backend (a rule without `packages`).

```json
{
  "$schema": "./node_modules/rn-privacy/config.schema.json",
  "rules": [
    {
      "name": "Acme Analytics",
      "packages": ["@acme/analytics-react-native", "AcmeAnalytics"],
      "collects": [
        { "type": "device-id", "purposes": ["analytics"], "linked": false, "tracking": false },
        { "type": "user-id", "purposes": ["analytics"], "linked": true, "tracking": false, "conditional": "Only after login" }
      ],
      "android": {
        "collects": [{ "type": "device-id", "purposes": ["analytics", "fraud-prevention"], "shared": false }]
      },
      "sources": ["https://wiki.example.com/acme-analytics/privacy"]
    },
    {
      "name": "Sign-in",
      "collects": [{ "type": "email", "purposes": ["app-functionality"], "linked": true, "tracking": false }],
      "android": { "collects": [{ "type": "email", "purposes": ["account-management"] }] }
    }
  ]
}
```

- `collects` uses Apple's terms and also feeds the Play answers, unless you add `android` with Play's purposes
  (`app-functionality`, `analytics`, `developer-communications`, `advertising`, `fraud-prevention`,
  `personalization`, `account-management`) and `shared`.
- `"collects": []` says a package collects nothing. `versions` limits a rule to a semver range.
- The `$schema` line gives you autocomplete and checks in VS Code and other editors. rn-privacy also checks the
  file itself: a misspelled data type, a purpose that does not exist or a missing `linked` stops the command
  with a list of what to fix, and a rule that matches no installed package is reported as a warning.

Required reason APIs are never taken from rules, yours included: they always come from scanning the code.

### Swift packages

Packages you add in Xcode (**File > Add Package Dependencies**) are not in `node_modules` or `ios/Pods`.
rn-privacy reads them from `Package.resolved` in `ios/*.xcworkspace` or `ios/*.xcodeproj`, then scans the copies
Xcode downloaded: the privacy manifests, the source code and binary frameworks, like any other native library.
It finds them in `ios/SourcePackages` (`xcodebuild -clonedSourcePackagesDirPath ios/SourcePackages`),
`ios/build/SourcePackages`, or Xcode's DerivedData folder for the workspace (set `RN_PRIVACY_DERIVED_DATA` if
yours is elsewhere). If they are not downloaded yet, for example on CI, rn-privacy says which packages it could
not scan. To scan them on CI:

```bash
xcodebuild -resolvePackageDependencies -workspace ios/App.xcworkspace -scheme App -clonedSourcePackagesDirPath ios/SourcePackages
```

### Android permissions

`scan` and `report` list the sensitive Android permissions in your app and where each comes from: a library's
`AndroidManifest.xml`, your app's manifest or `expo.android.permissions`, or a Gradle dependency (from the merged
manifest of your last Android build). Permissions you remove with `tools:node="remove"` or
`expo.android.blockedPermissions` are left out. `play` reminds you of the Advertising ID declaration when
`AD_ID` is present.

### Fix your libraries

```bash
npx rn-privacy audit --suggest
```

For each library with a privacy manifest problem, rn-privacy writes a folder in `rn-privacy-suggestions/` with:

- **`PrivacyInfo.xcprivacy`**: the corrected file. Invalid data types, purposes and reasons are removed, the API
  categories the code uses are added, and tracking domains become domain names. It passes the same validation as
  `check`.
- **`ISSUE.md`**: a ready-to-post issue with what was found, where in the code, the suggested file, and links to
  Apple's lists. The output tells you where to post it.

Nothing is guessed. A missing purpose is only filled from rn-privacy's rule for that library (which comes from the
vendor's documentation), and anything rn-privacy cannot know is listed under "Please decide" for the maintainer.

### Tracking

Some SDKs (attribution, ads) declare tracking and tracking domains in their own privacy manifest. Apple blocks
connections to tracking domains when the user has not allowed tracking, and expects your app to declare them.
`rn-privacy scan` lists them. If your app uses App Tracking Transparency:

```bash
npx rn-privacy ios --write --tracking
```

This sets `NSPrivacyTracking` to true and adds every tracking domain your libraries declare. rn-privacy never
turns tracking on without `--tracking`. With the Expo plugin, use `["rn-privacy", { "tracking": true }]`.
`check` warns when tracking is on but a library's tracking domain is missing.

### Set up in one command

```bash
npx rn-privacy init           # shows what it will do
npx rn-privacy init --write   # does it
```

| | Expo | Bare React Native |
| --- | --- | --- |
| Privacy manifest | Adds `"rn-privacy"` to `expo.plugins` in `app.json`, so every prebuild writes it | Creates or updates `ios/<App>/PrivacyInfo.xcprivacy` |
| `rn-privacy.config.json` | Created empty, ready for [your own rules](#your-own-rules) | same |
| `privacy-snapshot.json` | What your dependencies need today, so [pull requests show changes](#privacy-changes-in-pull-requests) | same |
| `.github/workflows/privacy.yml` | The [GitHub Action](#github-action) on every pull request, installing with your package manager (npm, Yarn, pnpm or Bun) and pointing at the app's folder in a monorepo | same |

Files that exist are left alone. `init` then lists what is left: installing `rn-privacy` as a dev dependency
when the Expo plugin needs it, and adding a new manifest to your Xcode target.

### App Store Connect, step by step

`rn-privacy report --format appstore` writes the App Privacy answers in the order App Store Connect asks for them:
whether you collect data, which data types to tick (by category), then for each type the purposes, whether it is
linked to the user, and whether it is used for tracking, naming the library that makes each answer Yes. Data that
is only collected in some setups is listed separately (or included with `--include-conditional`).

### Data inventory for your privacy policy

`rn-privacy report --format inventory` lists each kind of data the app collects, why (in one set of plain words
for both stores), which services receive it with links to their privacy pages, the tracking domains and the
device data the app can access. Hand it to whoever writes your privacy policy. It is facts only, not legal text,
and it says what it cannot know (your servers, data you send to SDKs yourself).

### Google Play Data safety

1. In Play Console, open your app, then **App content > Data safety**, and export the form to CSV.
2. Run:
   ```bash
   npx rn-privacy play data_safety.csv -o filled.csv
   ```
3. Import `filled.csv` on the same page and review it. Importing replaces the answers in the form, so always
   start from a fresh export.

It selects each data type your libraries collect, marks it as collected, and adds the purposes. It only turns
answers on, never off, and leaves every other row as it was, so it works with whatever template version Play
gives you. It lists what only you can answer: whether each data type is optional for users, whether data is
shared, encryption in transit, data deletion, and anything your own code collects.

### Expo config plugin

```bash
npm install --save-dev rn-privacy
```

```json
{
  "expo": {
    "plugins": ["rn-privacy"]
  }
}
```

On every `expo prebuild` (and EAS Build), the plugin scans your dependencies and merges what they need into
`expo.ios.privacyManifests`. Expo then writes `ios/<App>/PrivacyInfo.xcprivacy` from it. Anything you already
declared in `privacyManifests` is kept: the plugin only adds. Pass `["rn-privacy", { "includeConditional": true }]`
to also declare data that is only collected in some setups, and `{ "tracking": true }` if your app tracks users. Tested with Expo SDK 52, 54 and 58.

With the plugin enabled, `rn-privacy check` knows the manifest is generated and passes in a managed project.
If you have an `ios` folder, it checks that folder too and tells you to run `expo prebuild` when it is stale.

### EAS Build

Run `check` inside EAS Build, so every iOS build is checked against the files that actually ship. On iOS, EAS runs
the `eas-build-post-install` hook after `npm install`, `expo prebuild` and `pod install`
([Expo docs](https://docs.expo.dev/build-reference/npm-hooks/)), so `check` sees the generated `ios` folder and
the CocoaPods SDKs. Add it to `package.json`:

```json
{
  "scripts": {
    "eas-build-post-install": "[ \"$EAS_BUILD_PLATFORM\" != \"ios\" ] || npx rn-privacy check"
  }
}
```

The guard skips Android builds and local runs (`EAS_BUILD_PLATFORM` is only set inside EAS). If the manifest is
missing something or is invalid, the iOS build fails with the reason in the build log, before anything is
uploaded. With the Expo config plugin the manifest is regenerated on every build, so this is a safety net.

### JSON output

`scan`, `report`, `audit` and `check` accept `--format json`. `check --format json` prints the full result and
keeps the exit code (0 when everything is covered, 1 otherwise):

```json
{
  "ok": false,
  "projectType": "bare",
  "usesExpoPlugin": false,
  "requiredApis": [{ "category": "NSPrivacyAccessedAPICategoryDiskSpace", "label": "Disk space", "reasons": ["E174.1"], "packages": ["react-native-fs"] }],
  "manifests": [{
    "label": "ios/MyApp/PrivacyInfo.xcprivacy",
    "status": "missing-apis",
    "generated": false,
    "completedByPlugin": false,
    "missingApis": [{ "category": "NSPrivacyAccessedAPICategoryDiskSpace", "label": "Disk space", "packages": ["react-native-fs"] }],
    "errors": [], "warnings": [], "undeclaredData": [], "missingTrackingDomains": []
  }],
  "hint": "Run `rn-privacy ios --write` to fix."
}
```

`status` is one of `ok`, `missing-apis`, `invalid`, `not-generated` or `unreadable`.

### GitHub Action

```yaml
jobs:
  privacy:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write # to comment on pull requests
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - uses: yogesh2902/rn-privacy@v0.4.0
```

It runs `rn-privacy check`, fails the job when the manifest is missing something or is invalid, and shows each
problem as an annotation. On pull requests it posts **one comment** with the result and the privacy changes
since `privacy-snapshot.json`, and updates it on every push. It only comments when the check fails or something
changed, so passing pull requests stay quiet. The job summary also has the library audit and the store privacy
answers.

| Input | Default | |
| --- | --- | --- |
| `project-path` | `.` | Folder with the app's `package.json`. In a monorepo, use one step per app: each gets its own comment. |
| `version` | `latest` | rn-privacy version to run. |
| `fail-on-error` | `true` | Set to `false` to only report. |
| `comment` | `true` | Comment on pull requests. Needs `pull-requests: write`. Pull requests from forks get a read-only token, so the action warns instead. |
| `summary` | `true` | Write the job summary. |
| `annotations` | `true` | Annotate the pull request. |
| `github-token` | `github.token` | Token for the comment. |

Outputs: `result` (`pass` or `fail`), `privacy-changes` (`true` or `false`) and `comment-id`.

### Use it in other CI

```yaml
- run: npm ci
- run: npx rn-privacy check
```

Adding a new library that needs a declaration now fails the build instead of the App Store upload.

**Expo with prebuild:** the privacy manifest in `app.json` only reaches the app when `expo prebuild` writes it
into `ios/`. Run `check` after prebuild in CI to verify what actually ships:

```yaml
- run: npx expo prebuild --platform ios --no-install
- run: npx rn-privacy check
```

## Package managers and monorepos

npm, Yarn (with `node_modules`) and pnpm all work, including workspaces where dependencies are hoisted to the
repository root: run rn-privacy in the app's folder or pass `--project apps/mobile`. Yarn Plug'n'Play is not
supported, because React Native itself needs `nodeLinker: node-modules`.

## How it works

1. Reads the `dependencies` in your `package.json` (not `devDependencies`), plus native packages they pull in
   (Expo autolinking links transitive modules too).
2. Adds the pods in `ios/Pods` and the Swift packages in `Package.resolved`.
3. For each package with iOS native code, scans `.m`, `.mm`, `.swift` and `.h` files (skipping `example/`,
   tests and Android code) for the symbols Apple lists, and parses any `PrivacyInfo.xcprivacy` it ships.
4. Looks the package up in your `rn-privacy.config.json`, then in the [rules database](src/rules.ts), for the
   data it collects, using the rule for the installed version when a library's data collection changed between
   versions.
5. Merges everything into one result.

When a library uses an API but gives no reason, rn-privacy suggests the reason most React Native apps use
(the same ones React Native's own template uses) and marks it **suggested**. Review those: the right reason
depends on what your app does. Reasons Apple only allows for SDKs (`C56D.1`, `0A2A.1`) are never copied
into your app's manifest.

## Limits (please read)

- **It is a starting point, not legal advice.** You are responsible for what you declare.
- It only knows the data collection of libraries in its rules database and [your own rules](#your-own-rules).
  Libraries without a rule are still scanned for required reason APIs, but their data collection is not known.
- It cannot see what **your own code or backend** does with data (for example, sending the user's email
  to your server). Describe it in `rn-privacy.config.json`.
- What an SDK collects depends on its version and your configuration. Every rule links to the vendor's
  disclosure page: `rn-privacy report` lists them at the end. Check them.
- `rn-privacy ios` will not edit a manifest that `check` reports as invalid. Fix those entries by hand first:
  it only adds entries and never changes or removes yours.
- `NSPrivacyTracking` and `NSPrivacyTrackingDomains` are only switched on with `--tracking`.
- Prebuilt binaries are searched for the exact names of the required reason APIs. Binaries over 300 MB are
  skipped with a warning. Static analysis can miss dynamic calls or report code that never runs.
- Android permissions added by Gradle dependencies only appear after you build the Android app once.

## Contributing rules

The rules database is the most valuable part of this project. To add or fix a library, edit
[`src/rules.ts`](src/rules.ts), link the vendor's official disclosure page or its published `PrivacyInfo.xcprivacy` in `sources`, and run
`npm test`. Only add what the source says. If the vendor publishes a Google Play Data safety disclosure for its
Android SDK, add it under `android` with Play's purposes and `shared` where the vendor says so.

A weekly workflow ([`rule-freshness.yml`](.github/workflows/rule-freshness.yml)) downloads the newest version
of every SDK with a rule and the manifests the rules link to on GitHub, and compares them with
[`scripts/rules-baseline.json`](scripts/rules-baseline.json). When a vendor changes what it declares, or a vendor
link disappears, it opens an issue. After reviewing the rule, run `node scripts/rule-freshness.mjs --update` and
commit the baseline.

Required reason APIs are never taken from rules: they come from scanning the installed code, so they always
match the version you have. Rules only describe **data collection**. If that changed between versions of a
library, add one rule per range with `versions` (a semver range such as `">=6.0.0"` or `"^5.2.0 || ^6.0.0"`).
The first rule whose range matches the installed version is used, and a rule without `versions` is the fallback.

## License

MIT
