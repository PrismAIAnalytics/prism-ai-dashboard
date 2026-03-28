#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// PRISM AI Analytics — Excel CRM Tracker → SQLite Import
// ─────────────────────────────────────────────────────────────────────────────
// Usage:   node import-excel-crm.js [path-to-xlsx]
// Default: looks for ../../Admin/Prism_AI_CRM_Tracker.xlsx
// ─────────────────────────────────────────────────────────────────────────────
const ExcelJS = require('exceljs');
const Database = require('better-sqlite3');
const path = require('path');

// ─── Config ─────────────────────────────────────────────────────────────────
const xlsxPath = process.argv[2]
  || path.join(__dirname, '..', '..', 'Admin', 'Prism_AI_CRM_Tracker.xlsx');
const dbPath = path.join(__dirname, 'prism.db');

console.log('\n  PRISM AI — Excel CRM Import');
console.log('  ─────────────────────────────');
console.log(`  Source:  ${xlsxPath}`);
console.log(`  Target:  ${dbPath}\n`);

// ─── Column mapping (Excel header → internal key) ───────────────────────────
const COLUMN_MAP = {
  'Customer ID':      'customerId',
  'Company':          'company',
  'Contact Name':     'contactName',
  'Email':            'email',
  'Phone':            'phone',
  'Industry':         'industry',
  'Lead Source':       'leadSource',
  'Project ID':       'projectId',
  'Project Name':     'projectName',
  'Service Type':     'serviceType',
  'Budget':           'budget',
  'Status':           'status',
  'Start Date':       'startDate',
  'Target Delivery':  'targetDelivery',
  'Trigger Action':   'triggerAction',
  'SLA':              'sla',
  'Next Stage':       'nextStage',
  'Notes':            'notes',
};

function parseExcelDate(val) {
  if (!val) return null;
  if (val instanceof Date) {
    return val.toISOString().slice(0, 10);
  }
  const str = String(val).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return str.slice(0, 10);
  const parsed = new Date(str);
  if (!isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return null;
}

function normalize(row) {
  const out = {};
  for (const [excelCol, key] of Object.entries(COLUMN_MAP)) {
    out[key] = row[excelCol] !== undefined ? String(row[excelCol]).trim() : '';
  }
  // Parse budget as number
  if (out.budget) {
    const num = parseFloat(String(out.budget).replace(/[$,]/g, ''));
    out.budget = isNaN(num) ? null : num;
  } else {
    out.budget = null;
  }
  // Parse dates
  out.startDate = parseExcelDate(row['Start Date']);
  out.targetDelivery = parseExcelDate(row['Target Delivery']);
  return out;
}

async function main() {
  // ─── Read Excel ───────────────────────────────────────────────────────────
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.readFile(xlsxPath);
  } catch (e) {
    console.error(`  ERROR: Could not read Excel file.\n  ${e.message}`);
    process.exit(1);
  }

  const sheet = workbook.getWorksheet('CRM Tracker');
  if (!sheet) {
    const names = workbook.worksheets.map(ws => ws.name).join(', ');
    console.error(`  ERROR: Sheet "CRM Tracker" not found. Available: ${names}`);
    process.exit(1);
  }

  // Header row is row 5; build column index from it
  const headerRow = sheet.getRow(5);
  const colIndex = {};
  headerRow.eachCell((cell, colNumber) => {
    const header = String(cell.value || '').trim();
    if (header) colIndex[header] = colNumber;
  });

  // Read data rows starting from row 6
  const rawData = [];
  for (let r = 6; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const obj = {};
    for (const [header, colNum] of Object.entries(colIndex)) {
      const cell = row.getCell(colNum);
      obj[header] = cell.value != null ? cell.value : '';
    }
    rawData.push(obj);
  }

  console.log(`  Rows read from "CRM Tracker": ${rawData.length}`);

  // Filter to rows that actually have data
  const records = rawData.map(normalize).filter(r => r.company && r.customerId);
  console.log(`  Valid records to import: ${records.length}\n`);

  if (records.length === 0) {
    console.log('  No records to import. Exiting.');
    process.exit(0);
  }

  // ─── Open SQLite ──────────────────────────────────────────────────────────
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  function uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  // ─── Import logic ─────────────────────────────────────────────────────────
  const stats = { created: 0, updated: 0, skipped: 0 };

  const findByCompany = db.prepare(`
    SELECT id, company_name FROM clients WHERE LOWER(company_name) = LOWER(?)
  `);

  const insertClient = db.prepare(`
    INSERT INTO clients (id, company_name, industry_id, notes, is_active,
      created_at, updated_at, crm_status, crm_budget, crm_project_name,
      crm_service, crm_lead_source, crm_contact_name, crm_contact_email,
      crm_contact_phone, crm_last_status_change)
    VALUES (?,?,?,?,1, ?,?, ?,?,?, ?,?, ?,?,?, ?)
  `);

  const updateClient = db.prepare(`
    UPDATE clients SET
      crm_status = ?, crm_budget = ?, crm_project_name = ?,
      crm_service = ?, crm_lead_source = ?,
      crm_contact_name = ?, crm_contact_email = ?, crm_contact_phone = ?,
      notes = CASE WHEN ? != '' THEN ? ELSE notes END,
      updated_at = ?
    WHERE id = ?
  `);

  const findIndustry = db.prepare('SELECT id FROM industries WHERE LOWER(name) = LOWER(?)');
  const insertIndustry = db.prepare('INSERT INTO industries (name) VALUES (?)');

  const insertContact = db.prepare(`
    INSERT INTO contacts (id, client_id, first_name, last_name, email, phone, is_primary)
    VALUES (?,?,?,?,?,?,1)
  `);

  const insertActivity = db.prepare(`
    INSERT INTO activity_log (entity_type, entity_id, action, summary, logged_at)
    VALUES ('client', ?, ?, ?, ?)
  `);

  function resolveIndustry(name) {
    if (!name) return null;
    let row = findIndustry.get(name);
    if (row) return row.id;
    insertIndustry.run(name);
    row = findIndustry.get(name);
    return row ? row.id : null;
  }

  const importAll = db.transaction(() => {
    const now = new Date().toISOString();

    for (const rec of records) {
      const existing = findByCompany.get(rec.company);
      const industryId = resolveIndustry(rec.industry);

      if (existing) {
        updateClient.run(
          rec.status || 'New Lead',
          rec.budget,
          rec.projectName || null,
          rec.serviceType || null,
          rec.leadSource || null,
          rec.contactName || null,
          rec.email || null,
          rec.phone || null,
          rec.notes || '', rec.notes || '',
          now,
          existing.id
        );
        insertActivity.run(existing.id, 'excel_import', `Updated from Excel CRM Tracker (${rec.customerId})`, now);
        stats.updated++;
        console.log(`  UPDATED  ${rec.customerId}  ${rec.company}`);
      } else {
        const cid = uuid();
        insertClient.run(
          cid,
          rec.company,
          industryId,
          rec.notes || null,
          now, now,
          rec.status || 'New Lead',
          rec.budget,
          rec.projectName || null,
          rec.serviceType || null,
          rec.leadSource || null,
          rec.contactName || null,
          rec.email || null,
          rec.phone || null,
          now
        );

        if (rec.contactName || rec.email) {
          const parts = (rec.contactName || '').split(' ');
          const fn = parts[0] || '';
          const ln = parts.slice(1).join(' ') || rec.company;
          insertContact.run(uuid(), cid, fn, ln, rec.email || null, rec.phone || null);
        }

        insertActivity.run(cid, 'excel_import', `Imported from Excel CRM Tracker (${rec.customerId})`, now);
        stats.created++;
        console.log(`  CREATED  ${rec.customerId}  ${rec.company}`);
      }
    }
  });

  try {
    importAll();
    console.log(`\n  ─────────────────────────────`);
    console.log(`  Import complete!`);
    console.log(`    Created: ${stats.created}`);
    console.log(`    Updated: ${stats.updated}`);
    console.log(`    Skipped: ${stats.skipped}`);
    console.log(`    Total:   ${stats.created + stats.updated + stats.skipped}\n`);
  } catch (e) {
    console.error(`\n  IMPORT FAILED: ${e.message}\n`);
    process.exit(1);
  } finally {
    db.close();
  }
}

main();
