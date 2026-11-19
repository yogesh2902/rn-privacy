import { satisfies } from './semver.js';
import type { LibraryRule } from './types.js';

/**
 * Known data collection by popular React Native libraries.
 *
 * IMPORTANT: these rules are a starting point, not legal advice. What an SDK
 * collects can change between versions and depends on how you configure it.
 * Every rule links to the vendor's own disclosure page: check it before you
 * submit your app. Pull requests that fix or add rules are welcome.
 */
export const RULES: LibraryRule[] = [
  // ---------------------------------------------------------------- Firebase
  {
    packages: ['@react-native-firebase/analytics'],
    name: 'Firebase Analytics',
    collects: [
      { type: 'device-id', purposes: ['analytics'], linked: false, tracking: false },
      { type: 'product-interaction', purposes: ['analytics'], linked: false, tracking: false },
      { type: 'coarse-location', purposes: ['analytics'], linked: false, tracking: false, conditional: 'Approximate location is derived from the IP address' },
    ],
    sources: [
      'https://firebase.google.com/docs/android/play-data-disclosure',
      'https://firebase.google.com/docs/ios/app-store-data-collection',
    ],
    notes: 'If you link Analytics to Google Ads or enable ad personalization, add advertising purposes and review tracking.',
  },
  {
    packages: ['@react-native-firebase/crashlytics'],
    name: 'Firebase Crashlytics',
    collects: [
      { type: 'crash-data', purposes: ['app-functionality', 'analytics'], linked: false, tracking: false },
      { type: 'device-id', purposes: ['app-functionality', 'analytics'], linked: false, tracking: false },
      { type: 'user-id', purposes: ['app-functionality'], linked: true, tracking: false, conditional: 'Only if you call setUserId()' },
    ],
    sources: [
      'https://firebase.google.com/docs/android/play-data-disclosure',
      'https://firebase.google.com/docs/ios/app-store-data-collection',
    ],
  },
  {
    packages: ['@react-native-firebase/messaging'],
    name: 'Firebase Cloud Messaging',
    collects: [{ type: 'device-id', purposes: ['app-functionality'], linked: false, tracking: false }],
    sources: [
      'https://firebase.google.com/docs/android/play-data-disclosure',
      'https://firebase.google.com/docs/ios/app-store-data-collection',
    ],
  },
  {
    packages: ['@react-native-firebase/perf'],
    name: 'Firebase Performance Monitoring',
    collects: [
      { type: 'performance-data', purposes: ['analytics'], linked: false, tracking: false },
      { type: 'device-id', purposes: ['analytics'], linked: false, tracking: false },
    ],
    sources: [
      'https://firebase.google.com/docs/android/play-data-disclosure',
      'https://firebase.google.com/docs/ios/app-store-data-collection',
    ],
  },
  {
    packages: ['@react-native-firebase/auth'],
    name: 'Firebase Authentication',
    collects: [
      { type: 'user-id', purposes: ['app-functionality'], linked: true, tracking: false },
      { type: 'email', purposes: ['app-functionality'], linked: true, tracking: false, conditional: 'If you use email, Google or Apple sign-in' },
      { type: 'phone', purposes: ['app-functionality'], linked: true, tracking: false, conditional: 'If you use phone number sign-in' },
    ],
    sources: [
      'https://firebase.google.com/docs/android/play-data-disclosure',
      'https://firebase.google.com/docs/ios/app-store-data-collection',
    ],
  },

  // ------------------------------------------------------ Crash / monitoring
  {
    packages: ['@sentry/react-native'],
    name: 'Sentry',
    collects: [
      { type: 'crash-data', purposes: ['app-functionality'], linked: false, tracking: false },
      { type: 'performance-data', purposes: ['app-functionality'], linked: false, tracking: false, conditional: 'If tracing is enabled' },
      { type: 'other-diagnostic', purposes: ['app-functionality'], linked: false, tracking: false },
      { type: 'user-id', purposes: ['app-functionality'], linked: true, tracking: false, conditional: 'Only if you call Sentry.setUser()' },
    ],
    sources: [
      'https://docs.sentry.io/platforms/react-native/data-management/apple-privacy-manifest/',
      'https://docs.sentry.io/platforms/react-native/data-management/data-collected/',
    ],
    notes: 'Session Replay (if enabled) can capture screen content. Mask sensitive views.',
  },
  {
    packages: ['@bugsnag/react-native'],
    name: 'BugSnag',
    collects: [
      { type: 'crash-data', purposes: ['app-functionality'], linked: false, tracking: false },
      { type: 'other-diagnostic', purposes: ['app-functionality'], linked: false, tracking: false },
      { type: 'device-id', purposes: ['app-functionality'], linked: false, tracking: false },
      { type: 'user-id', purposes: ['app-functionality'], linked: true, tracking: false, conditional: 'Only if you call setUser()' },
    ],
    sources: ['https://docs.bugsnag.com/platforms/ios/appstore-privacy/'],
  },
  {
    packages: ['@datadog/mobile-react-native'],
    name: 'Datadog RUM',
    collects: [
      { type: 'crash-data', purposes: ['app-functionality', 'analytics'], linked: false, tracking: false },
      { type: 'performance-data', purposes: ['app-functionality', 'analytics'], linked: false, tracking: false },
      { type: 'product-interaction', purposes: ['analytics'], linked: false, tracking: false },
      { type: 'device-id', purposes: ['analytics'], linked: false, tracking: false },
    ],
    sources: ['https://docs.datadoghq.com/real_user_monitoring/mobile_and_tv_monitoring/react_native/'],
  },

  // --------------------------------------------------------------- Analytics
  {
    packages: ['@segment/analytics-react-native'],
    name: 'Segment',
    // From the PrivacyInfo.xcprivacy Segment ships in @segment/analytics-react-native 2.21 (packages/core/ios).
    collects: [
      { type: 'device-id', purposes: ['analytics', 'developer-advertising'], linked: true, tracking: false },
      { type: 'product-interaction', purposes: ['analytics'], linked: true, tracking: false },
      { type: 'user-id', purposes: ['analytics'], linked: true, tracking: false, conditional: 'Only if you call identify()' },
      { type: 'advertising-data', purposes: ['developer-advertising'], linked: false, tracking: false, conditional: 'Only with @segment/analytics-react-native-plugin-idfa' },
    ],
    sources: [
      'https://segment.com/docs/connections/sources/catalog/libraries/mobile/react-native/implementation/',
      'https://segment.com/docs/connections/sources/catalog/libraries/mobile/apple/ios-17/',
      'https://github.com/segmentio/analytics-react-native/blob/master/packages/core/ios/PrivacyInfo.xcprivacy',
    ],
    notes: 'Segment forwards data to the destinations you configure. Each destination may need its own disclosure. Segment\'s own manifest contains invalid entries ("App Name", "App Version", an empty purpose); rn-privacy ignores them.',
  },
  {
    packages: ['mixpanel-react-native'],
    name: 'Mixpanel',
    collects: [
      { type: 'device-id', purposes: ['analytics'], linked: false, tracking: false },
      { type: 'product-interaction', purposes: ['analytics'], linked: false, tracking: false },
      { type: 'coarse-location', purposes: ['analytics'], linked: false, tracking: false, conditional: 'Derived from the IP address unless disabled' },
      { type: 'user-id', purposes: ['analytics'], linked: true, tracking: false, conditional: 'Only if you call identify()' },
    ],
    sources: ['https://docs.mixpanel.com/docs/privacy/protecting-user-data'],
  },
  {
    packages: ['@amplitude/analytics-react-native'],
    name: 'Amplitude',
    collects: [
      { type: 'device-id', purposes: ['analytics'], linked: false, tracking: false },
      { type: 'product-interaction', purposes: ['analytics'], linked: false, tracking: false },
      { type: 'coarse-location', purposes: ['analytics'], linked: false, tracking: false, conditional: 'Derived from the IP address unless disabled' },
      { type: 'user-id', purposes: ['analytics'], linked: true, tracking: false, conditional: 'Only if you call setUserId()' },
    ],
    sources: ['https://amplitude.com/docs/sdks/analytics/react-native/react-native-sdk'],
  },
  {
    packages: ['posthog-react-native'],
    name: 'PostHog',
    collects: [
      { type: 'device-id', purposes: ['analytics'], linked: false, tracking: false },
      { type: 'product-interaction', purposes: ['analytics'], linked: false, tracking: false },
      { type: 'user-id', purposes: ['analytics'], linked: true, tracking: false, conditional: 'Only if you call identify()' },
    ],
    sources: ['https://posthog.com/docs/libraries/react-native'],
    notes: 'Session replay (if enabled) can capture screen content.',
  },

  {
    packages: ['clevertap-react-native'],
    name: 'CleverTap',
    // From the PrivacyInfo.xcprivacy in CleverTap's iOS SDK (CleverTapSDK/).
    collects: [
      { type: 'user-id', purposes: ['app-functionality', 'product-personalization'], linked: true, tracking: false },
      { type: 'device-id', purposes: ['app-functionality', 'product-personalization'], linked: true, tracking: false },
      { type: 'product-interaction', purposes: ['analytics', 'product-personalization'], linked: true, tracking: false },
    ],
    sources: ['https://github.com/CleverTap/clevertap-ios-sdk/blob/master/CleverTapSDK/PrivacyInfo.xcprivacy'],
    notes: 'CleverTap location (CleverTapLocation) ships its own manifest. Anything you send in profile or event properties (email, phone...) must be declared too.',
  },
  {
    packages: ['@braze/react-native-sdk'],
    name: 'Braze',
    // From the PrivacyInfo.xcprivacy in BrazeKit (braze-swift-sdk).
    collects: [
      { type: 'user-id', purposes: ['product-personalization', 'analytics', 'app-functionality'], linked: true, tracking: false },
      { type: 'device-id', purposes: ['product-personalization', 'analytics', 'app-functionality'], linked: true, tracking: false },
      { type: 'product-interaction', purposes: ['product-personalization', 'analytics', 'app-functionality'], linked: true, tracking: false },
    ],
    sources: ['https://github.com/braze-inc/braze-swift-sdk/blob/main/Sources/BrazeKitResources/Resources/PrivacyInfo.xcprivacy'],
    notes: 'Braze location and push stories ship their own manifests. Anything you set on the user profile (email, phone...) must be declared too.',
  },
  {
    packages: ['klaviyo-react-native-sdk'],
    name: 'Klaviyo',
    // From the PrivacyInfo.xcprivacy in klaviyo-swift-sdk (Sources/KlaviyoSwift).
    collects: [
      { type: 'device-id', purposes: ['analytics', 'product-personalization', 'developer-advertising'], linked: true, tracking: false },
      { type: 'user-id', purposes: ['product-personalization', 'analytics', 'developer-advertising'], linked: true, tracking: false },
      { type: 'product-interaction', purposes: ['analytics'], linked: true, tracking: false },
    ],
    sources: ['https://github.com/klaviyo/klaviyo-swift-sdk/blob/master/Sources/KlaviyoSwift/PrivacyInfo.xcprivacy'],
    notes: 'If you pass an email or phone number to Klaviyo, declare it too.',
  },
  {
    packages: ['react-native-moengage'],
    name: 'MoEngage',
    // From the PrivacyInfo.xcprivacy files MoEngage publishes (MoEngage-iOS-SDK-Beta) and its privacy manifest docs.
    collects: [
      { type: 'user-id', purposes: ['analytics', 'product-personalization', 'app-functionality'], linked: true, tracking: false },
      { type: 'device-id', purposes: ['analytics', 'product-personalization', 'app-functionality'], linked: true, tracking: false },
      { type: 'product-interaction', purposes: ['analytics', 'product-personalization', 'app-functionality'], linked: false, tracking: true },
      { type: 'precise-location', purposes: ['analytics', 'product-personalization', 'app-functionality'], linked: false, tracking: true, conditional: 'Only with the MoEngage Geofence module' },
      { type: 'coarse-location', purposes: ['analytics', 'product-personalization', 'app-functionality'], linked: false, tracking: true, conditional: 'Only with the MoEngage Geofence module' },
    ],
    sources: [
      'https://www.moengage.com/docs/user-guide/data/privacy/apple-privacy-manifest-update',
      'https://github.com/moengage/MoEngage-iOS-SDK-Beta/blob/master/Frameworks/MoEngageSDK.xcframework/ios-arm64/MoEngageSDK.framework/PrivacyInfo.xcprivacy',
    ],
    notes: 'MoEngage marks product interaction (and location) as used for tracking but sets NSPrivacyTracking to false. Review tracking with App Tracking Transparency in mind.',
  },
  {
    packages: ['@microsoft/react-native-clarity'],
    name: 'Microsoft Clarity',
    // From Microsoft's App Store privacy guidance for the Clarity mobile SDK.
    collects: [
      { type: 'product-interaction', purposes: ['analytics'], linked: false, tracking: false },
      { type: 'performance-data', purposes: ['app-functionality'], linked: false, tracking: false },
      { type: 'coarse-location', purposes: ['analytics'], linked: false, tracking: false, conditional: 'Derived from the IP address' },
    ],
    sources: ['https://learn.microsoft.com/en-us/clarity/mobile-sdk/sdk-apple-appstore-privacy-guidance'],
    notes: 'Microsoft gives "app owner market awareness" as the purpose for location and "SDK stability and performance" for performance data; rn-privacy maps them to Analytics and App functionality.',
  },
  {
    packages: ['@logrocket/react-native'],
    name: 'LogRocket',
    // From LogRocket's Apple privacy questionnaire page.
    collects: [
      { type: 'product-interaction', purposes: ['analytics', 'app-functionality'], linked: false, tracking: false },
      { type: 'crash-data', purposes: ['analytics', 'app-functionality'], linked: false, tracking: false },
      { type: 'performance-data', purposes: ['analytics', 'app-functionality'], linked: false, tracking: false },
      { type: 'coarse-location', purposes: ['analytics', 'app-functionality'], linked: false, tracking: false, conditional: 'Derived from the IP address; can be turned off when you initialize the SDK' },
      { type: 'user-id', purposes: ['analytics', 'app-functionality'], linked: true, tracking: false, conditional: 'Only if you identify users' },
      { type: 'name', purposes: ['analytics', 'app-functionality'], linked: true, tracking: false, conditional: 'Only if you identify users with a name' },
      { type: 'email', purposes: ['analytics', 'app-functionality'], linked: true, tracking: false, conditional: 'Only if you identify users with an email' },
    ],
    sources: ['https://docs.logrocket.com/docs/apple-privacy-questionnaire'],
    notes: 'LogRocket does not say per data type whether it is linked to the user. If you identify users, session data is tied to them: consider marking it as linked. Session replay can capture whatever is on screen.',
  },
  // ------------------------------------------------------- Ads / attribution
  {
    packages: ['react-native-google-mobile-ads'],
    name: 'Google Mobile Ads (AdMob)',
    collects: [
      { type: 'device-id', purposes: ['third-party-advertising', 'analytics'], linked: false, tracking: true },
      { type: 'advertising-data', purposes: ['third-party-advertising', 'analytics'], linked: false, tracking: true },
      { type: 'product-interaction', purposes: ['third-party-advertising', 'analytics'], linked: false, tracking: true },
      { type: 'coarse-location', purposes: ['third-party-advertising', 'analytics'], linked: false, tracking: true },
      { type: 'crash-data', purposes: ['analytics'], linked: false, tracking: false },
      { type: 'performance-data', purposes: ['analytics'], linked: false, tracking: false },
    ],
    sources: [
      'https://developers.google.com/admob/android/privacy/play-data-disclosure',
      'https://developers.google.com/admob/ios/privacy/data-disclosure',
    ],
    notes: 'Ad SDKs usually count as tracking on iOS: you need App Tracking Transparency and NSPrivacyTrackingDomains.',
  },
  {
    packages: ['react-native-fbsdk-next'],
    name: 'Meta (Facebook) SDK',
    collects: [
      { type: 'device-id', purposes: ['third-party-advertising', 'analytics'], linked: false, tracking: true },
      { type: 'advertising-data', purposes: ['third-party-advertising'], linked: false, tracking: true },
      { type: 'product-interaction', purposes: ['analytics', 'third-party-advertising'], linked: false, tracking: true },
      { type: 'user-id', purposes: ['app-functionality'], linked: true, tracking: false, conditional: 'If you use Facebook Login' },
    ],
    sources: ['https://developers.facebook.com/docs/ios'],
  },
  {
    packages: ['react-native-appsflyer'],
    name: 'AppsFlyer',
    collects: [
      { type: 'device-id', purposes: ['analytics', 'third-party-advertising'], linked: false, tracking: true },
      { type: 'advertising-data', purposes: ['analytics', 'third-party-advertising'], linked: false, tracking: true },
      { type: 'product-interaction', purposes: ['analytics'], linked: false, tracking: true },
    ],
    sources: ['https://support.appsflyer.com/hc/en-us/articles/207032086', 'https://support.appsflyer.com/hc/en-us/articles/21677433322641'],
  },
  {
    packages: ['react-native-branch'],
    name: 'Branch',
    // From the PrivacyInfo.xcprivacy in Branch's iOS SDK and Branch's App Store Connect guide.
    collects: [
      { type: 'device-id', purposes: ['third-party-advertising', 'developer-advertising', 'analytics'], linked: true, tracking: true },
      { type: 'performance-data', purposes: ['app-functionality'], linked: false, tracking: false },
      { type: 'product-interaction', purposes: ['analytics', 'developer-advertising'], linked: true, tracking: false, conditional: 'Only if you log events with Branch' },
      { type: 'purchase-history', purposes: ['analytics', 'developer-advertising'], linked: true, tracking: false, conditional: 'Only if you log commerce events with Branch' },
    ],
    sources: [
      'https://help.branch.io/using-branch/docs/answering-the-app-store-connect-privacy-questions',
      'https://help.branch.io/developer-hub/docs/ios-17-privacy-overview',
      'https://github.com/BranchMetrics/ios-branch-deep-linking-attribution/blob/master/Sources/Resources/PrivacyInfo.xcprivacy',
    ],
    notes: 'Branch also answers Yes to "Browsing history" (Apple\'s broad definition) and "Other data" (device metadata) in App Store Connect. Its SDK declares tracking with the domains api-safetrack.branch.io and api-safetrack-eu.branch.io, used only after ATT opt-in. If you only use deep linking, Branch says its data is not used for tracking.',
  },

  {
    packages: ['react-native-adjust'],
    name: 'Adjust',
    // From the PrivacyInfo.xcprivacy in Adjust's iOS SDK (Adjust/).
    collects: [
      { type: 'device-id', purposes: ['analytics', 'third-party-advertising'], linked: true, tracking: true },
      { type: 'product-interaction', purposes: ['analytics'], linked: false, tracking: false },
    ],
    sources: ['https://github.com/adjust/ios_sdk/blob/master/Adjust/PrivacyInfo.xcprivacy'],
    notes: 'Adjust declares tracking and its consent domains (consent.adjust.com and regional variants). Run `rn-privacy ios --write --tracking` if your app uses App Tracking Transparency.',
  },
  {
    packages: ['singular-react-native'],
    name: 'Singular',
    // From the PrivacyInfo.xcprivacy in Singular's iOS SDK (Sources/Singular).
    collects: [
      { type: 'device-id', purposes: ['third-party-advertising', 'analytics', 'developer-advertising'], linked: true, tracking: true },
    ],
    sources: ['https://github.com/singular-labs/Singular-iOS-SDK/blob/main/Sources/Singular/PrivacyInfo.xcprivacy'],
    notes: 'Singular declares tracking with the domain safetrack.singular.net. Run `rn-privacy ios --write --tracking` if your app uses App Tracking Transparency.',
  },
  // -------------------------------------------------- Push / purchases / misc
  {
    packages: ['react-native-onesignal'],
    name: 'OneSignal',
    collects: [
      { type: 'device-id', purposes: ['app-functionality'], linked: false, tracking: false },
      { type: 'product-interaction', purposes: ['analytics'], linked: false, tracking: false },
    ],
    sources: ['https://documentation.onesignal.com/docs/apple-app-privacy-requirements', 'https://documentation.onesignal.com/docs/google-play-data-safety-requirements'],
  },
  {
    packages: ['expo-notifications'],
    name: 'Expo Notifications',
    collects: [
      { type: 'device-id', purposes: ['app-functionality'], linked: false, tracking: false, conditional: 'If you register for push notifications' },
    ],
    sources: ['https://docs.expo.dev/guides/apple-privacy/'],
  },
  {
    packages: ['react-native-purchases'],
    name: 'RevenueCat',
    collects: [
      { type: 'purchase-history', purposes: ['app-functionality', 'analytics'], linked: true, tracking: false },
      { type: 'user-id', purposes: ['app-functionality'], linked: true, tracking: false },
    ],
    sources: ['https://www.revenuecat.com/docs/platform-resources/apple-platform-resources/apple-app-privacy'],
  },

  {
    packages: ['@intercom/intercom-react-native'],
    name: 'Intercom',
    // From the PrivacyInfo.xcprivacy in Intercom.xcframework (intercom-ios).
    collects: [
      { type: 'user-id', purposes: ['app-functionality'], linked: true, tracking: false },
      { type: 'email', purposes: ['app-functionality'], linked: true, tracking: false },
      { type: 'photos-videos', purposes: ['app-functionality'], linked: true, tracking: false },
      { type: 'performance-data', purposes: ['app-functionality'], linked: false, tracking: false },
      { type: 'other-diagnostic', purposes: ['app-functionality'], linked: false, tracking: false },
    ],
    sources: ['https://github.com/intercom/intercom-ios/blob/master/Intercom.xcframework/ios-arm64/Intercom.framework/PrivacyInfo.xcprivacy'],
  },
  {
    packages: ['@luciq/react-native', 'instabug-reactnative'],
    name: 'Luciq (Instabug)',
    // From Luciq's "App Privacy Details for iOS" page. It lists what is collected, not purposes, linking or tracking.
    collects: [
      { type: 'user-id', purposes: ['app-functionality'], linked: false, tracking: false },
      { type: 'product-interaction', purposes: ['app-functionality'], linked: false, tracking: false, conditional: 'Only with repro steps or user steps turned on' },
      { type: 'performance-data', purposes: ['app-functionality'], linked: false, tracking: false, conditional: 'Only with APM or the session profiler' },
    ],
    sources: ['https://docs.luciq.ai/ios/setup-luciq-for-ios/custom-settings/privacy-settings/app-privacy-details'],
    notes: 'Luciq\'s page does not state purposes, linking or tracking: rn-privacy assumes App functionality, not linked. It also lists "Other data types" (device and app info). Name, email and photos are only sent if you identify users or users attach them to bug reports.',
  },
  // ---------------------------------- Device access (declare only if sent off the device)
  {
    packages: ['expo-location', '@react-native-community/geolocation', 'react-native-geolocation-service', 'react-native-background-geolocation'],
    name: 'Location',
    accesses: [{ type: 'precise-location' }],
    sources: [],
  },
  {
    packages: ['expo-contacts', 'react-native-contacts'],
    name: 'Contacts',
    accesses: [{ type: 'contacts' }],
    sources: [],
  },
  {
    packages: ['expo-camera', 'expo-image-picker', 'expo-media-library', 'react-native-vision-camera', 'react-native-image-picker', 'react-native-image-crop-picker', '@react-native-camera-roll/camera-roll'],
    name: 'Camera / photo library',
    accesses: [{ type: 'photos-videos' }],
    sources: [],
  },
  {
    packages: ['expo-av', 'expo-audio', 'react-native-audio-recorder-player', '@react-native-voice/voice'],
    name: 'Microphone',
    accesses: [{ type: 'audio' }],
    sources: [],
  },
  {
    packages: ['react-native-health', 'react-native-health-connect', '@kingstinct/react-native-healthkit'],
    name: 'Health data',
    accesses: [{ type: 'health' }],
    sources: [],
  },
];

/**
 * The rule for a package. Pass the installed version to pick a version-specific rule:
 * the first rule whose `versions` range matches wins, and a rule without `versions` is the fallback.
 */
export function findRule(pkg: string, version?: string, rules: LibraryRule[] = RULES): LibraryRule | undefined {
  const candidates = rules.filter((r) => r.packages.includes(pkg));
  const matched = version ? candidates.find((r) => r.versions && satisfies(version, r.versions)) : undefined;
  return matched ?? candidates.find((r) => !r.versions);
}
