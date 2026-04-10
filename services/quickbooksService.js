'use strict';

const QuickBooks = require('node-quickbooks');
const cache = require('./cacheService');

let db = null;

function init(sqliteDb) {
  db = sqliteDb;
  db.exec(`
    CREATE TABLE IF NOT EXISTS qbo_tokens (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      access_token TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      realm_id TEXT NOT NULL,
      access_token_expires_at TEXT NOT NULL,
      refresh_token_expires_at TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);
  console.log('[qbo] Token table ready');
}

function getTokens() {
  if (!db) return null;
  return db.prepare('SELECT * FROM qbo_tokens WHERE id = 1').get() || null;
}

function saveTokens(tokens) {
  if (!db) return;
  const existing = getTokens();
  if (existing) {
    db.prepare(`UPDATE qbo_tokens SET access_token = ?, refresh_token = ?, realm_id = ?,
      access_token_expires_at = ?, refresh_token_expires_at = ?, updated_at = datetime('now') WHERE id = 1`)
      .run(tokens.access_token, tokens.refresh_token, tokens.realm_id,
        tokens.access_token_expires_at, tokens.refresh_token_expires_at);
  } else {
    db.prepare(`INSERT INTO qbo_tokens (id, access_token, refresh_token, realm_id,
      access_token_expires_at, refresh_token_expires_at) VALUES (1, ?, ?, ?, ?, ?)`)
      .run(tokens.access_token, tokens.refresh_token, tokens.realm_id,
        tokens.access_token_expires_at, tokens.refresh_token_expires_at);
  }
}

function isConnected() {
  const tokens = getTokens();
  if (!tokens) return false;
  // Refresh token valid for 100 days
  return new Date(tokens.refresh_token_expires_at) > new Date();
}

function getClient() {
  const tokens = getTokens();
  if (!tokens) return null;
  return new QuickBooks(
    process.env.QBO_CLIENT_ID,
    process.env.QBO_CLIENT_SECRET,
    tokens.access_token,
    false,
    tokens.realm_id,
    process.env.QBO_ENVIRONMENT === 'production',
    false,
    null,
    '2.0',
    tokens.refresh_token
  );
}

function promisify(qbo, method, ...args) {
  return new Promise((resolve, reject) => {
    qbo[method](...args, (err, data) => {
      if (err) reject(err);
      else resolve(data);
    });
  });
}

async function ensureFreshToken() {
  const tokens = getTokens();
  if (!tokens) throw new Error('QuickBooks not connected');
  if (new Date(tokens.access_token_expires_at) > new Date()) return;
  // Token expired, refresh it
  const qbo = getClient();
  return new Promise((resolve, reject) => {
    qbo.refreshAccessToken((err, result) => {
      if (err) return reject(new Error('Token refresh failed: ' + JSON.stringify(err)));
      const now = new Date();
      const accessExpires = new Date(now.getTime() + 3600 * 1000).toISOString();
      const refreshExpires = new Date(now.getTime() + 100 * 24 * 3600 * 1000).toISOString();
      saveTokens({
        access_token: result.access_token || result.token || tokens.access_token,
        refresh_token: result.refresh_token || tokens.refresh_token,
        realm_id: tokens.realm_id,
        access_token_expires_at: accessExpires,
        refresh_token_expires_at: refreshExpires,
      });
      resolve();
    });
  });
}

function getOAuthUri() {
  return QuickBooks.authorizeUrl(
    process.env.QBO_CLIENT_ID,
    process.env.QBO_REDIRECT_URI || 'http://localhost:3000/api/qbo/callback',
    process.env.QBO_ENVIRONMENT === 'production' ? QuickBooks.PRODUCTION_BASE_URL : QuickBooks.SANDBOX_BASE_URL,
    'com.intuit.quickbooks.accounting'
  );
}

async function handleCallback(authCode, realmId) {
  return new Promise((resolve, reject) => {
    QuickBooks.createToken(
      process.env.QBO_CLIENT_ID,
      process.env.QBO_CLIENT_SECRET,
      authCode,
      process.env.QBO_REDIRECT_URI || 'http://localhost:3000/api/qbo/callback',
      realmId,
      (err, token) => {
        if (err) return reject(new Error('OAuth token exchange failed: ' + JSON.stringify(err)));
        const now = new Date();
        saveTokens({
          access_token: token.access_token,
          refresh_token: token.refresh_token,
          realm_id: realmId,
          access_token_expires_at: new Date(now.getTime() + (token.expires_in || 3600) * 1000).toISOString(),
          refresh_token_expires_at: new Date(now.getTime() + (token.x_refresh_token_expires_in || 8640000) * 1000).toISOString(),
        });
        resolve({ success: true });
      }
    );
  });
}

// Parse QB P&L report into flat structure
function parsePnlReport(report) {
  const result = {
    totalIncome: 0,
    totalExpenses: 0,
    netIncome: 0,
    grossProfit: 0,
    incomeAccounts: {},
    expenseAccounts: {},
    monthlyBreakdown: {},
  };

  if (!report || !report.Rows) return result;

  const columns = (report.Columns && report.Columns.Column) || [];
  const monthLabels = columns.slice(1).map(c => c.ColTitle);

  function parseRows(rows, target) {
    if (!rows || !rows.Row) return;
    for (const row of rows.Row) {
      if (row.type === 'Data' && row.ColData) {
        const name = row.ColData[0].value;
        const amount = parseFloat(row.ColData[row.ColData.length - 1].value) || 0;
        target[name] = amount;
      }
      if (row.Rows) parseRows(row.Rows, target);
      if (row.Summary && row.Summary.ColData) {
        const label = row.Summary.ColData[0].value;
        const val = parseFloat(row.Summary.ColData[row.Summary.ColData.length - 1].value) || 0;
        if (label === 'Total Income') result.totalIncome = val;
        if (label === 'Total Expenses' || label === 'Total Cost of Goods Sold') result.totalExpenses += val;
        if (label === 'Net Income') result.netIncome = val;
        if (label === 'Gross Profit') result.grossProfit = val;
      }
    }
  }

  for (const section of report.Rows.Row || []) {
    const header = section.Header && section.Header.ColData ? section.Header.ColData[0].value : '';
    if (header === 'Income' || header === 'Other Income') {
      parseRows(section.Rows, result.incomeAccounts);
    } else if (header === 'Expenses' || header === 'Other Expenses' || header === 'Cost of Goods Sold') {
      parseRows(section.Rows, result.expenseAccounts);
    }
    if (section.Summary && section.Summary.ColData) {
      const label = section.Summary.ColData[0].value;
      const val = parseFloat(section.Summary.ColData[section.Summary.ColData.length - 1].value) || 0;
      if (label === 'Total Income' || label === 'Total Other Income') result.totalIncome += val;
      if (label.includes('Total') && (label.includes('Expenses') || label.includes('Cost'))) result.totalExpenses += val;
      if (label === 'Net Income') result.netIncome = val;
      if (label === 'Gross Profit') result.grossProfit = val;
    }
  }

  return result;
}

async function getProfitAndLoss(startDate, endDate) {
  if (!isConnected()) return { data: null, error: 'QuickBooks not connected' };
  const cacheKey = `qbo:pnl:${startDate}:${endDate}`;
  const cached = cache.get(cacheKey);
  if (cached && !cached.stale) return { data: cached.data };
  try {
    await ensureFreshToken();
    const qbo = getClient();
    const report = await promisify(qbo, 'reportProfitAndLoss', {
      start_date: startDate,
      end_date: endDate,
    });
    const parsed = parsePnlReport(report);
    cache.set(cacheKey, parsed, cache.DEFAULT_TTLS.pnl);
    return { data: parsed };
  } catch (err) {
    const msg = typeof err === 'object' ? (err.message || JSON.stringify(err)) : String(err);
    if (cached) return { data: cached.data, stale: true, error: msg };
    return { data: null, error: msg };
  }
}

async function getProfitAndLossMonthly(year) {
  if (!isConnected()) return { data: null, error: 'QuickBooks not connected' };
  const cacheKey = `qbo:pnl:monthly:${year}`;
  const cached = cache.get(cacheKey);
  if (cached && !cached.stale) return { data: cached.data };
  try {
    await ensureFreshToken();
    const qbo = getClient();
    const report = await promisify(qbo, 'reportProfitAndLoss', {
      start_date: `${year}-01-01`,
      end_date: `${year}-12-31`,
      summarize_column_by: 'Month',
    });

    const columns = (report.Columns && report.Columns.Column) || [];
    const months = columns.slice(1).filter(c => c.ColTitle !== 'TOTAL').map(c => c.ColTitle);
    const monthlyData = months.map(() => ({ income: 0, expenses: 0, netIncome: 0 }));

    function extractMonthlyTotals(rows, type) {
      if (!rows || !rows.Row) return;
      for (const row of rows.Row) {
        if (row.Summary && row.Summary.ColData) {
          const label = row.Summary.ColData[0].value;
          if (label === 'Total Income' || label === 'Total Other Income') {
            row.Summary.ColData.slice(1).forEach((col, idx) => {
              if (idx < monthlyData.length) monthlyData[idx].income += parseFloat(col.value) || 0;
            });
          }
          if (label.includes('Total') && (label.includes('Expense') || label.includes('Cost'))) {
            row.Summary.ColData.slice(1).forEach((col, idx) => {
              if (idx < monthlyData.length) monthlyData[idx].expenses += parseFloat(col.value) || 0;
            });
          }
          if (label === 'Net Income') {
            row.Summary.ColData.slice(1).forEach((col, idx) => {
              if (idx < monthlyData.length) monthlyData[idx].netIncome = parseFloat(col.value) || 0;
            });
          }
        }
        if (row.Rows) extractMonthlyTotals(row.Rows, type);
      }
    }

    for (const section of report.Rows.Row || []) {
      extractMonthlyTotals(section.Rows);
      if (section.Summary && section.Summary.ColData) {
        const label = section.Summary.ColData[0].value;
        if (label === 'Net Income') {
          section.Summary.ColData.slice(1).forEach((col, idx) => {
            if (idx < monthlyData.length) monthlyData[idx].netIncome = parseFloat(col.value) || 0;
          });
        }
      }
    }

    const result = {
      labels: months,
      income: monthlyData.map(m => m.income),
      expenses: monthlyData.map(m => m.expenses),
      netIncome: monthlyData.map(m => m.netIncome),
    };
    cache.set(cacheKey, result, cache.DEFAULT_TTLS.pnl);
    return { data: result };
  } catch (err) {
    const msg = typeof err === 'object' ? (err.message || JSON.stringify(err)) : String(err);
    if (cached) return { data: cached.data, stale: true, error: msg };
    return { data: null, error: msg };
  }
}

async function getInvoices(limit = 100) {
  if (!isConnected()) return { data: [], error: 'QuickBooks not connected' };
  const cached = cache.get('qbo:invoices');
  if (cached && !cached.stale) return { data: cached.data };
  try {
    await ensureFreshToken();
    const qbo = getClient();
    const result = await promisify(qbo, 'findInvoices', [
      { field: 'fetchAll', value: true },
    ]);
    const invoices = (result.QueryResponse && result.QueryResponse.Invoice || []).map(inv => ({
      id: inv.Id,
      docNumber: inv.DocNumber,
      customerName: inv.CustomerRef ? inv.CustomerRef.name : 'Unknown',
      txnDate: inv.TxnDate,
      dueDate: inv.DueDate,
      totalAmt: inv.TotalAmt,
      balance: inv.Balance,
      status: inv.Balance === 0 ? 'paid' : (new Date(inv.DueDate) < new Date() ? 'overdue' : 'open'),
      source: 'quickbooks',
    }));
    cache.set('qbo:invoices', invoices, cache.DEFAULT_TTLS.invoices);
    return { data: invoices };
  } catch (err) {
    const msg = typeof err === 'object' ? (err.message || JSON.stringify(err)) : String(err);
    if (cached) return { data: cached.data, stale: true, error: msg };
    return { data: [], error: msg };
  }
}

async function getCompanyInfo() {
  if (!isConnected()) return { data: null, error: 'QuickBooks not connected' };
  const cached = cache.get('qbo:company');
  if (cached && !cached.stale) return { data: cached.data };
  try {
    await ensureFreshToken();
    const qbo = getClient();
    const realmId = getTokens().realm_id;
    const info = await promisify(qbo, 'getCompanyInfo', realmId);
    const result = {
      name: info.CompanyName,
      legalName: info.LegalName,
      country: info.Country,
      fiscalYearStartMonth: info.FiscalYearStartMonth,
    };
    cache.set('qbo:company', result, cache.DEFAULT_TTLS.company);
    return { data: result };
  } catch (err) {
    const msg = typeof err === 'object' ? (err.message || JSON.stringify(err)) : String(err);
    if (cached) return { data: cached.data, stale: true, error: msg };
    return { data: null, error: msg };
  }
}

module.exports = {
  init, isConnected, getTokens, saveTokens, getOAuthUri, handleCallback,
  getProfitAndLoss, getProfitAndLossMonthly, getInvoices, getCompanyInfo,
};
