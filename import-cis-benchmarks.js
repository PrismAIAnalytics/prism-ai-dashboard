#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Import CIS Benchmark Rules from Excel — with Version & Status Parsing
// ─────────────────────────────────────────────────────────────────────────────
// Usage:  node import-cis-benchmarks.js [path-to-xlsx]
//
// Default path: ../../CIS Benchmarks/CIS_Benchmark_Rules_Extracted.xlsx
//
// This script:
//   1. Reads the Excel file (columns: Benchmark, Rule ID, Title, Profile Level,
//      Assessment Status, Description, Rationale, Remediation)
//   2. Parses benchmark_version (e.g. "v4.0.0") and benchmark_status
//      ("active" or "archive") from the Benchmark column name
//   3. Maps each benchmark name to a product_id in benchmark_products
//   4. Inserts all rules with version + status tracking
//   5. Assigns rules to their closest section header via keyword matching
// ─────────────────────────────────────────────────────────────────────────────

const Database = require('better-sqlite3');
const ExcelJS = require('exceljs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'prism.db');
const EXCEL_PATH = process.argv[2] || path.join(__dirname, '..', '..', 'CIS Benchmarks', 'CIS_Benchmark_Rules_Extracted.xlsx');

console.log(`\n  CIS Benchmark Rules Importer`);
console.log(`  ════════════════════════════════════════`);
console.log(`  DB:    ${DB_PATH}`);
console.log(`  Excel: ${EXCEL_PATH}\n`);

// ─── Connect to DB ──────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ─── Load all products for matching ─────────────────────────────────────────
const allProducts = db.prepare('SELECT id, product_name, vendor FROM benchmark_products').all();
console.log(`  Found ${allProducts.length} products in database\n`);

// ─── Product matching map ───────────────────────────────────────────────────
// Maps Excel benchmark name patterns → product name patterns in DB
const BENCHMARK_TO_PRODUCT = [
  // Windows — must be before generic "Windows" patterns
  { pattern: /Microsoft Windows 10.*EMS Gateway/i, product: 'Windows 10' },
  { pattern: /Microsoft Windows 10.*Stand-alone/i, product: 'Windows 10' },
  { pattern: /Microsoft Windows 10.*Enterprise.*RTM/i, product: 'Windows 10' },
  { pattern: /Microsoft Windows 10.*Enterprise.*Release/i, product: 'Windows 10' },
  { pattern: /Microsoft Windows 10.*Enterprise/i, product: 'Windows 10' },
  { pattern: /Microsoft Windows 10/i, product: 'Windows 10' },
  { pattern: /Microsoft Windows 11.*Stand-alone/i, product: 'Windows 11' },
  { pattern: /Microsoft Windows 11.*Enterprise/i, product: 'Windows 11' },
  { pattern: /Microsoft Windows 11/i, product: 'Windows 11' },
  { pattern: /Microsoft Windows Server 2025/i, product: 'Windows Server 2025' },
  { pattern: /Microsoft Windows Server 2022/i, product: 'Windows Server 2022' },
  { pattern: /Microsoft Windows Server 2019/i, product: 'Windows Server 2019' },
  { pattern: /Microsoft Windows 7/i, product: 'Windows 7' },
  { pattern: /Microsoft Windows 8\.1/i, product: 'Windows 8' },
  { pattern: /Microsoft Windows 8/i, product: 'Windows 8' },
  { pattern: /Microsoft Windows XP/i, product: 'Windows XP' },
  { pattern: /Microsoft Intune.*Windows 10/i, product: 'Windows 10' },
  { pattern: /Microsoft Intune.*Windows 11/i, product: 'Windows 11' },
  { pattern: /Microsoft Intune.*Edge/i, product: 'Microsoft Edge' },
  { pattern: /Microsoft Intune.*Office/i, product: 'Microsoft 365' },
  { pattern: /Microsoft Defender Antivirus/i, product: 'Windows 10' },

  // macOS
  { pattern: /Apple macOS.*Monterey/i, product: 'macOS' },
  { pattern: /Apple macOS.*Ventura/i, product: 'macOS' },
  { pattern: /Apple macOS.*Sonoma/i, product: 'macOS' },
  { pattern: /Apple macOS.*Sequoia/i, product: 'macOS' },
  { pattern: /Apple macOS.*Tahoe/i, product: 'macOS' },
  { pattern: /Apple macOS/i, product: 'macOS' },

  // Linux distros
  { pattern: /AlmaLinux OS 10/i, product: 'AlmaLinux' },
  { pattern: /AlmaLinux OS 9/i, product: 'AlmaLinux' },
  { pattern: /AlmaLinux OS 8/i, product: 'AlmaLinux' },
  { pattern: /AlmaLinux/i, product: 'AlmaLinux' },
  { pattern: /Amazon Linux 2023/i, product: 'Amazon Linux' },
  { pattern: /Amazon Linux 2 STIG/i, product: 'Amazon Linux' },
  { pattern: /Amazon Linux 2014/i, product: 'Amazon Linux' },
  { pattern: /Amazon Linux 2(?!\d)/i, product: 'Amazon Linux' },
  { pattern: /Amazon Linux/i, product: 'Amazon Linux' },
  { pattern: /Debian Linux 13/i, product: 'Debian Linux' },
  { pattern: /Debian Linux 11.*STIG/i, product: 'Debian Linux' },
  { pattern: /Debian Linux 11/i, product: 'Debian Linux' },
  { pattern: /Debian Linux 10/i, product: 'Debian Linux' },
  { pattern: /Debian Linux 9/i, product: 'Debian Linux' },
  { pattern: /Debian/i, product: 'Debian Linux' },
  { pattern: /Ubuntu.*18\.04.*LXD.*Container/i, product: 'Ubuntu Linux' },
  { pattern: /Ubuntu.*18\.04.*LXD.*Host/i, product: 'Ubuntu Linux' },
  { pattern: /Ubuntu.*24\.04/i, product: 'Ubuntu Linux' },
  { pattern: /Ubuntu.*22\.04/i, product: 'Ubuntu Linux' },
  { pattern: /Ubuntu.*20\.04/i, product: 'Ubuntu Linux' },
  { pattern: /Ubuntu.*18\.04/i, product: 'Ubuntu Linux' },
  { pattern: /Ubuntu/i, product: 'Ubuntu Linux' },
  { pattern: /RHEL8.*IBM Z/i, product: 'Red Hat Enterprise Linux 8' },
  { pattern: /Red Hat Enterprise Linux 10/i, product: 'Red Hat Enterprise Linux 10' },
  { pattern: /Red Hat Enterprise Linux 9/i, product: 'Red Hat Enterprise Linux 9' },
  { pattern: /Red Hat Enterprise Linux 8/i, product: 'Red Hat Enterprise Linux 8' },
  { pattern: /Red Hat/i, product: 'Red Hat Enterprise Linux 8' },
  { pattern: /Rocky Linux 9/i, product: 'Rocky Linux' },
  { pattern: /Rocky Linux 8/i, product: 'Rocky Linux' },
  { pattern: /Rocky/i, product: 'Rocky Linux' },
  { pattern: /SUSE.*15/i, product: 'SUSE Linux' },
  { pattern: /SUSE.*12/i, product: 'SUSE Linux' },
  { pattern: /SUSE/i, product: 'SUSE Linux' },
  { pattern: /Oracle Linux 9/i, product: 'Oracle Linux' },
  { pattern: /Oracle Linux 8/i, product: 'Oracle Linux' },
  { pattern: /Oracle Linux 7/i, product: 'Oracle Linux' },
  { pattern: /Oracle Linux/i, product: 'Oracle Linux' },
  { pattern: /Alibaba Cloud Linux 3/i, product: 'Aliyun' },
  { pattern: /Aliyun Linux/i, product: 'Aliyun' },
  { pattern: /Linux Mint/i, product: 'Linux Mint' },
  { pattern: /FreeBSD/i, product: 'FreeBSD' },
  { pattern: /Bottlerocket/i, product: 'Bottlerocket' },
  { pattern: /Google Container-Optimized/i, product: 'Bottlerocket' },

  // Cloud
  { pattern: /AWS.*Foundations/i, product: 'Amazon Web Services' },
  { pattern: /AWS.*Compute/i, product: 'Amazon Web Services' },
  { pattern: /AWS.*Database/i, product: 'Amazon Web Services' },
  { pattern: /AWS.*Storage/i, product: 'Amazon Web Services' },
  { pattern: /AWS.*End User/i, product: 'Amazon Web Services' },
  { pattern: /AWS/i, product: 'Amazon Web Services' },
  { pattern: /Azure.*Foundations/i, product: 'Microsoft Azure' },
  { pattern: /Azure.*Compute/i, product: 'Microsoft Azure' },
  { pattern: /Azure.*Database/i, product: 'Microsoft Azure' },
  { pattern: /Azure.*Storage/i, product: 'Microsoft Azure' },
  { pattern: /AKS.*Azure Linux/i, product: 'Microsoft Azure' },
  { pattern: /Azure/i, product: 'Microsoft Azure' },
  { pattern: /Google Cloud Platform/i, product: 'Google Cloud Platform' },
  { pattern: /GCP/i, product: 'Google Cloud Platform' },
  { pattern: /DigitalOcean/i, product: 'DigitalOcean' },
  { pattern: /Tencent Cloud/i, product: 'Tencent Cloud' },
  { pattern: /Alibaba Cloud Foundation/i, product: 'Tencent Cloud' },
  { pattern: /Oracle Cloud Infrastructure/i, product: 'Oracle Cloud' },
  { pattern: /Oracle SaaS/i, product: 'Oracle Cloud' },
  { pattern: /IBM Cloud Foundation/i, product: 'IBM AIX' },

  // Databases
  { pattern: /IBM Db2.*z\/OS/i, product: 'IBM Db2' },
  { pattern: /IBM Db2/i, product: 'IBM Db2' },
  { pattern: /Snowflake/i, product: 'Snowflake' },

  // SaaS / Identity
  { pattern: /Microsoft 365/i, product: 'Microsoft 365' },
  { pattern: /Google Workspace/i, product: 'Google Workspace' },
  { pattern: /Google ChromeOS/i, product: 'Google Chrome' },
  { pattern: /Dynamics 365/i, product: 'Dynamics 365' },

  // IBM
  { pattern: /IBM AIX/i, product: 'IBM AIX' },
  { pattern: /IBM i V7R5/i, product: 'IBM i' },
  { pattern: /IBM i V7R4/i, product: 'IBM i' },
  { pattern: /IBM i V7R3/i, product: 'IBM i' },
  { pattern: /IBM i V7R2/i, product: 'IBM i' },
  { pattern: /IBM i/i, product: 'IBM i' },
  { pattern: /IBM z.?OS/i, product: 'IBM z/OS' },
  { pattern: /IBM CICS/i, product: 'IBM CICS' },
  // AWS Foundations (catch the "Amazon Web Services" variant)
  { pattern: /Amazon Web Services Foundations/i, product: 'Amazon Web Services' },
];

// ─── Parse version and status from benchmark name ───────────────────────────
function parseBenchmarkMeta(benchmarkName) {
  // Extract version: e.g. "v4.0.0", "v1.0.1", "v2.1.0"
  const versionMatch = benchmarkName.match(/v(\d+\.\d+\.\d+)/i);
  const version = versionMatch ? `v${versionMatch[1]}` : null;

  // Extract status: "ARCHIVE" in name means archived
  const isArchive = /ARCHIVE/i.test(benchmarkName);
  const status = isArchive ? 'archive' : 'active';

  return { version, status };
}

// ─── Find product ID for a benchmark name ───────────────────────────────────
function findProductId(benchmarkName) {
  for (const mapping of BENCHMARK_TO_PRODUCT) {
    if (mapping.pattern.test(benchmarkName)) {
      const product = allProducts.find(p => p.product_name.includes(mapping.product));
      if (product) return product.id;
    }
  }
  return null;
}

// ─── Section keyword matching ───────────────────────────────────────────────
// Load section headers per product for assigning rules to sections
function loadSectionsForProduct(productId) {
  return db.prepare(
    "SELECT section FROM benchmark_rules WHERE product_id = ? AND rule_type = 'section' AND is_active = 1"
  ).all(productId).map(r => r.section);
}

const SECTION_KEYWORDS = {
  'Account Policies': ['password', 'account lockout', 'kerberos', 'logon', 'sign-in'],
  'Local Policies': ['user rights', 'security options', 'audit policy', 'privilege'],
  'Event Log': ['event log', 'log size', 'retention'],
  'System Services': ['service', 'daemon', 'systemd', 'upstart'],
  'Registry': ['registry', 'hklm', 'hkcu', 'reg_'],
  'Windows Firewall': ['firewall', 'windows defender firewall', 'inbound', 'outbound'],
  'Advanced Audit Policy Configuration': ['audit', 'auditing', 'logon/logoff', 'object access', 'privilege use', 'policy change', 'account management'],
  'Administrative Templates': ['administrative template', 'gpo', 'group policy', 'computer configuration', 'user configuration', 'mss:', 'network\\'],
  'BitLocker': ['bitlocker', 'encryption', 'tpm'],
  'Windows Defender': ['defender', 'antivirus', 'antimalware', 'real-time protection', 'exploit guard'],
  'Initial Setup': ['filesystem', 'partition', 'tmp', 'grub', 'bootloader', 'core dump', 'aslr', 'banner', 'motd', 'crypto policy'],
  'Services': ['xinetd', 'inetd', 'avahi', 'cups', 'dhcp', 'ldap', 'nfs', 'dns', 'ftp', 'http', 'samba', 'snmp', 'proxy', 'squid', 'net-snmp', 'rsyncd', 'time synchronization', 'chrony', 'ntp', 'mail transfer', 'postfix', 'rsync', 'xwindow'],
  'Network Configuration': ['network', 'ip forward', 'icmp', 'tcp', 'ipv6', 'wireless', 'dccp', 'sctp', 'tipc', 'iptables', 'nftables', 'firewalld', 'ip6tables', 'host', 'routing'],
  'Logging and Auditing': ['logging', 'auditd', 'audit', 'rsyslog', 'syslog', 'journald', 'log file', 'log_', 'logging and monitoring'],
  'Access Authentication and Authorization': ['pam', 'password', 'shadow', 'passwd', 'login', 'ssh', 'sshd', 'su ', 'sudo', 'cron', 'at ', 'user', 'group', 'root', 'wheel', 'umask', 'timeout', 'nologin'],
  'System Maintenance': ['permission', 'owner', 'suid', 'sgid', 'world-writable', 'unowned', 'ungrouped', 'integrity', 'aide', 'tripwire'],
  'Filesystem Configuration': ['filesystem', 'mount', 'fstab', 'partition', '/tmp', '/var', '/home', 'squashfs', 'udf', 'cramfs', 'usb-storage'],
  'Software Updates': ['update', 'patch', 'gpgcheck', 'repo_gpgcheck', 'package manager'],
  'AppArmor': ['apparmor', 'aa-enforce', 'profile'],
  'Identity and Access Management': ['iam', 'identity', 'access key', 'mfa', 'policy', 'role', 'user', 'credential', 'root account', 'console access', 'service account'],
  'Logging': ['logging', 'cloudtrail', 'cloudwatch', 'flow log', 'audit log', 'diagnostic', 'activity log', 'access log'],
  'Monitoring': ['monitoring', 'alarm', 'alert', 'metric', 'cloudwatch', 'sns', 'guard duty', 'security hub'],
  'Networking': ['vpc', 'security group', 'nacl', 'network acl', 'subnet', 'routing', 'peering', 'endpoint', 'dns', 'load balancer', 'cdn', 'waf'],
  'Storage': ['s3', 'bucket', 'blob', 'storage account', 'ebs', 'disk', 'object storage', 'encryption at rest', 'versioning'],
  'Compute': ['ec2', 'instance', 'vm', 'virtual machine', 'auto scaling', 'launch config', 'ami', 'image'],
  'Database Services': ['rds', 'database', 'dynamodb', 'aurora', 'cosmos', 'sql', 'redis', 'elasticache', 'cloud sql'],
  // Browsers
  'Installation and Updates': ['install', 'update', 'version', 'auto-update', 'channel'],
  'Privacy and Security': ['privacy', 'security', 'safe browsing', 'smartscreen', 'tracking', 'cookie', 'do not track'],
  'Content Settings': ['content', 'javascript', 'popup', 'notification', 'geolocation', 'camera', 'microphone'],
  'Password Manager': ['password manager', 'autofill', 'saved password', 'credential'],
  'Extensions': ['extension', 'addon', 'plugin', 'webstore'],
  // Network Devices
  'Management Plane': ['management', 'ssh', 'console', 'vty', 'aaa', 'tacacs', 'radius', 'ntp', 'snmp', 'banner', 'logging', 'enable', 'exec-timeout'],
  'Control Plane': ['control plane', 'routing', 'bgp', 'ospf', 'eigrp', 'copp', 'cpp'],
  'Data Plane': ['data plane', 'acl', 'access-list', 'qos', 'interface', 'vlan', 'trunk', 'cdp', 'lldp'],
  // SaaS
  'Account and Authentication': ['account', 'authentication', 'sign-in', 'mfa', 'password', 'conditional access'],
  'Microsoft Entra ID': ['entra', 'azure ad', 'conditional access', 'identity protection'],
  // Server Software
  'SSL/TLS Configuration': ['ssl', 'tls', 'certificate', 'cipher', 'protocol', 'https'],
  'Access Control': ['access control', 'authorization', 'permission', 'allow', 'deny', 'require'],
  // Databases
  'Installation and Patching': ['install', 'patch', 'version', 'update'],
  'Authentication': ['authentication', 'login', 'password', 'credential', 'user'],
  'Auditing': ['audit', 'logging', 'monitor', 'alert'],
  'Encryption': ['encrypt', 'tls', 'ssl', 'cipher', 'transparent data'],
  'Backup and Recovery': ['backup', 'recovery', 'restore', 'replication'],
};

function assignSection(ruleTitle, productSections) {
  if (!ruleTitle || !productSections || productSections.length === 0) return null;
  const titleLower = ruleTitle.toLowerCase();

  let bestSection = null;
  let bestScore = 0;

  for (const section of productSections) {
    const keywords = SECTION_KEYWORDS[section];
    if (!keywords) continue;

    let score = 0;
    for (const kw of keywords) {
      if (titleLower.includes(kw.toLowerCase())) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestSection = section;
    }
  }

  // Also try matching section name directly in title
  if (!bestSection) {
    for (const section of productSections) {
      if (titleLower.includes(section.toLowerCase())) {
        return section;
      }
    }
  }

  return bestSection;
}

// ─── Main Import ────────────────────────────────────────────────────────────
async function main() {
  // Clear existing non-section rules (keep section headers from seed)
  const deleted = db.prepare("DELETE FROM benchmark_rules WHERE rule_type != 'section'").run();
  console.log(`  Cleared ${deleted.changes} existing non-section rules\n`);

  // Read Excel
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(EXCEL_PATH);
  const sheet = workbook.worksheets[0];

  // Parse headers
  const headers = [];
  sheet.getRow(1).eachCell((cell, colNumber) => {
    headers[colNumber] = String(cell.value || '').trim();
  });
  console.log(`  Excel columns: ${headers.filter(Boolean).join(', ')}`);

  // Map column names to indices
  const colMap = {};
  headers.forEach((h, i) => {
    if (h) colMap[h.toLowerCase().replace(/\s+/g, '_')] = i;
  });

  const rows = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // skip header
    const get = (key) => {
      const idx = colMap[key];
      return idx ? String(row.getCell(idx).value || '').trim() : '';
    };
    rows.push({
      benchmark: get('benchmark'),
      rule_id: get('rule_id'),
      title: get('title'),
      profile_level: get('profile_level'),
      assessment_status: get('assessment_status'),
      description: get('description'),
      rationale: get('rationale'),
      remediation: get('remediation'),
    });
  });

  console.log(`  Total Excel rows: ${rows.length}\n`);

  // Group by benchmark name to show stats
  const benchmarkGroups = {};
  rows.forEach(r => {
    if (!benchmarkGroups[r.benchmark]) benchmarkGroups[r.benchmark] = [];
    benchmarkGroups[r.benchmark].push(r);
  });

  console.log(`  Unique benchmarks: ${Object.keys(benchmarkGroups).length}\n`);

  // Prepare insert
  const ins = db.prepare(`INSERT INTO benchmark_rules
    (product_id, rule_id, title, section, subsection, level, rule_type, source,
     severity, cis_profile, check_type, description, rationale, remediation,
     benchmark_version, benchmark_status, cis_uid, is_automatable, is_active)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  // Cache sections per product
  const sectionCache = {};
  function getSections(productId) {
    if (!sectionCache[productId]) {
      sectionCache[productId] = loadSectionsForProduct(productId);
    }
    return sectionCache[productId];
  }

  // Track rule sequence per product for CIS UID generation
  const ruleSeqByProduct = {};

  let imported = 0;
  let skipped = 0;
  let noProductMatch = {};

  const tx = db.transaction(() => {
    for (const [benchmarkName, benchmarkRows] of Object.entries(benchmarkGroups)) {
      const productId = findProductId(benchmarkName);
      if (!productId) {
        noProductMatch[benchmarkName] = benchmarkRows.length;
        skipped += benchmarkRows.length;
        continue;
      }

      const { version, status } = parseBenchmarkMeta(benchmarkName);
      const sections = getSections(productId);

      // Initialize sequence counter for this product
      if (!ruleSeqByProduct[productId]) ruleSeqByProduct[productId] = 0;

      for (const r of benchmarkRows) {
        if (!r.title) { skipped++; continue; }

        ruleSeqByProduct[productId]++;
        const seq = ruleSeqByProduct[productId];
        const cisUid = `CIS-2026-${String(productId).padStart(5,'0')}.${String(seq).padStart(3,'0')}`;

        const section = assignSection(r.title, sections);
        const checkType = r.assessment_status ?
          (r.assessment_status.toLowerCase().includes('auto') ? 'automated' :
           r.assessment_status.toLowerCase().includes('manual') ? 'manual' : null) : null;
        const cisProfile = r.profile_level ?
          (r.profile_level.includes('1') ? 'L1' : r.profile_level.includes('2') ? 'L2' : r.profile_level) : null;

        ins.run(
          productId,           // product_id
          r.rule_id || null,   // rule_id
          r.title,             // title
          section,             // section
          null,                // subsection
          2,                   // level (rule)
          'rule',              // rule_type
          'CIS',               // source
          null,                // severity
          cisProfile,          // cis_profile
          checkType,           // check_type
          r.description || null, // description
          r.rationale || null,   // rationale
          r.remediation || null, // remediation
          version,             // benchmark_version
          status,              // benchmark_status
          cisUid,              // cis_uid
          checkType === 'automated' ? 1 : 0, // is_automatable
          1                    // is_active
        );
        imported++;
      }
    }
  });

  tx();

  console.log(`  ════════════════════════════════════════`);
  console.log(`  Import complete!`);
  console.log(`  ────────────────────────────────────────`);
  console.log(`  Imported:  ${imported.toLocaleString()} rules`);
  console.log(`  Skipped:   ${skipped.toLocaleString()} rules`);
  console.log(`  Total:     ${(imported + skipped).toLocaleString()} rows\n`);

  if (Object.keys(noProductMatch).length > 0) {
    console.log(`  Unmatched benchmarks (no product in DB):`);
    for (const [name, count] of Object.entries(noProductMatch)) {
      console.log(`    - ${name} (${count} rules)`);
    }
    console.log('');
  }

  // Show version breakdown
  const versionStats = db.prepare(`
    SELECT benchmark_version, benchmark_status, COUNT(*) as n
    FROM benchmark_rules
    WHERE rule_type = 'rule' AND benchmark_version IS NOT NULL
    GROUP BY benchmark_version, benchmark_status
    ORDER BY benchmark_status, benchmark_version
  `).all();

  console.log(`  Version breakdown:`);
  let activeCount = 0, archiveCount = 0;
  versionStats.forEach(v => {
    const label = `${v.benchmark_version} (${v.benchmark_status})`;
    console.log(`    ${label.padEnd(25)} ${v.n.toLocaleString()} rules`);
    if (v.benchmark_status === 'active') activeCount += v.n;
    else archiveCount += v.n;
  });
  console.log(`\n  Active rules:   ${activeCount.toLocaleString()}`);
  console.log(`  Archived rules: ${archiveCount.toLocaleString()}\n`);

  // Per-product stats
  const productStats = db.prepare(`
    SELECT p.product_name, COUNT(r.id) as rule_count,
           GROUP_CONCAT(DISTINCT r.benchmark_version) as versions,
           GROUP_CONCAT(DISTINCT r.benchmark_status) as statuses
    FROM benchmark_rules r
    JOIN benchmark_products p ON r.product_id = p.id
    WHERE r.rule_type = 'rule'
    GROUP BY p.id
    ORDER BY rule_count DESC
  `).all();

  console.log(`  Rules per product (top 20):`);
  productStats.slice(0, 20).forEach(p => {
    console.log(`    ${p.product_name.padEnd(40)} ${String(p.rule_count).padStart(6)} rules  [${p.versions}] ${p.statuses}`);
  });
  console.log(`\n  Total products with rules: ${productStats.length}\n`);

  db.close();
}

main().catch(err => {
  console.error('\n  ERROR:', err.message);
  process.exit(1);
});
