#!/usr/bin/env python3
"""Generate PRISMA BRD as a professional PDF."""
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.colors import HexColor
from reportlab.lib.units import inch
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_JUSTIFY
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
    PageBreak, HRFlowable, KeepTogether
)
from reportlab.lib import colors
from datetime import datetime
import os

# Prism AI brand colors
NAVY = HexColor('#17135C')
ROYAL = HexColor('#3A5998')
SKY = HexColor('#BDC9DD')
CHARCOAL = HexColor('#1A1A2E')
WHITE = HexColor('#FFFFFF')
LIGHT_GRAY = HexColor('#F5F6FA')
GREEN = HexColor('#34D399')
RED = HexColor('#EF4444')
AMBER = HexColor('#F59E0B')

OUTPUT_DIR = os.path.dirname(os.path.abspath(__file__))
OUTPUT_FILE = os.path.join(OUTPUT_DIR, 'PRISMA_BRD_v1.0.pdf')


def build_styles():
    styles = getSampleStyleSheet()

    styles.add(ParagraphStyle(
        'CoverTitle', parent=styles['Title'],
        fontSize=32, leading=38, textColor=NAVY,
        spaceAfter=6, alignment=TA_CENTER, fontName='Helvetica-Bold'
    ))
    styles.add(ParagraphStyle(
        'CoverSubtitle', parent=styles['Normal'],
        fontSize=14, leading=18, textColor=ROYAL,
        spaceAfter=4, alignment=TA_CENTER, fontName='Helvetica'
    ))
    styles.add(ParagraphStyle(
        'CoverAcronym', parent=styles['Normal'],
        fontSize=11, leading=14, textColor=HexColor('#666666'),
        spaceAfter=20, alignment=TA_CENTER, fontName='Helvetica-Oblique'
    ))
    styles.add(ParagraphStyle(
        'SectionHeader', parent=styles['Heading1'],
        fontSize=18, leading=22, textColor=NAVY,
        spaceBefore=20, spaceAfter=10, fontName='Helvetica-Bold',
        borderWidth=0, borderPadding=0
    ))
    styles.add(ParagraphStyle(
        'SubHeader', parent=styles['Heading2'],
        fontSize=13, leading=16, textColor=ROYAL,
        spaceBefore=14, spaceAfter=6, fontName='Helvetica-Bold'
    ))
    styles.add(ParagraphStyle(
        'Body', parent=styles['Normal'],
        fontSize=10.5, leading=15, textColor=CHARCOAL,
        spaceAfter=8, alignment=TA_JUSTIFY, fontName='Helvetica'
    ))
    styles.add(ParagraphStyle(
        'BulletItem', parent=styles['Normal'],
        fontSize=10.5, leading=15, textColor=CHARCOAL,
        spaceAfter=4, leftIndent=24, bulletIndent=12,
        fontName='Helvetica'
    ))
    styles.add(ParagraphStyle(
        'TableHeader', parent=styles['Normal'],
        fontSize=9, leading=12, textColor=WHITE,
        fontName='Helvetica-Bold', alignment=TA_CENTER
    ))
    styles.add(ParagraphStyle(
        'TableCell', parent=styles['Normal'],
        fontSize=9, leading=12, textColor=CHARCOAL,
        fontName='Helvetica'
    ))
    styles.add(ParagraphStyle(
        'FooterText', parent=styles['Normal'],
        fontSize=8, leading=10, textColor=HexColor('#999999'),
        fontName='Helvetica', alignment=TA_CENTER
    ))
    styles.add(ParagraphStyle(
        'MetaLabel', parent=styles['Normal'],
        fontSize=10, leading=13, textColor=HexColor('#666666'),
        fontName='Helvetica-Bold', alignment=TA_CENTER
    ))
    styles.add(ParagraphStyle(
        'MetaValue', parent=styles['Normal'],
        fontSize=10, leading=13, textColor=CHARCOAL,
        fontName='Helvetica', alignment=TA_CENTER
    ))
    return styles


def hr():
    return HRFlowable(width='100%', thickness=1, color=SKY, spaceBefore=4, spaceAfter=8)


def section(title, styles):
    return [Spacer(1, 4), Paragraph(title, styles['SectionHeader']), hr()]


def sub(title, styles):
    return [Paragraph(title, styles['SubHeader'])]


def body(text, styles):
    return [Paragraph(text, styles['Body'])]


def bullet(text, styles):
    return [Paragraph(f'<bullet>&bull;</bullet> {text}', styles['BulletItem'])]


def make_table(headers, rows, col_widths, styles):
    header_cells = [Paragraph(h, styles['TableHeader']) for h in headers]
    data = [header_cells]
    for row in rows:
        data.append([Paragraph(str(c), styles['TableCell']) for c in row])

    t = Table(data, colWidths=col_widths, repeatRows=1)
    t.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), ROYAL),
        ('TEXTCOLOR', (0, 0), (-1, 0), WHITE),
        ('ALIGN', (0, 0), (-1, 0), 'CENTER'),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
        ('FONTSIZE', (0, 0), (-1, 0), 9),
        ('BOTTOMPADDING', (0, 0), (-1, 0), 8),
        ('TOPPADDING', (0, 0), (-1, 0), 8),
        ('BACKGROUND', (0, 1), (-1, -1), WHITE),
        ('ROWBACKGROUNDS', (0, 1), (-1, -1), [WHITE, LIGHT_GRAY]),
        ('GRID', (0, 0), (-1, -1), 0.5, SKY),
        ('LEFTPADDING', (0, 0), (-1, -1), 8),
        ('RIGHTPADDING', (0, 0), (-1, -1), 8),
        ('TOPPADDING', (0, 1), (-1, -1), 5),
        ('BOTTOMPADDING', (0, 1), (-1, -1), 5),
    ]))
    return t


def add_page_number(canvas, doc):
    canvas.saveState()
    canvas.setFont('Helvetica', 8)
    canvas.setFillColor(HexColor('#999999'))
    canvas.drawCentredString(letter[0] / 2, 30, f'Prism AI Analytics  |  PRISMA BRD v1.0  |  Page {doc.page}')
    canvas.restoreState()


def build_pdf():
    s = build_styles()
    doc = SimpleDocTemplate(
        OUTPUT_FILE, pagesize=letter,
        leftMargin=0.9*inch, rightMargin=0.9*inch,
        topMargin=0.8*inch, bottomMargin=0.8*inch
    )
    story = []
    W = letter[0] - 1.8*inch  # usable width

    # ─── COVER PAGE ─────────────────────────────────────────────────
    story.append(Spacer(1, 1.5*inch))
    story.append(Paragraph('PRISMA', s['CoverTitle']))
    story.append(Paragraph('Prism Risk Intelligence &<br/>Security Management Advisor', s['CoverSubtitle']))
    story.append(Spacer(1, 8))
    story.append(Paragraph('Business Requirements Document', s['CoverAcronym']))
    story.append(Spacer(1, 0.4*inch))
    story.append(HRFlowable(width='60%', thickness=2, color=ROYAL, spaceBefore=0, spaceAfter=20))
    story.append(Spacer(1, 0.3*inch))

    meta = [
        ['Document Version', 'v1.0'],
        ['Date', datetime.now().strftime('%B %d, %Y')],
        ['Author', 'Prism AI Analytics'],
        ['Status', 'Draft'],
        ['Classification', 'Internal'],
    ]
    meta_data = [[Paragraph(r[0], s['MetaLabel']), Paragraph(r[1], s['MetaValue'])] for r in meta]
    mt = Table(meta_data, colWidths=[2.5*inch, 3*inch])
    mt.setStyle(TableStyle([
        ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('TOPPADDING', (0, 0), (-1, -1), 4),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
        ('LINEBELOW', (0, 0), (-1, -2), 0.5, SKY),
    ]))
    story.append(mt)
    story.append(PageBreak())

    # ─── TABLE OF CONTENTS ──────────────────────────────────────────
    story += section('Table of Contents', s)
    toc_items = [
        '1. Executive Summary',
        '2. Project Overview',
        '3. Business Objectives',
        '4. Scope',
        '5. Functional Requirements',
        '6. Non-Functional Requirements',
        '7. Technical Architecture',
        '8. Data Requirements',
        '9. User Interface Requirements',
        '10. Integration Requirements',
        '11. Security & Compliance',
        '12. Success Metrics & KPIs',
        '13. Risks & Mitigations',
        '14. Timeline & Milestones',
        '15. Appendix',
    ]
    for item in toc_items:
        story += body(item, s)
    story.append(PageBreak())

    # ─── 1. EXECUTIVE SUMMARY ───────────────────────────────────────
    story += section('1. Executive Summary', s)
    story += body(
        'PRISMA (Prism Risk Intelligence & Security Management Advisor) is an AI-powered compliance '
        'analyst integrated into the Prism AI Analytics Dashboard. It provides instant, context-aware '
        'answers to CIS Benchmark and security hardening questions by searching a knowledge base of '
        '11,260+ real CIS rules across 68 products and cross-referencing product-level metadata '
        'including versions, drift detection capabilities, automation ceilings, and applicable frameworks.', s)
    story += body(
        'PRISMA eliminates the need for manual PDF lookups, reduces compliance research time by an '
        'estimated 80%, and enables Prism AI consultants and clients to make faster, data-driven '
        'security decisions directly within the dashboard.', s)

    # ─── 2. PROJECT OVERVIEW ────────────────────────────────────────
    story += section('2. Project Overview', s)
    story += sub('2.1 Background', s)
    story += body(
        'Prism AI Analytics manages CIS Benchmark compliance data for enterprise clients across '
        'cloud platforms, operating systems, databases, network devices, and SaaS applications. '
        'The existing Security Baselines page provides a matrix view of 68 products with drill-down '
        'to individual benchmark rules. However, finding specific rules, understanding remediation '
        'steps, and cross-referencing product capabilities required manual effort.', s)
    story += sub('2.2 Problem Statement', s)
    story += bullet('Consultants spend 15-30 minutes per query searching CIS PDFs manually', s)
    story += bullet('No way to ask natural language questions about compliance posture', s)
    story += bullet('Product metadata (versions, drift detection, automation) disconnected from rule data', s)
    story += bullet('Clients cannot self-serve compliance questions without deep CIS expertise', s)
    story += sub('2.3 Proposed Solution', s)
    story += body(
        'An AI chat assistant embedded in the dashboard that searches the full CIS rule database and '
        'product catalog, provides cited answers with CIS UIDs for traceability, and maintains '
        'conversation context for follow-up questions.', s)

    # ─── 3. BUSINESS OBJECTIVES ─────────────────────────────────────
    story += section('3. Business Objectives', s)
    obj_rows = [
        ['OBJ-1', 'Reduce Compliance Research Time', 'Reduce average query resolution from 20 min to under 30 seconds', 'High'],
        ['OBJ-2', 'Improve Rule Traceability', 'Every answer cites CIS UIDs linkable to dashboard records', 'High'],
        ['OBJ-3', 'Enable Client Self-Service', 'Clients can query compliance data without consultant involvement', 'Medium'],
        ['OBJ-4', 'Cross-Reference Product Data', 'Answers include product version, drift detection, and automation info', 'High'],
        ['OBJ-5', 'Support Sales Conversations', 'Demonstrate compliance depth during prospect demos', 'Medium'],
    ]
    story.append(make_table(
        ['ID', 'Objective', 'Success Criteria', 'Priority'],
        obj_rows, [0.6*inch, 1.6*inch, 3*inch, 0.7*inch], s))

    # ─── 4. SCOPE ───────────────────────────────────────────────────
    story += section('4. Scope', s)
    story += sub('4.1 In Scope', s)
    story += bullet('AI chat panel accessible from any dashboard page via floating action button', s)
    story += bullet('Natural language search across 11,260+ CIS benchmark rules', s)
    story += bullet('Product-level metadata search (68 products with version, vendor, drift, automation data)', s)
    story += bullet('CIS UID citation in all responses for dashboard cross-reference', s)
    story += bullet('Conversation history with context retention (last 10 exchanges)', s)
    story += bullet('Custom SVG avatar and branded PRISMA identity', s)
    story += sub('4.2 Out of Scope (Phase 1)', s)
    story += bullet('Semantic/vector search (ChromaDB integration deferred to Phase 2)', s)
    story += bullet('Automated remediation execution', s)
    story += bullet('Multi-tenant access controls per client', s)
    story += bullet('Export chat transcripts to PDF/Word', s)
    story += bullet('Voice input/output', s)
    story.append(PageBreak())

    # ─── 5. FUNCTIONAL REQUIREMENTS ─────────────────────────────────
    story += section('5. Functional Requirements', s)
    fr_rows = [
        ['FR-1', 'Chat Interface', 'Floating chat panel with message input, send button, and scrollable message history', 'Must Have'],
        ['FR-2', 'Rule Search', 'Search benchmark_rules table using keyword matching with relevance ranking across title, description, and remediation fields', 'Must Have'],
        ['FR-3', 'Product Search', 'Search benchmark_products table when product names are mentioned, returning version, vendor, drift detection, automation, and framework data', 'Must Have'],
        ['FR-4', 'CIS UID Citation', 'All rule references include the CIS UID (e.g., CIS-2026-00036.001) for dashboard lookup', 'Must Have'],
        ['FR-5', 'Conversation History', 'Maintain chat context across messages within a session (last 10 exchanges sent to LLM)', 'Must Have'],
        ['FR-6', 'Markdown Rendering', 'Render bold, code blocks, headers, and bullet points in assistant responses', 'Must Have'],
        ['FR-7', 'Error Handling', 'Display user-friendly error messages for API failures, missing API key, and auth issues', 'Must Have'],
        ['FR-8', 'Authentication', 'Chat endpoint requires valid session token (same auth as dashboard)', 'Must Have'],
        ['FR-9', 'Stopword Filtering', 'Remove common words from search queries to improve relevance', 'Should Have'],
        ['FR-10', 'Typing Indicator', 'Show "Searching benchmarks & thinking..." while awaiting response', 'Should Have'],
    ]
    story.append(make_table(
        ['ID', 'Requirement', 'Description', 'Priority'],
        fr_rows, [0.55*inch, 1.2*inch, 3.5*inch, 0.75*inch], s))

    # ─── 6. NON-FUNCTIONAL REQUIREMENTS ─────────────────────────────
    story += section('6. Non-Functional Requirements', s)
    nfr_rows = [
        ['NFR-1', 'Performance', 'Chat responses returned within 15 seconds (including LLM latency)'],
        ['NFR-2', 'Availability', 'Chat available whenever dashboard server is running'],
        ['NFR-3', 'Scalability', 'SQLite search handles 11K+ rules with sub-100ms query time'],
        ['NFR-4', 'Security', 'API key stored in .env file, never exposed to client; chat requires auth token'],
        ['NFR-5', 'Usability', 'Chat accessible via single click from any page; keyboard shortcut (Enter to send)'],
        ['NFR-6', 'Maintainability', 'Search logic in single function; easy to swap LLM provider'],
        ['NFR-7', 'Branding', 'PRISMA avatar and name consistent with Prism AI brand identity'],
    ]
    story.append(make_table(
        ['ID', 'Category', 'Requirement'],
        nfr_rows, [0.6*inch, 1.1*inch, 4.3*inch], s))

    story.append(PageBreak())

    # ─── 7. TECHNICAL ARCHITECTURE ──────────────────────────────────
    story += section('7. Technical Architecture', s)
    story += sub('7.1 System Components', s)
    arch_rows = [
        ['Frontend', 'Vanilla JS (index.html)', 'Chat panel, FAB button, message rendering, auth token management'],
        ['Backend API', 'Express.js (server.js)', 'POST /api/chat endpoint, rule search, product search, Claude API proxy'],
        ['Database', 'SQLite (better-sqlite3)', 'benchmark_rules (11,260 rows), benchmark_products (68 rows)'],
        ['AI Engine', 'Anthropic Claude API', 'claude-sonnet-4-20250514, 2048 max tokens, system prompt with PRISMA persona'],
        ['Knowledge Base', 'SQLite (cis_knowledge_base.db)', '56,106 rules from 351 CIS benchmarks (source of truth for bulk import)'],
        ['Data Pipeline', 'bulk-push-rules.js', 'Direct DB-to-DB transfer, regex-based benchmark-to-product mapping'],
    ]
    story.append(make_table(
        ['Component', 'Technology', 'Details'],
        arch_rows, [1.1*inch, 1.8*inch, 3.1*inch], s))

    story += sub('7.2 Data Flow', s)
    story += body(
        '<b>1.</b> User types question in chat panel<br/>'
        '<b>2.</b> Frontend sends POST /api/chat with message + conversation history + auth token<br/>'
        '<b>3.</b> Server runs searchRules() - keyword LIKE search across title, description, remediation with relevance ranking<br/>'
        '<b>4.</b> Server runs searchProducts() - matches product names mentioned in query<br/>'
        '<b>5.</b> Context assembled: rule details (CIS UID, rule ID, title, description, rationale, remediation) + product details (version, vendor, drift, automation, frameworks)<br/>'
        '<b>6.</b> Context + conversation history sent to Claude API with PRISMA system prompt<br/>'
        '<b>7.</b> Response returned to frontend, rendered with markdown formatting', s)

    story += sub('7.3 Search Algorithm', s)
    story += body(
        'The search uses a two-pass approach:', s)
    story += bullet('<b>Term extraction:</b> Query split into tokens, stopwords removed, terms under 3 characters filtered', s)
    story += bullet('<b>Broad matching:</b> OR logic between terms for recall (any term matching returns the rule)', s)
    story += bullet('<b>Relevance ranking:</b> Each term scores 3 points for title match, 1 for description, 1 for remediation. Results sorted by total score descending, limited to top 12', s)
    story += bullet('<b>Product matching:</b> Separate query against benchmark_products by product_name LIKE, returning full product metadata', s)

    # ─── 8. DATA REQUIREMENTS ───────────────────────────────────────
    story += section('8. Data Requirements', s)
    story += sub('8.1 Data Sources', s)
    data_rows = [
        ['benchmark_rules', 'prism.db', '11,261', 'CIS rules with UID, title, description, rationale, remediation, profile, check type'],
        ['benchmark_products', 'prism.db', '68', 'Products with version, vendor, CIS/STIG coverage, drift detection, automation, frameworks'],
        ['CIS Knowledge Base', 'cis_knowledge_base.db', '56,106', 'Full extracted rules from 351 CIS benchmark PDFs (source for bulk import)'],
    ]
    story.append(make_table(
        ['Table/Source', 'Database', 'Records', 'Key Fields'],
        data_rows, [1.3*inch, 1.2*inch, 0.6*inch, 2.9*inch], s))

    story += sub('8.2 Data Refresh Process', s)
    story += bullet('New CIS PDFs dropped into benchmark folders', s)
    story += bullet('cis_extract_pdfs MCP tool extracts rules into knowledge base', s)
    story += bullet('bulk-push-rules.js transfers latest version per product to dashboard DB', s)
    story += bullet('Dashboard active_rule_count updates automatically via SQL subquery', s)

    story.append(PageBreak())

    # ─── 9. USER INTERFACE REQUIREMENTS ─────────────────────────────
    story += section('9. User Interface Requirements', s)
    story += sub('9.1 Chat FAB (Floating Action Button)', s)
    story += bullet('Fixed position: bottom-right corner (24px from edges)', s)
    story += bullet('52px circular button with custom SVG avatar (PRISMA character)', s)
    story += bullet('Hover effect: scale 1.08x with box shadow', s)
    story += bullet('Accessible from every dashboard page', s)

    story += sub('9.2 Chat Panel', s)
    story += bullet('420px wide x 520px tall, fixed position above FAB', s)
    story += bullet('Dark theme matching dashboard (var(--card) background, var(--border) borders)', s)
    story += bullet('Header with PRISMA avatar, name, and close button', s)
    story += bullet('Scrollable message area with user (blue, right-aligned) and assistant (dark, left-aligned) bubbles', s)
    story += bullet('Input area with textarea (Enter to send, Shift+Enter for newline) and Send button', s)
    story += bullet('Error messages displayed in red-tinted bubbles', s)

    story += sub('9.3 PRISMA Identity', s)
    story += bullet('Name: PRISMA - Prism Risk Intelligence & Security Management Advisor', s)
    story += bullet('Avatar: Custom SVG - woman with dark hair, front bangs, medium-brown skin tone', s)
    story += bullet('Welcome message: "Hey, I\'m PRISMA - your Prism Risk Intelligence & Security Management Advisor..."', s)
    story += bullet('Typing indicator: "Searching benchmarks & thinking..."', s)

    # ─── 10. INTEGRATION REQUIREMENTS ───────────────────────────────
    story += section('10. Integration Requirements', s)
    int_rows = [
        ['Anthropic Claude API', '@anthropic-ai/sdk', 'LLM inference for chat responses', 'ANTHROPIC_API_KEY in .env'],
        ['Dashboard Auth', 'Express session tokens', 'Same auth as all dashboard endpoints', 'Bearer token from login'],
        ['CIS Knowledge Base', 'SQLite (read-only)', 'Source data for bulk rule import', 'bulk-push-rules.js'],
        ['CIS MCP Server', 'cis_dashboard_mcp.py', 'PDF extraction, search, sync pipeline', 'MCP tools via Claude Code'],
    ]
    story.append(make_table(
        ['System', 'Interface', 'Purpose', 'Auth/Config'],
        int_rows, [1.3*inch, 1.3*inch, 1.8*inch, 1.6*inch], s))

    # ─── 11. SECURITY & COMPLIANCE ──────────────────────────────────
    story += section('11. Security & Compliance', s)
    story += bullet('<b>API Key Protection:</b> ANTHROPIC_API_KEY stored server-side in .env, never sent to browser', s)
    story += bullet('<b>Authentication:</b> Chat endpoint requires valid session token (same as dashboard API)', s)
    story += bullet('<b>Data Privacy:</b> All rule data stays within the dashboard server; only user queries sent to Claude API', s)
    story += bullet('<b>Rate Limiting:</b> Express rate-limit middleware applies to all API endpoints including /api/chat', s)
    story += bullet('<b>Input Validation:</b> Message field validated for type and length before processing', s)
    story += bullet('<b>No PII in Rules:</b> CIS benchmark data is publicly available security guidance, no customer PII', s)

    story.append(PageBreak())

    # ─── 12. SUCCESS METRICS ────────────────────────────────────────
    story += section('12. Success Metrics & KPIs', s)
    kpi_rows = [
        ['Query Response Time', '< 15 seconds', 'Time from send to response displayed'],
        ['Search Relevance', '> 80% useful', 'Responses cite relevant rules for the query'],
        ['Rule Coverage', '68 products, 11K+ rules', 'All active products searchable via chat'],
        ['CIS UID Citation Rate', '100%', 'Every rule reference includes traceable CIS UID'],
        ['User Adoption', '> 50% of sessions', 'Percentage of dashboard sessions using chat'],
        ['Error Rate', '< 5%', 'Percentage of queries returning errors'],
    ]
    story.append(make_table(
        ['KPI', 'Target', 'Measurement'],
        kpi_rows, [1.5*inch, 1.3*inch, 3.2*inch], s))

    # ─── 13. RISKS & MITIGATIONS ────────────────────────────────────
    story += section('13. Risks & Mitigations', s)
    risk_rows = [
        ['R-1', 'API Key Exposure', 'High', 'Key stored server-side in .env, .gitignore prevents commit'],
        ['R-2', 'LLM Hallucination', 'Medium', 'System prompt restricts to provided context only; CIS UIDs enable verification'],
        ['R-3', 'Search Miss (0 results)', 'Medium', 'OR-based matching with stopword removal; product search as fallback'],
        ['R-4', 'API Cost Overrun', 'Low', 'Rate limiting on endpoint; 2048 max token cap per response'],
        ['R-5', 'Stale Rule Data', 'Low', 'bulk-push-rules.js can re-run anytime; CIS sync pipeline available'],
        ['R-6', 'Claude API Outage', 'Low', 'Graceful error message shown; dashboard fully functional without chat'],
    ]
    story.append(make_table(
        ['ID', 'Risk', 'Impact', 'Mitigation'],
        risk_rows, [0.5*inch, 1.3*inch, 0.7*inch, 3.5*inch], s))

    # ─── 14. TIMELINE & MILESTONES ──────────────────────────────────
    story += section('14. Timeline & Milestones', s)
    timeline_rows = [
        ['Phase 1 - Core Chat', 'Complete', 'Chat panel, rule search, product search, CIS UID citations, PRISMA identity'],
        ['Phase 2 - Enhanced Search', 'Planned', 'FTS5 full-text search, ChromaDB semantic search, search result previews'],
        ['Phase 3 - Deliverables', 'Planned', 'Export checklists, audit reports, gap analyses directly from chat'],
        ['Phase 4 - Multi-Tenant', 'Future', 'Per-client rule scoping, access controls, usage analytics'],
    ]
    story.append(make_table(
        ['Milestone', 'Status', 'Deliverables'],
        timeline_rows, [1.5*inch, 0.8*inch, 3.7*inch], s))

    # ─── 15. APPENDIX ───────────────────────────────────────────────
    story += section('15. Appendix', s)
    story += sub('A. API Endpoint Specification', s)
    story += body('<b>POST /api/chat</b>', s)
    story += body(
        '<b>Request Body:</b><br/>'
        '{ "message": "string (required)", "history": [{"role": "user|assistant", "content": "string"}] }<br/><br/>'
        '<b>Response (200):</b><br/>'
        '{ "ok": true, "answer": "string", "rulesFound": number }<br/><br/>'
        '<b>Error Responses:</b><br/>'
        '400: Missing or invalid message<br/>'
        '503: ANTHROPIC_API_KEY not configured<br/>'
        '500: AI processing error', s)

    story += sub('B. Benchmark-to-Product Mapping (Sample)', s)
    map_rows = [
        ['Amazon Web Services|AWS.*', '1 (AWS)'],
        ['Microsoft Azure.*', '2 (Azure)'],
        ['Windows Server 2025', '6'],
        ['Ubuntu', '12 (Ubuntu Linux)'],
        ['Kubernetes Benchmark', '31 (Kubernetes)'],
        ['MongoDB|MONGODB', '36 (MongoDB)'],
        ['Cisco IOS|Cisco ASA|Cisco NX-OS', '41 (Cisco IOS XE)'],
        ['FortiGate|Palo Alto', '42 (FortiGate)'],
    ]
    story.append(make_table(
        ['Regex Pattern', 'Product ID (Name)'],
        map_rows, [3.5*inch, 2.5*inch], s))

    story += sub('C. File Inventory', s)
    file_rows = [
        ['server.js', 'Express backend with /api/chat endpoint, search functions, .env loader'],
        ['public/index.html', 'Chat panel HTML/CSS/JS, PRISMA SVG avatar, message rendering'],
        ['bulk-push-rules.js', 'DB-to-DB rule transfer script (KB to dashboard)'],
        ['.env', 'ANTHROPIC_API_KEY, PORT, API_KEY configuration'],
        ['package.json', '@anthropic-ai/sdk dependency added'],
    ]
    story.append(make_table(
        ['File', 'Purpose'],
        file_rows, [1.8*inch, 4.2*inch], s))

    # Build
    doc.build(story, onFirstPage=add_page_number, onLaterPages=add_page_number)
    print(f'BRD generated: {OUTPUT_FILE}')


if __name__ == '__main__':
    build_pdf()
