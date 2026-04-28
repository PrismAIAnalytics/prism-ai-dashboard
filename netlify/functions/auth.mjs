import { randomBytes, createHash } from 'crypto';

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

// In-memory session store (persists across warm invocations, cleared on cold start)
const sessions = new Map();

function generateToken() {
  return randomBytes(32).toString('hex');
}

// Users from env vars: DASHBOARD_USERS=username:password,username2:password2
function getUsers() {
  const usersStr = process.env.DASHBOARD_USERS || '';
  const users = {};
  for (const entry of usersStr.split(',').filter(Boolean)) {
    const [username, ...passParts] = entry.split(':');
    if (username && passParts.length > 0) {
      users[username.trim().toLowerCase()] = passParts.join(':').trim();
    }
  }
  return users;
}

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  const path = event.path.replace(/^\/api\/auth\/?/, '');

  // POST /api/auth/login
  if (path === 'login' && event.httpMethod === 'POST') {
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch (_) {
      return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Invalid JSON' }) };
    }

    const { username, password } = body;
    if (!username || !password) {
      return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Username and password required' }) };
    }

    const users = getUsers();
    const user = username.toLowerCase().trim();
    if (!users[user] || users[user] !== password) {
      return { statusCode: 401, headers, body: JSON.stringify({ ok: false, error: 'Invalid credentials' }) };
    }

    const token = generateToken();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    sessions.set(token, { username: user, role: 'admin', expiresAt });

    // Clean expired sessions
    const now = Date.now();
    for (const [t, s] of sessions) {
      if (new Date(s.expiresAt).getTime() < now) sessions.delete(t);
    }

    const displayName = user.charAt(0).toUpperCase() + user.slice(1);
    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        ok: true, token, expires_at: expiresAt,
        user: { id: user, username: user, role: 'admin', name: displayName }
      })
    };
  }

  // POST /api/auth/logout
  if (path === 'logout' && event.httpMethod === 'POST') {
    const auth = event.headers.authorization || '';
    if (auth.startsWith('Bearer ')) sessions.delete(auth.slice(7));
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  }

  // GET /api/auth/me
  if (path === 'me' && event.httpMethod === 'GET') {
    const auth = event.headers.authorization || '';
    if (!auth.startsWith('Bearer ')) {
      return { statusCode: 401, headers, body: JSON.stringify({ ok: false }) };
    }
    const token = auth.slice(7);
    const session = sessions.get(token);
    if (!session || new Date(session.expiresAt).getTime() < Date.now()) {
      sessions.delete(token);
      return { statusCode: 401, headers, body: JSON.stringify({ ok: false }) };
    }
    const displayName = session.username.charAt(0).toUpperCase() + session.username.slice(1);
    return {
      statusCode: 200, headers,
      body: JSON.stringify({ ok: true, user: { username: session.username, role: session.role, name: displayName } })
    };
  }

  return { statusCode: 404, headers, body: JSON.stringify({ ok: false, error: 'Not found' }) };
}
