import { DATA_TYPES, PLAY_PURPOSES } from './types.js';
import type { DataType, PlayCollected, PlayPurpose } from './types.js';

/**
 * Google Play Data safety CSV.
 *
 * Play Console can export the Data safety form as CSV and import it back. Instead of building
 * the file from scratch (Google changes the template), rn-privacy fills in the file the user
 * exported: it only turns answers on, never off, and keeps every other row as it was.
 *
 * Columns: Question ID, Response ID, Response value, Answer requirement, Human-friendly label.
 */
export const PLAY_DATA_IDS: Record<DataType, { question: string; response: string }> = {
  name: { question: 'PSL_DATA_TYPES_PERSONAL', response: 'PSL_NAME' },
  email: { question: 'PSL_DATA_TYPES_PERSONAL', response: 'PSL_EMAIL' },
  'user-id': { question: 'PSL_DATA_TYPES_PERSONAL', response: 'PSL_USER_ACCOUNT' },
  phone: { question: 'PSL_DATA_TYPES_PERSONAL', response: 'PSL_PHONE' },
  'purchase-history': { question: 'PSL_DATA_TYPES_FINANCIAL', response: 'PSL_PURCHASE_HISTORY' },
  'coarse-location': { question: 'PSL_DATA_TYPES_LOCATION', response: 'PSL_APPROX_LOCATION' },
  'precise-location': { question: 'PSL_DATA_TYPES_LOCATION', response: 'PSL_PRECISE_LOCATION' },
  'photos-videos': { question: 'PSL_DATA_TYPES_PHOTOS_AND_VIDEOS', response: 'PSL_PHOTOS' },
  audio: { question: 'PSL_DATA_TYPES_AUDIO', response: 'PSL_AUDIO' },
  health: { question: 'PSL_DATA_TYPES_HEALTH_AND_FITNESS', response: 'PSL_HEALTH' },
  contacts: { question: 'PSL_DATA_TYPES_CONTACTS', response: 'PSL_CONTACTS' },
  'crash-data': { question: 'PSL_DATA_TYPES_APP_PERFORMANCE', response: 'PSL_CRASH_LOGS' },
  'performance-data': { question: 'PSL_DATA_TYPES_APP_PERFORMANCE', response: 'PSL_PERFORMANCE_DIAGNOSTICS' },
  'other-diagnostic': { question: 'PSL_DATA_TYPES_APP_PERFORMANCE', response: 'PSL_OTHER_PERFORMANCE' },
  'product-interaction': { question: 'PSL_DATA_TYPES_APP_ACTIVITY', response: 'PSL_USER_INTERACTION' },
  'advertising-data': { question: 'PSL_DATA_TYPES_APP_ACTIVITY', response: 'PSL_OTHER_APP_ACTIVITY' },
  'other-usage': { question: 'PSL_DATA_TYPES_APP_ACTIVITY', response: 'PSL_OTHER_APP_ACTIVITY' },
  'device-id': { question: 'PSL_DATA_TYPES_IDENTIFIERS', response: 'PSL_DEVICE_ID' },
};

/** Play's purpose response IDs (used for both "collected" and "shared" purposes). */
export const PLAY_PURPOSE_IDS: Record<PlayPurpose, string> = Object.fromEntries(
  (Object.keys(PLAY_PURPOSES) as PlayPurpose[]).map((p) => [p, PLAY_PURPOSES[p].id]),
) as Record<PlayPurpose, string>;

const HEADER = 'Question ID (machine readable)';

// ------------------------------------------------------------------ CSV

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export function toCsv(rows: string[][], eol: string, trailingNewline: boolean): string {
  const cell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const body = rows.map((r) => r.map(cell).join(',')).join(eol);
  return trailingNewline ? body + eol : body;
}

// ----------------------------------------------------------------- fill

export interface PlayFillResult {
  content: string;
  /** Human-readable answers that were turned on. */
  changes: string[];
  /** Answers rn-privacy wanted to set but the CSV has no row for (older or newer template). */
  missingRows: string[];
  /** Data types whose "required or optional?" question only the developer can answer. */
  todo: string[];
  /** Data types whose purposes the SDK vendor does not state. */
  purposeTodo: string[];
}

export function isPlayCsv(text: string): boolean {
  return parseCsv(text.slice(0, 500))[0]?.[0]?.trim() === HEADER;
}

/** Turn on the answers for the collected data. Never turns an answer off. */
export function fillPlayCsv(text: string, collected: PlayCollected[]): PlayFillResult {
  if (!isPlayCsv(text)) {
    throw new Error('This is not a Data safety CSV exported from Play Console (the first column should be "Question ID (machine readable)").');
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const rows = parseCsv(text);
  const trailingNewline = /\r?\n$/.test(text);
  const index = new Map<string, string[]>();
  for (const r of rows.slice(1)) {
    while (r.length < 3) r.push('');
    index.set(`${r[0]}\u0000${r[1]}`, r);
  }

  const changes: string[] = [];
  const missingRows: string[] = [];
  const isOn = (r: string[]) => r[2].trim().toLowerCase() === 'true';
  /** Set an answer; returns true if it changed. */
  const set = (question: string, response: string, value: 'true' | 'false', label: string): boolean => {
    const row = index.get(`${question}\u0000${response}`);
    if (!row) {
      missingRows.push(`${label} (${question}${response ? ` / ${response}` : ''})`);
      return false;
    }
    if (value === 'true' ? isOn(row) : row[2].trim() !== '') return false; // only fill, never override
    row[2] = value;
    return true;
  };

  // Several of our types share one Play type (advertising data and other usage are both "Other actions").
  const byPlayType = new Map<string, { label: string; purposes: Set<PlayPurpose>; shared: boolean; sharedPurposes: Set<PlayPurpose> }>();
  for (const item of collected) {
    const ids = PLAY_DATA_IDS[item.type];
    let entry = byPlayType.get(ids.response);
    if (!entry) byPlayType.set(ids.response, (entry = { label: DATA_TYPES[item.type].play.type, purposes: new Set(), shared: false, sharedPurposes: new Set() }));
    for (const p of item.purposes) entry.purposes.add(p);
    if (item.shared) {
      entry.shared = true;
      for (const p of item.sharedPurposes ?? item.purposes) entry.sharedPurposes.add(p);
    }
  }

  if (byPlayType.size && set('PSL_DATA_COLLECTION_COLLECTS_PERSONAL_DATA', '', 'true', 'Collects or shares user data')) {
    changes.push('Does your app collect or share user data? Yes');
  }

  const todo: string[] = [];
  const purposeTodo: string[] = [];
  for (const [response, { label, purposes, shared, sharedPurposes }] of byPlayType) {
    const question = Object.values(PLAY_DATA_IDS).find((x) => x.response === response)!.question;
    const done: string[] = [];
    if (set(question, response, 'true', label)) done.push('selected');

    const usage = `PSL_DATA_USAGE_RESPONSES:${response}`;
    if (set(`${usage}:PSL_DATA_USAGE_COLLECTION_AND_SHARING`, 'PSL_DATA_USAGE_ONLY_COLLECTED', 'true', `${label}: collected`)) done.push('collected');
    // The SDKs in the rules send data to their servers and keep it, so it is not processed ephemerally.
    if (set(`${usage}:PSL_DATA_USAGE_EPHEMERAL`, '', 'false', `${label}: ephemeral`)) done.push('not ephemeral');

    const purposeLabels: string[] = [];
    for (const p of purposes) {
      const name = PLAY_PURPOSES[p].label;
      if (set(`${usage}:DATA_USAGE_COLLECTION_PURPOSE`, PLAY_PURPOSE_IDS[p], 'true', `${label}: purpose ${name}`)) purposeLabels.push(name);
    }
    if (purposeLabels.length) done.push(`purposes: ${purposeLabels.join(', ')}`);
    if (!purposes.size) purposeTodo.push(label);
    // An SDK that says the data is shared (for example an ad network) shares it for the same purposes.
    if (shared) {
      if (set(`${usage}:PSL_DATA_USAGE_COLLECTION_AND_SHARING`, 'PSL_DATA_USAGE_ONLY_SHARED', 'true', `${label}: shared`)) done.push('shared');
      for (const p of sharedPurposes) set(`${usage}:DATA_USAGE_SHARING_PURPOSE`, PLAY_PURPOSE_IDS[p], 'true', `${label}: sharing purpose ${PLAY_PURPOSES[p].label}`);
    }
    if (done.length) changes.push(`${label}: ${done.join(', ')}`);

    const control = ['PSL_DATA_USAGE_USER_CONTROL_OPTIONAL', 'PSL_DATA_USAGE_USER_CONTROL_REQUIRED']
      .map((id) => index.get(`${usage}:DATA_USAGE_USER_CONTROL\u0000${id}`));
    if (control.every((r) => r && !isOn(r))) todo.push(label);
  }

  return { content: toCsv(rows, eol, trailingNewline), changes, missingRows, todo, purposeTodo };
}
