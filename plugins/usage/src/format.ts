export function formatCurrencyAmounts(
  amounts: Readonly<Record<string, number>>,
): string {
  const entries = Object.entries(amounts);
  if (entries.length === 0) {
    return "no cost";
  }
  return entries
    .map(([currency, amount]) => `${currency} ${amount.toFixed(4)}`)
    .join(" + ");
}
