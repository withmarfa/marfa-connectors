export interface Scope {
  admits(fullName: string): boolean;
  unmatched(fullNames: Iterable<string>): string[];
}

// Loose on purpose: a typo is named as unmatched rather than refused.
const entry = /^[a-z0-9_.-]+\/(?:\*|[a-z0-9_.-]+)$/;

export function scopeOf(value: string | undefined): Scope | undefined {
  if (value === undefined) return undefined;
  const entries = value
    .split(/[\s,]+/)
    .filter((one) => one !== "")
    .map((one) => one.toLowerCase());
  const malformed = entries.filter((one) => !entry.test(one));
  if (malformed.length > 0) {
    throw new Error(
      `GITHUB_REPOSITORIES holds ${malformed.join(", ")}, where each is owner/repo or owner/*`,
    );
  }
  if (entries.length === 0) return undefined;
  const matches = (one: string, fullName: string): boolean => {
    const name = fullName.toLowerCase();
    return one.endsWith("/*")
      ? name.startsWith(one.slice(0, -1))
      : name === one;
  };
  return {
    admits: (fullName) => entries.some((one) => matches(one, fullName)),
    unmatched: (fullNames) => {
      const names = [...fullNames];
      return entries.filter((one) => !names.some((name) => matches(one, name)));
    },
  };
}
