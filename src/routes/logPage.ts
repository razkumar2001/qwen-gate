/*
 * File: logPage.ts
 * Professional monitoring dashboard — auto-updates via SSE and polling
 */

export const logHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Qwen Gate — Monitoring</title>
<style>
:root {
  --bg-primary: #0a0a0f;
  --bg-card: #12121a;
  --bg-elevated: #1a1a25;
  --border: #2a2a35;
  --text-primary: #e4e4e7;
  --text-secondary: #71717a;
  --accent: #6366f1;
  --accent-soft: rgba(99,102,241,0.15);
  --success: #22c55e;
  --success-soft: rgba(34,197,94,0.15);
  --warning: #f59e0b;
  --warning-soft: rgba(245,158,11,0.15);
  --danger: #ef4444;
  --danger-soft: rgba(239,68,68,0.15);
  --radius: 12px;
  --font: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  --mono: 'SF Mono', Monaco, Consolas, monospace;
}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
body{font-family:var(--font);background:var(--bg-primary);color:var(--text-primary);line-height:1.5;min-height:100vh}

/* Layout */
.dashboard{max-width:1440px;margin:0 auto;padding:20px}
.header{display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;flex-wrap:wrap;gap:12px}
.header-left{display:flex;align-items:center;gap:12px}
.header h1{font-size:1.125rem;font-weight:600;color:var(--text-primary);letter-spacing:-0.01em}
.live-indicator{display:flex;align-items:center;gap:6px;font-size:0.75rem;color:var(--success);text-transform:uppercase;letter-spacing:0.05em;font-weight:500}
.live-dot{width:6px;height:6px;border-radius:50%;background:var(--success);animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:0.4;transform:scale(0.85)}}
.header-meta{font-size:0.75rem;color:var(--text-secondary);font-family:var(--mono)}

/* KPI Grid */
.kpi-grid{display:grid;grid-template-columns:repeat(6,1fr);gap:12px;margin-bottom:20px}
.kpi-card{background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:16px;display:flex;flex-direction:column;gap:4px;transition:border-color 0.2s}
.kpi-card:hover{border-color:var(--accent)}
.kpi-label{font-size:0.75rem;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-secondary);font-weight:500}
.kpi-value{font-size:2rem;font-weight:700;line-height:1.1;color:var(--text-primary);font-variant-numeric:tabular-nums}
.kpi-sub{font-size:0.75rem;color:var(--text-secondary);font-family:var(--mono)}

/* Panels Grid */
.panels-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:16px;margin-bottom:20px}
.panel-full{grid-column:1/-1}

/* Panel */
.panel{background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden}
.panel-header{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;cursor:pointer;user-select:none;border-bottom:1px solid transparent;transition:background 0.15s}
.panel-header:hover{background:var(--bg-elevated)}
.panel-header.open{border-bottom-color:var(--border)}
.panel-title{font-size:0.875rem;font-weight:600;color:var(--accent);display:flex;align-items:center;gap:8px}
.panel-title svg{width:14px;height:14px;opacity:0.7}
.panel-chevron{width:16px;height:16px;color:var(--text-secondary);transition:transform 0.25s ease}
.panel-header.open .panel-chevron{transform:rotate(180deg)}
.panel-body{max-height:0;overflow:hidden;transition:max-height 0.35s ease}
.panel-body.open{max-height:4000px}
.panel-content{padding:0 16px 16px}

/* Tables */
.tbl-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
table{width:100%;border-collapse:collapse;font-size:0.8125rem}
thead th{text-align:left;padding:10px 8px;font-size:0.7rem;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-secondary);font-weight:500;border-bottom:1px solid var(--border);white-space:nowrap}
tbody td{padding:10px 8px;border-bottom:1px solid var(--border);color:var(--text-primary);vertical-align:middle;word-break:break-all}
tbody tr:last-child td{border-bottom:none}
tbody tr:hover{background:var(--bg-elevated)}

/* Badges */
.badge{display:inline-flex;align-items:center;padding:2px 8px;border-radius:9999px;font-size:0.7rem;font-weight:500;white-space:nowrap;gap:4px}
.badge-success{background:var(--success-soft);color:var(--success)}
.badge-danger{background:var(--danger-soft);color:var(--danger)}
.badge-warning{background:var(--warning-soft);color:var(--warning)}
.badge-accent{background:var(--accent-soft);color:var(--accent)}
.badge-neutral{background:var(--bg-elevated);color:var(--text-secondary)}

/* Session Pool Visual */
.pool-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;padding-top:8px}
.pool-stat{text-align:center;padding:12px;background:var(--bg-elevated);border-radius:8px}
.pool-stat-value{font-size:1.5rem;font-weight:700;font-variant-numeric:tabular-nums}
.pool-stat-label{font-size:0.7rem;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-secondary);margin-top:2px}
.pool-bar{height:4px;background:var(--bg-elevated);border-radius:2px;margin-top:12px;overflow:hidden}
.pool-bar-fill{height:100%;border-radius:2px;transition:width 0.5s ease}

/* System Logs */
.sys-log-entry{display:flex;gap:10px;padding:6px 0;font-family:var(--mono);font-size:0.75rem;border-bottom:1px solid var(--border);align-items:flex-start}
.sys-log-entry:last-child{border-bottom:none}
.sys-log-ts{color:var(--text-secondary);white-space:nowrap;flex-shrink:0}
.sys-log-level{font-weight:600;width:44px;flex-shrink:0;text-transform:uppercase;font-size:0.65rem;padding-top:1px}
.sys-log-cat{color:var(--accent);white-space:nowrap;flex-shrink:0;min-width:80px}
.sys-log-msg{color:var(--text-primary);word-break:break-all}
.log-debug{color:#71717a}.log-info{color:#6366f1}.log-warn{color:#f59e0b}.log-error{color:#ef4444}

/* Request Log / SSE Stream */
.req-entry{border-bottom:1px solid var(--border);animation:fadeIn 0.3s ease}
.req-entry:last-child{border-bottom:none}
@keyframes fadeIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}
.req-header{display:flex;align-items:center;gap:8px;padding:10px 0;cursor:pointer;flex-wrap:wrap}
.req-header:hover{opacity:0.85}
.req-ts{font-family:var(--mono);font-size:0.7rem;color:var(--text-secondary);flex-shrink:0}
.req-model{font-size:0.75rem;font-weight:500}
.req-status{font-size:0.7rem;font-family:var(--mono)}
.req-toggle-icon{font-size:0.65rem;color:var(--text-secondary);margin-left:auto;transition:transform 0.2s}
.req-entry.expanded .req-toggle-icon{transform:rotate(90deg)}
.req-detail{display:none;padding:0 0 12px 0}
.req-entry.expanded .req-detail{display:block}
.req-section-label{font-size:0.65rem;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-secondary);margin:8px 0 4px;font-weight:500}
.req-block{background:var(--bg-elevated);border-radius:8px;padding:10px 12px;font-family:var(--mono);font-size:0.7rem;line-height:1.6;white-space:pre-wrap;word-break:break-all;color:var(--text-primary);max-height:300px;overflow-y:auto}

/* Empty State */
.empty-state{padding:32px 16px;text-align:center;color:var(--text-secondary);font-size:0.8125rem}
.empty-state svg{width:32px;height:32px;margin-bottom:8px;opacity:0.3}

/* Responsive */
@media(max-width:1200px){.kpi-grid{grid-template-columns:repeat(3,1fr)}}
@media(max-width:900px){.panels-grid{grid-template-columns:1fr}.kpi-grid{grid-template-columns:repeat(3,1fr)}}
@media(max-width:600px){.kpi-grid{grid-template-columns:repeat(2,1fr)}.pool-grid{grid-template-columns:repeat(2,1fr)}.dashboard{padding:12px}}
</style>
</head>
<body>
<div class="dashboard">
  <!-- Header -->
  <div class="header">
    <div class="header-left">
      <h1>Qwen Gate</h1>
      <div class="live-indicator"><span class="live-dot"></span>Live</div>
    </div>
    <div class="header-meta" id="uptimeDisplay">—</div>
  </div>

  <!-- KPI Cards -->
  <div class="kpi-grid">
    <div class="kpi-card">
      <span class="kpi-label">Total Accounts</span>
      <span class="kpi-value" id="kpiTotalAccounts">—</span>
      <span class="kpi-sub" id="kpiTotalAccountsSub">&nbsp;</span>
    </div>
    <div class="kpi-card">
      <span class="kpi-label">Available</span>
      <span class="kpi-value" id="kpiAvailable">—</span>
      <span class="kpi-sub" id="kpiAvailableSub">&nbsp;</span>
    </div>
    <div class="kpi-card">
      <span class="kpi-label">Active Sessions</span>
      <span class="kpi-value" id="kpiActiveSessions">—</span>
      <span class="kpi-sub" id="kpiActiveSessionsSub">&nbsp;</span>
    </div>
    <div class="kpi-card">
      <span class="kpi-label">Queue</span>
      <span class="kpi-value" id="kpiQueue">—</span>
      <span class="kpi-sub" id="kpiQueueSub">&nbsp;</span>
    </div>
    <div class="kpi-card">
      <span class="kpi-label">Total Requests</span>
      <span class="kpi-value" id="kpiTotalRequests">—</span>
      <span class="kpi-sub" id="kpiTotalRequestsSub">&nbsp;</span>
    </div>
    <div class="kpi-card">
      <span class="kpi-label">Uptime</span>
      <span class="kpi-value" id="kpiUptime">—</span>
      <span class="kpi-sub" id="kpiUptimeSub">&nbsp;</span>
    </div>
  </div>

  <!-- Accounts Panel -->
  <div class="panels-grid">
    <div class="panel panel-full">
      <div class="panel-header open" onclick="togglePanel(this)">
        <span class="panel-title"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>Accounts</span>
        <svg class="panel-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
      </div>
      <div class="panel-body open"><div class="panel-content">
        <div class="tbl-wrap">
          <table id="accountsTable">
            <thead><tr><th>Email</th><th>Auth</th><th>In Flight</th><th>Total Reqs</th><th>Throttle</th><th>Token TTL</th></tr></thead>
            <tbody id="accountsBody"></tbody>
          </table>
        </div>
        <div class="empty-state" id="accountsEmpty" style="display:none">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>
          <div>No accounts registered</div>
        </div>
      </div></div>
    </div>

    <!-- Session Pool Panel -->
    <div class="panel">
      <div class="panel-header open" onclick="togglePanel(this)">
        <span class="panel-title"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>Session Pool</span>
        <svg class="panel-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
      </div>
      <div class="panel-body open"><div class="panel-content">
        <div class="pool-grid" id="poolGrid">
          <div class="pool-stat"><div class="pool-stat-value" id="poolActive">—</div><div class="pool-stat-label">Active</div></div>
          <div class="pool-stat"><div class="pool-stat-value" id="poolWaiting">—</div><div class="pool-stat-label">Waiting</div></div>
          <div class="pool-stat"><div class="pool-stat-value" id="poolMax">—</div><div class="pool-stat-label">Max Wait</div></div>
          <div class="pool-stat"><div class="pool-stat-value" id="poolTimeout">—</div><div class="pool-stat-label">Timeout</div></div>
        </div>
        <div class="pool-bar"><div class="pool-bar-fill" id="poolBarFill" style="width:0%;background:var(--accent)"></div></div>
        <div class="empty-state" id="poolEmpty" style="display:none">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
          <div>No pool data available</div>
        </div>
      </div></div>
    </div>

    <!-- Model Health Panel -->
    <div class="panel">
      <div class="panel-header open" onclick="togglePanel(this)">
        <span class="panel-title"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>Model Health</span>
        <svg class="panel-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
      </div>
      <div class="panel-body open"><div class="panel-content">
        <div class="tbl-wrap">
          <table id="modelTable">
            <thead><tr><th>Model</th><th>Success</th><th>Errors</th><th>Rate</th><th>Last Activity</th></tr></thead>
            <tbody id="modelBody"></tbody>
          </table>
        </div>
        <div class="empty-state" id="modelEmpty" style="display:none">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
          <div>No model activity recorded</div>
        </div>
      </div></div>
    </div>

    <!-- System Logs Panel -->
    <div class="panel panel-full">
      <div class="panel-header open" onclick="togglePanel(this)">
        <span class="panel-title"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>System Logs</span>
        <svg class="panel-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
      </div>
      <div class="panel-body open"><div class="panel-content" id="sysLogsContainer">
        <div class="empty-state" id="sysLogsEmpty">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          <div>No system logs yet</div>
        </div>
      </div></div>
    </div>

    <!-- Request Log Panel (SSE) -->
    <div class="panel panel-full">
      <div class="panel-header open" onclick="togglePanel(this)">
        <span class="panel-title"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>Request Log</span>
        <svg class="panel-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
      </div>
      <div class="panel-body open"><div class="panel-content" id="requestLogContainer">
        <div class="empty-state" id="requestLogEmpty">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
          <div>Waiting for requests…</div>
        </div>
      </div></div>
    </div>
  </div>
</div>

<script>
function authHeaders() {
  if (!window.API_KEY) return {};
  return { 'Authorization': 'Bearer ' + window.API_KEY };
}
function authUrl(path) {
  if (!window.API_KEY) return path;
  return path + (path.includes('?') ? '&' : '?') + 'token=' + window.API_KEY;
}

/* ── Helpers ── */
function fmtDuration(ms) {
  if (ms == null || ms < 0) return '—';
  var s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
  s %= 60; m %= 60; h %= 24;
  var parts = [];
  if (d > 0) parts.push(d + 'd');
  if (h > 0) parts.push(h + 'h');
  if (m > 0) parts.push(m + 'm');
  if (parts.length === 0) parts.push(s + 's');
  return parts.join(' ');
}
function fmtTTL(ms) {
  if (ms == null || ms < 0) return '—';
  var m = Math.floor(ms / 60000), h = Math.floor(m / 60);
  m %= 60;
  if (h > 0) return h + 'h ' + m + 'm';
  return m + 'm';
}
function fmtTime(ts) {
  if (!ts) return '—';
  var d = typeof ts === 'number' ? new Date(ts) : new Date(ts);
  if (isNaN(d.getTime())) return '—';
  return d.toTimeString().slice(0, 8);
}
function escHtml(s) {
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function togglePanel(header) {
  header.classList.toggle('open');
  var body = header.nextElementSibling;
  body.classList.toggle('open');
}

/* ── State ── */
var MAX_REQUEST_ENTRIES = 200;
var requestEntries = [];

/* ── Fetch wrapper ── */
async function apiFetch(url) {
  try {
    var res = await fetch(url, { headers: authHeaders() });
    if (!res.ok) return null;
    return await res.json();
  } catch(e) { return null; }
}

/* ── KPI + Health ── */
async function refreshHealth() {
  var data = await apiFetch('/health');
  if (!data) return;
  var accts = data.accounts || {};
  setText('kpiTotalAccounts', accts.total != null ? accts.total : '—');
  setText('kpiAvailable', accts.available != null ? accts.available : '—');
  setText('kpiUptime', fmtDuration(data.uptime));
  setText('uptimeDisplay', data.status === 'ok' ? 'Operational' : data.status || '—');
  var availPct = accts.total > 0 ? Math.round((accts.available / accts.total) * 100) : 0;
  setText('kpiAvailableSub', availPct + '% of total');
}

/* ── Accounts ── */
async function refreshAccounts() {
  var data = await apiFetch('/accounts');
  var tbody = document.getElementById('accountsBody');
  var empty = document.getElementById('accountsEmpty');
  var table = document.getElementById('accountsTable');
  if (!data || !Array.isArray(data) || data.length === 0) {
    table.style.display = 'none';
    empty.style.display = '';
    setText('kpiTotalRequests', '0');
    return;
  }
  table.style.display = '';
  empty.style.display = 'none';
  var totalReqs = 0;
  var rows = '';
  for (var i = 0; i < data.length; i++) {
    var a = data[i];
    totalReqs += (a.totalRequests || 0);
    var authBadge = a.authenticated
      ? '<span class="badge badge-success">✓ Auth</span>'
      : '<span class="badge badge-danger">✗ No</span>';
    var throttleBadge = a.throttled
      ? '<span class="badge badge-warning">Throttled ' + fmtTTL(a.throttledRemainingMs) + '</span>'
      : '<span class="badge badge-neutral">OK</span>';
    rows += '<tr>'
      + '<td>' + escHtml(a.email) + '</td>'
      + '<td>' + authBadge + '</td>'
      + '<td>' + (a.inFlight || 0) + '</td>'
      + '<td>' + (a.totalRequests || 0) + '</td>'
      + '<td>' + throttleBadge + '</td>'
      + '<td>' + fmtTTL(a.tokenExpiresInMs) + '</td>'
      + '</tr>';
  }
  tbody.innerHTML = rows;
  setText('kpiTotalRequests', totalReqs);
}

/* ── Pool Stats ── */
async function refreshPool() {
  var data = await apiFetch('/pool/stats');
  var grid = document.getElementById('poolGrid');
  var empty = document.getElementById('poolEmpty');
  var bar = document.getElementById('poolBarFill');
  if (!data) {
    grid.style.display = 'none';
    bar.parentElement.style.display = 'none';
    empty.style.display = '';
    return;
  }
  grid.style.display = '';
  bar.parentElement.style.display = '';
  empty.style.display = 'none';
  setText('poolActive', data.activeSessions != null ? data.activeSessions : '0');
  setText('poolWaiting', data.waitingQueue != null ? data.waitingQueue : '0');
  setText('poolMax', data.maxWaiting != null ? data.maxWaiting : '—');
  setText('poolTimeout', data.waitTimeoutMs != null ? (data.waitTimeoutMs / 1000) + 's' : '—');
  setText('kpiActiveSessions', data.activeSessions != null ? data.activeSessions : '0');
  setText('kpiQueue', data.waitingQueue != null ? data.waitingQueue : '0');
  var maxW = data.maxWaiting || 1;
  var pct = Math.min(100, Math.round(((data.waitingQueue || 0) / maxW) * 100));
  bar.style.width = pct + '%';
  bar.style.background = pct > 80 ? 'var(--danger)' : pct > 50 ? 'var(--warning)' : 'var(--accent)';
  setText('kpiQueueSub', 'max ' + maxW);
}

/* ── Model Health ── */
async function refreshModelHealth() {
  var data = await apiFetch('/metrics/model-health');
  var tbody = document.getElementById('modelBody');
  var empty = document.getElementById('modelEmpty');
  var table = document.getElementById('modelTable');
  if (!data || typeof data !== 'object' || Object.keys(data).length === 0) {
    table.style.display = 'none';
    empty.style.display = '';
    return;
  }
  table.style.display = '';
  empty.style.display = 'none';
  var rows = '';
  var keys = Object.keys(data).sort();
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i], m = data[k];
    var total = (m.successCount || 0) + (m.errorCount || 0);
    var rate = total > 0 ? Math.round(((m.successCount || 0) / total) * 100) : 0;
    var rateClass = rate >= 95 ? 'badge-success' : rate >= 80 ? 'badge-warning' : 'badge-danger';
    rows += '<tr>'
      + '<td>' + escHtml(k) + '</td>'
      + '<td>' + (m.successCount || 0) + '</td>'
      + '<td>' + (m.errorCount || 0) + '</td>'
      + '<td><span class="badge ' + rateClass + '">' + rate + '%</span></td>'
      + '<td>' + fmtTime(m.lastActivity) + '</td>'
      + '</tr>';
  }
  tbody.innerHTML = rows;
}

/* ── System Logs ── */
async function refreshSysLogs() {
  var data = await apiFetch('/system/logs?limit=50');
  var container = document.getElementById('sysLogsContainer');
  var empty = document.getElementById('sysLogsEmpty');
  if (!data || !Array.isArray(data) || data.length === 0) {
    empty.style.display = '';
    return;
  }
  empty.style.display = 'none';
  var html = '';
  for (var i = data.length - 1; i >= 0; i--) {
    var l = data[i];
    var lvl = (l.level || 'info').toLowerCase();
    var cls = 'log-' + (lvl === 'debug' ? 'debug' : lvl === 'warn' || lvl === 'warning' ? 'warn' : lvl === 'error' ? 'error' : 'info');
    html += '<div class="sys-log-entry">'
      + '<span class="sys-log-ts">' + fmtTime(l.timestamp) + '</span>'
      + '<span class="sys-log-level ' + cls + '">' + escHtml(lvl) + '</span>'
      + '<span class="sys-log-cat">' + escHtml(l.category || '') + '</span>'
      + '<span class="sys-log-msg">' + escHtml(l.message || '') + '</span>'
      + '</div>';
  }
  /* preserve empty state element */
  container.innerHTML = html;
  container.appendChild(empty);
}

/* ── SSE Request Log ── */
function connectSSE() {
  var es = new EventSource(authUrl('/log/stream'));
  es.onmessage = function(ev) {
    try {
      var entry = JSON.parse(ev.data);
      addRequestEntry(entry);
    } catch(e) {}
  };
  es.onerror = function() {
    es.close();
    setTimeout(connectSSE, 3000);
  };
}
function addRequestEntry(entry) {
  var empty = document.getElementById('requestLogEmpty');
  if (empty) empty.style.display = 'none';
  var container = document.getElementById('requestLogContainer');
  var id = 'req-' + Date.now() + '-' + Math.random().toString(36).slice(2,6);
  var model = entry.model || entry.request?.model || 'unknown';
  var stream = entry.stream !== false;
  var status = entry.error ? 'error' : (entry.done ? 'done' : 'streaming');
  var statusBadge = status === 'error' ? 'badge-danger'
    : status === 'done' ? 'badge-success' : 'badge-accent';
  var rawText = entry.rawOutput || entry.raw || '';
  var processedText = entry.processedOutput || entry.processed || entry.output || '';
  var div = document.createElement('div');
  div.className = 'req-entry';
  div.id = id;
  div.innerHTML = '<div class="req-header">'
    + '<span class="req-ts">' + fmtTime(entry.timestamp || Date.now()) + '</span>'
    + '<span class="badge badge-neutral">' + escHtml(model) + '</span>'
    + '<span class="badge ' + (stream ? 'badge-accent' : 'badge-neutral') + '">' + (stream ? 'SSE' : 'SYNC') + '</span>'
    + '<span class="badge ' + statusBadge + '">' + status + '</span>'
    + (entry.tokens ? '<span class="req-status">' + entry.tokens + ' tok</span>' : '')
    + '<span class="req-toggle-icon">▶</span>'
    + '</div>'
    + '<div class="req-detail">'
    + (entry.clientRequest?.messages?.length ? '<div class="req-section-label">Request Sent</div><div class="req-block">' + escHtml(JSON.stringify(entry.clientRequest.messages, null, 2)) + '</div>' : '')
    + (rawText ? '<div class="req-section-label">Raw AI Response</div><div class="req-block">' + escHtml(rawText) + '</div>' : '')
    + (processedText ? '<div class="req-section-label">Processed Output</div><div class="req-block">' + escHtml(processedText) + '</div>' : '')
    + (entry.parsedToolCalls?.length ? '<div class="req-section-label">Tool Execution</div>' + entry.parsedToolCalls.map(tc => {
        var status = tc.blocked ? '<span class="badge badge-warning">BLOCKED</span>' : (tc.error ? '<span class="badge badge-danger">ERROR</span>' : '<span class="badge badge-success">SUCCESS</span>');
        var details = '';
        if (tc.blocked) details += 'Reason: ' + escHtml(tc.blockReason || 'N/A') + '<br>';
        if (tc.error) details += 'Error: ' + escHtml(tc.error) + '<br>';
        if (tc.result !== undefined) details += 'Result: ' + escHtml(JSON.stringify(tc.result, null, 2)) + '<br>';
        if (tc.executionTimeMs !== undefined) details += 'Exec time: ' + tc.executionTimeMs + 'ms';
        return '<div style="margin:8px 0;padding:8px;background:var(--bg-elevated);border-radius:6px">'
          + '<strong>' + escHtml(tc.name) + '</strong> ' + status + '<br>'
          + '<small>Args: ' + escHtml(JSON.stringify(tc.arguments)) + '</small><br>'
          + (details ? '<div style="margin-top:4px;font-family:var(--mono);font-size:0.8em;white-space:pre-wrap">' + details + '</div>' : '')
          + '</div>';
      }).join('') : '')
    + '</div>';
  div.querySelector('.req-header').addEventListener('click', function() {
    div.classList.toggle('expanded');
  });
  container.insertBefore(div, container.firstChild.nextSibling || null);
  requestEntries.push(id);
  while (requestEntries.length > MAX_REQUEST_ENTRIES) {
    var old = requestEntries.shift();
    var el = document.getElementById(old);
    if (el) el.remove();
  }
}

/* ── Utility ── */
function setText(id, val) {
  var el = document.getElementById(id);
  if (el) el.textContent = val;
}

/* ── Init ── */
function init() {
  refreshHealth();
  refreshAccounts();
  refreshPool();
  refreshModelHealth();
  refreshSysLogs();
  refreshRequestLogs();
  setupEventSource();
  
  // Polling fallback for SSE
  setInterval(() => {
    refreshHealth();
    refreshAccounts();
    refreshPool();
    refreshModelHealth();
    refreshSysLogs();
    refreshRequestLogs();
  }, 2000);
  
  // Refresh uptime every second
  setInterval(async () => {
    try {
      const data = await apiFetch('/metrics/uptime');
      if (data?.uptimeSeconds !== undefined) {
        const secs = data.uptimeSeconds;
        const h = Math.floor(secs / 3600);
        const m = Math.floor((secs % 3600) / 60);
        const s = secs % 60;
        setText('kpiUptime', h + 'h ' + m + 'm ' + s + 's');
        setText('kpiUptimeSub', 'since server start');
      }
    } catch (e) {
      // Uptime endpoint may not be available in older versions
    }
  }, 1000);
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
</script>
</body>
</html>`;
