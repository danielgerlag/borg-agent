interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease?: readonly string[];
}

const VERSION_PATTERN =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function parseVersion(value: string): Version | undefined {
  const match = VERSION_PATTERN.exec(value.trim());
  if (!match) {
    return undefined;
  }

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) {
    return undefined;
  }

  const prerelease = match[4]?.split(".");
  if (
    prerelease?.some(
      (identifier) => /^\d+$/.test(identifier) && identifier.length > 1 && identifier[0] === "0",
    )
  ) {
    return undefined;
  }

  return prerelease === undefined
    ? { major, minor, patch }
    : { major, minor, patch, prerelease };
}

function compare(left: Version, right: Version): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) {
      return left[key] < right[key] ? -1 : 1;
    }
  }

  if (left.prerelease === undefined && right.prerelease === undefined) {
    return 0;
  }
  if (left.prerelease === undefined) {
    return 1;
  }
  if (right.prerelease === undefined) {
    return -1;
  }

  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = left.prerelease[index];
    const rightIdentifier = right.prerelease[index];
    if (leftIdentifier === undefined) {
      return -1;
    }
    if (rightIdentifier === undefined) {
      return 1;
    }
    if (leftIdentifier === rightIdentifier) {
      continue;
    }

    const leftNumeric = /^\d+$/.test(leftIdentifier);
    const rightNumeric = /^\d+$/.test(rightIdentifier);
    if (leftNumeric && rightNumeric) {
      return leftIdentifier.length === rightIdentifier.length
        ? leftIdentifier < rightIdentifier
          ? -1
          : 1
        : leftIdentifier.length < rightIdentifier.length
          ? -1
          : 1;
    }
    if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    }
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }
  return 0;
}

function satisfiesComparator(version: Version, comparator: string): boolean | undefined {
  const match = /^(>=|<=|>|<|=)?\s*(\S+)$/.exec(comparator);
  if (!match) {
    return undefined;
  }

  const target = parseVersion(match[2] ?? "");
  if (!target) {
    return undefined;
  }

  const result = compare(version, target);
  switch (match[1] ?? "=") {
    case ">":
      return result > 0;
    case ">=":
      return result >= 0;
    case "<":
      return result < 0;
    case "<=":
      return result <= 0;
    case "=":
      return result === 0;
  }

  return false;
}

function satisfiesSimpleRange(version: Version, range: string): boolean | undefined {
  const trimmed = range.trim();
  if (trimmed === "" || trimmed === "*") {
    return true;
  }

  const wildcard = /^(0|[1-9]\d*)\.(?:(0|[1-9]\d*)\.)?(?:x|\*)$/i.exec(
    trimmed,
  );
  if (wildcard) {
    const major = Number(wildcard[1]);
    const minor = wildcard[2];
    return version.major === major && (minor === undefined || version.minor === Number(minor));
  }

  if (trimmed.startsWith("^") || trimmed.startsWith("~")) {
    const lower = parseVersion(trimmed.slice(1));
    if (!lower) {
      return undefined;
    }
    if (compare(version, lower) < 0) {
      return false;
    }

    const upper =
      trimmed[0] === "~"
        ? { major: lower.major, minor: lower.minor + 1, patch: 0 }
        : lower.major > 0
          ? { major: lower.major + 1, minor: 0, patch: 0 }
          : lower.minor > 0
            ? { major: 0, minor: lower.minor + 1, patch: 0 }
            : { major: 0, minor: 0, patch: lower.patch + 1 };

    return compare(version, upper) < 0;
  }

  const comparators = trimmed.split(/\s+/);
  const results = comparators.map((comparator) =>
    satisfiesComparator(version, comparator),
  );
  return results.some((result) => result === undefined)
    ? undefined
    : results.every((result) => result === true);
}

export function satisfiesBorgEngine(range: string, currentVersion: string): boolean {
  const version = parseVersion(currentVersion);
  if (!version) {
    return false;
  }

  if (version.prerelease !== undefined && !range.includes("-")) {
    return false;
  }

  const alternatives = range.split("||");
  if (alternatives.some((part) => part.trim() === "")) {
    return false;
  }

  const results = alternatives.map((part) => satisfiesSimpleRange(version, part));
  return results.some((result) => result === undefined)
    ? false
    : results.some((result) => result === true);
}
