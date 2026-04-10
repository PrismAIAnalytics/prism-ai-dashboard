'use strict';

const store = new Map();

const DEFAULT_TTLS = {
  balance: 300,       // 5 min
  kpis: 300,          // 5 min
  payments: 600,      // 10 min
  pnl: 900,           // 15 min
  invoices: 900,      // 15 min
  customers: 3600,    // 60 min
  company: 3600,      // 60 min
};

function get(key) {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) return { data: entry.data, stale: true, updatedAt: entry.updatedAt };
  return { data: entry.data, stale: false, updatedAt: entry.updatedAt };
}

function set(key, data, ttlSeconds) {
  const ttl = ttlSeconds || DEFAULT_TTLS.pnl;
  store.set(key, {
    data,
    expiresAt: Date.now() + ttl * 1000,
    updatedAt: new Date().toISOString(),
  });
}

function invalidate(key) {
  if (key) {
    store.delete(key);
  }
}

function invalidateAll() {
  const count = store.size;
  store.clear();
  return count;
}

function getUpdatedAt(key) {
  const entry = store.get(key);
  return entry ? entry.updatedAt : null;
}

module.exports = { get, set, invalidate, invalidateAll, getUpdatedAt, DEFAULT_TTLS };
