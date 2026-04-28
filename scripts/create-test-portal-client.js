#!/usr/bin/env node
/**
 * Create (or reset) a test client account Michele can use to test the portal flow.
 *
 * Run:   node scripts/create-test-portal-client.js
 * Output: prints the email + password at the end.
 *
 * Idempotent — running it twice replaces the password so she doesn't have to
 * remember which one it is.
 */
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const db = new Database(path.join(__dirname, '..', 'prism.db'));

const EMAIL = 'portal-test@prismaianalytics.com';
const PASSWORD = 'PortalTest2026!';
const COMPANY = 'Portal Test Account';
const FIRST = 'Portal';
const LAST = 'Tester';

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}
function uuid() {
  return crypto.randomUUID();
}

const salt = crypto.randomBytes(16).toString('hex');
const passwordHash = hashPassword(PASSWORD, salt);

const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(EMAIL);

const tx = db.transaction(() => {
  let clientId, userId;

  if (existing) {
    // Reset password on existing account; keep linked contact + client
    userId = existing.id;
    db.prepare('UPDATE users SET password_hash = ?, salt = ?, role = ? WHERE id = ?')
      .run(passwordHash, salt, 'client', userId);
    const c = db.prepare('SELECT client_id FROM contacts WHERE email = ? LIMIT 1').get(EMAIL);
    clientId = c && c.client_id;
    if (!clientId) {
      clientId = uuid();
      db.prepare('INSERT INTO clients (id, company_name, crm_status) VALUES (?, ?, ?)').run(clientId, COMPANY, 'Active Client');
      db.prepare('INSERT INTO contacts (id, client_id, first_name, last_name, email, is_primary) VALUES (?, ?, ?, ?, ?, 1)')
        .run(uuid(), clientId, FIRST, LAST, EMAIL);
    }
    console.log('[reset] existing test account password reset');
  } else {
    clientId = uuid();
    userId = uuid();
    db.prepare('INSERT INTO clients (id, company_name, crm_status) VALUES (?, ?, ?)').run(clientId, COMPANY, 'Active Client');
    db.prepare('INSERT INTO contacts (id, client_id, first_name, last_name, email, is_primary) VALUES (?, ?, ?, ?, ?, 1)')
      .run(uuid(), clientId, FIRST, LAST, EMAIL);
    db.prepare('INSERT INTO users (id, username, password_hash, salt, role) VALUES (?, ?, ?, ?, ?)')
      .run(userId, EMAIL, passwordHash, salt, 'client');
    console.log('[created] new test client account');
  }

  return { clientId, userId };
});

const { clientId, userId } = tx();

console.log('');
console.log('Test portal account ready');
console.log('─────────────────────────────────────────────');
console.log('  URL:       http://localhost:3000/login');
console.log('  Email:     ' + EMAIL);
console.log('  Password:  ' + PASSWORD);
console.log('  Role:      client');
console.log('  Company:   ' + COMPANY);
console.log('  ClientId:  ' + clientId);
console.log('─────────────────────────────────────────────');
console.log('Sign in via the Password tab, or request a magic link.');
console.log('You can rerun this script anytime to reset the password.');
