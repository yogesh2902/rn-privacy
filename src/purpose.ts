import { stripComments } from './apis.js';

/**
 * Info.plist purpose strings (NSCameraUsageDescription...). When an app's code asks for access to
 * the camera, location, contacts and so on without the matching purpose string, App Store Connect
 * rejects the upload (ITMS-90683), and iOS ends the app when the prompt would appear.
 *
 * rn-privacy looks for the calls that ask for access (they show the permission prompt), not for
 * any mention of a framework, so a library that only touches a class does not count.
 */
export interface PurposeKeyInfo {
  label: string;
  /** Other keys that also satisfy it (newer or broader ones). */
  alternatives?: string[];
  /** Missing it does not block the upload, but iOS ends the app or refuses the feature. */
  runtimeOnly?: boolean;
  source: RegExp[];
  /** In prebuilt binaries: every name in one group must be present (zero-terminated). */
  binary: string[][];
}

export const PURPOSE_KEYS: Record<string, PurposeKeyInfo> = {
  NSCameraUsageDescription: {
    label: 'Camera',
    source: [
      /requestAccess(?:ForMediaType)?\s*[:(]\s*(?:for:\s*)?(?:AVMediaTypeVideo|\.video)\b/,
      /\bUIImagePickerControllerSourceTypeCamera\b/,
      /\bsourceType\s*=\s*\.camera\b/,
    ],
    binary: [['requestAccessForMediaType:completionHandler:', '_AVMediaTypeVideo']],
  },
  NSMicrophoneUsageDescription: {
    label: 'Microphone',
    source: [
      /\brequestRecordPermission\b/,
      /requestAccess(?:ForMediaType)?\s*[:(]\s*(?:for:\s*)?(?:AVMediaTypeAudio|\.audio)\b/,
      /\bAVAudioRecorder\b/,
    ],
    binary: [['requestRecordPermission:'], ['requestRecordPermissionWithCompletionHandler:'], ['_OBJC_CLASS_$_AVAudioRecorder'], ['requestAccessForMediaType:completionHandler:', '_AVMediaTypeAudio']],
  },
  NSPhotoLibraryUsageDescription: {
    label: 'Photo library',
    source: [/\bPHPhotoLibrary\b[\s.]*requestAuthorization/, /\bPHAsset\b[\s.]*fetchAssets/],
    binary: [['_OBJC_CLASS_$_PHPhotoLibrary', 'requestAuthorization:'], ['_OBJC_CLASS_$_PHPhotoLibrary', 'requestAuthorizationForAccessLevel:handler:'], ['_OBJC_CLASS_$_PHAsset', 'fetchAssetsWithOptions:']],
  },
  NSPhotoLibraryAddUsageDescription: {
    label: 'Saving to the photo library',
    alternatives: ['NSPhotoLibraryUsageDescription'],
    source: [/\bUIImageWriteToSavedPhotosAlbum\b/, /\bUISaveVideoAtPathToSavedPhotosAlbum\b/, /\bPHAsset(?:Creation|Change)Request\b/],
    binary: [['_UIImageWriteToSavedPhotosAlbum'], ['_UISaveVideoAtPathToSavedPhotosAlbum'], ['_OBJC_CLASS_$_PHAssetCreationRequest'], ['_OBJC_CLASS_$_PHAssetChangeRequest']],
  },
  NSLocationWhenInUseUsageDescription: {
    label: 'Location',
    source: [/\brequestWhenInUseAuthorization\b/, /\brequestAlwaysAuthorization\b/],
    binary: [['requestWhenInUseAuthorization'], ['requestAlwaysAuthorization']],
  },
  NSLocationAlwaysAndWhenInUseUsageDescription: {
    label: 'Location in the background',
    source: [/\brequestAlwaysAuthorization\b/],
    binary: [['requestAlwaysAuthorization']],
  },
  NSContactsUsageDescription: {
    label: 'Contacts',
    source: [/\bCNContactStore\b/, /\bABAddressBook(?:CreateWithOptions|RequestAccessWithCompletion)\b/],
    binary: [['_OBJC_CLASS_$_CNContactStore'], ['_ABAddressBookCreateWithOptions']],
  },
  NSCalendarsUsageDescription: {
    label: 'Calendars',
    alternatives: ['NSCalendarsFullAccessUsageDescription', 'NSCalendarsWriteOnlyAccessUsageDescription'],
    source: [/requestAccessToEntityType\s*[:(]\s*(?:EKEntityTypeEvent|\.event)\b/, /\brequestFullAccessToEvents\b/, /\brequestWriteOnlyAccessToEvents\b/],
    binary: [['_OBJC_CLASS_$_EKEventStore', 'requestAccessToEntityType:completion:'], ['requestFullAccessToEventsWithCompletion:'], ['requestWriteOnlyAccessToEventsWithCompletion:']],
  },
  NSRemindersUsageDescription: {
    label: 'Reminders',
    alternatives: ['NSRemindersFullAccessUsageDescription'],
    source: [/requestAccessToEntityType\s*[:(]\s*(?:EKEntityTypeReminder|\.reminder)\b/, /\brequestFullAccessToReminders\b/],
    binary: [['requestFullAccessToRemindersWithCompletion:']],
  },
  NSBluetoothAlwaysUsageDescription: {
    label: 'Bluetooth',
    source: [/\bCB(?:Central|Peripheral)Manager\b/],
    binary: [['_OBJC_CLASS_$_CBCentralManager'], ['_OBJC_CLASS_$_CBPeripheralManager']],
  },
  NSMotionUsageDescription: {
    label: 'Motion and fitness',
    source: [/\bCMMotionActivityManager\b/, /\bCMPedometer\b/],
    binary: [['_OBJC_CLASS_$_CMMotionActivityManager'], ['_OBJC_CLASS_$_CMPedometer']],
  },
  NSSpeechRecognitionUsageDescription: {
    label: 'Speech recognition',
    source: [/\bSFSpeechRecognizer\b/],
    binary: [['_OBJC_CLASS_$_SFSpeechRecognizer']],
  },
  NSAppleMusicUsageDescription: {
    label: 'Media library',
    source: [/\bMPMedia(?:Library|Query|PickerController)\b/],
    binary: [['_OBJC_CLASS_$_MPMediaLibrary'], ['_OBJC_CLASS_$_MPMediaQuery'], ['_OBJC_CLASS_$_MPMediaPickerController']],
  },
  NSUserTrackingUsageDescription: {
    label: 'Tracking (App Tracking Transparency)',
    source: [/\brequestTrackingAuthorization/],
    binary: [['requestTrackingAuthorizationWithCompletionHandler:']],
  },
  NSHealthShareUsageDescription: {
    label: 'Health data',
    source: [/requestAuthorization(?:ToShareTypes|\s*\(\s*toShare)/],
    binary: [['requestAuthorizationToShareTypes:readTypes:completion:']],
  },
  NSSiriUsageDescription: {
    label: 'Siri',
    source: [/\brequestSiriAuthorization\b/],
    binary: [['requestSiriAuthorization:']],
  },
  NFCReaderUsageDescription: {
    label: 'NFC',
    source: [/\bNFC(?:NDEF|Tag)ReaderSession\b/],
    binary: [['_OBJC_CLASS_$_NFCNDEFReaderSession'], ['_OBJC_CLASS_$_NFCTagReaderSession']],
  },
  NSFaceIDUsageDescription: {
    label: 'Face ID',
    runtimeOnly: true,
    source: [/\bevaluatePolicy\b/],
    binary: [['_OBJC_CLASS_$_LAContext', 'evaluatePolicy:localizedReason:reply:']],
  },
};

export const PURPOSE_KEY_NAMES = Object.keys(PURPOSE_KEYS);

export function isPurposeKey(v: string): boolean {
  return v in PURPOSE_KEYS;
}

/** Purpose strings the source code needs, with the matching code. */
export function findPurposeUses(source: string): { key: string; symbol: string }[] {
  const code = stripComments(source);
  const out: { key: string; symbol: string }[] = [];
  for (const [key, info] of Object.entries(PURPOSE_KEYS)) {
    for (const re of info.source) {
      const m = re.exec(code);
      if (m) {
        out.push({ key, symbol: m[0].replace(/\s+/g, ' ') });
        break;
      }
    }
  }
  return out;
}

const BINARY_PATTERNS = Object.entries(PURPOSE_KEYS).map(([key, info]) => ({
  key,
  groups: info.binary.map((group) => group.map((name) => ({ name: name.replace(/^_(OBJC_CLASS_\$_)?/, ''), bytes: Buffer.from(`\0${name}\0`, 'latin1') }))),
}));

/** Purpose strings a prebuilt binary needs. */
export function findPurposeUsesInBinary(data: Buffer): { key: string; symbol: string }[] {
  const out: { key: string; symbol: string }[] = [];
  for (const p of BINARY_PATTERNS) {
    const group = p.groups.find((g) => g.every((n) => data.indexOf(n.bytes) !== -1));
    if (group) out.push({ key: p.key, symbol: group.map((n) => n.name).join(' + ') });
  }
  return out;
}

/** react-native-permissions only compiles the handlers listed in setup_permissions in the Podfile. */
export function podfilePermissions(podfile: string): Set<string> | null {
  const m = /setup_permissions\s*\(\s*\[([\s\S]*?)\]\s*\)/.exec(stripRubyComments(podfile));
  if (!m) return null;
  return new Set([...m[1].matchAll(/['"]([A-Za-z]+)['"]/g)].map((x) => x[1]));
}

function stripRubyComments(text: string): string {
  return text.replace(/(^|\s)#.*$/gm, '$1');
}
