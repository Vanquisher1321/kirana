/**
 * Where the goods go.
 *
 * A checkout that moves money and never asks for a destination is not a
 * checkout: the merchant is paid and has no idea what to ship or where. This
 * module is the destination half of the same decision the cap is the money half
 * of, and both are made by the same person at the same moment.
 *
 * THE ADDRESS IS THE HUMAN'S, NEVER THE AGENT'S.
 *
 * That is the load-bearing rule here, and it is a security property rather than
 * a preference. Every other guard in this system bounds how MUCH an agent can
 * spend; none of them bound where the goods land. An agent that could name the
 * delivery address would not need to exceed a cap to steal — it could have a
 * human approve a perfectly reasonable basket and quietly ship it somewhere
 * else. So there is no tool argument, anywhere on the MCP surface, that reaches
 * this: an address arrives from the console, on the approval, from the person
 * whose money it is.
 *
 * The agent never reads one back either. It is given to the merchant who has to
 * fulfil the order and to the buyer who gave it, and to nobody else.
 */

export interface Delivery {
  name: string;
  phone: string;
  line1: string;
  line2: string;
  city: string;
  state: string;
  pincode: string;
}

export class DeliveryError extends Error {
  code: string;
  field: string;
  constructor(code: string, field: string, message: string) {
    super(message);
    this.name = 'DeliveryError';
    this.code = code;
    this.field = field;
  }
}

/**
 * Flatten before length is measured.
 *
 * This text is rendered in a merchant's console, so it is scrubbed the same way
 * a shop's own name is before it reaches a buyer agent: every control character
 * and Unicode line separator out, whitespace collapsed. U+2028 is included
 * because many renderers treat it as a hard break, which is exactly the framing
 * a fake line of an address would need.
 */
function flatten(value: unknown): string {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function bounded(field: string, value: unknown, min: number, max: number, label: string): string {
  const v = flatten(value);
  if (v.length < min) throw new DeliveryError('incomplete', field, `${label} is required.`);
  if (v.length > max) throw new DeliveryError('too_long', field, `${label} cannot be longer than ${max} characters.`);
  return v;
}

/**
 * Indian mobile numbers: ten digits beginning 6-9, with an optional +91 or 0
 * that people type out of habit and that no merchant wants to see stored.
 */
function phone(value: unknown): string {
  const digits = flatten(value).replace(/[^\d]/g, '').replace(/^(?:91|0)(?=\d{10}$)/, '');
  if (!/^[6-9]\d{9}$/.test(digits)) {
    throw new DeliveryError('bad_phone', 'phone', 'A 10-digit Indian mobile number is required, so the courier can call.');
  }
  return digits;
}

/** Six digits, never starting at zero. A wrong PIN is an undeliverable order. */
function pincode(value: unknown): string {
  const digits = flatten(value).replace(/[^\d]/g, '');
  if (!/^[1-9]\d{5}$/.test(digits)) {
    throw new DeliveryError('bad_pincode', 'pincode', 'A 6-digit PIN code is required.');
  }
  return digits;
}

/**
 * Validate at the boundary and store only the validated shape.
 *
 * Refusing a malformed address here costs the person one correction while they
 * are still looking at the screen. Accepting it costs the merchant a parcel
 * that comes back a week later, and the buyer their money in the meantime.
 */
export function parseDelivery(input: unknown): Delivery {
  if (!input || typeof input !== 'object') {
    throw new DeliveryError('missing', 'delivery', 'A delivery address is required before anything can be charged.');
  }
  const d = input as Record<string, unknown>;
  return {
    name: bounded('name', d.name, 2, 80, 'A name for the delivery'),
    phone: phone(d.phone),
    line1: bounded('line1', d.line1, 3, 120, 'The street address'),
    // The only optional field: plenty of addresses are one line.
    line2: flatten(d.line2).slice(0, 120),
    city: bounded('city', d.city, 2, 60, 'The town or city'),
    state: bounded('state', d.state, 2, 60, 'The state'),
    pincode: pincode(d.pincode),
  };
}

/** Round-trips through the database column. Null when nothing was stored. */
export function readDelivery(stored: unknown): Delivery | null {
  if (typeof stored !== 'string' || stored.length === 0) return null;
  try {
    const parsed = JSON.parse(stored) as Record<string, unknown>;
    return {
      name: String(parsed.name ?? ''), phone: String(parsed.phone ?? ''),
      line1: String(parsed.line1 ?? ''), line2: String(parsed.line2 ?? ''),
      city: String(parsed.city ?? ''), state: String(parsed.state ?? ''),
      pincode: String(parsed.pincode ?? ''),
    };
  } catch {
    return null;
  }
}

/** One line for a console, a label, or an audit note. */
export function formatDelivery(d: Delivery): string {
  return [d.line1, d.line2, d.city, d.state, d.pincode].filter(Boolean).join(', ');
}

/**
 * What may safely be said about an address without disclosing it.
 *
 * The audit trail is read by the platform view and by tenants, and an address
 * is the most personal thing this system holds. The ledger records that a
 * destination was given and enough to recognise it in a support call -- never
 * the street.
 */
export function deliveryRef(d: Delivery): { city: string; pincode: string; phoneLast4: string } {
  return { city: d.city, pincode: d.pincode, phoneLast4: d.phone.slice(-4) };
}
