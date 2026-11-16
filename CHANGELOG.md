# Changelog

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
