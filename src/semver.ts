/**
 * A tiny semver range matcher for rule `versions`, so the package has no extra dependency.
 *
 * Supported: exact versions (`6.1.0`), comparators (`>=6`, `<7.2.0`, `>1`, `<=2.0`),
 * caret and tilde (`^6.1.0`, `~6.1`), x-ranges (`6.x`, `6`, `*`), comparators joined
 * by spaces (AND) and `||` (OR). Pre-release tags are ignored.
 */
type Version = [number, number, number];

function parse(v: string): Version | null {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : null;
}

function compare(a: Version, b: Version): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** Number of version parts given (`6` = 1, `6.1` = 2, `6.1.0` = 3); `x` and `*` end the count. */
function precision(v: string): number {
  const parts = v.replace(/^v/, '').split('-')[0].split('.');
  const n = parts.findIndex((p) => !/^\d+$/.test(p));
  return n === -1 ? Math.min(parts.length, 3) : n;
}

/** The first version above a partial version: `6` gives 7.0.0, `6.1` gives 6.2.0. */
function bump(v: Version, level: number): Version {
  if (level <= 0) return [v[0] + 1, 0, 0];
  if (level === 1) return [v[0], v[1] + 1, 0];
  return [v[0], v[1], v[2] + 1];
}

function satisfiesComparator(version: Version, comp: string): boolean {
  if (comp === '*' || comp === 'x' || comp === '') return true;
  const m = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(comp);
  if (!m) return false;
  const [, op = '', raw] = m;
  const target = parse(raw);
  if (!target) return raw === '*' || raw === 'x';
  const prec = precision(raw);
  const cmp = compare(version, target);

  switch (op) {
    case '>=': return cmp >= 0;
    case '<=': return prec < 3 ? compare(version, bump(target, prec - 1)) < 0 : cmp <= 0;
    case '>': return prec < 3 ? compare(version, bump(target, prec - 1)) >= 0 : cmp > 0;
    case '<': return cmp < 0;
    case '^': {
      // ^6.1.0 := >=6.1.0 <7.0.0, ^0.2.3 := >=0.2.3 <0.3.0, ^0.0.3 := >=0.0.3 <0.0.4
      const level = target[0] > 0 || prec === 1 ? 0 : target[1] > 0 || prec === 2 ? 1 : 2;
      return cmp >= 0 && compare(version, bump(target, level)) < 0;
    }
    case '~': return cmp >= 0 && compare(version, bump(target, prec >= 2 ? 1 : 0)) < 0;
    default: // exact or x-range
      return prec >= 3 ? cmp === 0 : cmp >= 0 && compare(version, bump(target, prec - 1)) < 0;
  }
}

/** True when `version` is inside `range`. An unreadable version never matches. */
export function satisfies(version: string, range: string): boolean {
  const v = parse(version);
  if (!v) return false;
  return range.split('||').some((set) => {
    const comps = set.trim().replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1').split(/\s+/).filter(Boolean);
    return comps.every((comp) => satisfiesComparator(v, comp));
  });
}
