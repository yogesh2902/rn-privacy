# Changelog

## 0.4.0
- **10 more SDK rules**, each from the vendor's own source: CleverTap, Braze, Klaviyo, Adjust, Singular and
  Intercom (from the privacy manifests they publish), MoEngage (manifests and docs), Microsoft Clarity,
  LogRocket and Luciq/Instabug (vendor docs; what the docs leave out is stated in the rule's notes).
- **Prebuilt binaries are scanned.** Closed-source SDKs (`.xcframework`, `.framework`, `.a`) in node_modules and
  `ios/Pods` are searched for the exact symbol names of the required reason APIs. Works on Linux CI too.
- **Android permissions.** `scan`, `report`, `play` and JSON list sensitive permissions from library manifests,
  your app's manifest, `expo.android.permissions` and the merged manifest of your last build, minus those you
  remove. `play` reminds you of the Advertising ID declaration.
- **`snapshot` and `diff`:** commit `privacy-snapshot.json`, and `diff` shows new APIs, data, tracking domains,
  permissions and library versions. `--base <git ref>`, `--strict`, `--format json`. The GitHub Action shows the
  diff in the job summary.
- **`audit --suggest`:** for each library with a problem, a corrected `PrivacyInfo.xcprivacy` (it passes
  validation) and a ready-to-post `ISSUE.md` with the findings, evidence and Apple's lists. Nothing is guessed:
  open questions are listed for the maintainer.
- **Pull request comments:** the GitHub Action posts the result and the privacy diff as one comment per app,
  updated on every push, only when the check fails or something changed. New outputs `privacy-changes` and
  `comment-id`.
- **pnpm and monorepos:** verified with real pnpm installs (including transitive Expo modules) and npm workspaces
  with hoisted dependencies. Yarn Plug'n'Play gets one clear message (React Native needs `nodeLinker: node-modules`).
- **Android data collection for SDKs:** rules can describe the Android SDK from the vendor's Google Play Data
  safety disclosure, with Play's purposes (including Fraud prevention and Developer communications) and whether
  the data is shared. Added for Firebase (Analytics, Crashlytics, Messaging, Performance, Auth), AdMob, AppsFlyer,
  Adjust, Branch, OneSignal, RevenueCat, Braze, CleverTap and MoEngage. `report` gets a Shared column and marks
  answers derived from iOS with †; `play` ticks "shared" and the sharing purposes, and leaves purposes the vendor
  does not state for you to choose.
- **Your own rules in `rn-privacy.config.json`:** describe in-house or private SDKs (npm packages, CocoaPods pods
  or Swift packages), replace a built-in rule, or declare data your app itself collects (a rule without
  `packages`). The file is checked strictly, with a fix for each problem, and `config.schema.json` gives editors
  autocomplete. Rules that match no installed package are reported.
- **Swift Package Manager:** packages added in Xcode are read from `Package.resolved` (formats 1 to 3) and scanned
  from `ios/SourcePackages`, `ios/build/SourcePackages` or Xcode's DerivedData: privacy manifests, source code and
  binary targets. `audit` covers them and links their issue trackers, and the snapshot records their versions.
  Packages that are not downloaded yet are named in a warning.
- **Play disclosures for BugSnag, Microsoft Clarity, Singular and Luciq.** The other SDKs without one were checked:
  their vendors publish no Play Data safety guidance, so their answers stay derived from iOS (marked †).
- CocoaPods pods and Swift packages no longer add iOS-only data to the Google Play answers.
- **Releases publish from GitHub** with npm trusted publishing, so packages carry a provenance statement
  (see RELEASING.md).
- SDK tracking domains are normalized to domain names (Adjust lists URLs). The CLI reads its version from
  package.json.

## 0.3.0
- **`rn-privacy audit`:** checks the privacy manifests your libraries ship. It finds invalid manifests (made-up
  data types, empty purposes, unreadable files), libraries that use required reason APIs without a manifest,
  and manifests that miss categories the code uses, with a link to each library's issue tracker. `--strict`
  exits with code 1 on a problem. `scan` and `report` summarize it, and the GitHub Action adds it to the job summary.
- **Tracking domains:** rn-privacy reads `NSPrivacyTracking` and `NSPrivacyTrackingDomains` from your libraries'
  manifests (CocoaPods SDKs included) and lists them in `scan` and `report`. `ios --write --tracking` (or the
  Expo plugin's `{ "tracking": true }`) sets `NSPrivacyTracking` and declares those domains. Tracking is still
  never turned on without asking. `check` warns when tracking is on but a library's domain is missing.
- **`check --format json`:** the full result (status of each manifest, missing APIs, validation errors, undeclared
  data, missing tracking domains, a hint) for CI tools and bots. The exit code is unchanged.
- **EAS Build:** README section on running `check` in the `eas-build-post-install` hook, which on iOS runs after
  prebuild and pod install, so every EAS build is checked against the files that ship.
- Library manifests are validated as SDK manifests, so the SDK-only reasons (`C56D.1`, `0A2A.1`) are allowed there.

## 0.2.0
- **Expo config plugin:** add `"plugins": ["rn-privacy"]` and every prebuild merges what your libraries need
  into `expo.ios.privacyManifests`, so the generated manifest is always current. `check` recognizes the plugin.
  Tested with Expo SDK 52, 54 and 58.
- **GitHub Action:** `uses: yogesh2902/rn-privacy@v0.2.0` runs `check`, annotates the pull request, and writes
  the result and store privacy answers to the job summary.
- Rules: Branch and Segment now follow the privacy manifests those SDKs ship and their current docs. Branch no
  longer claims approximate location, and its device ID is linked and used for tracking. Segment's device ID is
  linked, and advertising data is listed when you use its IDFA plugin. Dead vendor links were replaced.
- `--help` mentions the Expo plugin and the GitHub Action.
- The package is now compiled to CommonJS so the Expo plugin loads on every Node version. `import` and
  `require` both keep working.
- New `play` command: fills in the Google Play Data safety CSV exported from Play Console. It selects the data
  types your libraries collect, marks them as collected, adds purposes, never turns an answer off, keeps the
  file's format, and lists what you still need to answer.
- `check` now validates the manifest against Apple's lists and fails on what App Store Connect rejects with
  ITMS-91056: unknown reason codes, SDK-only reasons (`C56D.1`, `0A2A.1`) in an app, invalid data types or
  purposes, wrong value types, and files that are not valid property lists. Likely mistakes (unknown keys,
  duplicates, tracking domains without `NSPrivacyTracking`) are warnings.
- `ios` refuses to edit an invalid manifest and explains what to fix.

## 0.1.2
- `check` now verifies every manifest your app ships. In an Expo project with an `ios` folder it checks both
  `app.json` and the generated `ios/<App>/PrivacyInfo.xcprivacy`, and tells you when the ios folder is out of
  date and needs `expo prebuild`.
- Rules can target package versions with a semver range (`versions`). The rule that matches the installed
  version is used. Reports show the installed version next to each vendor link.

## 0.1.1
- Add GitHub repository links and more search keywords.

## 0.1.0
- First release: `scan`, `ios`, `report` and `check` commands.
