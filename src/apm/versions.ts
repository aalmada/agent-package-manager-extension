export function versionParts(value: string): { numbers: number[]; pre: string[] } | undefined {
  const match = value.match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  return match ? { numbers: match.slice(1, 4).map(Number), pre: match[4]?.split('.') ?? [] } : undefined;
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
