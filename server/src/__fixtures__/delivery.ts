import type { Delivery } from '../checkout/delivery.ts';

/**
 * One valid address, for the tests that need a consent to be spendable rather
 * than to be about addresses.
 *
 * Kept here so that a test asserting something else -- a cap, a race, a webhook
 * -- says `delivery: SAMPLE_DELIVERY` and moves on. The tests that are actually
 * about the destination build their own, deliberately malformed or deliberately
 * different, in the file that is about it.
 */
export const SAMPLE_DELIVERY: Delivery = {
  name: 'Test Buyer',
  phone: '9876543210',
  line1: '12 Church Street',
  line2: 'Near the coffee place',
  city: 'Bengaluru',
  state: 'Karnataka',
  pincode: '560001',
};
