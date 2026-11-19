import type { Analysis } from './analyze.js';
import type { CollectedData, DataType, Purpose, ScanResult } from './types.js';

/**
 * App Store Connect's App Privacy form, step by step: data types are ticked by category, then each
 * type gets its purposes, "linked to the user's identity?" and "used for tracking?".
 */
export const ASC_TYPES: Record<DataType, { category: string; type: string }> = {
  name: { category: 'Contact Info', type: 'Name' },
  email: { category: 'Contact Info', type: 'Email Address' },
  phone: { category: 'Contact Info', type: 'Phone Number' },
  health: { category: 'Health & Fitness', type: 'Health' },
  'precise-location': { category: 'Location', type: 'Precise Location' },
  'coarse-location': { category: 'Location', type: 'Coarse Location' },
  contacts: { category: 'Contacts', type: 'Contacts' },
  'photos-videos': { category: 'User Content', type: 'Photos or Videos' },
  audio: { category: 'User Content', type: 'Audio Data' },
  'user-id': { category: 'Identifiers', type: 'User ID' },
  'device-id': { category: 'Identifiers', type: 'Device ID' },
  'purchase-history': { category: 'Purchases', type: 'Purchase History' },
  'product-interaction': { category: 'Usage Data', type: 'Product Interaction' },
  'advertising-data': { category: 'Usage Data', type: 'Advertising Data' },
  'other-usage': { category: 'Usage Data', type: 'Other Usage Data' },
  'crash-data': { category: 'Diagnostics', type: 'Crash Data' },
  'performance-data': { category: 'Diagnostics', type: 'Performance Data' },
  'other-diagnostic': { category: 'Diagnostics', type: 'Other Diagnostic Data' },
};

/** Purposes in the order App Store Connect lists them. */
export const ASC_PURPOSES: [Purpose, string][] = [
  ['third-party-advertising', 'Third-Party Advertising'],
  ['developer-advertising', "Developer's Advertising or Marketing"],
  ['analytics', 'Analytics'],
  ['product-personalization', 'Product Personalization'],
  ['app-functionality', 'App Functionality'],
  ['other', 'Other Purposes'],
];

const ORDER = Object.keys(ASC_TYPES) as DataType[];

interface Answer {
  type: DataType;
  purposes: Purpose[];
  linked: boolean;
  tracking: boolean;
  /** Who makes each answer Yes, for the reader to check. */
  linkedBy: string[];
  trackingBy: string[];
  packages: string[];
  /** Only with --include-conditional: the setups that add this. */
  conditions: string[];
}

/** What one package says about one data type (its rule, else its own manifest). */
function itemFor(scan: ScanResult, pkg: string, type: DataType): CollectedData | undefined {
  const report = scan.packages.find((p) => p.name === pkg);
  const items = report?.rule ? report.rule.collects ?? [] : report?.manifestCollected ?? [];
  return items.find((i) => i.type === type && !i.conditional) ?? items.find((i) => i.type === type);
}

function answers(scan: ScanResult, a: Analysis, includeConditional: boolean): { answers: Answer[]; optional: { type: DataType; pkg: string; condition: string; purposes: Purpose[] }[] } {
  const out: Answer[] = [];
  const optional: { type: DataType; pkg: string; condition: string; purposes: Purpose[] }[] = [];
  for (const d of a.data) {
    const items = [
      ...(d.packages.length ? [{ pkg: d.packages.join(', '), item: { purposes: d.purposes, linked: d.linked, tracking: d.tracking }, condition: '' }] : []),
      ...(includeConditional ? d.conditional.map((x) => ({ pkg: x.pkg, item: x.item, condition: x.condition })) : []),
    ];
    if (!includeConditional) for (const x of d.conditional) optional.push({ type: d.type, pkg: x.pkg, condition: x.condition, purposes: x.item.purposes });
    if (!items.length) continue;
    out.push({
      type: d.type,
      purposes: [...new Set(items.flatMap((i) => i.item.purposes))],
      linked: items.some((i) => i.item.linked),
      tracking: items.some((i) => i.item.tracking),
      linkedBy: d.packages.filter((p) => itemFor(scan, p, d.type)?.linked),
      trackingBy: d.packages.filter((p) => itemFor(scan, p, d.type)?.tracking),
      packages: [...d.packages, ...(includeConditional ? d.conditional.map((x) => x.pkg) : [])],
      conditions: items.filter((i) => i.condition).map((i) => `${i.pkg}: ${i.condition}`),
    });
    const last = out[out.length - 1];
    if (includeConditional) {
      for (const x of d.conditional) {
        if (x.item.linked && !last.linkedBy.includes(x.pkg)) last.linkedBy.push(x.pkg);
        if (x.item.tracking && !last.trackingBy.includes(x.pkg)) last.trackingBy.push(x.pkg);
      }
    }
  }
  out.sort((x, y) => ORDER.indexOf(x.type) - ORDER.indexOf(y.type));
  return { answers: out, optional };
}

const yes = (v: boolean) => (v ? '**Yes**' : '**No**');

/** `report --format appstore`: the App Privacy answers in the order App Store Connect asks for them. */
export function formatAppStore(scan: ScanResult, a: Analysis, includeConditional: boolean): string {
  const { answers: list, optional } = answers(scan, a, includeConditional);
  const out: string[] = [];
  out.push('# App Store Connect: App Privacy, step by step', '');
  out.push('In App Store Connect, open your app and choose **App Privacy** in the sidebar, then **Get Started** (or **Edit** next to Data Types).', '');
  out.push(
    '> Generated by rn-privacy from your dependencies and your rules in rn-privacy.config.json. It cannot see what your own',
    '> code or server collects: add that too. Check the vendor pages in `rn-privacy report` before you publish.',
    '',
  );

  out.push('## 1. Data collection', '');
  out.push(`"Do you or your third-party partners collect data from this app?" ${yes(list.length > 0)}`, '');
  if (!list.length) {
    out.push('rn-privacy found no data collection in your libraries. If your own code collects data, answer Yes and add it.', '');
  }

  if (list.length) {
    out.push('## 2. Data types', '', 'Tick these, then **Save**:', '');
    const byCategory = new Map<string, string[]>();
    for (const x of list) {
      const { category, type } = ASC_TYPES[x.type];
      byCategory.set(category, [...(byCategory.get(category) ?? []), type]);
    }
    for (const [category, types] of byCategory) out.push(`- **${category}**: ${types.join(', ')}`);
    out.push('');

    out.push('## 3. Each data type', '', 'App Store Connect now asks three questions per data type. Use **Set Up** next to each one:', '');
    for (const x of list) {
      const { category, type } = ASC_TYPES[x.type];
      out.push(`### ${type} (${category})`, '');
      const purposes = ASC_PURPOSES.filter(([p]) => x.purposes.includes(p)).map(([, label]) => `**${label}**`);
      out.push(`1. Purposes: tick ${purposes.join(', ')}`);
      out.push(`2. Linked to the user's identity? ${yes(x.linked)}${x.linked && x.linkedBy.length ? ` (because of ${x.linkedBy.join(', ')})` : ''}`);
      out.push(`3. Used for tracking? ${yes(x.tracking)}${x.tracking && x.trackingBy.length ? ` (because of ${x.trackingBy.join(', ')})` : ''}`);
      out.push('', `Collected by ${x.packages.join(', ')}.${x.conditions.length ? ` Only in some setups: ${x.conditions.join('; ')}.` : ''}`, '');
    }
  }

  if (optional.length) {
    out.push('## Only if you use these features', '');
    out.push('These libraries collect more in some setups. If yours does, add the data type with these purposes (or run with `--include-conditional`):', '');
    for (const o of optional) {
      const purposes = ASC_PURPOSES.filter(([p]) => o.purposes.includes(p)).map(([, label]) => label).join(', ');
      out.push(`- **${ASC_TYPES[o.type].type}** (${ASC_TYPES[o.type].category}), from ${o.pkg}: ${o.condition}. Purposes: ${purposes}.`);
    }
    out.push('');
  }

  out.push('## 4. Before you publish', '');
  if (list.some((x) => x.tracking)) {
    out.push('- Some data is used for tracking. Your app must ask for permission with App Tracking Transparency before it tracks, and its privacy manifest needs `NSPrivacyTracking` and the tracking domains (`rn-privacy ios --write --tracking`).');
  }
  out.push('- Check the preview, then **Publish** on the App Privacy page. The answers are for the app, not for one version.');
  out.push('- The App Privacy page also asks for your **Privacy Policy URL**. `rn-privacy report --format inventory` gives whoever writes the policy the facts.');
  out.push('- Keep the privacy manifest in your build consistent with these answers: `rn-privacy check`.');
  return out.join('\n') + '\n';
}
