/**
 * Money helpers. Every value in this system is an integer number of minor units.
 *
 * parseFloat("499.10") * 100 === 49909.999999999993, and a payments project that
 * ships that bug deserves to lose. So decimal strings are parsed as strings.
 */

export class MoneyError extends Error {}

/** "499.00" | "499" | "1,499.50" | 499.5 -> 49900 | 49900 | 149950 | 49950 */
export function toMinor(input: string | number, decimals = 2): number {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new MoneyError(`Non-finite amount: ${input}`);
    return toMinor(input.toFixed(decimals), decimals);
  }
  const cleaned = input.trim().replace(/[,\s ]/g, '').replace(/^(₹|Rs\.?|INR)/i, '');
  if (!/^-?\d*(\.\d*)?$/.test(cleaned) || cleaned === '' || cleaned === '.') {
    throw new MoneyError(`Unparseable amount: ${JSON.stringify(input)}`);
  }
  const negative = cleaned.startsWith('-');
  const body = negative ? cleaned.slice(1) : cleaned;
  const [whole = '0', frac = ''] = body.split('.');
  const paddedFrac = frac.padEnd(decimals, '0').slice(0, decimals);
  const minor = Number(`${whole || '0'}${paddedFrac}`);
  if (!Number.isSafeInteger(minor)) throw new MoneyError(`Amount out of range: ${input}`);
  return negative ? -minor : minor;
}

/** 49900 -> "499.00" */
export function fromMinor(minor: number, decimals = 2): string {
  const negative = minor < 0;
  const s = String(Math.abs(minor)).padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals);
  return `${negative ? '-' : ''}${whole}${decimals ? '.' + frac : ''}`;
}

/** 49900 -> "₹499.00" with Indian digit grouping. */
export function formatInr(minor: number): string {
  const [whole = '0', frac = '00'] = fromMinor(minor).split('.');
  const neg = whole.startsWith('-');
  const digits = neg ? whole.slice(1) : whole;
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3);
  const grouped = rest ? rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3 : last3;
  return `${neg ? '-' : ''}₹${grouped}.${frac}`;
}
