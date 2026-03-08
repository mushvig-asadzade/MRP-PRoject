'use strict';
const express = require('express');
const session = require('express-session');
const sql     = require('mssql');
const fs      = require('fs');
const path    = require('path');

const app       = express();
const PORT      = 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

// ── DB CONFIG ─────────────────────────────────────────────────────────
const dbConfig = {
  server: '192.168.1.250',
  database: 'TIGER',
  user: 'sa',
  password: 'sys.123',
  options: { trustServerCertificate: true, encrypt: false }
};

// ── DATA STORE ────────────────────────────────────────────────────────
function loadData() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      const d = { users: [{ id: 1, username: 'sa', password: 'sys.123', role: 'admin', allowedUsers: [] }], reportGroups: [], reports: [], nextId: 2 };
      fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2));
      return d;
    }
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    console.error('Data load error:', e);
    return { users: [], reportGroups: [], reports: [], nextId: 1 };
  }
}
function saveData(d) { fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2)); }
function makeId(d)   { const id = d.nextId || 1; d.nextId = id + 1; return id; }

// ── EXPRESS ───────────────────────────────────────────────────────────
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({ secret: 'lojimax2026', resave: false, saveUninitialized: false }));

// ── MIDDLEWARE ────────────────────────────────────────────────────────
const IDLE_TIMEOUT = 20 * 60 * 1000; // 20 dakika
const auth = (req, res, next) => {
  if (req.session && req.session.user) {
    const now = Date.now();
    if (req.session.lastActivity && (now - req.session.lastActivity) > IDLE_TIMEOUT) {
      req.session.destroy();
      return res.redirect('/login?timeout=1');
    }
    req.session.lastActivity = now;
    return next();
  }
  res.redirect('/login');
};
const adminOnly = (req, res, next) => {
  if (req.session && req.session.role === 'admin') return next();
  res.status(403).send('<h2 style="padding:40px;color:#c62828;">Erişim reddedildi. Yönetici yetkisi gereklidir.</h2>');
};

// ── HELPERS ───────────────────────────────────────────────────────────
const formatDate = v => {
  if (v === null || v === undefined || v === '') return '-';
  const d = new Date(v);
  return isNaN(d.getTime()) ? String(v) : d.toLocaleDateString('tr-TR');
};
const badge = (val, map) => {
  const c = map[val] || { bg: '#f5f5f5', col: '#555', b: '#ccc' };
  return `<span style="background:${c.bg};color:${c.col};border:1px solid ${c.b};padding:3px 10px;border-radius:20px;font-size:11px;font-weight:600;white-space:nowrap;">${val || '—'}</span>`;
};
const sipMap = { 'Sevkedilebilir': { bg: '#e8f5e9', col: '#2e7d32', b: '#a5d6a7' }, 'Öneri': { bg: '#fff8e1', col: '#f57f17', b: '#ffe082' } };
const urtMap = { 'Planlama bekliyor': { bg: '#fce4ec', col: '#880e4f', b: '#f48fb1' }, 'Üretim aşamasında': { bg: '#e3f2fd', col: '#0d47a1', b: '#90caf9' }, 'Sevke hazır': { bg: '#e8f5e9', col: '#1b5e20', b: '#a5d6a7' } };
const terminCell = v => {
  if (v === null || v === undefined) return '-';
  const n = parseInt(v);
  if (n < 0)  return `<span style="color:#c62828;font-weight:700;">${n} gün</span>`;
  if (n <= 7) return `<span style="color:#e65100;font-weight:700;">${n} gün</span>`;
  return `<span style="color:#2e7d32;font-weight:600;">${n} gün</span>`;
};

const CHART_COLORS = ['#1a3a8f','#c62828','#2e7d32','#e65100','#6a1b9a','#00838f','#f57f17','#4e342e','#37474f','#558b2f','#0277bd','#ad1457'];

function formatCell(v, type) {
  if (v === null || v === undefined) return '-';
  const s = String(v);
  if (type === 'number') {
    const n = parseFloat(s.replace(/[,\s]/g, ''));
    return isNaN(n) ? s : n.toLocaleString('tr-TR');
  }
  if (type === 'currency') {
    const n = parseFloat(s.replace(/[,\s]/g, ''));
    return isNaN(n) ? s : n.toLocaleString('tr-TR', {minimumFractionDigits:2, maximumFractionDigits:2}) + ' ₺';
  }
  if (type === 'percent') {
    const n = parseFloat(s);
    return isNaN(n) ? s : n.toLocaleString('tr-TR', {maximumFractionDigits:2}) + '%';
  }
  if (type === 'date') {
    const d = new Date(v);
    return isNaN(d.getTime()) ? s : d.toLocaleDateString('tr-TR');
  }
  if (type === 'datetime') {
    const d = new Date(v);
    return isNaN(d.getTime()) ? s : d.toLocaleString('tr-TR');
  }
  return s;
}

function computeStatCard(rows, card) {
  const { aggregate, column, operator, value } = card;
  switch (aggregate) {
    case 'count_all': return rows.length;
    case 'count_where':
      return rows.filter(r => {
        const rv = r[column]; const rn = parseFloat(rv); const vn = parseFloat(value);
        switch (operator) {
          case 'lt': return rn < vn; case 'gt': return rn > vn;
          case 'lte': return rn <= vn; case 'gte': return rn >= vn;
          case 'eq': return String(rv) === String(value);
          case 'neq': return String(rv) !== String(value);
          default: return false;
        }
      }).length;
    case 'sum': { const s = rows.reduce((a, r) => a + (parseFloat(r[column]) || 0), 0); return Number.isInteger(s) ? s : s.toFixed(2); }
    case 'avg': { if (!rows.length) return 0; const s = rows.reduce((a, r) => a + (parseFloat(r[column]) || 0), 0); const avg = s / rows.length; return Number.isInteger(avg) ? avg : avg.toFixed(2); }
    case 'count_distinct': return new Set(rows.map(r => r[column])).size;
    case 'formula': {
      const lv = parseFloat(computeStatCard(rows, { aggregate: card.leftAgg, column: card.leftCol }));
      const rv = card.rightAgg === 'const'
        ? parseFloat(card.rightConst || 0)
        : parseFloat(computeStatCard(rows, { aggregate: card.rightAgg, column: card.rightCol }));
      if (isNaN(lv) || isNaN(rv)) return '—';
      let res;
      switch (card.fOp) {
        case '+': res = lv + rv; break;
        case '-': res = lv - rv; break;
        case '*': res = lv * rv; break;
        case '/': res = rv !== 0 ? lv / rv : '∞'; break;
        default: res = lv;
      }
      return typeof res === 'number' ? (Number.isInteger(res) ? res : res.toFixed(2)) : res;
    }
    default: return rows.length;
  }
}
function computeChartData(rows, chart) {
  const { labelColumn, valueAgg, valueColumn, top } = chart;
  const groups = {};
  rows.forEach(r => {
    const lbl = String(r[labelColumn] ?? 'Diğer');
    if (!groups[lbl]) groups[lbl] = { count: 0, sum: 0 };
    groups[lbl].count++;
    if (valueAgg === 'sum' && valueColumn) groups[lbl].sum += parseFloat(r[valueColumn]) || 0;
  });
  let entries = Object.entries(groups).map(([k, v]) => [k, valueAgg === 'sum' ? v.sum : v.count]);
  entries.sort((a, b) => b[1] - a[1]);
  if (top) entries = entries.slice(0, parseInt(top));
  return { labels: entries.map(e => e[0]), data: entries.map(e => e[1]) };
}


// ── CSS ───────────────────────────────────────────────────────────────
const CSS = `
  *{margin:0;padding:0;box-sizing:border-box;}
  body{font-family:'Segoe UI',Tahoma,sans-serif;background:#eef0f5;min-height:100vh;display:flex;flex-direction:column;}
  header{background:linear-gradient(135deg,#0d1b6e,#1a3a8f);color:white;padding:14px 32px;display:flex;align-items:center;justify-content:space-between;box-shadow:0 3px 10px rgba(0,0,0,0.3);}
  .header-left{display:flex;align-items:center;gap:12px;}
  .logo{width:52px;height:52px;border-radius:10px;display:flex;align-items:center;justify-content:center;overflow:hidden;flex-shrink:0;}
  .logo-text h1{font-size:18px;letter-spacing:3px;font-weight:700;} .logo-text p{font-size:9px;opacity:0.55;letter-spacing:1px;margin-top:1px;}
  .header-right{display:flex;align-items:center;gap:18px;}
  .user-badge{background:rgba(255,255,255,0.12);border-radius:8px;padding:6px 14px;font-size:11px;letter-spacing:0.5px;}
  .logout-btn{background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.25);color:white;padding:6px 14px;border-radius:7px;font-size:11px;cursor:pointer;text-decoration:none;transition:all 0.2s;}
  .logout-btn:hover{background:rgba(255,255,255,0.2);}
  .app-body{display:flex;flex:1;}
  .side-section{padding:0 16px;margin-bottom:6px;}
  .side-section-title{font-size:9px;font-weight:700;color:#aaa;letter-spacing:1.5px;text-transform:uppercase;padding:8px 10px 4px;}
  .side-item{display:block;padding:9px 12px;border-radius:8px;font-size:12.5px;color:#444;text-decoration:none;transition:all 0.15s;cursor:pointer;border:none;background:transparent;width:100%;text-align:left;}
  .side-item:hover{background:#eef0f5;color:#0d1b6e;} .side-item.active{background:#e8eaf6;color:#0d1b6e;font-weight:600;}
  .side-item.sub{padding-left:16px;} .side-item.sub2{padding-left:26px;font-size:12px;color:#555;}
  .side-item.sub3{padding-left:38px;font-size:11.5px;color:#666;}
  .side-item.sub2.active,.side-item.sub3.active{background:#e8eaf6;color:#0d1b6e;font-weight:600;} .side-group{margin-bottom:2px;}
  .side-divider{height:1px;background:#f0f0f0;margin:10px 16px;}
  main{flex:1;padding:24px 32px;overflow:auto;}
  .breadcrumb{font-size:11px;color:#999;margin-bottom:16px;display:flex;align-items:center;gap:6px;}
  .breadcrumb a{color:#1a3a8f;text-decoration:none;} .breadcrumb a:hover{text-decoration:underline;} .breadcrumb span{color:#ccc;}
  .page-title{font-size:20px;font-weight:700;color:#1a1a2e;margin-bottom:20px;display:flex;align-items:center;gap:12px;}
  .page-title small{font-size:13px;font-weight:400;color:#999;}
  .menu-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:16px;margin-top:8px;}
  .menu-card{background:white;border-radius:12px;box-shadow:0 2px 10px rgba(0,0,0,0.07);padding:24px 22px;cursor:pointer;text-decoration:none;color:#333;transition:all 0.2s;border-left:4px solid #1a3a8f;display:block;}
  .menu-card:hover{transform:translateY(-2px);box-shadow:0 6px 20px rgba(0,0,0,0.12);}
  .menu-card .icon{font-size:26px;margin-bottom:10px;} .menu-card .title{font-size:14px;font-weight:700;color:#1a1a2e;margin-bottom:4px;} .menu-card .desc{font-size:11px;color:#888;}
  .stats{display:flex;gap:14px;margin-bottom:20px;flex-wrap:wrap;}
  .stat-card{background:white;border-radius:10px;padding:14px 22px;box-shadow:0 2px 8px rgba(0,0,0,0.07);flex:1;min-width:120px;border-left:4px solid;}
  .stat-card.blue{border-color:#1a3a8f;} .stat-card.red{border-color:#c62828;} .stat-card.orange{border-color:#e65100;} .stat-card.green{border-color:#2e7d32;} .stat-card.purple{border-color:#6a1b9a;} .stat-card.teal{border-color:#00838f;}
  .stat-label{font-size:10px;color:#888;text-transform:uppercase;letter-spacing:0.5px;} .stat-value{font-size:26px;font-weight:700;color:#1a1a2e;margin-top:3px;}
  .stat-card.red .stat-value{color:#c62828;} .stat-card.orange .stat-value{color:#e65100;} .stat-card.green .stat-value{color:#2e7d32;} .stat-card.purple .stat-value{color:#6a1b9a;} .stat-card.teal .stat-value{color:#00838f;}
  .nav-tabs{display:flex;gap:6px;margin-bottom:16px;}
  .nav-tab{padding:8px 20px;border-radius:8px;cursor:pointer;font-size:12px;font-weight:600;color:#666;border:none;background:#e8eaf6;transition:all 0.2s;}
  .nav-tab.active{background:#1a3a8f;color:white;} .nav-tab:hover:not(.active){background:#c5cae9;color:#0d1b6e;}
  .view{display:none;} .view.active{display:block;}
  .card{background:white;border-radius:12px;box-shadow:0 2px 16px rgba(0,0,0,0.08);overflow:hidden;}
  .card-header{background:linear-gradient(90deg,#0d1b6e,#1a3a8f);color:white;padding:12px 20px;font-size:12px;font-weight:700;letter-spacing:1.5px;display:flex;align-items:center;justify-content:space-between;}
  .card-header span{font-size:11px;opacity:0.7;font-weight:400;letter-spacing:0;}
  table{width:100%;border-collapse:collapse;}
  thead{position:sticky;top:0;z-index:1;}
  th{background:#e8eaf6;color:#1a237e;padding:10px 13px;text-align:center;font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;border-bottom:2px solid #c5cae9;white-space:nowrap;}
  td{padding:9px 13px;font-size:12px;color:#333;border-bottom:1px solid #f0f0f0;white-space:nowrap;max-width:260px;overflow:hidden;text-overflow:ellipsis;}
  .data-row:hover td{background:#f0f4ff!important;}
  .scroll-wrap{overflow-x:auto;max-height:60vh;overflow-y:auto;}
  .tbl-footer{text-align:center;padding:12px;font-size:11px;color:#aaa;border-top:1px solid #f0f0f0;}
  .dash-grid{display:grid;grid-template-columns:1fr 1fr;gap:18px;}
  .dash-card{background:white;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,0.07);overflow:hidden;}
  .dash-card-header{background:linear-gradient(90deg,#0d1b6e,#1a3a8f);color:white;padding:11px 18px;font-size:11px;font-weight:700;letter-spacing:1px;}
  .dash-card-body{padding:16px;position:relative;height:280px;} .dash-card-body.tall{height:360px;} .dash-card-body.wide{height:240px;}
  .dash-full{margin-top:18px;}
  .coming-soon{background:white;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,0.07);padding:60px;text-align:center;color:#aaa;}
  /* ADMIN */
  .admin-kpi-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:14px;margin-bottom:28px;}
  .admin-kpi{background:white;border-radius:10px;padding:20px;box-shadow:0 2px 8px rgba(0,0,0,0.07);border-top:3px solid #1a3a8f;text-align:center;}
  .admin-kpi .kpi-n{font-size:36px;font-weight:700;color:#1a3a8f;} .admin-kpi .kpi-l{font-size:11px;color:#888;margin-top:4px;}
  .admin-kpi.red{border-color:#c62828;} .admin-kpi.red .kpi-n{color:#c62828;}
  .admin-kpi.green{border-color:#2e7d32;} .admin-kpi.green .kpi-n{color:#2e7d32;}
  .admin-kpi.orange{border-color:#e65100;} .admin-kpi.orange .kpi-n{color:#e65100;}
  .tbl-card{background:white;border-radius:12px;box-shadow:0 2px 10px rgba(0,0,0,0.07);overflow:hidden;margin-bottom:24px;}
  .tbl-card-header{padding:14px 20px;background:#f8f9ff;border-bottom:2px solid #e8eaf6;display:flex;align-items:center;justify-content:space-between;}
  .tbl-card-title{font-size:13px;font-weight:700;color:#1a1a2e;}
  .admin-table{width:100%;border-collapse:collapse;}
  .admin-table th{background:#e8eaf6;color:#1a237e;padding:10px 16px;text-align:left;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;border-bottom:2px solid #c5cae9;}
  .admin-table td{padding:10px 16px;font-size:12.5px;border-bottom:1px solid #f0f0f0;color:#333;vertical-align:middle;}
  .admin-table tr:last-child td{border-bottom:none;} .admin-table tr:hover td{background:#f8f9ff;}
  .btn{display:inline-flex;align-items:center;gap:5px;padding:8px 16px;border-radius:7px;font-size:12px;font-weight:600;cursor:pointer;border:none;text-decoration:none;transition:all 0.15s;}
  .btn-sm{padding:4px 11px;font-size:11px;border-radius:5px;}
  .btn-primary{background:#1a3a8f;color:white;} .btn-primary:hover{background:#0d1b6e;}
  .btn-edit{background:#e3f2fd;color:#1565c0;border:1px solid #90caf9;} .btn-edit:hover{background:#bbdefb;}
  .btn-danger{background:#fce4ec;color:#c62828;border:1px solid #f48fb1;} .btn-danger:hover{background:#f8bbd9;}
  .btn-success{background:#e8f5e9;color:#2e7d32;border:1px solid #a5d6a7;} .btn-success:hover{background:#c8e6c9;}
  .btn-warning{background:#fff8e1;color:#f57f17;border:1px solid #ffe082;} .btn-warning:hover{background:#fff3cd;}
  .btn-secondary{background:#e8eaf6;color:#444;border:1px solid #c5cae9;} .btn-secondary:hover{background:#c5cae9;}
  .form-card{background:white;border-radius:12px;box-shadow:0 2px 16px rgba(0,0,0,0.08);padding:28px 32px;max-width:940px;}
  .form-row{margin-bottom:18px;}
  .form-row label{display:block;font-size:11px;font-weight:700;color:#555;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;}
  .form-row input,.form-row select,.form-row textarea{width:100%;padding:10px 14px;border:1.5px solid #e0e0e0;border-radius:8px;font-size:13px;font-family:inherit;outline:none;transition:border 0.2s;background:white;color:#333;}
  .form-row input:focus,.form-row select:focus,.form-row textarea:focus{border-color:#1a3a8f;}
  .form-row textarea{resize:vertical;min-height:160px;font-family:'Consolas','Courier New',monospace;font-size:12px;line-height:1.6;}
  .form-cols{display:grid;grid-template-columns:1fr 1fr;gap:16px;}
  .form-cols-3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;}
  .form-cols-4{display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:10px;}
  .section-hdr{font-size:13px;font-weight:700;color:#1a3a8f;padding:12px 0 10px;border-bottom:2px solid #e8eaf6;margin:22px 0 14px;display:flex;align-items:center;justify-content:space-between;}
  .dyn-row{background:#f8f9ff;border:1px solid #e0e4f0;border-radius:8px;padding:14px 14px 14px 16px;margin-bottom:10px;position:relative;}
  .dyn-row .rm{position:absolute;top:10px;right:10px;background:none;border:none;color:#ccc;font-size:16px;cursor:pointer;line-height:1;} .dyn-row .rm:hover{color:#c62828;}
  .alert{padding:12px 16px;border-radius:8px;font-size:12.5px;margin-bottom:16px;border-left:3px solid;}
  .alert-success{background:#e8f5e9;color:#2e7d32;border-color:#2e7d32;} .alert-error{background:#fce4ec;color:#c62828;border-color:#c62828;}
  .role-badge{display:inline-block;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:600;}
  .role-admin{background:#e3f2fd;color:#1565c0;border:1px solid #90caf9;} .role-user{background:#f3e5f5;color:#6a1b9a;border:1px solid #ce93d8;}
  .sql-preview{margin-top:10px;background:#0d1117;color:#7ee787;font-family:'Consolas',monospace;font-size:11px;border-radius:8px;padding:14px;max-height:200px;overflow:auto;display:none;white-space:pre-wrap;}
  .hint{font-size:10.5px;color:#aaa;margin-top:4px;}
  .tag{display:inline-block;padding:2px 8px;border-radius:12px;font-size:10px;font-weight:600;background:#e8eaf6;color:#555;}
  .actions{display:flex;gap:8px;align-items:center;}
  /* FILTER POPUP */
  .th-inner{display:flex;align-items:center;justify-content:space-between;gap:6px;}
  .col-filter-btn{background:none;border:none;cursor:pointer;color:#c5cae9;padding:2px 4px;border-radius:4px;font-size:11px;flex-shrink:0;transition:color 0.15s;line-height:1;}
  .col-filter-btn:hover{color:#1a3a8f;} .col-filter-btn.active{color:#c62828;}
  .filter-popup{display:none;position:fixed;background:white;border:1px solid #e0e4f0;border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,0.18);z-index:9999;width:240px;}
  .filter-popup.open{display:block;}
  .fp-tabs{display:flex;border-bottom:2px solid #e8eaf6;}
  .fp-tab{flex:1;padding:9px 6px;text-align:center;font-size:11px;font-weight:600;cursor:pointer;color:#999;background:none;border:none;border-bottom:2px solid transparent;margin-bottom:-2px;transition:all 0.15s;}
  .fp-tab.active{color:#1a3a8f;border-bottom-color:#1a3a8f;background:#f8f9ff;}
  .fp-body{padding:10px 12px;max-height:260px;overflow-y:auto;}
  .fp-val-item{display:flex;align-items:center;gap:7px;padding:3px 0;font-size:12px;cursor:pointer;user-select:none;}
  .fp-val-item:hover{color:#1a3a8f;}
  .fp-val-all{background:#f0f4ff;border-radius:6px;padding:4px 6px;margin-bottom:4px;font-weight:600;}
  .fp-search-wrap{padding:6px 12px 0;}
  .fp-search-wrap input{width:100%;padding:6px 28px 6px 10px;border:1.5px solid #e0e0e0;border-radius:7px;font-size:12px;outline:none;box-sizing:border-box;font-family:inherit;}
  .fp-search-wrap input:focus{border-color:#1a3a8f;}
  .fp-search-wrap{position:relative;}
  .fp-search-icon{position:absolute;right:20px;top:50%;transform:translateY(-50%);color:#aaa;font-size:13px;pointer-events:none;}
  .fp-text select,.fp-text input[type=text]{width:100%;padding:7px 10px;border:1.5px solid #e0e0e0;border-radius:7px;font-size:12px;outline:none;margin-bottom:8px;font-family:inherit;}
  .fp-text select:focus,.fp-text input[type=text]:focus{border-color:#1a3a8f;}
  .fp-footer{display:flex;justify-content:space-between;align-items:center;padding:8px 12px;border-top:1px solid #f0f0f0;gap:6px;}
  .refresh-bar{display:flex;align-items:center;justify-content:flex-end;gap:10px;margin-bottom:10px;}
  .refresh-time{font-size:11px;color:#999;}
  /* COLUMN PANEL */
  .col-panel{display:none;position:fixed;background:white;border:1px solid #e0e4f0;border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,0.18);z-index:9999;width:220px;}
  .col-panel.open{display:block;}
  .col-panel-hdr{display:flex;align-items:center;justify-content:space-between;padding:10px 12px 8px;border-bottom:2px solid #e8eaf6;font-size:11px;font-weight:700;color:#1a3a8f;}
  .col-panel-body{padding:8px 12px;max-height:280px;overflow-y:auto;}
  .col-item{display:flex;align-items:center;gap:7px;padding:4px 0;font-size:12px;cursor:pointer;user-select:none;}
  .col-item:hover{color:#1a3a8f;}
  .col-panel-footer{padding:8px 12px;border-top:1px solid #f0f0f0;display:flex;gap:6px;}
  /* SIDEBAR TOGGLE */
  .mob-menu-btn{display:flex;background:rgba(255,255,255,0.12);border:1px solid rgba(255,255,255,0.25);color:white;width:36px;height:36px;border-radius:8px;font-size:18px;cursor:pointer;align-items:center;justify-content:center;flex-shrink:0;margin-right:8px;transition:background 0.2s;}
  .mob-menu-btn:hover{background:rgba(255,255,255,0.22);}
  aside{width:240px;background:white;box-shadow:2px 0 8px rgba(0,0,0,0.06);padding:20px 0;flex-shrink:0;overflow-y:auto;overflow-x:hidden;transition:width 0.25s ease,padding 0.25s ease;}
  aside.closed{width:0;padding:0;}
  .sidebar-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:999;}
  .sidebar-overlay.open{display:block;}
  @media(max-width:768px){
    header{padding:10px 14px;}
    .logo{width:38px;height:38px;} .logo img{width:38px!important;height:38px!important;}
    .logo-text h1{font-size:15px;letter-spacing:2px;} .logo-text p{display:none;}
    .user-badge{display:none;}
    .logout-btn{padding:5px 11px;font-size:11px;}
    aside{position:fixed;left:0;top:0;bottom:0;z-index:1000;width:260px!important;padding:16px 0!important;transform:translateX(-100%);transition:transform 0.25s ease;}
    aside.closed{transform:translateX(-100%)!important;}
    aside.open{transform:translateX(0)!important;}
    main{padding:14px 14px;}
    .breadcrumb{font-size:10px;margin-bottom:10px;}
    .page-title{font-size:16px;margin-bottom:14px;flex-wrap:wrap;gap:6px;}
    .stats{gap:10px;}
    .stat-card{padding:10px 14px;min-width:calc(50% - 5px);}
    .stat-value{font-size:20px;}
    .dash-grid{grid-template-columns:1fr;}
    .dash-card-body{height:220px;}
    .form-card{padding:16px 14px;}
    .form-cols{grid-template-columns:1fr;}
    .form-cols-3{grid-template-columns:1fr;}
    .form-cols-4{grid-template-columns:1fr 1fr;}
    .menu-grid{grid-template-columns:repeat(auto-fill,minmax(150px,1fr));}
    .nav-tabs{flex-wrap:wrap;}
    .nav-tab{padding:7px 14px;font-size:11px;}
    .card-header{padding:10px 14px;font-size:11px;}
    .tbl-card-header{flex-wrap:wrap;gap:8px;}
    .actions{flex-wrap:wrap;gap:6px;}
    .admin-kpi-grid{grid-template-columns:repeat(auto-fill,minmax(130px,1fr));}
    .admin-kpi .kpi-n{font-size:28px;}
    .refresh-bar{flex-wrap:wrap;gap:6px;}
    .filter-popup{width:calc(100vw - 28px);max-width:320px;}
    .col-panel{width:calc(100vw - 28px);max-width:240px;}
    .btn{padding:7px 12px;font-size:11px;}
    .btn-sm{padding:4px 9px;font-size:10px;}
    td{font-size:11px;padding:7px 10px;}
    th{font-size:10px;padding:8px 10px;}
    .scroll-wrap{max-height:55vh;}
  }
`;

// ── LAYOUT ────────────────────────────────────────────────────────────
function layout(title, breadcrumb, body, sess) {
  const d = loadData();
  const visibleReports = d.reports.filter(r => {
    if (sess.role === 'admin') return true;
    if (!r.allowedUsers || r.allowedUsers.length === 0) return true;
    return r.allowedUsers.includes(sess.user);
  });
  let customSidebar = '';
  const rootGroups = d.reportGroups.filter(g => !g.parentId);
  const childGroups = d.reportGroups.filter(g => !!g.parentId);
  rootGroups.forEach(grp => {
    const grpReports = visibleReports.filter(r => r.groupId === grp.id);
    const children = childGroups.filter(sg => sg.parentId === grp.id);
    const hasChildren = children.some(sg => visibleReports.some(r => r.groupId === sg.id));
    if (grpReports.length === 0 && !hasChildren) return;
    let childHtml = '';
    children.forEach(sg => {
      const sgReports = visibleReports.filter(r => r.groupId === sg.id);
      if (sgReports.length === 0) return;
      childHtml += `<div class="side-group">
        <a href="/raporlar/grup/${sg.id}" class="side-item sub2">📁 ${sg.name}</a>
        ${sgReports.map(r => `<a href="/raporlar/custom/${r.id}" class="side-item sub3${title === r.name ? ' active' : ''}">└ ${r.name}</a>`).join('')}
      </div>`;
    });
    customSidebar += `<div class="side-group">
      <a href="/raporlar/grup/${grp.id}" class="side-item sub">${grp.icon || '📊'} ${grp.name}</a>
      ${grpReports.map(r => `<a href="/raporlar/custom/${r.id}" class="side-item sub2${title === r.name ? ' active' : ''}">└ ${r.name}</a>`).join('')}
      ${childHtml}
    </div>`;
  });
  const adminSidebar = sess.role === 'admin' ? `
    <div class="side-divider"></div>
    <div class="side-section">
      <div class="side-section-title">Yönetim</div>
      <a href="/admin" class="side-item${title === 'Admin Panel' ? ' active' : ''}">⚙️ Admin Panel</a>
    </div>` : '';

  return `<!DOCTYPE html>
<html lang="tr"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — LOJİMAX</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.5.31/jspdf.plugin.autotable.min.js"></script>
<style>${CSS}</style></head>
<body>
<header>
  <div class="header-left">
    <button class="mob-menu-btn" onclick="toggleSidebar()" aria-label="Menü">☰</button>
    <div class="logo"><img src="/logo" style="width:52px;height:52px;object-fit:contain;" onerror="this.style.display='none';this.insertAdjacentHTML('afterend','<span style=&quot;font-size:22px;font-weight:900;color:white;&quot;>L</span>')"></div>
    <div class="logo-text"><h1>LOJİMAX</h1><p>RAPORLAMA SİSTEMİ</p></div>
  </div>
  <div class="header-right">
    <span class="user-badge">👤 ${sess.user}${sess.role === 'admin' ? ' &nbsp;<span style="font-size:9px;opacity:0.6;">ADMİN</span>' : ''}</span>
    <a href="/logout" class="logout-btn">Çıkış</a>
  </div>
</header>
<div class="sidebar-overlay" id="sidebarOverlay" onclick="toggleSidebar()"></div>
<div class="app-body">
  <aside id="sidebar">
    <div class="side-section">
      <div class="side-section-title">Ana Menü</div>
      <a href="/" class="side-item${title === 'Ana Sayfa' ? ' active' : ''}">🏠 Ana Sayfa</a>
    </div>
    <div class="side-section">
      <div class="side-section-title">Raporlar</div>
      ${customSidebar || '<span style="font-size:11px;color:#ccc;padding:6px 10px;display:block;">Rapor yok</span>'}
    </div>
    ${adminSidebar}
  </aside>
  <main onclick="closeSidebarOnMain()">
    <div class="breadcrumb">${breadcrumb}</div>
    ${body}
  </main>
</div>
<div id="_timeoutWarn" style="display:none;position:fixed;bottom:20px;right:20px;background:#c62828;color:white;border-radius:12px;padding:14px 20px;box-shadow:0 4px 20px rgba(0,0,0,0.3);z-index:99999;align-items:center;gap:14px;font-size:13px;max-width:320px;">
  <span>⏱️ Oturum <strong id="_timeoutSecs">120</strong> saniye içinde sona erecek.</span>
  <button onclick="_stayActive()" style="background:white;color:#c62828;border:none;border-radius:7px;padding:6px 14px;font-size:12px;font-weight:700;cursor:pointer;margin-left:6px;">Devam Et</button>
</div>
<script>
(function(){
  var TIMEOUT=20*60*1000, WARN=2*60*1000, timer, warnTimer, warned=false;
  function reset(){
    clearTimeout(timer); clearTimeout(warnTimer);
    if(warned){document.getElementById('_timeoutWarn').style.display='none'; warned=false;}
    timer=setTimeout(expire, TIMEOUT);
    warnTimer=setTimeout(showWarn, TIMEOUT-WARN);
  }
  function showWarn(){
    warned=true;
    var el=document.getElementById('_timeoutWarn'); el.style.display='flex';
    var sec=120, si=setInterval(function(){
      sec--; var s=document.getElementById('_timeoutSecs'); if(s) s.textContent=sec;
      if(sec<=0){clearInterval(si); expire();}
    },1000);
    el._si=si;
  }
  function expire(){ window.location='/login?timeout=1'; }
  window._stayActive=function(){
    var el=document.getElementById('_timeoutWarn');
    if(el && el._si) clearInterval(el._si);
    reset();
    fetch('/api/ping').catch(function(){});
  };
  ['mousemove','keydown','click','touchstart'].forEach(function(e){
    document.addEventListener(e,reset,{passive:true,capture:true});
  });
  reset();
})();
var isMob=function(){return window.innerWidth<=768;};
function toggleSidebar(){
  var s=document.getElementById('sidebar'),o=document.getElementById('sidebarOverlay');
  if(isMob()){
    var open=s.classList.toggle('open');
    s.classList.remove('closed');
    o.classList.toggle('open',open);
  } else {
    var closed=s.classList.toggle('closed');
    localStorage.setItem('sidebarClosed',closed?'1':'0');
  }
}
function closeSidebarOnMain(){
  if(isMob()){
    var s=document.getElementById('sidebar'),o=document.getElementById('sidebarOverlay');
    s.classList.remove('open');o.classList.remove('open');
  }
}
(function(){
  if(!isMob() && localStorage.getItem('sidebarClosed')==='1'){
    document.getElementById('sidebar').classList.add('closed');
  }
})();
</script>
</body></html>`;
}

// ── LOGIN ─────────────────────────────────────────────────────────────
app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.send(`<!DOCTYPE html><html lang="tr"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LOJİMAX — Giriş</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box;}
  body{font-family:'Segoe UI',Tahoma,sans-serif;background:linear-gradient(135deg,#0d1b6e,#1a3a8f);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px;}
  .box{background:white;border-radius:16px;padding:40px 44px;box-shadow:0 20px 60px rgba(0,0,0,0.3);width:360px;max-width:100%;}
  @media(max-width:480px){.box{padding:28px 22px;border-radius:12px;}}
  .logo{text-align:center;margin-bottom:28px;}
  .logo-icon{width:80px;height:80px;border-radius:14px;display:inline-flex;align-items:center;justify-content:center;overflow:hidden;margin-bottom:10px;background:linear-gradient(135deg,#0d1b6e,#1a3a8f);}
  .logo h1{font-size:22px;letter-spacing:3px;color:#0d1b6e;font-weight:700;} .logo p{font-size:10px;color:#aaa;letter-spacing:1px;margin-top:2px;}
  label{display:block;font-size:11px;font-weight:600;color:#666;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:5px;}
  input{width:100%;padding:11px 14px;border:1.5px solid #e0e0e0;border-radius:8px;font-size:13px;outline:none;transition:border 0.2s;margin-bottom:16px;}
  input:focus{border-color:#1a3a8f;}
  button{width:100%;padding:12px;background:linear-gradient(135deg,#0d1b6e,#1a3a8f);color:white;border:none;border-radius:8px;font-size:13px;font-weight:700;letter-spacing:1px;cursor:pointer;margin-top:4px;transition:opacity 0.2s;}
  button:hover{opacity:0.9;}
  .error{background:#fce4ec;color:#c62828;border-radius:8px;padding:10px 14px;font-size:12px;margin-bottom:16px;border-left:3px solid #c62828;}
  .footer-txt{text-align:center;font-size:10px;color:#ccc;margin-top:20px;}
</style></head>
<body><div class="box">
  <div class="logo">
    <div class="logo-icon"><img src="/logo" style="width:78px;height:78px;object-fit:contain;" onerror="this.style.display='none';this.insertAdjacentHTML('afterend','<span style=&quot;font-size:28px;font-weight:900;color:white;&quot;>L</span>')"></div>
    <h1>LOJİMAX</h1><p>RAPORLAMA SİSTEMİ</p>
  </div>
  ${req.query.timeout ? '<div class="error">⏱️ Oturum süreniz doldu. Lütfen tekrar giriş yapın.</div>' : ''}
  ${req.query.err ? '<div class="error">Kullanıcı adı veya şifre hatalı.</div>' : ''}
  <form method="POST" action="/login">
    <label>Kullanıcı Adı</label>
    <input name="username" type="text" placeholder="Kullanıcı adınızı girin" autocomplete="username">
    <label>Şifre</label>
    <input name="password" type="password" placeholder="••••••••" autocomplete="current-password">
    <button type="submit">GİRİŞ YAP</button>
  </form>
  <div class="footer-txt">LOJİMAX Raporlama &copy; ${new Date().getFullYear()}</div>
</div></body></html>`);
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const d = loadData();
  const user = d.users.find(u => u.username === username && u.password === password);
  if (user) {
    req.session.user   = user.username;
    req.session.role   = user.role;
    req.session.userId = user.id;
    res.redirect('/');
  } else {
    res.redirect('/login?err=1');
  }
});

app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });
app.get('/api/ping', auth, (_req, res) => res.json({ ok: true }));

// ── ANA SAYFA ─────────────────────────────────────────────────────────
app.get('/', auth, (req, res) => {
  const d = loadData();
  const visibleReports = d.reports.filter(r => {
    if (req.session.role === 'admin') return true;
    if (!r.allowedUsers || r.allowedUsers.length === 0) return true;
    return r.allowedUsers.includes(req.session.user);
  });
  const groupCards = d.reportGroups.filter(g => visibleReports.some(r => r.groupId === g.id))
    .map(g => `<a href="/raporlar/grup/${g.id}" class="menu-card"><div class="icon">${g.icon||'📊'}</div><div class="title">${g.name}</div><div class="desc">${g.description||''}</div></a>`).join('');
  const body = `
    <div class="page-title">Ana Sayfa</div>
    <div class="menu-grid">
      ${groupCards}
      ${req.session.role === 'admin' ? `<a href="/admin" class="menu-card" style="border-left-color:#6a1b9a;">
        <div class="icon">⚙️</div>
        <div class="title">Admin Panel</div>
        <div class="desc">Kullanıcılar, rapor grupları ve özel raporlar</div>
      </a>` : ''}
    </div>`;
  res.send(layout('Ana Sayfa', `<a href="/">Ana Sayfa</a>`, body, req.session));
});



// ── RAPOR GRUBU INDEX ────────────────────────────────────────────────
app.get('/raporlar/grup/:id', auth, (req, res) => {
  const d   = loadData();
  const grp = d.reportGroups.find(g => g.id === parseInt(req.params.id));
  if (!grp) return res.redirect('/');
  const reports = d.reports.filter(r => r.groupId === grp.id && (
    req.session.role === 'admin' || !r.allowedUsers || r.allowedUsers.length === 0 || r.allowedUsers.includes(req.session.user)
  ));
  const cards = reports.map(r => `
    <a href="/raporlar/custom/${r.id}" class="menu-card">
      <div class="icon">📊</div>
      <div class="title">${r.name}</div>
      <div class="desc">${r.description||''}</div>
    </a>`).join('');
  const body = `<div class="page-title">${grp.icon||'📊'} ${grp.name}</div>
    <div class="menu-grid">${cards || '<p style="color:#aaa;">Bu grupta henüz rapor yok.</p>'}</div>`;
  res.send(layout(grp.name, `<a href="/">Ana Sayfa</a> <span>›</span> ${grp.name}`, body, req.session));
});

// ── ÖZEL RAPOR GÖRÜNTÜLE ─────────────────────────────────────────────
app.get('/raporlar/custom/:id', auth, async (req, res) => {
  const d      = loadData();
  const report = d.reports.find(r => r.id === parseInt(req.params.id));
  if (!report) return res.redirect('/');

  const canView = req.session.role === 'admin' || !report.allowedUsers || report.allowedUsers.length === 0 || report.allowedUsers.includes(req.session.user);
  if (!canView) return res.status(403).send('<h2 style="padding:40px;color:#c62828;">Bu rapora erişim yetkiniz yok.</h2>');

  const grp = d.reportGroups.find(g => g.id === report.groupId);

  try {
    const pool   = await sql.connect(dbConfig);
    const result = await pool.request().query(report.sql);
    const rows   = result.recordset;
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
    await sql.close();

    // Stat cards
    const statCardsHtml = (report.statCards || []).map(card => {
      const val = computeStatCard(rows, card);
      return `<div class="stat-card ${card.color||'blue'}"><div class="stat-label">${card.label}</div><div class="stat-value">${val}</div></div>`;
    }).join('');

    // Table rows
    const colTypes = report.columnTypes || {};
    const rightAlignTypes = new Set(['number','currency','percent']);
    const tableRows = rows.map((row, i) => {
      const cells = columns.map(col => {
        const type = colTypes[col] || 'text';
        const formatted = formatCell(row[col], type);
        const align = rightAlignTypes.has(type) ? ' style="text-align:right;font-variant-numeric:tabular-nums;"' : '';
        return `<td${align}>${formatted}</td>`;
      }).join('');
      return `<tr ${i%2===1?'style="background:#fafbff;"':''} class="data-row">${cells}</tr>`;
    }).join('');

    const aliases = report.columnAliases || {};
    const displayColumns = columns.map(c => aliases[c] || c);
    const customRefreshTime = new Date().toLocaleString('tr-TR');
    const headerRow = displayColumns.map((c,i)=>`<th><div class="th-inner"><span>${c}</span><button class="col-filter-btn" onclick="_openFilter(${i},this,event)">&#9661;</button></div></th>`).join('');

    // Charts
    const chartScripts = (report.charts || []).map((chart, ci) => {
      const cd   = computeChartData(rows, chart);
      const type = chart.type === 'bar_h' ? 'bar' : (chart.type || 'bar');
      const isHorizontal = chart.type === 'bar_h';
      const colors = cd.labels.map((_, i) => CHART_COLORS[i % CHART_COLORS.length]);
      return `new Chart(document.getElementById('chart_${ci}'),{type:'${type}',data:{labels:${JSON.stringify(cd.labels)},datasets:[{data:${JSON.stringify(cd.data)},backgroundColor:${JSON.stringify(colors)},borderRadius:5,borderWidth:2}]},options:{${isHorizontal?'indexAxis:"y",':""}responsive:true,maintainAspectRatio:false,plugins:{legend:{display:${type==='pie'||type==='doughnut'?'true':'false'},position:'bottom'}},scales:{${type!=='pie'&&type!=='doughnut'?'x:{beginAtZero:true},y:{beginAtZero:true}':''}}}});`;
    }).join('\n');

    const hasTabs = (report.charts || []).length > 0;
    const toplam  = rows.length;

    const body = `
      <div class="page-title" style="justify-content:space-between;">
        <span>${report.name}</span>
        ${req.session.role === 'admin' ? `<a href="/admin/reports/${report.id}/edit" class="btn btn-sm btn-secondary">✏️ Düzenle</a>` : ''}
      </div>
      ${statCardsHtml ? `<div class="stats">${statCardsHtml}</div>` : ''}
      ${hasTabs ? `<div class="nav-tabs">
        <button class="nav-tab active" onclick="switchView('tablo',this)">☰ Tablo</button>
        <button class="nav-tab" onclick="switchView('dashboard',this)">▦ Dashboard</button>
      </div>` : ''}
      <div id="view-tablo" class="view active">
        <div class="refresh-bar">
          <span class="refresh-time">🕐 Son yenileme: ${customRefreshTime}</span>
          <div style="display:flex;gap:6px;">
            <button class="btn btn-sm btn-secondary" id="_clearAllBtn" style="display:none;" onclick="_clearAllFilters()">✕ Filtreleri Temizle</button>
            <button class="btn btn-sm btn-secondary" onclick="_exportCSV('${report.name.replace(/'/g,"\\'")}')">📥 Excel</button>
            <button class="btn btn-sm btn-secondary" onclick="_exportPDF('${report.name.replace(/'/g,"\\'")}')">📄 PDF</button>
            <a href="/raporlar/custom/${report.id}" class="btn btn-sm btn-secondary">🔄 Yenile</a>
          </div>
        </div>
        <div class="card">
          <div class="card-header">${report.name.toUpperCase()} <span id="kayitSayisi">${toplam} kayıt</span></div>
          <div class="scroll-wrap">
            <table id="mainTable">
              <thead><tr>${headerRow}</tr></thead>
              <tbody id="tableBody">${tableRows}</tbody>
            </table>
          </div>
          <div class="tbl-footer" id="tblFooter">Toplam ${toplam} kayıt</div>
        </div>
      </div>
      ${hasTabs ? `<div id="view-dashboard" class="view">
        <div class="dash-grid">
          ${(report.charts||[]).map((chart,ci)=>`
            <div class="dash-card">
              <div class="dash-card-header">${chart.title||chart.labelColumn}</div>
              <div class="dash-card-body${(report.charts||[]).length===1?' wide':''}"><canvas id="chart_${ci}"></canvas></div>
            </div>`).join('')}
        </div>
      </div>` : ''}
      <div id="_filterPopup" class="filter-popup">
        <div class="fp-tabs">
          <button class="fp-tab active" data-tab="values" onclick="_switchFpTab('values')">Değerler</button>
          <button class="fp-tab" data-tab="text" onclick="_switchFpTab('text')">Metin filtreleri</button>
        </div>
        <div class="fp-search-wrap" id="_fp_search_wrap">
          <input type="text" id="_fp_searchVal" placeholder="aramak için metni girin" oninput="_filterVals()">
          <span class="fp-search-icon">&#128269;</span>
        </div>
        <div class="fp-body">
          <div id="_fp_vals_pane"></div>
          <div id="_fp_text_pane" class="fp-text" style="display:none;">
            <select id="_fp_textMode">
              <option value="equals">Eşittir</option><option value="notequals">Eşit değil</option>
              <option value="contains">İçerir</option><option value="notcontains">İçermez</option>
              <option value="startswith">İle başlar</option><option value="endswith">İle biter</option>
              <option value="gt">Büyüktür</option><option value="lt">Küçüktür</option>
            </select>
            <input type="text" id="_fp_textVal" placeholder="Filtre değeri...">
          </div>
        </div>
        <div class="fp-footer">
          <button class="btn btn-sm btn-secondary" onclick="_clearColFilter()">Filtreyi temizle</button>
          <div style="display:flex;gap:6px;">
            <button class="btn btn-sm btn-primary" id="_fp_applyBtn" style="display:none;" onclick="_applyTextFilter()">Uygula</button>
            <button class="btn btn-sm btn-secondary" onclick="_closeFilter()">Kapat</button>
          </div>
        </div>
      </div>
      <script>
        var _colNames = ${JSON.stringify(displayColumns).replace(/<\//g, '<\\/')};
        var _sqlCols = ${JSON.stringify(columns).replace(/<\//g, '<\\/')};
        var _savedHidden = ${JSON.stringify((report.hiddenColumns||[]).filter(Boolean)).replace(/<\//g, '<\\/')};
        var _hiddenCols = _sqlCols.reduce(function(acc,n,i){if(_savedHidden.indexOf(n)>=0)acc.push(i);return acc;},[]);
        var _chartsInited = false;
        function _isHidden(i){return _hiddenCols.indexOf(i)>=0;}
        function _initCharts(){
          if(_chartsInited)return; _chartsInited=true;
          try{ ${chartScripts} }catch(e){console.error('Grafik hatası:',e);}
        }
        function switchView(n,b){
          document.querySelectorAll('.view').forEach(function(v){v.classList.remove('active');});
          document.querySelectorAll('.nav-tab').forEach(function(x){x.classList.remove('active');});
          document.getElementById('view-'+n).classList.add('active');
          b.classList.add('active');
          if(n==='dashboard')_initCharts();
        }
        var _fState={},_uCache={},_aCol=-1;
        var _aRows=Array.from(document.querySelectorAll('#tableBody tr'));
        var _popup=document.getElementById('_filterPopup');
        function _cellTxt(r,i){var td=r.querySelectorAll('td')[i];return td?(td.textContent||'').trim():'';}
        function _getUniq(ci){
          if(!_uCache[ci]){var s=new Set();_aRows.forEach(function(r){s.add(_cellTxt(r,ci));});_uCache[ci]=Array.from(s).sort(function(a,b){return a.localeCompare(b,'tr');});}
          return _uCache[ci];
        }
        function _hasF(i){var s=_fState[i];if(!s)return false;return s.mode==='text'?!!s.tVal:(s.excl&&s.excl.size>0);}
        function _updateIcons(){
          document.querySelectorAll('.col-filter-btn').forEach(function(b,i){b.classList.toggle('active',_hasF(i));});
          var anyFilter=Object.keys(_fState).some(function(k){return _hasF(parseInt(k));});
          var cb=document.getElementById('_clearAllBtn');if(cb)cb.style.display=anyFilter?'':'none';
        }
        function _clearAllFilters(){_fState={};_uCache={};_applyAll();_updateIcons();}
        function _applyAll(){
          var vis=0;
          _aRows.forEach(function(row){
            var ok=true;
            for(var ci in _fState){
              var s=_fState[ci],i=parseInt(ci),cell=_cellTxt(row,i);
              if(s.mode==='values'&&s.excl&&s.excl.has(cell)){ok=false;break;}
              if(s.mode==='text'&&s.tVal){
                var c=cell.toLowerCase(),v=s.tVal.toLowerCase(),n=parseFloat(cell),nv=parseFloat(s.tVal);
                if(s.tMode==='contains'&&!c.includes(v))ok=false;
                else if(s.tMode==='notcontains'&&c.includes(v))ok=false;
                else if(s.tMode==='startswith'&&!c.startsWith(v))ok=false;
                else if(s.tMode==='endswith'&&!c.endsWith(v))ok=false;
                else if(s.tMode==='equals'&&c!==v)ok=false;
                else if(s.tMode==='notequals'&&c===v)ok=false;
                else if(s.tMode==='gt'&&(isNaN(n)||isNaN(nv)||n<=nv))ok=false;
                else if(s.tMode==='lt'&&(isNaN(n)||isNaN(nv)||n>=nv))ok=false;
                if(!ok)break;
              }
            }
            row.style.display=ok?'':'none';
            if(ok)vis++;
          });
          var tot=_aRows.length,el=document.getElementById('kayitSayisi');
          if(el)el.textContent=vis===tot?tot+' kayıt':vis+'/'+tot+' kayıt';
        }
        function _buildValPane(ci){
          var vals=_getUniq(ci),excl=(_fState[ci]&&_fState[ci].excl)||new Set();
          var search=(document.getElementById('_fp_searchVal').value||'').toLowerCase();
          var filtered=search?vals.filter(function(v){return (v||'').toLowerCase().includes(search);}):vals;
          var allChecked=filtered.length>0&&filtered.every(function(v){return !excl.has(v);});
          var someChecked=filtered.some(function(v){return !excl.has(v);});
          var html='<label class="fp-val-item fp-val-all"><input type="checkbox" id="_fp_allCb" '+(allChecked?'checked':'')+' onchange="_toggleAll('+ci+',this)"> Tüm</label>';
          html+=filtered.map(function(v){
            var vi=vals.indexOf(v);
            return '<label class="fp-val-item"><input type="checkbox" data-vi="'+vi+'" '+(excl.has(v)?'':'checked')+' onchange="_vChg('+ci+',this)"> '+(v||'(boş)')+'</label>';
          }).join('');
          document.getElementById('_fp_vals_pane').innerHTML=html;
          var allCb=document.getElementById('_fp_allCb');
          if(allCb)allCb.indeterminate=!allChecked&&someChecked;
        }
        function _toggleAll(ci,cb){
          var vals=_getUniq(ci);
          var search=(document.getElementById('_fp_searchVal').value||'').toLowerCase();
          var filtered=search?vals.filter(function(v){return (v||'').toLowerCase().includes(search);}):vals;
          if(!_fState[ci])_fState[ci]={mode:'values',excl:new Set()};
          if(!_fState[ci].excl)_fState[ci].excl=new Set();
          _fState[ci].mode='values';
          filtered.forEach(function(v){if(cb.checked)_fState[ci].excl.delete(v);else _fState[ci].excl.add(v);});
          _buildValPane(ci);
          _applyAll();_updateIcons();
        }
        function _filterVals(){if(_aCol>=0)_buildValPane(_aCol);}
        function _openFilter(ci,btn,e){
          if(e)e.stopPropagation();
          if(_aCol===ci){_closeFilter();return;}
          _aCol=ci;
          var rect=btn.getBoundingClientRect(),left=rect.left;
          if(left+245>window.innerWidth)left=window.innerWidth-250;
          _popup.style.top=(rect.bottom+4)+'px';_popup.style.left=left+'px';
          document.getElementById('_fp_searchVal').value='';
          _buildValPane(ci);
          var s=_fState[ci]||{};
          document.getElementById('_fp_textMode').value=s.tMode||'equals';
          document.getElementById('_fp_textVal').value=s.tVal||'';
          _switchFpTab(s.mode==='text'?'text':'values');
          _popup.classList.add('open');
        }
        function _closeFilter(){_popup.classList.remove('open');_aCol=-1;}
        function _switchFpTab(tab){
          document.querySelectorAll('.fp-tab').forEach(function(t){t.classList.toggle('active',t.dataset.tab===tab);});
          document.getElementById('_fp_vals_pane').style.display=tab==='values'?'':'none';
          document.getElementById('_fp_text_pane').style.display=tab==='text'?'':'none';
          document.getElementById('_fp_applyBtn').style.display=tab==='text'?'':'none';
          document.getElementById('_fp_search_wrap').style.display=tab==='values'?'':'none';
          if(_aCol>=0){_fState[_aCol]=_fState[_aCol]||{};_fState[_aCol].mode=tab;}
        }
        function _vChg(ci,cb){
          var vi=parseInt(cb.dataset.vi),val=_getUniq(ci)[vi];
          if(!_fState[ci])_fState[ci]={mode:'values',excl:new Set()};
          if(!_fState[ci].excl)_fState[ci].excl=new Set();
          _fState[ci].mode='values';
          if(!cb.checked)_fState[ci].excl.add(val);else _fState[ci].excl.delete(val);
          var allCb=document.getElementById('_fp_allCb');
          if(allCb){
            var vals=_getUniq(ci),search=(document.getElementById('_fp_searchVal').value||'').toLowerCase();
            var filtered=search?vals.filter(function(v){return (v||'').toLowerCase().includes(search);}):vals;
            var excl=_fState[ci].excl;
            var allChecked=filtered.every(function(v){return !excl.has(v);});
            var someChecked=filtered.some(function(v){return !excl.has(v);});
            allCb.checked=allChecked;allCb.indeterminate=!allChecked&&someChecked;
          }
          _applyAll();_updateIcons();
        }
        function _applyTextFilter(){
          if(_aCol<0)return;
          _fState[_aCol]={mode:'text',tMode:document.getElementById('_fp_textMode').value,tVal:document.getElementById('_fp_textVal').value};
          _applyAll();_updateIcons();_closeFilter();
        }
        function _clearColFilter(){if(_aCol<0)return;delete _fState[_aCol];_applyAll();_updateIcons();_closeFilter();}
        document.getElementById('_fp_textVal').addEventListener('keydown',function(e){if(e.key==='Enter')_applyTextFilter();});
        if(_popup)_popup.addEventListener('click',function(e){e.stopPropagation();});
        document.addEventListener('click',function(){if(_popup&&_popup.classList.contains('open'))_closeFilter();});
        function _applyColVis(){
          document.querySelectorAll('#mainTable thead th').forEach(function(th,i){th.style.display=_isHidden(i)?'none':'';});
          _aRows.forEach(function(row){row.querySelectorAll('td').forEach(function(td,i){td.style.display=_isHidden(i)?'none':'';});});
        }
        if(_hiddenCols.length>0)_applyColVis();
        function _visibleRows(){return Array.from(document.querySelectorAll('#tableBody tr')).filter(function(r){return r.style.display!=='none';});}
        function _visibleColIdxs(){return _colNames.map(function(_,i){return i;}).filter(function(i){return !_isHidden(i);});}
        function _headers(){
          var idxs=_visibleColIdxs();
          return Array.from(document.querySelectorAll('#mainTable thead th')).filter(function(_,i){return idxs.indexOf(i)>=0;}).map(function(th){var s=th.querySelector('span');return s?s.textContent.trim():th.textContent.trim();});
        }
        function _exportCSV(name){
          var hdrs=_headers(),idxs=_visibleColIdxs();
          if(!hdrs.length){alert('Tablo başlıkları bulunamadı.');return;}
          var rows=_visibleRows().map(function(r){
            var tds=r.querySelectorAll('td');
            return idxs.map(function(i){return '"'+((tds[i]?tds[i].innerText||'':'').replace(/"/g,'""'))+'"';}).join(',');
          });
          var csv='\\uFEFF'+[hdrs.map(function(h){return '"'+h+'"';}).join(',')].concat(rows).join('\\n');
          var blob=new Blob([csv],{type:'text/csv;charset=utf-8;'});
          var url=URL.createObjectURL(blob);
          var a=document.createElement('a');
          a.style.display='none';a.href=url;a.download=name+'.csv';
          document.body.appendChild(a);a.click();
          setTimeout(function(){document.body.removeChild(a);URL.revokeObjectURL(url);},200);
        }
        function _exportPDF(name){
          var hdrs=_headers(),idxs=_visibleColIdxs();
          var bodyData=_visibleRows().map(function(r){
            var tds=r.querySelectorAll('td');
            return idxs.map(function(i){return tds[i]?(tds[i].innerText||'').trim():'';});
          });
          try{
            var jsPDF=window.jspdf.jsPDF;
            var doc=new jsPDF({orientation:'landscape',unit:'mm',format:'a3'});
            doc.autoTable({head:[hdrs],body:bodyData,styles:{fontSize:7,cellPadding:2},headStyles:{fillColor:[26,58,143],textColor:255,fontStyle:'bold'},alternateRowStyles:{fillColor:[248,249,255]},margin:{top:14}});
            doc.save(name+'.pdf');
          }catch(e){
            var tbl='<table border="1" style="border-collapse:collapse;font-size:11px;width:100%;font-family:Arial"><thead><tr style="background:#1a3a8f;color:white;">'+
              hdrs.map(function(h){return '<th style="padding:6px 8px;">'+h+'</th>';}).join('')+
              '</tr></thead><tbody>'+
              bodyData.map(function(r,ri){
                return '<tr style="'+(ri%2?'background:#f8f9ff':'')+'">'+ r.map(function(c){return '<td style="padding:5px 8px;">'+c+'</td>';}).join('')+'</tr>';
              }).join('')+'</tbody></table>';
            var w=window.open('','_blank');
            if(!w){alert('Açılır pencere engellendi.');return;}
            w.document.write('<html><head><title>'+name+'</title><style>body{margin:20px;font-family:Arial;}@media print{.no-print{display:none;}}</style></head><body><h2>'+name+'</h2>'+tbl+'<br><button class="no-print" onclick="window.print()" style="margin-top:12px;padding:8px 20px;background:#1a3a8f;color:white;border:none;border-radius:6px;cursor:pointer;">Yazdır / PDF Kaydet</button></body></html>');
            w.document.close();
          }
        }
      </script>`;

    res.send(layout(report.name,
      `<a href="/">Ana Sayfa</a> <span>›</span> ${grp ? `<a href="/raporlar/grup/${grp.id}">${grp.name}</a> <span>›</span> ` : ''}${report.name}`,
      body, req.session));
  } catch (err) {
    res.status(500).send(`<h2 style="padding:40px;color:#c62828;">SQL Hatası</h2><pre style="padding:20px;">${err.message}</pre>`);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// ADMİN PANELİ
// ═══════════════════════════════════════════════════════════════════════

// ── ADMIN ANA SAYFA ───────────────────────────────────────────────────
app.get('/admin', auth, adminOnly, (req, res) => {
  const d = loadData();
  const body = `
    <div class="page-title">⚙️ Admin Panel</div>
    <div class="admin-kpi-grid">
      <div class="admin-kpi"><div class="kpi-n">${d.users.length}</div><div class="kpi-l">Kullanıcı</div></div>
      <div class="admin-kpi green"><div class="kpi-n">${d.reportGroups.length}</div><div class="kpi-l">Rapor Grubu</div></div>
      <div class="admin-kpi orange"><div class="kpi-n">${d.reports.length}</div><div class="kpi-l">Özel Rapor</div></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;">
      <a href="/admin/users" class="menu-card" style="border-left-color:#1a3a8f;">
        <div class="icon">👥</div><div class="title">Kullanıcılar</div>
        <div class="desc">Kullanıcı ekle, düzenle, sil, şifre değiştir</div>
      </a>
      <a href="/admin/report-groups" class="menu-card" style="border-left-color:#2e7d32;">
        <div class="icon">📁</div><div class="title">Rapor Grupları</div>
        <div class="desc">Rapor kategorilerini yönet</div>
      </a>
      <a href="/admin/reports" class="menu-card" style="border-left-color:#e65100;">
        <div class="icon">📋</div><div class="title">Raporlar</div>
        <div class="desc">SQL raporları oluştur, düzenle, izin ver</div>
      </a>
    </div>`;
  res.send(layout('Admin Panel', `<a href="/">Ana Sayfa</a> <span>›</span> Admin Panel`, body, req.session));
});

// ── ADMIN KULLANICILAR ────────────────────────────────────────────────
app.get('/admin/users', auth, adminOnly, (req, res) => {
  const d    = loadData();
  const msg  = req.query.msg ? `<div class="alert alert-success">${decodeURIComponent(req.query.msg)}</div>` : '';
  const rows = d.users.map(u => `
    <tr>
      <td>${u.id}</td>
      <td><strong>${u.username}</strong></td>
      <td><span class="role-badge role-${u.role}">${u.role}</span></td>
      <td class="actions">
        <a href="/admin/users/${u.id}/edit" class="btn btn-sm btn-edit">✏️ Düzenle</a>
        ${u.username !== req.session.user ? `<form method="POST" action="/admin/users/${u.id}/delete" style="display:inline;" onsubmit="return confirm('Kullanıcıyı silmek istediğinize emin misiniz?')">
          <button type="submit" class="btn btn-sm btn-danger">🗑️ Sil</button>
        </form>` : '<span style="color:#aaa;font-size:11px;">(Aktif)</span>'}
      </td>
    </tr>`).join('');
  const body = `
    ${msg}
    <div class="page-title" style="justify-content:space-between;">
      <span>👥 Kullanıcılar</span>
      <a href="/admin/users/new" class="btn btn-primary">+ Yeni Kullanıcı</a>
    </div>
    <div class="tbl-card">
      <table class="admin-table">
        <thead><tr><th>#</th><th>Kullanıcı Adı</th><th>Rol</th><th>İşlemler</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  res.send(layout('Kullanıcılar', `<a href="/">Ana Sayfa</a> <span>›</span> <a href="/admin">Admin Panel</a> <span>›</span> Kullanıcılar`, body, req.session));
});

app.get('/admin/users/new', auth, adminOnly, (req, res) => {
  const body = `
    <div class="page-title">+ Yeni Kullanıcı</div>
    <div class="form-card">
      <form method="POST" action="/admin/users/create">
        <div class="form-cols">
          <div class="form-row"><label>Kullanıcı Adı</label><input name="username" required placeholder="ornek_kullanici"></div>
          <div class="form-row"><label>Şifre</label><input name="password" type="password" required placeholder="••••••••"></div>
        </div>
        <div class="form-row"><label>Rol</label>
          <select name="role">
            <option value="user">Kullanıcı</option>
            <option value="admin">Admin</option>
          </select>
        </div>
        <div style="display:flex;gap:10px;margin-top:8px;">
          <button type="submit" class="btn btn-primary">Kaydet</button>
          <a href="/admin/users" class="btn btn-secondary">İptal</a>
        </div>
      </form>
    </div>`;
  res.send(layout('Yeni Kullanıcı', `<a href="/">Ana Sayfa</a> <span>›</span> <a href="/admin">Admin Panel</a> <span>›</span> <a href="/admin/users">Kullanıcılar</a> <span>›</span> Yeni`, body, req.session));
});

app.post('/admin/users/create', auth, adminOnly, (req, res) => {
  const { username, password, role } = req.body;
  const d = loadData();
  if (d.users.find(u => u.username === username)) return res.redirect('/admin/users/new?err=duplicate');
  d.users.push({ id: makeId(d), username, password, role: role || 'user', allowedUsers: [] });
  saveData(d);
  res.redirect('/admin/users?msg=' + encodeURIComponent('Kullanıcı oluşturuldu.'));
});

app.get('/admin/users/:id/edit', auth, adminOnly, (req, res) => {
  const d    = loadData();
  const user = d.users.find(u => u.id === parseInt(req.params.id));
  if (!user) return res.redirect('/admin/users');
  const reports = d.reports;
  const perms = reports.map(r => `
    <label style="display:flex;align-items:center;gap:8px;font-size:12.5px;padding:4px 0;cursor:pointer;">
      <input type="checkbox" name="allowedReports" value="${r.id}" ${(!r.allowedUsers||r.allowedUsers.length===0||r.allowedUsers.includes(user.username))?'checked':''}>
      ${r.name}
    </label>`).join('');
  const body = `
    <div class="page-title">✏️ Kullanıcı Düzenle: ${user.username}</div>
    <div class="form-card">
      <form method="POST" action="/admin/users/${user.id}/update">
        <div class="form-cols">
          <div class="form-row"><label>Kullanıcı Adı</label><input name="username" value="${user.username}" required></div>
          <div class="form-row"><label>Yeni Şifre <span style="font-weight:400;color:#aaa;">(boş bırakın = değişmesin)</span></label><input name="password" type="password" placeholder="••••••••"></div>
        </div>
        <div class="form-row"><label>Rol</label>
          <select name="role">
            <option value="user" ${user.role==='user'?'selected':''}>Kullanıcı</option>
            <option value="admin" ${user.role==='admin'?'selected':''}>Admin</option>
          </select>
        </div>
        <div class="form-row">
          <label>Rapor İzinleri <span style="font-weight:400;color:#aaa;">(işaretlenenler bu kullanıcıya açık)</span></label>
          <div style="background:#f8f9ff;border:1px solid #e0e4f0;border-radius:8px;padding:12px 16px;max-height:280px;overflow-y:auto;">
            ${perms || '<span style="font-size:12px;color:#aaa;">Henüz rapor yok</span>'}
          </div>
          <div class="hint">Admin kullanıcılar zaten tüm raporlara erişebilir.</div>
        </div>
        <div style="display:flex;gap:10px;margin-top:8px;">
          <button type="submit" class="btn btn-primary">Kaydet</button>
          <a href="/admin/users" class="btn btn-secondary">İptal</a>
        </div>
      </form>
    </div>`;
  res.send(layout(`Kullanıcı: ${user.username}`, `<a href="/">Ana Sayfa</a> <span>›</span> <a href="/admin">Admin</a> <span>›</span> <a href="/admin/users">Kullanıcılar</a> <span>›</span> Düzenle`, body, req.session));
});

app.post('/admin/users/:id/update', auth, adminOnly, (req, res) => {
  const d    = loadData();
  const user = d.users.find(u => u.id === parseInt(req.params.id));
  if (!user) return res.redirect('/admin/users');
  user.username = req.body.username || user.username;
  if (req.body.password) user.password = req.body.password;
  user.role = req.body.role || user.role;

  // Rapor izinleri
  const allowed = Array.isArray(req.body.allowedReports) ? req.body.allowedReports.map(Number) : (req.body.allowedReports ? [Number(req.body.allowedReports)] : []);
  d.reports.forEach(r => {
    if (!r.allowedUsers) r.allowedUsers = [];
    const idx = r.allowedUsers.indexOf(user.username);
    if (allowed.includes(r.id)) { if (idx === -1) r.allowedUsers.push(user.username); }
    else { if (idx !== -1) r.allowedUsers.splice(idx, 1); }
  });

  saveData(d);
  res.redirect('/admin/users?msg=' + encodeURIComponent('Kullanıcı güncellendi.'));
});

app.post('/admin/users/:id/delete', auth, adminOnly, (req, res) => {
  const d = loadData();
  d.users = d.users.filter(u => u.id !== parseInt(req.params.id));
  saveData(d);
  res.redirect('/admin/users?msg=' + encodeURIComponent('Kullanıcı silindi.'));
});

// ── ADMIN RAPOR GRUPLARI ──────────────────────────────────────────────
app.get('/admin/report-groups', auth, adminOnly, (req, res) => {
  const d   = loadData();
  const msg = req.query.msg ? `<div class="alert alert-success">${decodeURIComponent(req.query.msg)}</div>` : '';
  const rows = d.reportGroups.map(g => {
    const cnt = d.reports.filter(r => r.groupId === g.id).length;
    return `<tr>
      <td>${g.id}</td>
      <td>${g.icon||''} <strong>${g.name}</strong></td>
      <td>${g.description||'-'}</td>
      <td><span class="tag">${cnt} rapor</span></td>
      <td class="actions">
        <a href="/admin/report-groups/${g.id}/edit" class="btn btn-sm btn-edit">✏️ Düzenle</a>
        <form method="POST" action="/admin/report-groups/${g.id}/delete" style="display:inline;" onsubmit="return confirm('Grubu silmek istediğinize emin misiniz? Gruptaki raporlar silinmez.')">
          <button type="submit" class="btn btn-sm btn-danger">🗑️ Sil</button>
        </form>
      </td>
    </tr>`;
  }).join('');
  const builtinGroupRow = `
    <tr>
      <td>—</td>
      <td>📦 <strong>Satış Sipariş Raporu</strong></td>
      <td>Açık siparişler, sevk durumu, termin takibi</td>
      <td><span class="tag">2 rapor</span></td>
      <td style="color:#aaa;font-size:11px;">Silinemez</td>
    </tr>`;
  const body = `
    ${msg}
    <div class="page-title" style="justify-content:space-between;">
      <span>📁 Rapor Grupları</span>
      <a href="/admin/report-groups/new" class="btn btn-primary">+ Yeni Grup</a>
    </div>
    <div class="tbl-card">
      <table class="admin-table">
        <thead><tr><th>#</th><th>Grup Adı</th><th>Açıklama</th><th>Raporlar</th><th>İşlemler</th></tr></thead>
        <tbody>${builtinGroupRow}${rows}</tbody>
      </table>
      ${d.reportGroups.length === 0 ? '<div style="padding:16px 20px;font-size:12px;color:#aaa;border-top:1px solid #f0f0f0;">Henüz özel rapor grubu yok. <a href="/admin/report-groups/new">İlk grubu oluştur →</a></div>' : ''}
    </div>`;
  res.send(layout('Rapor Grupları', `<a href="/">Ana Sayfa</a> <span>›</span> <a href="/admin">Admin Panel</a> <span>›</span> Rapor Grupları`, body, req.session));
});

const ICON_LIST = [
  { cat: 'Satış & Sipariş',    icons: ['🛒','🏷️','🧾','📋','📝','💼','📦','🎁','🤝','💬'] },
  { cat: 'Sevkiyat & Lojistik',icons: ['🚚','🚛','✈️','🚢','🚂','📫','📬','🗺️','🔄','📍'] },
  { cat: 'Finans & Muhasebe',  icons: ['💰','💳','💵','🏦','📊','📈','📉','💱','🧮','🪙'] },
  { cat: 'Üretim & İmalat',    icons: ['⚙️','🔧','🔩','🛠️','🏭','⚒️','🔨','🏗️','🪛','⚡'] },
  { cat: 'Stok & Depo',        icons: ['🗃️','🗄️','📦','📋','🏪','🏬','📊','🔍','📌','🗂️'] },
  { cat: 'İnsan Kaynakları',   icons: ['👥','👤','🧑‍💼','👨‍💼','👩‍💼','📅','🎓','🏅','🤝','📞'] },
  { cat: 'Müşteri & CRM',      icons: ['⭐','🌟','💫','🎯','🏆','👋','✉️','📧','📱','💡'] },
  { cat: 'Genel',              icons: ['📁','📂','📊','🗓️','🔖','📌','🔑','🌐','🏢','🎪'] },
];

function groupForm(grp, action, title, allGroups) {
  allGroups = allGroups || [];
  const rootGroups = allGroups.filter(g => !g.parentId && g.id !== grp.id);
  const parentOptions = rootGroups.map(g =>
    `<option value="${g.id}"${grp.parentId === g.id ? ' selected' : ''}>${g.icon||'📊'} ${g.name}</option>`
  ).join('');
  const selectedIcon = grp.icon || '📊';
  const iconSections = ICON_LIST.map(sec => `
    <div style="margin-bottom:10px;">
      <div style="font-size:10px;font-weight:700;color:#aaa;letter-spacing:1px;text-transform:uppercase;margin-bottom:6px;">${sec.cat}</div>
      <div style="display:flex;flex-wrap:wrap;gap:4px;">
        ${sec.icons.map(ic => `<button type="button" onclick="pickIcon('${ic}')" title="${ic}"
          style="width:38px;height:38px;font-size:20px;border-radius:7px;border:2px solid ${ic===selectedIcon?'#1a3a8f':'transparent'};background:${ic===selectedIcon?'#e8eaf6':'#f5f5f5'};cursor:pointer;transition:all 0.15s;display:flex;align-items:center;justify-content:center;"
          class="_iconBtn" data-ic="${ic}">${ic}</button>`).join('')}
      </div>
    </div>`).join('');

  return `
    <div class="page-title">${title}</div>
    <div class="form-card">
      <form method="POST" action="${action}">
        <div class="form-row"><label>Grup Adı</label><input name="name" value="${grp.name||''}" required placeholder="Örn: Finans Raporları"></div>
        <div class="form-row"><label>Açıklama</label><input name="description" value="${grp.description||''}" placeholder="Kısa açıklama..."></div>
        <div class="form-row"><label>Üst Grup <span style="font-weight:400;color:#aaa;">(isteğe bağlı — alt grup yapmak için seçin)</span></label>
          <select name="parentId"><option value="">— Ana grup (üst grup yok) —</option>${parentOptions}</select>
        </div>
        <div class="form-row">
          <label>İkon <span style="font-weight:400;color:#aaa;">— seçili: <span id="_selIconPreview" style="font-size:18px;">${selectedIcon}</span></span></label>
          <input type="hidden" name="icon" id="_iconVal" value="${selectedIcon}">
          <div style="background:#f8f9ff;border:1.5px solid #e0e0e0;border-radius:8px;padding:14px 16px;max-height:320px;overflow-y:auto;">
            ${iconSections}
          </div>
        </div>
        <div style="display:flex;gap:10px;margin-top:8px;">
          <button type="submit" class="btn btn-primary">Kaydet</button>
          <a href="/admin/report-groups" class="btn btn-secondary">İptal</a>
        </div>
      </form>
    </div>
    <script>
    function pickIcon(ic) {
      document.getElementById('_iconVal').value = ic;
      document.getElementById('_selIconPreview').textContent = ic;
      document.querySelectorAll('._iconBtn').forEach(b => {
        const sel = b.dataset.ic === ic;
        b.style.border = sel ? '2px solid #1a3a8f' : '2px solid transparent';
        b.style.background = sel ? '#e8eaf6' : '#f5f5f5';
      });
    }
    </script>`;
}

app.get('/admin/report-groups/new', auth, adminOnly, (req, res) => {
  const d = loadData();
  const body = groupForm({}, '/admin/report-groups/create', '+ Yeni Rapor Grubu', d.reportGroups);
  res.send(layout('Rapor Grupları', `<a href="/">Ana Sayfa</a> <span>›</span> <a href="/admin">Admin</a> <span>›</span> <a href="/admin/report-groups">Rapor Grupları</a> <span>›</span> Yeni`, body, req.session));
});

app.post('/admin/report-groups/create', auth, adminOnly, (req, res) => {
  const d = loadData();
  const parentId = req.body.parentId ? parseInt(req.body.parentId) : null;
  d.reportGroups.push({ id: makeId(d), name: req.body.name, icon: req.body.icon||'📊', description: req.body.description||'', ...(parentId ? { parentId } : {}) });
  saveData(d);
  res.redirect('/admin/report-groups?msg=' + encodeURIComponent('Rapor grubu oluşturuldu.'));
});

app.get('/admin/report-groups/:id/edit', auth, adminOnly, (req, res) => {
  const d   = loadData();
  const grp = d.reportGroups.find(g => g.id === parseInt(req.params.id));
  if (!grp) return res.redirect('/admin/report-groups');
  const body = groupForm(grp, `/admin/report-groups/${grp.id}/update`, `✏️ Grup Düzenle: ${grp.name}`, d.reportGroups);
  res.send(layout('Rapor Grupları', `<a href="/">Ana Sayfa</a> <span>›</span> <a href="/admin">Admin</a> <span>›</span> <a href="/admin/report-groups">Rapor Grupları</a> <span>›</span> Düzenle`, body, req.session));
});

app.post('/admin/report-groups/:id/update', auth, adminOnly, (req, res) => {
  const d   = loadData();
  const grp = d.reportGroups.find(g => g.id === parseInt(req.params.id));
  if (!grp) return res.redirect('/admin/report-groups');
  grp.name = req.body.name || grp.name;
  grp.icon = req.body.icon || grp.icon;
  grp.description = req.body.description || '';
  const parentId = req.body.parentId ? parseInt(req.body.parentId) : null;
  if (parentId) grp.parentId = parentId; else delete grp.parentId;
  saveData(d);
  res.redirect('/admin/report-groups?msg=' + encodeURIComponent('Grup güncellendi.'));
});

app.post('/admin/report-groups/:id/delete', auth, adminOnly, (req, res) => {
  const d = loadData();
  d.reportGroups = d.reportGroups.filter(g => g.id !== parseInt(req.params.id));
  saveData(d);
  res.redirect('/admin/report-groups?msg=' + encodeURIComponent('Grup silindi.'));
});

// ── ADMIN RAPORLAR ────────────────────────────────────────────────────
app.get('/admin/reports', auth, adminOnly, (req, res) => {
  const d   = loadData();
  const msg = req.query.msg ? `<div class="alert alert-success">${decodeURIComponent(req.query.msg)}</div>` : '';
  const rows = d.reports.map(r => {
    const grp = d.reportGroups.find(g => g.id === r.groupId);
    const perm = (!r.allowedUsers || r.allowedUsers.length === 0) ? '<span class="tag" style="background:#e8f5e9;color:#2e7d32;">Herkese açık</span>' : `<span class="tag" style="background:#fff8e1;color:#f57f17;">${r.allowedUsers.length} kullanıcı</span>`;
    return `<tr>
      <td>${r.id}</td>
      <td><strong>${r.name}</strong><br><small style="color:#aaa;">${r.description||''}</small></td>
      <td>${grp ? `${grp.icon||'📊'} ${grp.name}` : '<span style="color:#aaa;">—</span>'}</td>
      <td><span class="tag">${(r.statCards||[]).length} kart</span> <span class="tag">${(r.charts||[]).length} grafik</span></td>
      <td>${perm}</td>
      <td class="actions">
        <a href="/raporlar/custom/${r.id}" class="btn btn-sm btn-success" target="_blank">▶ Görüntüle</a>
        <a href="/admin/reports/${r.id}/edit" class="btn btn-sm btn-edit">✏️ Düzenle</a>
        <form method="POST" action="/admin/reports/${r.id}/delete" style="display:inline;" onsubmit="return confirm('Raporu silmek istediğinize emin misiniz?')">
          <button type="submit" class="btn btn-sm btn-danger">🗑️ Sil</button>
        </form>
      </td>
    </tr>`;
  }).join('');
  const builtinRows = `
    <tr>
      <td>—</td>
      <td><strong>Açık Sipariş Raporu</strong><br><small style="color:#aaa;">Teslim edilmemiş siparişler, termin ve üretim durumu</small></td>
      <td>📦 Satış Sipariş Raporu</td>
      <td><span class="tag">4 kart</span> <span class="tag">5 grafik</span></td>
      <td><span class="tag" style="background:#e8f5e9;color:#2e7d32;">Herkese açık</span></td>
      <td class="actions"><a href="/raporlar/satis-siparis/acik-siparis" class="btn btn-sm btn-success" target="_blank">▶ Görüntüle</a></td>
    </tr>
    <tr>
      <td>—</td>
      <td><strong>Sevk Raporu</strong><br><small style="color:#aaa;">Sevk edilen siparişlerin detay raporu</small></td>
      <td>📦 Satış Sipariş Raporu</td>
      <td>—</td>
      <td><span class="tag" style="background:#e8f5e9;color:#2e7d32;">Herkese açık</span></td>
      <td class="actions"><a href="/raporlar/satis-siparis/sevk" class="btn btn-sm btn-success" target="_blank">▶ Görüntüle</a></td>
    </tr>`;
  const body = `
    ${msg}
    <div class="page-title" style="justify-content:space-between;">
      <span>📋 Raporlar</span>
      <a href="/admin/reports/new" class="btn btn-primary">+ Yeni Rapor</a>
    </div>
    <div class="tbl-card">
      <table class="admin-table">
        <thead><tr><th>#</th><th>Rapor Adı</th><th>Grup</th><th>Bileşenler</th><th>İzin</th><th>İşlemler</th></tr></thead>
        <tbody>${builtinRows}${rows}</tbody>
      </table>
      ${d.reports.length === 0 ? '<div style="padding:16px 20px;font-size:12px;color:#aaa;border-top:1px solid #f0f0f0;">Henüz özel rapor yok. <a href="/admin/reports/new">İlk raporu oluştur →</a></div>' : ''}
    </div>`;
  res.send(layout('Raporlar (Admin)', `<a href="/">Ana Sayfa</a> <span>›</span> <a href="/admin">Admin Panel</a> <span>›</span> Raporlar`, body, req.session));
});

function reportFormHtml(report, groups, users, action, pageTitle) {
  const gOpts = groups.map(g => `<option value="${g.id}" ${report.groupId===g.id?'selected':''}>${g.icon||'📊'} ${g.name}</option>`).join('');
  const cards = (report.statCards||[]).map((c,i) => statCardRowHtml(c,i)).join('');
  const charts = (report.charts||[]).map((c,i) => chartRowHtml(c,i)).join('');

  // Column visibility section
  const existingColKeys = Object.keys(report.columnAliases || {});
  const savedHiddenCols = report.hiddenColumns || [];
  let existingColVis;
  if (existingColKeys.length > 0) {
    existingColVis = '<div id="colVisRows" style="background:#f8f9ff;border:1px solid #e0e4f0;border-radius:8px;padding:12px 16px;display:flex;flex-wrap:wrap;gap:8px;">' +
      existingColKeys.map(col => {
        const alias = (report.columnAliases || {})[col] || col;
        const isHidden = savedHiddenCols.includes(col);
        return '<label style="display:flex;align-items:center;gap:6px;font-size:12px;padding:4px 10px;background:white;border:1.5px solid ' + (isHidden ? '#f48fb1' : '#a5d6a7') + ';border-radius:20px;cursor:pointer;"><input type="checkbox" value="' + col + '" ' + (isHidden ? '' : 'checked') + ' onchange="updateColVis()"> ' + alias + '</label>';
      }).join('') +
      '</div>';
  } else {
    existingColVis = '<div id="colVisRows" style="background:#f8f9ff;border:1px solid #e0e4f0;border-radius:8px;padding:12px 16px;font-size:11px;color:#aaa;">SQL sorgusunu test ettikten sonra sütunlar burada görünecek.</div>';
  }

  const userChecks = users.map(u => `
    <label style="display:flex;align-items:center;gap:8px;font-size:12.5px;padding:3px 0;cursor:pointer;">
      <input type="checkbox" name="allowedUsers" value="${u.username}" ${(!report.allowedUsers||report.allowedUsers.length===0||report.allowedUsers.includes(u.username))?'checked':''}>
      ${u.username} <span class="role-badge role-${u.role}">${u.role}</span>
    </label>`).join('');

  return `
    <div class="page-title">${pageTitle}</div>
    <div class="form-card">
      <form method="POST" action="${action}" id="reportForm">
        <input type="hidden" name="statCardsJson" id="statCardsJson">
        <input type="hidden" name="chartsJson" id="chartsJson">
        <input type="hidden" name="columnAliasesJson" id="columnAliasesJson" value="${JSON.stringify(report.columnAliases||{})}">
        <input type="hidden" name="hiddenColumnsJson" id="hiddenColumnsJson" value="${JSON.stringify(savedHiddenCols).replace(/"/g,'&quot;')}">
        <input type="hidden" name="columnTypesJson" id="columnTypesJson" value="${JSON.stringify(report.columnTypes||{}).replace(/"/g,'&quot;')}">

        <div class="form-cols">
          <div class="form-row"><label>Rapor Adı</label><input name="name" value="${report.name||''}" required placeholder="Örn: Aylık Stok Raporu"></div>
          <div class="form-row"><label>Rapor Grubu</label>
            <select name="groupId" required>
              <option value="">— Grup Seçin —</option>
              ${gOpts}
            </select>
            ${groups.length===0?'<div class="hint" style="color:#c62828;">Önce <a href="/admin/report-groups/new">rapor grubu</a> oluşturun.</div>':''}
          </div>
        </div>
        <div class="form-row"><label>Açıklama <span style="font-weight:400;color:#aaa;">(opsiyonel)</span></label>
          <input name="description" value="${report.description||''}" placeholder="Rapor hakkında kısa açıklama...">
        </div>

        <div class="form-row">
          <label>SQL Sorgusu</label>
          <textarea name="sql" id="sqlInput" rows="10" required placeholder="SELECT ... FROM ... WHERE ...">${report.sql||''}</textarea>
          <div style="display:flex;gap:8px;margin-top:8px;align-items:center;">
            <button type="button" class="btn btn-sm btn-warning" onclick="testSQL()">▶ SQL Test Et</button>
            <span id="testStatus" style="font-size:11px;color:#aaa;"></span>
          </div>
          <div class="sql-preview" id="sqlPreview"></div>
          <div class="hint">TIGER ve CoralReef_Loj veritabanlarına erişilebilir. Örn: SELECT TOP 100 * FROM LG_023_ITEMS</div>
        </div>

        <div class="section-hdr">
          Sütun Görüntüleme Adları
          <small style="font-size:11px;font-weight:400;color:#aaa;">SQL Test Et'e bastıktan sonra otomatik dolar</small>
        </div>
        <div id="colAliasSection">
          <table style="width:100%;border-collapse:collapse;margin-bottom:6px;" id="colAliasTable">
            <thead><tr>
              <th style="padding:7px 12px;font-size:10px;font-weight:700;color:#555;text-align:left;background:#f0f4ff;border:1px solid #e0e4f0;width:30%">Sütun Adı (SQL)</th>
              <th style="padding:7px 12px;font-size:10px;font-weight:700;color:#555;text-align:left;background:#f0f4ff;border:1px solid #e0e4f0;">Görüntüleme Adı</th>
              <th style="padding:7px 12px;font-size:10px;font-weight:700;color:#555;text-align:left;background:#f0f4ff;border:1px solid #e0e4f0;width:140px">Veri Tipi</th>
            </tr></thead>
            <tbody id="colAliasRows">${Object.keys(report.columnAliases||{}).length===0?'<tr><td colspan="3" style="padding:10px 12px;font-size:11px;color:#aaa;border:1px solid #e0e4f0;">SQL sorgusunu test ettikten sonra sütunlar burada görünecek.</td></tr>':Object.keys(report.columnAliases||{}).map(col=>{const ct=(report.columnTypes||{})[col]||'text';return `<tr><td style="padding:5px 12px;font-size:12px;font-family:monospace;background:#f8f9ff;border:1px solid #e0e4f0;">${col}</td><td style="padding:3px 8px;border:1px solid #e0e4f0;"><input type="text" placeholder="${col}" value="${(report.columnAliases||{})[col]||''}" data-col="${col}" style="width:100%;padding:6px 10px;border:1.5px solid #e0e0e0;border-radius:6px;font-size:12px;outline:none;" oninput="updateAliasMap()"></td><td style="padding:3px 8px;border:1px solid #e0e4f0;"><select data-col="${col}" onchange="updateTypeMap()" style="width:100%;padding:6px 8px;border:1.5px solid #e0e0e0;border-radius:6px;font-size:12px;outline:none;background:white;"><option value="text" ${ct==='text'?'selected':''}>Metin</option><option value="number" ${ct==='number'?'selected':''}>Sayı</option><option value="currency" ${ct==='currency'?'selected':''}>Para (₺)</option><option value="date" ${ct==='date'?'selected':''}>Tarih</option><option value="datetime" ${ct==='datetime'?'selected':''}>Tarih Saat</option><option value="percent" ${ct==='percent'?'selected':''}>Yüzde (%)</option></select></td></tr>`;}).join('')}</tbody>
          </table>
        </div>

        <div class="section-hdr">
          Sütun Görünürlüğü
          <small style="font-size:11px;font-weight:400;color:#aaa;">İşaretli sütunlar raporda görünür, işaretsizler gizlenir</small>
        </div>
        ${existingColVis}

        <div class="section-hdr">
          Özet Kartlar (Üst Toplamlar)
          <button type="button" class="btn btn-sm btn-success" onclick="addStatCard()">+ Kart Ekle</button>
        </div>
        <div id="statCards">${cards}</div>

        <div class="section-hdr">
          Grafikler
          <button type="button" class="btn btn-sm btn-success" onclick="addChart()">+ Grafik Ekle</button>
        </div>
        <div id="charts">${charts}</div>

        <div class="section-hdr">Kullanıcı İzinleri</div>
        <div class="form-row">
          <div style="background:#f8f9ff;border:1px solid #e0e4f0;border-radius:8px;padding:12px 16px;">
            ${userChecks || '<span style="color:#aaa;font-size:12px;">Henüz kullanıcı yok.</span>'}
          </div>
          <div class="hint">İşaretlenen kullanıcılar bu rapora erişebilir. Hepsini işaretleyin = herkese açık.</div>
        </div>

        <div style="display:flex;gap:10px;margin-top:16px;">
          <button type="submit" class="btn btn-primary" onclick="prepareSubmit()">💾 Kaydet</button>
          <a href="/admin/reports" class="btn btn-secondary">İptal</a>
        </div>
      </form>
    </div>

    <script>
      let scIdx = ${(report.statCards||[]).length};
      let chIdx = ${(report.charts||[]).length};

      function addStatCard() {
        scIdx++;
        const div = document.createElement('div');
        div.className = 'dyn-row';
        div.id = 'sc_'+scIdx;
        div.innerHTML = statCardTemplate(scIdx);
        document.getElementById('statCards').appendChild(div);
        updateAggFields('sc_'+scIdx);
      }
      function addChart() {
        chIdx++;
        const div = document.createElement('div');
        div.className = 'dyn-row';
        div.id = 'ch_'+chIdx;
        div.innerHTML = chartTemplate(chIdx);
        document.getElementById('charts').appendChild(div);
        updateChartFields('ch_'+chIdx);
      }
      function removeEl(id) { const el=document.getElementById(id); if(el) el.remove(); }

      function statCardTemplate(idx) {
        return \`<button type="button" class="rm" onclick="removeEl('sc_\${idx}')">✕</button>
          <div class="form-cols-4">
            <div class="form-row" style="margin:0;"><label>Etiket</label><input sc-label data-idx="\${idx}" placeholder="Toplam"></div>
            <div class="form-row" style="margin:0;"><label>Renk</label>
              <select sc-color data-idx="\${idx}">
                <option value="blue">Mavi</option><option value="green">Yeşil</option>
                <option value="red">Kırmızı</option><option value="orange">Turuncu</option>
                <option value="purple">Mor</option><option value="teal">Teal</option>
              </select></div>
            <div class="form-row" style="margin:0;"><label>Hesaplama</label>
              <select sc-agg data-idx="\${idx}" onchange="updateAggFields('sc_\${idx}')">
                <option value="count_all">Toplam Satır Sayısı</option>
                <option value="count_where">Koşullu Sayı</option>
                <option value="sum">Toplam (Sütun)</option>
                <option value="avg">Ortalama (Sütun)</option>
                <option value="count_distinct">Benzersiz Sayı (Sütun)</option>
                <option value="formula">Formül (A işlem B)</option>
              </select></div>
            <div class="form-row" style="margin:0;"><label>Sütun Adı</label><input sc-col data-idx="\${idx}" placeholder="SütunAdı"></div>
          </div>
          <div id="sc_cond_\${idx}" style="display:none;">
            <div class="form-cols-3" style="margin-top:8px;">
              <div class="form-row" style="margin:0;"><label>Sütun</label><input sc-cond-col data-idx="\${idx}" placeholder="SütunAdı"></div>
              <div class="form-row" style="margin:0;"><label>Operatör</label>
                <select sc-op data-idx="\${idx}">
                  <option value="lt">Küçüktür (&lt;)</option><option value="lte">Küçük Eşit (&lt;=)</option>
                  <option value="gt">Büyüktür (&gt;)</option><option value="gte">Büyük Eşit (&gt;=)</option>
                  <option value="eq">Eşittir (=)</option><option value="neq">Eşit Değil (≠)</option>
                </select></div>
              <div class="form-row" style="margin:0;"><label>Değer</label><input sc-cond-val data-idx="\${idx}" placeholder="0"></div>
            </div>
          </div>
          <div id="sc_formula_\${idx}" style="display:none;margin-top:8px;">
            <div class="form-cols-4" style="gap:8px;">
              <div class="form-row" style="margin:0;"><label>Sol Hesap</label>
                <select sc-left-agg data-idx="\${idx}">
                  <option value="sum">Toplam</option><option value="count_all">Satır Sayısı</option>
                  <option value="avg">Ortalama</option><option value="count_distinct">Benzersiz Sayı</option>
                </select></div>
              <div class="form-row" style="margin:0;"><label>Sol Sütun</label><input sc-left-col data-idx="\${idx}" placeholder="SütunAdı"></div>
              <div class="form-row" style="margin:0;"><label>İşlem</label>
                <select sc-fop data-idx="\${idx}">
                  <option value="/">Böl (/)</option><option value="*">Çarp (×)</option>
                  <option value="+">Topla (+)</option><option value="-">Çıkar (−)</option>
                </select></div>
              <div class="form-row" style="margin:0;"><label>Sağ Hesap</label>
                <select sc-right-agg data-idx="\${idx}" onchange="updateRightCol('sc_\${idx}')">
                  <option value="sum">Toplam</option><option value="count_all">Satır Sayısı</option>
                  <option value="avg">Ortalama</option><option value="count_distinct">Benzersiz Sayı</option>
                  <option value="const">Sabit Sayı</option>
                </select></div>
            </div>
            <div class="form-cols-4" style="gap:8px;margin-top:6px;">
              <div></div>
              <div id="sc_rcol_\${idx}" class="form-row" style="margin:0;"><label>Sağ Sütun</label><input sc-right-col data-idx="\${idx}" placeholder="SütunAdı"></div>
              <div id="sc_rconst_\${idx}" class="form-row" style="margin:0;display:none;"><label>Sabit Değer</label><input sc-right-const data-idx="\${idx}" placeholder="100" type="number"></div>
            </div>
          </div>\`;
      }

      function chartTemplate(idx) {
        return \`<button type="button" class="rm" onclick="removeEl('ch_\${idx}')">✕</button>
          <div class="form-cols-3">
            <div class="form-row" style="margin:0;"><label>Grafik Başlığı</label><input ch-title data-idx="\${idx}" placeholder="Dağılım Analizi"></div>
            <div class="form-row" style="margin:0;"><label>Grafik Tipi</label>
              <select ch-type data-idx="\${idx}">
                <option value="doughnut">Halka (Doughnut)</option><option value="pie">Pasta (Pie)</option>
                <option value="bar">Dikey Çubuk (Bar)</option><option value="bar_h">Yatay Çubuk</option>
                <option value="line">Çizgi (Line)</option>
              </select></div>
            <div class="form-row" style="margin:0;"><label>Etiket Sütunu <small>(gruplama)</small></label><input ch-label-col data-idx="\${idx}" placeholder="SütunAdı"></div>
          </div>
          <div class="form-cols-3" style="margin-top:8px;">
            <div class="form-row" style="margin:0;"><label>Değer Hesaplama</label>
              <select ch-val-agg data-idx="\${idx}" onchange="updateChartFields('ch_\${idx}')">
                <option value="count">Satır Sayısı</option>
                <option value="sum">Toplam (Sütun)</option>
              </select></div>
            <div class="form-row" style="margin:0;" id="ch_vcol_\${idx}" style="display:none;"><label>Değer Sütunu</label><input ch-val-col data-idx="\${idx}" placeholder="SütunAdı"></div>
            <div class="form-row" style="margin:0;"><label>Top N <small>(0=tümü)</small></label><input ch-top data-idx="\${idx}" type="number" min="0" value="0" placeholder="10"></div>
          </div>\`;
      }

      function updateAggFields(rowId) {
        const row = document.getElementById(rowId);
        if (!row) return;
        const agg = row.querySelector('[sc-agg]').value;
        const idx = row.querySelector('[sc-agg]').dataset.idx;
        const condDiv = document.getElementById('sc_cond_' + idx);
        const formulaDiv = document.getElementById('sc_formula_' + idx);
        const colInput = row.querySelector('[sc-col]');
        const isFormula = agg === 'formula';
        const isWhere = agg === 'count_where';
        const noCol = agg === 'count_all' || isWhere || isFormula;
        if (condDiv) condDiv.style.display = isWhere ? '' : 'none';
        if (formulaDiv) formulaDiv.style.display = isFormula ? '' : 'none';
        if (colInput) colInput.parentElement.style.display = noCol ? 'none' : '';
      }
      function updateRightCol(rowId) {
        const row = document.getElementById(rowId);
        if (!row) return;
        const idx = row.querySelector('[sc-right-agg]').dataset.idx;
        const isConst = row.querySelector('[sc-right-agg]').value === 'const';
        const rcolDiv = document.getElementById('sc_rcol_' + idx);
        const rconstDiv = document.getElementById('sc_rconst_' + idx);
        if (rcolDiv) rcolDiv.style.display = isConst ? 'none' : '';
        if (rconstDiv) rconstDiv.style.display = isConst ? '' : 'none';
      }
      function updateChartFields(rowId) {
        const row = document.getElementById(rowId);
        if (!row) return;
        const agg = row.querySelector('[ch-val-agg]').value;
        const vcolDiv = document.getElementById('ch_vcol_' + row.querySelector('[ch-val-agg]').dataset.idx);
        if (vcolDiv) vcolDiv.style.display = agg === 'sum' ? '' : 'none';
      }

      function collectStatCards() {
        const rows = document.querySelectorAll('#statCards .dyn-row');
        return Array.from(rows).map(row => {
          const idx  = row.querySelector('[sc-agg]').dataset.idx;
          const agg  = row.querySelector('[sc-agg]').value;
          const card = {
            label:     row.querySelector('[sc-label]').value,
            color:     row.querySelector('[sc-color]').value,
            aggregate: agg,
            column:    row.querySelector('[sc-col]') ? row.querySelector('[sc-col]').value : '',
          };
          if (agg === 'count_where') {
            card.column   = row.querySelector('[sc-cond-col]') ? row.querySelector('[sc-cond-col]').value : '';
            card.operator = row.querySelector('[sc-op]') ? row.querySelector('[sc-op]').value : 'lt';
            card.value    = row.querySelector('[sc-cond-val]') ? row.querySelector('[sc-cond-val]').value : '0';
          } else if (agg === 'formula') {
            card.column    = '';
            card.leftAgg   = row.querySelector('[sc-left-agg]') ? row.querySelector('[sc-left-agg]').value : 'sum';
            card.leftCol   = row.querySelector('[sc-left-col]') ? row.querySelector('[sc-left-col]').value : '';
            card.fOp       = row.querySelector('[sc-fop]') ? row.querySelector('[sc-fop]').value : '/';
            card.rightAgg  = row.querySelector('[sc-right-agg]') ? row.querySelector('[sc-right-agg]').value : 'sum';
            card.rightCol  = row.querySelector('[sc-right-col]') ? row.querySelector('[sc-right-col]').value : '';
            card.rightConst = row.querySelector('[sc-right-const]') ? row.querySelector('[sc-right-const]').value : '';
          }
          return card;
        });
      }
      function collectCharts() {
        const rows = document.querySelectorAll('#charts .dyn-row');
        return Array.from(rows).map(row => ({
          title:       row.querySelector('[ch-title]').value,
          type:        row.querySelector('[ch-type]').value,
          labelColumn: row.querySelector('[ch-label-col]').value,
          valueAgg:    row.querySelector('[ch-val-agg]').value,
          valueColumn: row.querySelector('[ch-val-col]') ? row.querySelector('[ch-val-col]').value : '',
          top:         parseInt(row.querySelector('[ch-top]').value) || 0,
        }));
      }
      function prepareSubmit() {
        document.getElementById('statCardsJson').value = JSON.stringify(collectStatCards());
        document.getElementById('chartsJson').value    = JSON.stringify(collectCharts());
        updateAliasMap();
        updateTypeMap();
        updateColVis();
      }
      function updateColVis() {
        var hidden = [];
        document.querySelectorAll('#colVisRows input[type=checkbox]').forEach(function(inp) {
          if (!inp.checked) hidden.push(inp.value);
        });
        document.getElementById('hiddenColumnsJson').value = JSON.stringify(hidden);
      }

      function updateAliasMap() {
        const map = {};
        document.querySelectorAll('#colAliasRows input[data-col]').forEach(inp => {
          if (inp.value.trim()) map[inp.dataset.col] = inp.value.trim();
        });
        document.getElementById('columnAliasesJson').value = JSON.stringify(map);
      }
      function updateTypeMap() {
        const map = {};
        document.querySelectorAll('#colAliasRows select[data-col]').forEach(sel => {
          if (sel.value && sel.value !== 'text') map[sel.dataset.col] = sel.value;
        });
        document.getElementById('columnTypesJson').value = JSON.stringify(map);
      }
      async function testSQL() {
        const sqlVal = document.getElementById('sqlInput').value.trim();
        if (!sqlVal) { alert('SQL boş!'); return; }
        const status = document.getElementById('testStatus');
        const preview = document.getElementById('sqlPreview');
        status.textContent = 'Çalışıyor...'; status.style.color='#f57f17';
        preview.style.display='none';
        try {
          const res = await fetch('/admin/api/test-sql', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({sql:sqlVal}) });
          const data = await res.json();
          if (data.error) { status.textContent='Hata: '+data.error; status.style.color='#c62828'; preview.style.display='none'; }
          else {
            status.textContent='Başarılı — '+data.total+' kayıt (ilk '+data.rows.length+' gösteriliyor)';
            status.style.color='#2e7d32';
            const cols = data.columns.join(' | ');
            const rows = data.rows.map(r => data.columns.map(c=>String(r[c]??'').substring(0,30)).join(' | ')).join('\\n');
            preview.textContent = cols+'\\n'+('-'.repeat(80))+'\\n'+rows;
            preview.style.display='block';
            // Populate column alias rows
            const existingAliases = JSON.parse(document.getElementById('columnAliasesJson').value || '{}');
            const existingTypes = JSON.parse(document.getElementById('columnTypesJson').value || '{}');
            const typeOpts = [['text','Metin'],['number','Sayı'],['currency','Para (₺)'],['date','Tarih'],['datetime','Tarih Saat'],['percent','Yüzde (%)']];
            const tbody = document.getElementById('colAliasRows');
            tbody.innerHTML = data.columns.map(col => {
              const selOpts = typeOpts.map(function(t){return '<option value="'+t[0]+'"'+(existingTypes[col]===t[0]||(!existingTypes[col]&&t[0]==='text')?' selected':'')+'>'+t[1]+'</option>';}).join('');
              return \`<tr><td style="padding:5px 12px;font-size:12px;font-family:monospace;background:#f8f9ff;border:1px solid #e0e4f0;">\${col}</td><td style="padding:3px 8px;border:1px solid #e0e4f0;"><input type="text" placeholder="\${col}" value="\${existingAliases[col]||''}" data-col="\${col}" style="width:100%;padding:6px 10px;border:1.5px solid #e0e0e0;border-radius:6px;font-size:12px;outline:none;" oninput="updateAliasMap()"></td><td style="padding:3px 8px;border:1px solid #e0e4f0;"><select data-col="\${col}" onchange="updateTypeMap()" style="width:100%;padding:6px 8px;border:1.5px solid #e0e0e0;border-radius:6px;font-size:12px;outline:none;background:white;">\${selOpts}</select></td></tr>\`;
            }).join('');
            updateAliasMap();
            updateTypeMap();
            // Populate column visibility rows
            var existingHidden = JSON.parse(document.getElementById('hiddenColumnsJson').value || '[]');
            var visRows = document.getElementById('colVisRows');
            if (visRows) {
              visRows.style.display = 'flex';
              visRows.style.flexWrap = 'wrap';
              visRows.style.gap = '8px';
              visRows.innerHTML = data.columns.map(function(col) {
                var alias = existingAliases[col] || col;
                var isHidden = existingHidden.indexOf(col) >= 0;
                var borderColor = isHidden ? '#f48fb1' : '#a5d6a7';
                return '<label style="display:flex;align-items:center;gap:6px;font-size:12px;padding:4px 10px;background:white;border:1.5px solid ' + borderColor + ';border-radius:20px;cursor:pointer;"><input type="checkbox" value="' + col + '" ' + (isHidden ? '' : 'checked') + ' onchange="updateColVis();this.parentNode.style.borderColor=this.checked?\\\'#a5d6a7\\\':\\\'#f48fb1\\\'"> ' + alias + '</label>';
              }).join('');
              updateColVis();
            }
          }
        } catch(e) { status.textContent='Bağlantı hatası'; status.style.color='#c62828'; }
      }

      // Init existing rows
      document.querySelectorAll('#statCards .dyn-row').forEach(row => {
        const idx = row.querySelector('[sc-agg]')?.dataset.idx;
        if(idx) { updateAggFields('sc_'+idx); updateRightCol('sc_'+idx); }
      });
      document.querySelectorAll('#charts .dyn-row').forEach(row => {
        const idx = row.querySelector('[ch-val-agg]')?.dataset.idx;
        if(idx) updateChartFields('ch_'+idx);
      });
    </script>`;
}

function statCardRowHtml(card, i) {
  const aggLabels = {count_all:'Toplam Satır Sayısı',count_where:'Koşullu Sayı',sum:'Toplam (Sütun)',avg:'Ortalama (Sütun)',count_distinct:'Benzersiz Sayı (Sütun)',formula:'Formül (A işlem B)'};
  const aggOpts = Object.keys(aggLabels).map(a =>
    `<option value="${a}" ${card.aggregate===a?'selected':''}>${aggLabels[a]}</option>`
  ).join('');
  const colorOpts = ['blue','green','red','orange','purple','teal'].map(c =>
    `<option value="${c}" ${card.color===c?'selected':''}>${{blue:'Mavi',green:'Yeşil',red:'Kırmızı',orange:'Turuncu',purple:'Mor',teal:'Teal'}[c]}</option>`
  ).join('');
  const opOpts = ['lt','lte','gt','gte','eq','neq'].map(o =>
    `<option value="${o}" ${card.operator===o?'selected':''}>${{lt:'Küçüktür (<)',lte:'Küçük Eşit (<=)',gt:'Büyüktür (>)',gte:'Büyük Eşit (>=)',eq:'Eşittir (=)',neq:'Eşit Değil (≠)'}[o]}</option>`
  ).join('');
  const isWhere   = card.aggregate === 'count_where';
  const isFormula = card.aggregate === 'formula';
  const noCol     = card.aggregate === 'count_all' || isWhere || isFormula;
  // formula sub-field helpers
  const fAggOpts = (sel) => ['sum','count_all','avg','count_distinct','const'].map(a =>
    `<option value="${a}" ${sel===a?'selected':''}>${{sum:'Toplam',count_all:'Satır Sayısı',avg:'Ortalama',count_distinct:'Benzersiz Sayı',const:'Sabit Sayı'}[a]}</option>`
  ).join('');
  const fOpOpts = ['/','+','-','*'].map(o =>
    `<option value="${o}" ${card.fOp===o?'selected':''}>${{'/':'Böl (/)','*':'Çarp (×)','+':'Topla (+)','-':'Çıkar (−)'}[o]}</option>`
  ).join('');
  const isConst = card.rightAgg === 'const';
  return `<div class="dyn-row" id="sc_${i}">
    <button type="button" class="rm" onclick="removeEl('sc_${i}')">✕</button>
    <div class="form-cols-4">
      <div class="form-row" style="margin:0;"><label>Etiket</label><input sc-label data-idx="${i}" value="${card.label||''}" placeholder="Toplam"></div>
      <div class="form-row" style="margin:0;"><label>Renk</label><select sc-color data-idx="${i}">${colorOpts}</select></div>
      <div class="form-row" style="margin:0;"><label>Hesaplama</label><select sc-agg data-idx="${i}" onchange="updateAggFields('sc_${i}')">${aggOpts}</select></div>
      <div class="form-row" style="margin:0;${noCol?'display:none;':''}"><label>Sütun Adı</label><input sc-col data-idx="${i}" value="${(!isWhere&&!isFormula&&card.column)||''}" placeholder="SütunAdı"></div>
    </div>
    <div id="sc_cond_${i}" style="${isWhere?'':'display:none;'}">
      <div class="form-cols-3" style="margin-top:8px;">
        <div class="form-row" style="margin:0;"><label>Sütun</label><input sc-cond-col data-idx="${i}" value="${isWhere?card.column||'':''}" placeholder="SütunAdı"></div>
        <div class="form-row" style="margin:0;"><label>Operatör</label><select sc-op data-idx="${i}">${opOpts}</select></div>
        <div class="form-row" style="margin:0;"><label>Değer</label><input sc-cond-val data-idx="${i}" value="${card.value||'0'}" placeholder="0"></div>
      </div>
    </div>
    <div id="sc_formula_${i}" style="${isFormula?'':'display:none;'}margin-top:8px;">
      <div class="form-cols-4" style="gap:8px;">
        <div class="form-row" style="margin:0;"><label>Sol Hesap</label><select sc-left-agg data-idx="${i}">${fAggOpts(card.leftAgg||'sum').replace('<option value="const"','<option value="const" style="display:none"')}</select></div>
        <div class="form-row" style="margin:0;"><label>Sol Sütun</label><input sc-left-col data-idx="${i}" value="${card.leftCol||''}" placeholder="SütunAdı"></div>
        <div class="form-row" style="margin:0;"><label>İşlem</label><select sc-fop data-idx="${i}">${fOpOpts}</select></div>
        <div class="form-row" style="margin:0;"><label>Sağ Hesap</label><select sc-right-agg data-idx="${i}" onchange="updateRightCol('sc_${i}')">${fAggOpts(card.rightAgg||'sum')}</select></div>
      </div>
      <div class="form-cols-4" style="gap:8px;margin-top:6px;">
        <div></div>
        <div id="sc_rcol_${i}" class="form-row" style="margin:0;${isConst?'display:none;':''}"><label>Sağ Sütun</label><input sc-right-col data-idx="${i}" value="${card.rightCol||''}" placeholder="SütunAdı"></div>
        <div id="sc_rconst_${i}" class="form-row" style="margin:0;${isConst?'':'display:none;'}"><label>Sabit Değer</label><input sc-right-const data-idx="${i}" value="${card.rightConst||''}" placeholder="100" type="number"></div>
      </div>
    </div>
  </div>`;
}

function chartRowHtml(chart, i) {
  const typeOpts = ['doughnut','pie','bar','bar_h','line'].map(t =>
    `<option value="${t}" ${chart.type===t?'selected':''}>${{doughnut:'Halka (Doughnut)',pie:'Pasta (Pie)',bar:'Dikey Çubuk (Bar)',bar_h:'Yatay Çubuk',line:'Çizgi (Line)'}[t]}</option>`
  ).join('');
  const aggOpts = ['count','sum'].map(a =>
    `<option value="${a}" ${chart.valueAgg===a?'selected':''}>${a==='count'?'Satır Sayısı':'Toplam (Sütun)'}</option>`
  ).join('');
  const isSum = chart.valueAgg === 'sum';
  return `<div class="dyn-row" id="ch_${i}">
    <button type="button" class="rm" onclick="removeEl('ch_${i}')">✕</button>
    <div class="form-cols-3">
      <div class="form-row" style="margin:0;"><label>Grafik Başlığı</label><input ch-title data-idx="${i}" value="${chart.title||''}" placeholder="Dağılım Analizi"></div>
      <div class="form-row" style="margin:0;"><label>Grafik Tipi</label><select ch-type data-idx="${i}">${typeOpts}</select></div>
      <div class="form-row" style="margin:0;"><label>Etiket Sütunu <small>(gruplama)</small></label><input ch-label-col data-idx="${i}" value="${chart.labelColumn||''}" placeholder="SütunAdı"></div>
    </div>
    <div class="form-cols-3" style="margin-top:8px;">
      <div class="form-row" style="margin:0;"><label>Değer Hesaplama</label><select ch-val-agg data-idx="${i}" onchange="updateChartFields('ch_${i}')">${aggOpts}</select></div>
      <div class="form-row" style="margin:0;${isSum?'':'display:none;'}" id="ch_vcol_${i}"><label>Değer Sütunu</label><input ch-val-col data-idx="${i}" value="${chart.valueColumn||''}" placeholder="SütunAdı"></div>
      <div class="form-row" style="margin:0;"><label>Top N <small>(0=tümü)</small></label><input ch-top data-idx="${i}" type="number" min="0" value="${chart.top||0}"></div>
    </div>
  </div>`;
}

app.get('/admin/reports/new', auth, adminOnly, (req, res) => {
  const d = loadData();
  if (d.reportGroups.length === 0) return res.redirect('/admin/report-groups/new');
  const body = reportFormHtml({}, d.reportGroups, d.users, '/admin/reports/create', '+ Yeni Rapor');
  res.send(layout('Raporlar (Admin)', `<a href="/">Ana Sayfa</a> <span>›</span> <a href="/admin">Admin</a> <span>›</span> <a href="/admin/reports">Raporlar</a> <span>›</span> Yeni`, body, req.session));
});

app.post('/admin/reports/create', auth, adminOnly, (req, res) => {
  const d = loadData();
  let statCards = [], charts = [], columnAliases = {}, hiddenColumns = [], columnTypes = {};
  try { statCards = JSON.parse(req.body.statCardsJson || '[]'); } catch(e) {}
  try { charts    = JSON.parse(req.body.chartsJson    || '[]'); } catch(e) {}
  try { columnAliases = JSON.parse(req.body.columnAliasesJson || '{}'); } catch(e) {}
  try { hiddenColumns = JSON.parse(req.body.hiddenColumnsJson || '[]'); } catch(e) {}
  try { columnTypes   = JSON.parse(req.body.columnTypesJson   || '{}'); } catch(e) {}
  const allowed = Array.isArray(req.body.allowedUsers) ? req.body.allowedUsers : (req.body.allowedUsers ? [req.body.allowedUsers] : []);
  d.reports.push({
    id: makeId(d),
    name: req.body.name,
    groupId: parseInt(req.body.groupId),
    description: req.body.description || '',
    sql: req.body.sql,
    statCards,
    charts,
    columnAliases,
    hiddenColumns,
    columnTypes,
    allowedUsers: allowed,
    createdAt: new Date().toISOString()
  });
  saveData(d);
  res.redirect('/admin/reports?msg=' + encodeURIComponent('Rapor oluşturuldu.'));
});

app.get('/admin/reports/:id/edit', auth, adminOnly, (req, res) => {
  const d      = loadData();
  const report = d.reports.find(r => r.id === parseInt(req.params.id));
  if (!report) return res.redirect('/admin/reports');
  const body = reportFormHtml(report, d.reportGroups, d.users, `/admin/reports/${report.id}/update`, `✏️ Rapor Düzenle: ${report.name}`);
  res.send(layout('Raporlar (Admin)', `<a href="/">Ana Sayfa</a> <span>›</span> <a href="/admin">Admin</a> <span>›</span> <a href="/admin/reports">Raporlar</a> <span>›</span> Düzenle`, body, req.session));
});

app.post('/admin/reports/:id/update', auth, adminOnly, (req, res) => {
  const d      = loadData();
  const report = d.reports.find(r => r.id === parseInt(req.params.id));
  if (!report) return res.redirect('/admin/reports');
  let statCards = [], charts = [], columnAliases = {}, hiddenColumns = [], columnTypes = {};
  try { statCards = JSON.parse(req.body.statCardsJson || '[]'); } catch(e) {}
  try { charts    = JSON.parse(req.body.chartsJson    || '[]'); } catch(e) {}
  try { columnAliases = JSON.parse(req.body.columnAliasesJson || '{}'); } catch(e) {}
  try { hiddenColumns = JSON.parse(req.body.hiddenColumnsJson || '[]'); } catch(e) {}
  try { columnTypes   = JSON.parse(req.body.columnTypesJson   || '{}'); } catch(e) {}
  const allowed = Array.isArray(req.body.allowedUsers) ? req.body.allowedUsers : (req.body.allowedUsers ? [req.body.allowedUsers] : []);
  report.name        = req.body.name || report.name;
  report.groupId     = parseInt(req.body.groupId) || report.groupId;
  report.description = req.body.description || '';
  report.sql         = req.body.sql || report.sql;
  report.statCards   = statCards;
  report.charts      = charts;
  report.columnAliases = columnAliases;
  report.hiddenColumns = hiddenColumns;
  report.columnTypes   = columnTypes;
  report.allowedUsers = allowed;
  report.updatedAt   = new Date().toISOString();
  saveData(d);
  res.redirect('/admin/reports?msg=' + encodeURIComponent('Rapor güncellendi.'));
});

app.post('/admin/reports/:id/delete', auth, adminOnly, (req, res) => {
  const d = loadData();
  d.reports = d.reports.filter(r => r.id !== parseInt(req.params.id));
  saveData(d);
  res.redirect('/admin/reports?msg=' + encodeURIComponent('Rapor silindi.'));
});

// ── SQL TEST API ──────────────────────────────────────────────────────
app.post('/admin/api/test-sql', auth, adminOnly, async (req, res) => {
  const { sql: sqlQuery } = req.body;
  if (!sqlQuery) return res.json({ error: 'SQL boş' });
  try {
    const pool   = await sql.connect(dbConfig);
    const result = await pool.request().query(sqlQuery);
    await sql.close();
    const rows    = result.recordset.slice(0, 5);
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
    res.json({ columns, rows, total: result.recordset.length });
  } catch (err) {
    try { await sql.close(); } catch(e) {}
    res.json({ error: err.message });
  }
});

// ── LOGO ──────────────────────────────────────────────────────────────
app.get('/logo', (req, res) => res.sendFile(path.join(__dirname, 'lojimax logo.PNG')));

// ── START ─────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`LOJİMAX RAPOR çalışıyor: http://localhost:${PORT}`));
