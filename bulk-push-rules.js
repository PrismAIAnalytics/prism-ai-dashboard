#!/usr/bin/env node
/**
 * Bulk push CIS rules from knowledge base SQLite → dashboard SQLite
 * Direct DB-to-DB transfer, bypassing the API for speed.
 *
 * Usage: node bulk-push-rules.js [--clear] [--dry-run]
 *   --clear   Remove existing rules before inserting
 *   --dry-run Show what would be inserted without writing
 */
const Database = require('better-sqlite3');
const path = require('path');
const re = (pattern, str) => new RegExp(pattern, 'i').test(str || '');

// Paths
const KB_PATH = path.resolve(__dirname, '../../CIS Benchmarks/cis-compliance-assistant/output/cis_knowledge_base.db');
const DASH_PATH = path.resolve(__dirname, 'prism.db');

// Same mapping as cis_dashboard_mcp.py
const BENCHMARK_TO_PRODUCT = [
  [/Amazon Web Services|AWS Foundations|AWS Compute|AWS Database|AWS End User|AWS Storage/i, 1],
  [/Microsoft Azure Foundations|Microsoft Azure Compute|Microsoft Azure Database|Microsoft Azure Storage/i, 2],
  [/Google Cloud Platform|GCP Foundation/i, 3],
  [/DigitalOcean/i, 4],
  [/Tencent Cloud/i, 5],
  [/Oracle Cloud Infrastructure(?! .*Container)(?! .*OKE)/i, 76],
  [/Alibaba Cloud|Aliyun|CIS Alibaba/i, 72],
  [/Windows Server 2025/i, 6],
  [/Windows Server 2022/i, 7],
  [/Windows Server 2019|Windows Server 2016|Windows Server 2012|Windows Server 2008/i, 8],
  [/Windows 11/i, 19],
  [/Windows 10/i, 20],
  [/Windows 8/i, 70],
  [/Windows 7/i, 69],
  [/Windows XP/i, 71],
  [/macOS|Apple macOS/i, 21],
  [/Red Hat Enterprise Linux 10|RHEL.*10/i, 9],
  [/Red Hat Enterprise Linux 9|RHEL.*9/i, 10],
  [/Red Hat Enterprise Linux 8|RHEL.*8/i, 11],
  [/Ubuntu/i, 12], [/Debian/i, 13], [/SUSE/i, 14],
  [/Rocky Linux/i, 15], [/AlmaLinux/i, 16], [/Oracle Linux/i, 17], [/Amazon Linux/i, 18],
  [/Linux Mint/i, 73], [/Alibaba Cloud Linux|Aliyun Linux/i, 72],
  [/IBM AIX/i, 26], [/IBM i V7/i, 27], [/IBM z.?OS/i, 74], [/FreeBSD/i, 75],
  [/Bottlerocket/i, 22], [/Talos Linux/i, 23],
  [/Apple iOS|Apple iPadOS|iOS.*iPadOS|iPadOS/i, 28],
  [/Google Android|Motorola.*Android/i, 29],
  [/Docker/i, 30], [/Kubernetes Benchmark/i, 31],
  [/Amazon Elastic Kubernetes|EKS/i, 31], [/Azure Kubernetes|AKS/i, 31],
  [/Google Kubernetes|GKE/i, 31], [/Red Hat OpenShift|Openshift/i, 31],
  [/Microsoft SQL Server/i, 33], [/PostgreSQL/i, 34], [/MySQL|Oracle MySQL|MariaDB/i, 35],
  [/MongoDB|MONGODB/i, 36], [/IBM Db2|IBM DB2/i, 37], [/Apache Cassandra/i, 38],
  [/SingleStore/i, 39], [/YugabyteDB/i, 40], [/Oracle Database/i, 32], [/Snowflake/i, 77],
  [/Cisco IOS|Cisco ASA|Cisco Firepower|Cisco Firewall|Cisco NX-OS/i, 41],
  [/FortiGate|Fortigate|Palo Alto/i, 42], [/Check Point/i, 43], [/F5 Networks/i, 44],
  [/Arista/i, 45], [/Juniper/i, 46], [/Sophos Firewall/i, 47],
  [/pfSense/i, 48], [/OPNsense/i, 49],
  [/Google Chrome(?!.*OS)/i, 52], [/Mozilla Firefox/i, 53],
  [/Apple Safari|macOS Safari/i, 54], [/Microsoft Edge|Microsoft Internet Explorer/i, 55],
  [/Apache HTTP Server/i, 64], [/Nginx|NGINX/i, 65],
  [/Microsoft IIS/i, 66], [/Apache Tomcat|IBM WebSphere/i, 67], [/IBM CICS/i, 79],
  [/Microsoft 365|Microsoft Office/i, 56], [/Google Workspace/i, 57],
  [/Okta/i, 58], [/Zoom/i, 59], [/Microsoft Dynamics/i, 78],
  [/ISC BIND/i, 50],
  [/Multi-function Print|MFP/i, 68],
  [/ChromeOS|Chrome OS/i, 52],
  [/VMware|VMWare|ESXi/i, 63],  // map to a reasonable product or skip
  [/Microsoft Exchange/i, 56],
  [/Microsoft SharePoint/i, 56],
  [/Microsoft Defender/i, 56],
  [/Microsoft Intune for Windows/i, 20],
  [/Microsoft Intune for Office/i, 56],
  [/Microsoft Intune for Edge/i, 55],
  [/Visual Studio Code/i, 55],
  [/GitLab|Github|GitHub/i, 31],
  [/HPE Aruba|ExtremeNetworks/i, 45],
  [/Oracle Solaris/i, 17],
  [/Oracle SaaS/i, 76],
  [/ROS Melodic/i, null],  // skip unmappable
  [/Wind River|Anduril|Forescout|Dragos|Xylok|Axonius|Tanium|Infoblox/i, null],
];

function getProductId(benchmarkName) {
  for (const [pattern, pid] of BENCHMARK_TO_PRODUCT) {
    if (pattern.test(benchmarkName)) return pid;
  }
  return null;
}

function extractVersion(name) {
  const m = (name || '').match(/v(\d+\.\d+(?:\.\d+)?)/);
  return m ? `v${m[1]}` : null;
}

function isArchive(name) {
  return /ARCHIVE|FINAL UPDATE|Archive/i.test(name || '');
}

// ── Main ────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const clearFirst = args.includes('--clear');
const dryRun = args.includes('--dry-run');

console.log(`\n📦 CIS Benchmark Bulk Push`);
console.log(`   KB:   ${KB_PATH}`);
console.log(`   Dash: ${DASH_PATH}`);
console.log(`   Mode: ${dryRun ? 'DRY RUN' : clearFirst ? 'CLEAR + INSERT' : 'INSERT'}\n`);

// Open databases
const kb = new Database(KB_PATH, { readonly: true });
const dash = new Database(DASH_PATH);

// Load all KB rules
const allRules = kb.prepare('SELECT * FROM rules').all();
console.log(`Loaded ${allRules.length.toLocaleString()} rules from knowledge base`);

// Group by benchmark
const benchmarks = {};
for (const rule of allRules) {
  const bm = rule.benchmark;
  if (!benchmarks[bm]) benchmarks[bm] = [];
  benchmarks[bm].push(rule);
}
console.log(`Found ${Object.keys(benchmarks).length} benchmarks\n`);

// Map to products, pick latest version per product
const productVersions = {};  // pid → [{version, name, archive, rules}]
const unmapped = [];

for (const [bmName, rules] of Object.entries(benchmarks)) {
  const pid = getProductId(bmName);
  if (pid === null) {
    unmapped.push({ name: bmName, count: rules.length });
    continue;
  }
  if (!productVersions[pid]) productVersions[pid] = [];
  productVersions[pid].push({
    version: extractVersion(bmName),
    name: bmName,
    archive: isArchive(bmName),
    rules
  });
}

// Select best (latest non-archived) version per product
const productRules = {};  // pid → [transformed rules]
let totalRules = 0;

for (const [pid, versions] of Object.entries(productVersions)) {
  const nonArchive = versions.filter(v => !v.archive);
  const candidates = nonArchive.length > 0 ? nonArchive : versions;
  candidates.sort((a, b) => (b.version || '').localeCompare(a.version || ''));
  const best = candidates[0];

  const transformed = best.rules.map((rule, i) => {
    const pl = rule.profile_level || '';
    const level = (pl.includes('Level 2') || pl.includes('L2')) ? 2 : 1;
    const cisProfile = level === 2 ? 'L2' : 'L1';
    const assessment = (rule.assessment_status || '').toLowerCase();
    const checkType = assessment.includes('automated') ? 'automated' : 'manual';
    const ruleId = rule.rule_id || `R${i + 1}`;
    const sectionMatch = ruleId.match(/^(\d+)/);

    return {
      product_id: parseInt(pid),
      rule_id: ruleId,
      title: (rule.title || 'Untitled').substring(0, 500),
      section: sectionMatch ? sectionMatch[1] : null,
      subsection: null,
      level,
      rule_type: 'rule',
      source: 'CIS',
      severity: null,
      cis_profile: cisProfile,
      check_type: checkType,
      description: rule.description || null,
      rationale: rule.rationale || null,
      remediation: rule.remediation || null,
      audit_command: null,
      default_value: null,
      recommended_value: null,
      config_parameter: null,
      config_location: null,
      benchmark_version: extractVersion(best.name),
      benchmark_status: isArchive(best.name) ? 'archived' : 'active',
      cis_uid: `CIS-2026-${String(pid).padStart(5, '0')}.${String(i + 1).padStart(3, '0')}`,
      is_automatable: checkType === 'automated' ? 1 : 0,
      is_active: isArchive(best.name) ? 0 : 1,
    };
  });

  productRules[pid] = { name: best.name, rules: transformed };
  totalRules += transformed.length;
}

console.log(`Mapped to ${Object.keys(productRules).length} products, ${totalRules.toLocaleString()} rules total`);
if (unmapped.length > 0) {
  console.log(`\nUnmapped benchmarks (${unmapped.length}):`);
  unmapped.sort((a, b) => b.count - a.count);
  for (const u of unmapped.slice(0, 15)) {
    console.log(`  - ${u.name} (${u.count} rules)`);
  }
  if (unmapped.length > 15) console.log(`  ... and ${unmapped.length - 15} more`);
}

if (dryRun) {
  console.log(`\n--- DRY RUN: Would insert ${totalRules.toLocaleString()} rules ---`);
  for (const [pid, data] of Object.entries(productRules).sort((a, b) => a[0] - b[0])) {
    console.log(`  [${pid}] ${data.name}: ${data.rules.length} rules`);
  }
  process.exit(0);
}

// Clear existing rules if requested
if (clearFirst) {
  const deleted = dash.prepare("DELETE FROM benchmark_rules WHERE rule_type = 'rule' AND source = 'CIS'").run();
  console.log(`\nCleared ${deleted.changes.toLocaleString()} existing CIS rules`);
}

// Insert in a transaction for speed
const ins = dash.prepare(`INSERT INTO benchmark_rules (
  product_id, rule_id, title, section, subsection, level, rule_type, source,
  severity, cis_profile, check_type, description, rationale, remediation,
  audit_command, default_value, recommended_value, config_parameter, config_location,
  benchmark_version, benchmark_status, cis_uid, is_automatable, is_active, "references"
) VALUES (
  @product_id, @rule_id, @title, @section, @subsection, @level, @rule_type, @source,
  @severity, @cis_profile, @check_type, @description, @rationale, @remediation,
  @audit_command, @default_value, @recommended_value, @config_parameter, @config_location,
  @benchmark_version, @benchmark_status, @cis_uid, @is_automatable, @is_active, @references
)`);

console.log(`\nInserting ${totalRules.toLocaleString()} rules...`);
const start = Date.now();

const insertAll = dash.transaction(() => {
  let inserted = 0;
  for (const [pid, data] of Object.entries(productRules)) {
    for (const rule of data.rules) {
      ins.run(rule);
      inserted++;
    }
  }
  return inserted;
});

const inserted = insertAll();
const elapsed = ((Date.now() - start) / 1000).toFixed(1);
console.log(`\n✅ Inserted ${inserted.toLocaleString()} rules in ${elapsed}s`);

// Show summary
const summary = dash.prepare(`
  SELECT bp.id, bp.product_name,
    (SELECT COUNT(*) FROM benchmark_rules br WHERE br.product_id = bp.id AND br.rule_type = 'rule' AND (br.benchmark_status = 'active' OR br.benchmark_status IS NULL)) as active_rules,
    (SELECT COUNT(*) FROM benchmark_rules br WHERE br.product_id = bp.id) as total_rules
  FROM benchmark_products bp WHERE bp.is_active = 1
  ORDER BY active_rules DESC
`).all();

console.log(`\n--- Dashboard Product Summary ---`);
let withRules = 0;
for (const p of summary) {
  if (p.active_rules > 0) withRules++;
  console.log(`  [${String(p.id).padStart(2)}] ${p.product_name.substring(0, 40).padEnd(40)} active: ${String(p.active_rules).padStart(5)}  total: ${String(p.total_rules).padStart(5)}`);
}
console.log(`\n${withRules}/${summary.length} products now have active rules`);

kb.close();
dash.close();
