export function versionParts(value: string): { numbers: number[]; pre: string[] } | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
  if (!match) return undefined;
  return { numbers: match.slice(1, 4).map(Number), pre: match[4]?.split('.') ?? [] };
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
  if (!left && !right) return a.localeCompare(b);
  if (!left) return 1;
  if (!right) return -1;

  const numberComparison = compareNumberParts(left.numbers, right.numbers);
  if (numberComparison !== 0) return numberComparison;
  return comparePrereleaseParts(left.pre, right.pre);
}

function compareNumberParts(left: number[], right: number[]): number {
  for (let index = 0; index < left.length; index++) {
    const difference = left[index] - right[index];
    if (difference !== 0) return difference;
  }
  return 0;
}

function comparePrereleaseParts(left: string[], right: string[]): number {
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;

  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const leftPart = left[index], rightPart = right[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;

    const comparison = comparePrereleaseIdentifiers(leftPart, rightPart);
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function comparePrereleaseIdentifiers(left: string, right: string): number {
  if (left === right) return 0;
  const leftIsNumeric = /^\d+$/.test(left), rightIsNumeric = /^\d+$/.test(right);
  if (leftIsNumeric && rightIsNumeric) return Number(left) - Number(right);
  if (leftIsNumeric) return -1;
  if (rightIsNumeric) return 1;
  return left.localeCompare(right);
}
