export function versionParts(value: string): { numbers: number[]; pre: string[] } | undefined {
  const match = value.match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  return match ? { numbers: match.slice(1, 4).map(Number), pre: match[4]?.split('.') ?? [] } : undefined;
}

export type VersionUpdateKind = 'major' | 'minor' | 'patch' | 'available';

export function versionUpdateKind(current: string, latest: string | undefined): VersionUpdateKind {
  if (!latest) return 'available';
  const left = versionParts(current), right = versionParts(latest);
  if (!left || !right || left.pre.length || right.pre.length || left.numbers[0] === 0 || right.numbers[0] === 0) return 'available';
  if (left.numbers[0] !== right.numbers[0]) return 'major';
  if (left.numbers[1] !== right.numbers[1]) return 'minor';
  if (left.numbers[2] !== right.numbers[2]) return 'patch';
  return 'available';
}

export function compareVersions(a: string, b: string): number {
  const left = versionParts(a), right = versionParts(b);
  if (!left || !right) return left ? -1 : right ? 1 : a.localeCompare(b);
  for (let i = 0; i < 3; i++) if (left.numbers[i] !== right.numbers[i]) return left.numbers[i] - right.numbers[i];
  if (!left.pre.length || !right.pre.length) return left.pre.length ? -1 : right.pre.length ? 1 : 0;
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i], y = right.pre[i];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    return xn && yn ? Number(x) - Number(y) : xn ? -1 : yn ? 1 : x.localeCompare(y);
  }
  return 0;
}
