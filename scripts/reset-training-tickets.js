/**
 * reset-training-tickets.js
 *
 * Delete all training-category tickets and replace them with the Anthropic
 * Academy curriculum assigned to every active team member.
 *
 * Run from the dashboard directory:
 *   node scripts/reset-training-tickets.js
 *
 * In Railway prod:
 *   railway run node scripts/reset-training-tickets.js
 */

const Database = require('better-sqlite3');
const path = require('path');
const { resetTrainingTickets } = require('./training-curriculum');

const dbPath = path.join(__dirname, '..', 'prism.db');
const db = new Database(dbPath);
db.pragma('foreign_keys = ON');

const result = resetTrainingTickets(db);

console.log(`Deleted ${result.deleted} existing training tickets.`);
console.log(`Inserted ${result.inserted} new training tickets.`);
console.log('\nBy assignee:');
for (const [name, count] of Object.entries(result.byAssignee)) {
  console.log(`  ${name}: ${count}`);
}

db.close();
