// Stripe SDK singleton.

import Stripe from 'stripe';
import { env } from '../env.js';

let client: Stripe | null = null;

export function stripe(): Stripe {
  if (!env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY not configured');
  if (!client) {
    client = new Stripe(env.STRIPE_SECRET_KEY, {
      // Pin a stable API version. Update intentionally.
      apiVersion: '2024-09-30.acacia' as Stripe.LatestApiVersion,
      appInfo: { name: 'feedsorter-api', version: '0.1.0' },
    });
  }
  return client;
}
