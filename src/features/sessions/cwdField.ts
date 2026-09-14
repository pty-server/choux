const trailingSeparators = /[\\/]+$/;
const leadingSeparator = /^[\\/]/;

function trimTrailingSeparators(path: string): string {
  return path.replace(trailingSeparators, "") || path;
}

export function cwdFieldValue(picked: string, root: string): string {
  const base = trimTrailingSeparators(root);
  const target = trimTrailingSeparators(picked);
  if (target === base) return "";
  if (!target.startsWith(base)) return target;
  const rest = target.slice(base.length);
  if (trailingSeparators.test(base)) return rest;
  return leadingSeparator.test(rest) ? rest.slice(1) : target;
}
