'use strict';

const cache = require('./cacheService');

let stripe = null;

function init() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    console.warn('[stripe] STRIPE_SECRET_KEY not set — Stripe features disabled');
    return;
  }
  stripe = require('stripe')(key);
  console.log('[stripe] Initialized');
}

function isConnected() {
  return stripe !== null;
}

async function getBalance() {
  if (!stripe) return { data: null, error: 'Stripe not configured' };
  const cached = cache.get('stripe:balance');
  if (cached && !cached.stale) return { data: cached.data };
  try {
    const balance = await stripe.balance.retrieve();
    const result = {
      available: (balance.available || []).map(b => ({ amount: b.amount / 100, currency: b.currency })),
      pending: (balance.pending || []).map(b => ({ amount: b.amount / 100, currency: b.currency })),
      availableTotal: (balance.available || []).reduce((s, b) => s + b.amount, 0) / 100,
      pendingTotal: (balance.pending || []).reduce((s, b) => s + b.amount, 0) / 100,
    };
    cache.set('stripe:balance', result, cache.DEFAULT_TTLS.balance);
    return { data: result };
  } catch (err) {
    if (cached) return { data: cached.data, stale: true, error: err.message };
    return { data: null, error: err.message };
  }
}

async function getCustomers(limit = 100) {
  if (!stripe) return { data: [], error: 'Stripe not configured' };
  const cached = cache.get('stripe:customers');
  if (cached && !cached.stale) return { data: cached.data };
  try {
    const result = await stripe.customers.list({ limit });
    const customers = result.data.map(c => ({
      id: c.id,
      name: c.name || c.email || 'Unknown',
      email: c.email,
      created: c.created,
      currency: c.currency,
      delinquent: c.delinquent,
    }));
    cache.set('stripe:customers', customers, cache.DEFAULT_TTLS.customers);
    return { data: customers };
  } catch (err) {
    if (cached) return { data: cached.data, stale: true, error: err.message };
    return { data: [], error: err.message };
  }
}

async function getPaymentIntents(limit = 50) {
  if (!stripe) return { data: [], error: 'Stripe not configured' };
  const cached = cache.get('stripe:payments');
  if (cached && !cached.stale) return { data: cached.data };
  try {
    const result = await stripe.paymentIntents.list({ limit });
    const payments = result.data.map(pi => ({
      id: pi.id,
      amount: pi.amount / 100,
      currency: pi.currency,
      status: pi.status,
      created: new Date(pi.created * 1000).toISOString(),
      description: pi.description,
      customerEmail: pi.receipt_email,
      paymentMethod: pi.payment_method_types ? pi.payment_method_types[0] : null,
    }));
    cache.set('stripe:payments', payments, cache.DEFAULT_TTLS.payments);
    return { data: payments };
  } catch (err) {
    if (cached) return { data: cached.data, stale: true, error: err.message };
    return { data: [], error: err.message };
  }
}

async function getSubscriptions(limit = 50) {
  if (!stripe) return { data: [], error: 'Stripe not configured' };
  const cached = cache.get('stripe:subscriptions');
  if (cached && !cached.stale) return { data: cached.data };
  try {
    const result = await stripe.subscriptions.list({ limit, status: 'active' });
    const subs = result.data.map(s => ({
      id: s.id,
      customerId: s.customer,
      status: s.status,
      currentPeriodStart: new Date(s.current_period_start * 1000).toISOString(),
      currentPeriodEnd: new Date(s.current_period_end * 1000).toISOString(),
      items: s.items.data.map(i => ({
        priceId: i.price.id,
        productId: i.price.product,
        amount: i.price.unit_amount / 100,
        currency: i.price.currency,
        interval: i.price.recurring ? i.price.recurring.interval : null,
      })),
    }));
    cache.set('stripe:subscriptions', subs, cache.DEFAULT_TTLS.invoices);
    return { data: subs };
  } catch (err) {
    if (cached) return { data: cached.data, stale: true, error: err.message };
    return { data: [], error: err.message };
  }
}

async function getProducts() {
  if (!stripe) return { data: [], error: 'Stripe not configured' };
  const cached = cache.get('stripe:products');
  if (cached && !cached.stale) return { data: cached.data };
  try {
    const [products, prices] = await Promise.all([
      stripe.products.list({ limit: 100, active: true }),
      stripe.prices.list({ limit: 100, active: true }),
    ]);
    const result = products.data.map(p => ({
      id: p.id,
      name: p.name,
      description: p.description,
      prices: prices.data
        .filter(pr => pr.product === p.id)
        .map(pr => ({
          id: pr.id,
          amount: pr.unit_amount / 100,
          currency: pr.currency,
          type: pr.type,
          interval: pr.recurring ? pr.recurring.interval : null,
        })),
    }));
    cache.set('stripe:products', result, cache.DEFAULT_TTLS.customers);
    return { data: result };
  } catch (err) {
    if (cached) return { data: cached.data, stale: true, error: err.message };
    return { data: [], error: err.message };
  }
}

module.exports = { init, isConnected, getBalance, getCustomers, getPaymentIntents, getSubscriptions, getProducts };
