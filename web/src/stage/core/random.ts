export type Random = () => number;

export function weightedPick<T extends { weight?: number }>(items: readonly T[], random: Random): T | null {
  const total = items.reduce((sum, item) => sum + (item.weight ?? 1), 0);
  if (total <= 0) return null;
  let r = random() * total;
  for (const item of items) {
    r -= item.weight ?? 1;
    if (r < 0) return item;
  }
  return items[items.length - 1];
}
