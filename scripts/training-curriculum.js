/**
 * Shared training-curriculum reset logic.
 * Used by both the CLI script (scripts/reset-training-tickets.js) and
 * the admin endpoint (POST /api/admin/reset-training-tickets).
 */

const crypto = require('crypto');

const uuid = () => crypto.randomUUID();
const addDays = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);

const CURRICULUM = [
  { title: 'Claude 101 — Intro to Claude Cowork',
    desc: 'Anthropic Academy intro course. Fundamental Claude concepts and Cowork collaborative features.',
    status: 'todo', priority: 'high', due: 14,
    tags: 'anthropic,training,course' },
  { title: 'AI Fluency: Framework & Foundations',
    desc: 'Anthropic Academy — 4 hours, 15 lessons. Core framework for working effectively with AI.',
    status: 'todo', priority: 'high', due: 21,
    tags: 'anthropic,training,course' },
  { title: 'Real-World Prompting',
    desc: 'Anthropic Academy — advanced prompt engineering patterns for production use cases.',
    status: 'todo', priority: 'high', due: 28,
    tags: 'anthropic,training,course' },
  { title: 'Claude Code in Action',
    desc: 'Anthropic Academy — practical applications of Claude Code functionality, agents, and workflows.',
    status: 'backlog', priority: 'high', due: 42,
    tags: 'anthropic,training,course' },
  { title: 'Building with Claude API',
    desc: 'Anthropic Academy — 6 hours, 20 lessons. API development, tool use, streaming, prompt caching.',
    status: 'backlog', priority: 'medium', due: 56,
    tags: 'anthropic,training,course' },
  { title: 'Model Context Protocol (MCP)',
    desc: 'Anthropic Academy — building MCP servers, integrations, and working with Claude context capabilities.',
    status: 'backlog', priority: 'medium', due: 70,
    tags: 'anthropic,training,course' },
  { title: 'CCA — Claude Code Config & Workflows domain',
    desc: 'Claude Certified Architect prep: work through all 7 items in the Claude Code Config & Workflows domain.',
    status: 'backlog', priority: 'high', due: 56,
    tags: 'anthropic,cca,training,certification' },
  { title: 'CCA — Agentic Architecture & Orchestration domain',
    desc: 'Claude Certified Architect prep: work through all 7 items in the Agentic Architecture & Orchestration domain.',
    status: 'backlog', priority: 'high', due: 70,
    tags: 'anthropic,cca,training,certification' },
  { title: 'CCA — Prompt Engineering & Design domain',
    desc: 'Claude Certified Architect prep: work through all 7 items in the Prompt Engineering & Design domain.',
    status: 'backlog', priority: 'medium', due: 84,
    tags: 'anthropic,cca,training,certification' },
  { title: 'CCA — Tool Design & MCP Integration domain',
    desc: 'Claude Certified Architect prep: work through all 7 items in the Tool Design & MCP Integration domain.',
    status: 'backlog', priority: 'medium', due: 98,
    tags: 'anthropic,cca,training,certification' },
  { title: 'CCA — Context Management & Optimization domain',
    desc: 'Claude Certified Architect prep: work through all 7 items in the Context Management & Optimization domain.',
    status: 'backlog', priority: 'medium', due: 112,
    tags: 'anthropic,cca,training,certification' },
  { title: 'CCA — Foundations (proctored exam)',
    desc: 'Claude Certified Architect — Foundations. Proctored 60-question architecture exam. 120 min. Pass: 720/1000.',
    status: 'backlog', priority: 'high', due: 126,
    tags: 'anthropic,cca,training,certification,exam' },
];

/**
 * Delete all training-category tickets and re-seed the Anthropic curriculum
 * for every active team member.
 * @param {import('better-sqlite3').Database} db
 * @returns {{ deleted: number, inserted: number, byAssignee: Object<string, number> }}
 */
function resetTrainingTickets(db) {
  const existing = db.prepare("SELECT id FROM tickets WHERE category = 'training'").all();
  const delComments = db.prepare('DELETE FROM ticket_comments WHERE ticket_id = ?');
  const delTicket = db.prepare('DELETE FROM tickets WHERE id = ?');

  db.transaction(() => {
    for (const { id } of existing) {
      delComments.run(id);
      delTicket.run(id);
    }
  })();

  const assignees = db.prepare(
    "SELECT id, first_name FROM team_members WHERE status = 'active' ORDER BY first_name"
  ).all();

  if (assignees.length === 0) {
    throw new Error('No active team members — cannot seed training tickets.');
  }

  const ins = db.prepare(`INSERT INTO tickets
    (id, title, description, ticket_type, category, status, priority, assigned_to, due_date, tags, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  const byAssignee = {};
  let inserted = 0;

  db.transaction(() => {
    for (const assignee of assignees) {
      byAssignee[assignee.first_name] = 0;
      for (const c of CURRICULUM) {
        ins.run(
          uuid(),
          c.title,
          c.desc,
          'internal',
          'training',
          c.status,
          c.priority,
          assignee.id,
          addDays(c.due),
          c.tags,
          'system'
        );
        byAssignee[assignee.first_name]++;
        inserted++;
      }
    }
  })();

  return { deleted: existing.length, inserted, byAssignee };
}

module.exports = { CURRICULUM, resetTrainingTickets };
