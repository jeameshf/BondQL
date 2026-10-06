'use strict';
/* ============================================================
   BondQL · 智能问数 — 前端应用
   通过 REST API 与 server.py 交互，数据来自真实 SQLite 查询。
   ============================================================ */

/* ---------- 基础工具 ---------- */
const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
const esc = t => { const d = document.createElement('div'); d.textContent = t == null ? '' : String(t); return d.innerHTML; };
const uid = p => (p || 'id') + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const fmtNum = n => Number(n).toLocaleString('zh-CN');

function toast(msg, type = 'success') {
  const wrap = $('#toastWrap');
  const el = document.createElement('div');
  el.className = 'toast ' + (type || '');
  el.innerHTML = '<span>' + (type === 'error' ? '⚠️' : type === 'success' ? '✅' : 'ℹ️') + '</span>' + esc(msg);
  wrap.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 260); }, 2400);
}

/* ---------- API ---------- */
let token = localStorage.getItem('bondql_token') || null;
let currentUser = null;

async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (token) opts.headers['Authorization'] = 'Bearer ' + token;
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const resp = await fetch('/api' + path, opts);
  const ct = resp.headers.get('Content-Type') || '';
  const data = ct.includes('json') ? await resp.json() : await resp.text();
  if (resp.status === 401 && path !== '/login') { showLogin(); throw new Error((data && data.error) || '未登录'); }
  if (!resp.ok) throw new Error((data && data.error) || resp.status);
  return data;
}

/* ---------- 弹窗系统 ---------- */
function openModal(title, bodyHtml, footHtml, size) {
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = bodyHtml;
  $('#modalFoot').innerHTML = footHtml || '';
  $('#modalBox').className = 'modal' + (size === 'lg' ? ' modal-lg' : '');
  $('#modalMask').classList.add('open');
}
function closeModal() { $('#modalMask').classList.remove('open'); }
function confirmModal(title, text, onOk) {
  openModal(title, '<div class="confirm-box"><div class="confirm-icon">!</div><div class="confirm-title">' + esc(title) + '</div><div class="confirm-text">' + esc(text) + '</div></div>',
    '<button class="btn btn-s" onclick="closeModal()">取消</button><button class="btn btn-d" id="confirmOkBtn">确认</button>');
  $('#confirmOkBtn').onclick = () => { closeModal(); onOk(); };
}
$('#modalMask').addEventListener('click', e => { if (e.target === $('#modalMask')) closeModal(); });

/* ---------- 状态 ---------- */
let state = null;
let activeChatId = null;
let chatMessages = [];
let busy = false;
let resSeq = 0;
let selectedModelId = null;
const relPositions = {};
const chartCache = {};

function dsById(id) { return state ? state.datasources.find(d => d.id === id) : null; }
function curDs() { return dsById(state.active_datasource) || (state.datasources && state.datasources[0]); }
function curWs() { return state.workspaces.find(w => w.id === state.active_workspace); }
function wsDatasources(wsId) { const w = state.workspaces.find(x => x.id === wsId); return w ? state.datasources.filter(d => (w.datasource_ids || []).includes(d.id)) : []; }
function isAdmin() { return currentUser && currentUser.role === 'admin'; }

/* ---------- 登录 / 权限 ---------- */
function showLogin() { $('#loginMask').style.display = 'flex'; }
function hideLogin() { $('#loginMask').style.display = 'none'; }
async function doLogin() {
  const username = $('#loginUsername').value.trim();
  const password = $('#loginPassword').value;
  if (!username || !password) { toast('请输入用户名和密码', 'error'); return; }
  try {
    const r = await api('POST', '/login', { username, password });
    token = r.token; currentUser = r.user;
    localStorage.setItem('bondql_token', token);
    hideLogin();
    await loadApp();
  } catch (e) { toast(e.message || '登录失败', 'error'); }
}
async function doLogout() {
  await api('POST', '/logout').catch(() => {});
  token = null; currentUser = null;
  localStorage.removeItem('bondql_token');
  state = null; activeChatId = null; chatMessages = [];
  showLogin();
}
function renderUserFooter() {
  if (!currentUser) return;
  $('#userName').textContent = currentUser.name || currentUser.username;
  $('#userRole').textContent = (currentUser.role === 'admin' ? '管理员' : '普通用户') + (curWs() ? ' · ' + curWs().name : '');
  $('#userAvatar').textContent = (currentUser.name || currentUser.username || 'A').charAt(0).toUpperCase();
}
function applyPermissions() {
  const admin = isAdmin();
  const adminSections = ['数据管理', '业务上下文配置', '权限管理', '系统管理'];
  $$('.nav-section').forEach(sec => {
    const t = sec.querySelector('.nav-section-title');
    if (t && adminSections.includes(t.textContent.trim())) sec.style.display = admin ? '' : 'none';
  });
  $$('.topbar-tab').forEach(tab => {
    if (['data', 'context', 'permission', 'system'].includes(tab.dataset.tab)) tab.style.display = admin ? '' : 'none';
  });
}

/* ---------- 导航 ---------- */
const TAB_PAGE_MAP = {
  chat: 'workspace', dashboard: 'workspace', history: 'workspace',
  datasources: 'data', 'table-management': 'data', 'table-relations': 'data',
  terms: 'context', 'sql-examples': 'context', prompts: 'context',
  permissions: 'permission', workspace: 'permission',
  mcp: 'system', assistant: 'system', 'model-config': 'system', settings: 'system'
};
const TAB_FIRST = { workspace: 'chat', data: 'datasources', context: 'terms', permission: 'permissions', system: 'mcp' };

function go(page) {
  $$('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.page === page));
  const tab = TAB_PAGE_MAP[page] || 'workspace';
  $$('.topbar-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  $$('.page').forEach(p => p.classList.remove('active'));
  const target = $('#page-' + page);
  if (target) target.classList.add('active');
  renderPage(page);
}
function currentPage() { const el = document.querySelector('.page.active'); return el ? el.id.replace('page-', '') : 'chat'; }

function renderPage(page) {
  switch (page) {
    case 'chat': renderChat(); break;
    case 'dashboard': renderDashboard(); break;
    case 'history': renderHistory(); break;
    case 'datasources': renderDatasources(); break;
    case 'table-management': renderTables(); break;
    case 'table-relations': renderRelations(); break;
    case 'terms': renderTerms(); break;
    case 'sql-examples': renderExamples(); break;
    case 'prompts': renderPrompts(); break;
    case 'permissions': renderRules(); break;
    case 'workspace': renderWorkspaces(); break;
    case 'assistant': renderAssistants(); break;
    case 'model-config': renderModels(); break;
  }
}
$$('.nav-item[data-page]').forEach(item => item.addEventListener('click', () => go(item.dataset.page)));
$$('.topbar-tab').forEach(tab => tab.addEventListener('click', () => { const p = TAB_FIRST[tab.dataset.tab]; if (p) go(p); }));

/* ---------- 工作空间切换 ---------- */
function renderWorkspaceMenu() {
  if (!state) return;
  $('#wsMenu').innerHTML = state.workspaces.map(w =>
    '<div class="ws-menu-item ' + (w.id === state.active_workspace ? 'active' : '') + '" data-ws="' + w.id + '">🏢 ' + esc(w.name) + (w.id === state.active_workspace ? '<span class="ck">✓</span>' : '') + '</div>'
  ).join('');
  $('#wsMenu').querySelectorAll('.ws-menu-item').forEach(it => it.addEventListener('click', () => {
    state.active_workspace = it.dataset.ws;
    const ds = wsDatasources(state.active_workspace).find(d => d.status === 'enabled');
    if (ds) state.active_datasource = ds.id;
    api('PUT', '/settings/active_workspace', { value: state.active_workspace }).catch(() => {});
    api('PUT', '/settings/active_datasource', { value: state.active_datasource }).catch(() => {});
    syncWsLabel(); renderWorkspaceMenu(); renderChatDsSelect(); closeWsMenu();
    toast('已切换到「' + state.workspaces.find(w => w.id === state.active_workspace).name + '」', 'success');
    go(currentPage());
  }));
}
function syncWsLabel() { const w = curWs(); $('#wsSelectorLabel').textContent = w ? w.name : '演示空间'; }
function closeWsMenu() { $('#wsMenu').classList.remove('open'); }
$('#wsSelector').addEventListener('click', e => { e.stopPropagation(); $('#wsMenu').classList.toggle('open'); });
document.addEventListener('click', () => closeWsMenu());

/* ---------- 状态标签 ---------- */
function tag(s) {
  const map = {
    enabled: ['t-green', '启用'], disabled: ['t-gray', '禁用'], pending: ['t-yellow', '待审核'],
    running: ['t-green', '运行中'], ready: ['t-blue', '已配置'], default: ['t-green', '默认'], none: ['t-gray', '未配置'],
    current: ['t-green', '当前工作空间'], switchable: ['t-gray', '可切换']
  };
  const m = map[s] || ['t-gray', s];
  return '<span class="tag ' + m[0] + '">' + m[1] + '</span>';
}
function dsName(id) { const d = dsById(id); return d ? d.name : '—'; }

/* ---------- 仪表板 ---------- */
function renderDashboard() {
  $('#dashboardGrid').innerHTML = (state.dashboards || []).map(d => `
    <div class="card"><div class="card-body">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;">
        <div><div style="font-size:14px;font-weight:600;">${esc(d.name)}</div><div style="font-size:11px;color:var(--gray-500);margin-top:2px;">${d.charts}个图表 · ${esc(d.refresh)}</div></div>
        ${d.status === 'running' ? '<span class="tag t-green">运行中</span>' : '<span class="tag t-orange">待发布</span>'}
      </div>
      <div style="margin-top:14px;display:flex;gap:16px;">
        <div><div style="font-size:11px;color:var(--gray-500);">今日PV</div><div style="font-size:20px;font-weight:700;">${d.pv}</div></div>
        <div><div style="font-size:11px;color:var(--gray-500);">分享</div><div style="font-size:20px;font-weight:700;">${d.share}</div></div>
        <div style="margin-left:auto;align-self:center;"><button class="btn btn-s btn-sm" onclick="toast('正在打开「${esc(d.name)}」','success')">查看</button></div>
      </div>
    </div></div>`).join('');
}

/* ---------- 问数历史 ---------- */
async function renderHistory() {
  try { state.chats = await api('GET', '/chats'); } catch (e) { state.chats = []; }
  const list = state.chats || [];
  if (!list.length) { $('#historyList').innerHTML = '<div class="empty"><div class="ei">🕐</div>暂无问数历史，去智能问数开始第一段对话吧</div>'; return; }
  $('#historyList').innerHTML = `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>会话标题</th><th>数据源</th><th>消息数</th><th>最后活动</th><th>操作</th></tr></thead><tbody>
    ${list.map(c => `<tr>
      <td><strong>${esc(c.title)}</strong></td>
      <td>${esc(dsName(c.ds_id))}</td>
      <td>${c.msg_count}</td>
      <td>${esc(timeAgo(c.updated))}</td>
      <td><button class="btn btn-s btn-sm" onclick="restoreChat('${c.id}')">恢复</button> <button class="btn btn-s btn-sm" onclick="deleteChat('${c.id}')">删除</button></td>
    </tr>`).join('')}
  </tbody></table></div>`;
}
function timeAgo(ts) {
  if (!ts) return '—';
  const d = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (d < 60) return '刚刚'; if (d < 3600) return Math.floor(d / 60) + '分钟前';
  if (d < 86400) return Math.floor(d / 3600) + '小时前'; return Math.floor(d / 86400) + '天前';
}
async function clearHistory() {
  confirmModal('清空历史', '确定要删除所有问数历史吗？此操作不可恢复。', async () => {
    for (const c of (state.chats || [])) { await api('DELETE', '/chats/' + c.id).catch(() => {}); }
    state.chats = []; toast('历史已清空', 'success'); renderHistory();
  });
}
async function deleteChat(id) {
  confirmModal('删除会话', '确定删除该会话吗？', async () => {
    await api('DELETE', '/chats/' + id).catch(() => {});
    if (activeChatId === id) { activeChatId = null; chatMessages = []; }
    toast('已删除', 'success'); renderHistory();
  });
}
async function restoreChat(id) {
  try {
    const detail = await api('GET', '/chats/' + id);
    activeChatId = detail.id;
    chatMessages = detail.messages || [];
    go('chat');
  } catch (e) { toast('恢复会话失败', 'error'); }
}

/* ---------- 数据源 ---------- */
function renderDatasources() {
  const list = state.datasources;
  $('#datasourceGrid').innerHTML = list.length ? list.map(d => `
    <div class="card"><div class="card-body">
      <div style="display:flex;align-items:center;gap:12px;">
        <div style="width:42px;height:42px;border-radius:10px;background:${d.status === 'enabled' ? '#EFF6FF' : '#F3F4F6'};display:flex;align-items:center;justify-content:center;font-size:20px;">${d.icon || '🗄️'}</div>
        <div style="flex:1;min-width:0;"><div style="font-size:14px;font-weight:600;">${esc(d.name)}</div><div style="font-size:11px;color:var(--gray-500);">${esc(d.engine)}${d.host ? ' · ' + esc(d.host) : ''}</div></div>
        <button class="icon-btn" onclick="deleteDataSource('${d.id}')" title="删除">🗑️</button>
      </div>
      <div style="margin-top:12px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
        ${d.status === 'enabled' ? '<span class="tag t-green">智能问数已开启</span>' : '<span class="tag t-gray">未开启</span>'}
        ${d.id === 'ds-demo' ? '<span class="tag t-blue">内置演示库</span>' : ''}
        <span class="tag t-blue" style="cursor:pointer;" onclick="setActiveDs('${d.id}')">${state.active_datasource === d.id ? '当前问数数据源' : '设为问数数据源'}</span>
      </div>
      <div style="margin-top:12px;display:flex;gap:6px;">
        <button class="btn btn-s btn-sm" onclick="openDataSourceModal('${d.id}')">编辑</button>
        <button class="btn btn-s btn-sm" onclick="testConnection('${d.id}')">测试连接</button>
        <button class="btn btn-p btn-sm" onclick="toggleDataSource('${d.id}')">${d.status === 'enabled' ? '关闭问数' : '开启问数'}</button>
      </div>
    </div></div>`).join('') : '<div class="empty" style="grid-column:1/-1;"><div class="ei">🗄️</div>暂无数据源</div>';
}
async function testConnection(id) {
  const d = dsById(id);
  toast('正在测试连接「' + (d ? d.name : id) + '」…', 'success');
  try {
    const r = await api('POST', '/test-connection', { id });
    toast((r.message || '连接成功') + (r.latency_ms ? `（${r.latency_ms}ms）` : ''), 'success');
  } catch (e) { toast('连接失败：' + e.message, 'error'); }
}
async function setActiveDs(id) { state.active_datasource = id; await api('PUT', '/settings/active_datasource', { value: id }).catch(() => {}); renderDatasources(); toast('已切换问数数据源为「' + dsById(id).name + '」', 'success'); }
async function toggleDataSource(id) { const d = dsById(id); d.status = d.status === 'enabled' ? 'disabled' : 'enabled'; await api('PUT', '/datasources/' + id, d).catch(() => {}); renderDatasources(); toast(d.status === 'enabled' ? '已开启智能问数' : '已关闭智能问数', 'success'); }
async function deleteDataSource(id) {
  confirmModal('删除数据源', '确定删除该数据源吗？', async () => {
    await api('DELETE', '/datasources/' + id).catch(() => {});
    state.datasources = state.datasources.filter(d => d.id !== id);
    renderDatasources(); toast('已删除', 'success');
  });
}
function openDataSourceModal(id) {
  const d = id ? dsById(id) : { name: '', engine: 'MySQL', host: '', port: '', db: '', username: '', password: '', desc: '', status: 'enabled' };
  openModal(id ? '编辑数据源' : '新建数据源', `
    <div class="form-grid fg2">
      <div class="field"><label>数据源名称 <span class="req">*</span></label><input name="name" value="${esc(d.name)}" placeholder="例如：生产制造销售数据"></div>
      <div class="field"><label>数据库类型</label><select name="engine">${['SQLite', 'MySQL', 'PostgreSQL', 'Oracle', 'SQL Server', '达梦', 'Kingbase', 'ClickHouse', 'Apache Doris', 'Elasticsearch', 'StarRocks', 'AWS RedShift', 'Apache Hive', 'Excel/CSV'].map(e => `<option ${e === d.engine ? 'selected' : ''}>${e}</option>`).join('')}</select></div>
      <div class="field"><label>主机名</label><input name="host" value="${esc(d.host || '')}" placeholder="localhost / 10.123.22.252"></div>
      <div class="field"><label>端口</label><input name="port" value="${esc(d.port || '')}" placeholder="3306"></div>
      <div class="field"><label>数据库名</label><input name="db" value="${esc(d.db || '')}" placeholder="database"></div>
      <div class="field"><label>用户名</label><input name="username" value="${esc(d.username || '')}" placeholder="root"></div>
      <div class="field"><label>密码 ${d.password_set ? '<span class="tag t-teal" style="margin-left:4px;">已设置（留空保持不变）</span>' : ''}</label><input name="password" type="password" placeholder="••••••"></div>
      <div class="field" style="grid-column:1/-1;"><label>描述</label><textarea name="desc" placeholder="数据源用途说明">${esc(d.desc || '')}</textarea></div>
    </div>`,
    `<button class="btn btn-s" onclick="testConnectionFromForm()">测试连接</button><button class="btn btn-s" onclick="closeModal()">取消</button><button class="btn btn-p" id="saveDsBtn">${id ? '保存' : '创建'}</button>`);
  $('#saveDsBtn').onclick = async () => {
    const name = $('#modalBody [name=name]').value.trim();
    if (!name) { toast('请填写数据源名称', 'error'); return; }
    const engine = $('#modalBody [name=engine]').value;
    const iconMap = { MySQL: '🐬', PostgreSQL: '🐘', Oracle: '📊', ClickHouse: '⚡', Doris: '🪶', Elasticsearch: '🔎', 'Excel/CSV': '📄', SQLite: '🗄️' };
    const payload = { name, engine, host: $('#modalBody [name=host]').value.trim(), port: $('#modalBody [name=port]').value.trim(), db: $('#modalBody [name=db]').value.trim(), username: $('#modalBody [name=username]').value.trim(), desc: $('#modalBody [name=desc]').value, status: 'enabled', icon: iconMap[engine] || '🗄️' };
    const pw = $('#modalBody [name=password]').value;
    if (pw) payload.password = pw;
    try {
      if (id) { await api('PUT', '/datasources/' + id, payload); Object.assign(d, payload); d.password_set = d.password_set || !!pw; }
      else { const r = await api('POST', '/datasources', payload); state.datasources.unshift(Object.assign({ id: r.id }, payload)); }
      closeModal(); renderDatasources(); toast('数据源已保存', 'success');
    } catch (e) { toast('保存失败：' + e.message, 'error'); }
  };
}
function testConnectionFromForm() {
  const name = $('#modalBody [name=name]').value.trim();
  if (!name) { toast('请先填写数据源名称', 'error'); return; }
  const payload = { name, engine: $('#modalBody [name=engine]').value, host: $('#modalBody [name=host]').value.trim(), port: $('#modalBody [name=port]').value.trim(), db: $('#modalBody [name=db]').value.trim(), username: $('#modalBody [name=username]').value.trim(), password: $('#modalBody [name=password]').value };
  api('POST', '/test-connection', payload)
    .then(r => toast((r.message || '连接成功') + (r.latency_ms ? `（${r.latency_ms}ms）` : ''), 'success'))
    .catch(e => toast('连接失败：' + e.message, 'error'));
}

/* ---------- 表管理 ---------- */
function renderTables() {
  const ds = curDs();
  const dsOpts = state.datasources.map(d => `<option value="${d.id}" ${d.id === ds.id ? 'selected' : ''}>${esc(d.name)}</option>`).join('');
  const tables = state.tables.filter(t => t.ds_id === ds.id);
  $('#tableMgmtSub').textContent = `${ds.name} · 筛选、重命名数据库中的表和字段，添加业务描述`;
  $('#tableMgmtList').innerHTML = `
    <div class="toolbar"><span style="font-size:12px;color:var(--gray-500);">数据源：</span>
      <select style="border:1px solid var(--gray-300);border-radius:7px;padding:6px 10px;font-size:13px;" onchange="switchTableDs(this.value)">${dsOpts}</select>
      <button class="btn btn-s btn-sm" onclick="syncTables('${ds.id}')">🔄 同步表结构</button>
    </div>
    <table class="tbl"><thead><tr><th style="width:40px;"><input type="checkbox" onchange="toggleAllTables(this.checked)"></th><th>表名</th><th>业务名称</th><th>字段数</th><th>描述</th><th>状态</th><th>字段注解</th></tr></thead><tbody>
    ${tables.length ? tables.map(t => `<tr style="${t.enabled ? '' : 'opacity:0.5;'}">
      <td><input type="checkbox" data-tid="${t.id}" ${t.enabled ? 'checked' : ''} onchange="syncTableState()"></td>
      <td><code>${esc(t.name)}</code></td>
      <td><input class="t-inp" data-tid="${t.id}" data-f="biz" value="${esc(t.biz)}" style="border:1px solid var(--gray-300);border-radius:4px;padding:4px 8px;font-size:12px;width:130px;"></td>
      <td>${t.fields}</td>
      <td><input class="t-inp" data-tid="${t.id}" data-f="desc" value="${esc(t.desc)}" style="border:1px solid var(--gray-300);border-radius:4px;padding:4px 8px;font-size:12px;width:180px;"></td>
      <td>${t.enabled ? '<span class="tag t-green">启用</span>' : '<span class="tag t-gray">禁用</span>'}</td>
      <td><button class="btn btn-s btn-sm" onclick="openFieldsModal('${t.id}')">编辑字段</button></td>
    </tr>`).join('') : '<tr><td colspan="7" style="text-align:center;padding:24px;color:#94A3B8;">该数据源暂无已同步的表，请点击上方「🔄 同步表结构」</td></tr>'}
    </tbody></table>`;
}
function openFieldsModal(tableId) {
  const t = state.tables.find(x => x.id === tableId);
  const fields = (state.table_fields || []).filter(f => f.table_id === tableId);
  if (!t || !fields.length) { toast('该表暂无字段定义', 'error'); return; }
  openModal('字段注解 · ' + t.name, `
    <div style="font-size:12px;color:var(--gray-500);margin-bottom:10px;">为字段填写业务含义与描述，帮助大模型更准确地理解字段。</div>
    <table class="field-table"><thead><tr><th style="width:140px;">字段名</th><th style="width:90px;">类型</th><th style="width:150px;">业务含义</th><th>描述/注解</th></tr></thead><tbody>
    ${fields.map(f => `<tr>
      <td><code>${esc(f.name)}</code></td>
      <td style="color:#94A3B8;font-size:11px;">${esc(f.type)}</td>
      <td><input data-fid="${f.id}" data-f="biz" value="${esc(f.biz || '')}"></td>
      <td><input data-fid="${f.id}" data-f="desc" value="${esc(f.desc || '')}"></td>
    </tr>`).join('')}
    </tbody></table>`, `<button class="btn btn-s" onclick="closeModal()">取消</button><button class="btn btn-p" id="saveFieldsBtn">保存字段注解</button>`, 'lg');
  $('#saveFieldsBtn').onclick = async () => {
    const inputs = [...document.querySelectorAll('#modalBody input[data-fid]')];
    const updates = {};
    inputs.forEach(inp => {
      const fid = inp.dataset.fid, f = inp.dataset.f;
      (updates[fid] = updates[fid] || {})[f] = inp.value.trim();
      const field = fields.find(x => x.id === fid);
      if (field) field[f] = inp.value.trim();
    });
    await Promise.all(Object.entries(updates).map(([fid, patch]) => api('PUT', '/table_fields/' + fid, patch).catch(() => {})));
    closeModal(); toast('字段注解已保存', 'success');
  };
}
function switchTableDs(id) { state.active_datasource = id; api('PUT', '/settings/active_datasource', { value: id }).catch(() => {}); renderTables(); }
async function syncTables(dsId) {
  toast('正在同步表结构…', 'success');
  try {
    const r = await api('POST', '/datasources/' + dsId + '/sync');
    const fresh = await api('GET', '/bootstrap');
    state.datasources = fresh.datasources;
    state.tables = fresh.tables;
    state.table_fields = fresh.table_fields;
    state.workspaces = fresh.workspaces;
    toast('已同步 ' + r.count + ' 张表', 'success');
    renderPage(currentPage());
  } catch (e) { toast('同步失败：' + e.message, 'error'); }
}
function toggleAllTables(checked) { $$('#tableMgmtList input[data-tid]').forEach(cb => { cb.checked = checked; }); syncTableState(); }
function syncTableState() {
  $$('#tableMgmtList input[data-tid]').forEach(cb => { const t = state.tables.find(x => x.id === cb.dataset.tid); if (t) t.enabled = cb.checked; });
  renderTables();
}
async function saveTables() {
  $$('#tableMgmtList .t-inp').forEach(inp => { const t = state.tables.find(x => x.id === inp.dataset.tid); if (t) t[inp.dataset.f] = inp.value.trim(); });
  await Promise.all(state.tables.map(t => api('PUT', '/tables/' + t.id, t).catch(() => {})));
  toast('表配置已保存', 'success');
}

/* ---------- 表关联关系（拖拽画布 · 保存式） ---------- */
let relDs = null;
let relDraft = [];   // 草稿关联 [{lt,lf,rt,rf,type}]
let relTables = [];  // 画布上的表名
let relConn = null;  // 正在连线的源字段 {table, field}

function relEnabledTables(dsId) { return state.tables.filter(t => t.ds_id === dsId && t.enabled); }

function initRelState(ds) {
  relDs = ds.id;
  const rels = state.relations.filter(r => r.ds_id === ds.id);
  relDraft = rels.map(r => ({ lt: r.lt, lf: r.lf, rt: r.rt, rf: r.rf, type: r.type }));
  const names = new Set();
  rels.forEach(r => { names.add(r.lt); names.add(r.rt); });
  relTables = [...names];
  if (!relTables.length) relTables = relEnabledTables(ds.id).slice(0, 3).map(t => t.name);
}

function renderRelations() {
  const ds = curDs();
  if (relDs !== ds.id) initRelState(ds);
  const allTables = relEnabledTables(ds.id);
  const dsOpts = state.datasources.map(d => `<option value="${d.id}" ${d.id === ds.id ? 'selected' : ''}>${esc(d.name)}</option>`).join('');
  const pool = allTables.filter(t => !relTables.includes(t.name));

  const canvas = $('#relationCanvas');
  canvas.className = 'model-canvas';
  canvas.innerHTML = `
    <div class="rel-toolbar" style="grid-column:1/-1;width:100%;">
      <span>数据源：</span><select onchange="switchRelDs(this.value)">${dsOpts}</select>
    </div>
    <div class="rel-picker" style="grid-column:1/-1;width:100%;" ondrop="event.preventDefault()" ondragover="event.preventDefault()">
      <span class="rel-picker-title">表格库（拖到下方画布）：</span>
      ${allTables.length === 0 ? '<span style="color:#94A3B8;font-size:12px;">该数据源暂无已同步的表，请先在「表管理」同步表结构</span>' : (pool.map(t => `<span class="rel-picker-chip" draggable="true" ondragstart="onPickerDrag(event,'${esc(t.name)}')" onclick="addRelTable('${esc(t.name)}')">📋 ${esc(t.biz || t.name)}<small>${esc(t.name)}</small></span>`).join('') || '<span style="color:#94A3B8;font-size:12px;">所有表已加入画布</span>')}
    </div>
    <div class="rel-canvas" id="relInner" style="position:relative;min-height:440px;border:1px dashed #D1D5DB;border-radius:12px;background:#F8FAFC;overflow:hidden;width:100%;" ondrop="onCanvasDrop(event)" ondragover="event.preventDefault()">
      <div class="rel-hint">💡 拖动表卡片调整位置 · 点击一个字段，再点另一表字段连线 · 点表头 ✕ 移出画布</div>
      <svg class="rel-svg" id="relSvg"></svg>
    </div>
    <div class="rel-actions" style="grid-column:1/-1;width:100%;">
      <button class="btn btn-s" onclick="resetRelations()">重置</button>
      <button class="btn btn-p" onclick="saveRelations()">💾 保存关联</button>
    </div>`;

  const inner = $('#relInner');
  const fields = state.table_fields || [];
  const cols = Math.min(3, Math.max(1, relTables.length));
  relTables.forEach((name, i) => {
    const t = allTables.find(x => x.name === name) || state.tables.find(x => x.name === name);
    if (!t) return;
    if (!relPositions[name]) relPositions[name] = { x: 30 + (i % cols) * 250, y: 40 + Math.floor(i / cols) * 280 };
    const pos = relPositions[name];
    const node = document.createElement('div');
    node.className = 'rel-node';
    node.style.left = pos.x + 'px';
    node.style.top = pos.y + 'px';
    const tf = fields.filter(f => f.table_id === t.id);
    node.innerHTML = `<div class="rel-node-hd">📋 ${esc(t.biz || t.name)}<small>${esc(t.name)}</small><button style="margin-left:auto;border:none;background:none;cursor:pointer;color:#94A3B8;font-size:14px;" onclick="removeRelTable('${esc(t.name)}')" title="移出画布">✕</button></div>` +
      tf.map(f => `<div class="rel-field" data-table="${esc(t.name)}" data-field="${esc(f.name)}" title="${esc(f.desc || '')}"><span>${esc(f.name)} <small style="color:#94A3B8;">${esc(f.biz || '')}</small></span><span class="dot"></span></div>`).join('');
    node.addEventListener('mousedown', e => onNodeDown(e, node, t.name));
    node.querySelectorAll('.rel-field').forEach(f => f.addEventListener('click', e => onFieldClick(e, f)));
    inner.appendChild(node);
  });
  drawRelLines(relDraft);

  $('#relationTable').innerHTML = `<thead><tr><th>左表</th><th>左字段</th><th>右表</th><th>右字段</th><th>关联类型</th><th>操作</th></tr></thead><tbody>
    ${relDraft.map((r, i) => `<tr><td>${esc(r.lt)}</td><td>${esc(r.lf)}</td><td>${esc(r.rt)}</td><td>${esc(r.rf)}</td><td><span class="tag ${r.type === '自关联' ? 't-purple' : 't-blue'}">${esc(r.type)}</span></td><td><button class="btn btn-s btn-sm" onclick="removeRelDraft(${i})">删除</button></td></tr>`).join('') || '<tr><td colspan="6" style="text-align:center;color:#94A3B8;">暂无草稿关联</td></tr>'}
  </tbody>`;
}

function switchRelDs(id) { state.active_datasource = id; relDs = null; api('PUT', '/settings/active_datasource', { value: id }).catch(() => {}); renderRelations(); }
function onPickerDrag(e, name) { e.dataTransfer.setData('text/plain', name); }
function onCanvasDrop(e) {
  e.preventDefault();
  const name = e.dataTransfer.getData('text/plain');
  if (name && !relTables.includes(name)) { relTables.push(name); renderRelations(); toast('已加入「' + name + '」', 'success'); }
}
function removeRelTable(name) {
  relTables = relTables.filter(n => n !== name);
  relDraft = relDraft.filter(r => r.lt !== name && r.rt !== name);
  renderRelations();
}
function addRelTable(name) { if (!relTables.includes(name)) { relTables.push(name); renderRelations(); } }
function removeRelDraft(i) { relDraft.splice(i, 1); renderRelations(); }
function resetRelations() { initRelState(curDs()); renderRelations(); toast('已重置为已保存状态', 'success'); }
async function saveRelations() {
  const ds = curDs();
  try {
    const r = await api('POST', '/relations/save', { ds_id: ds.id, relations: relDraft });
    state.relations = state.relations.filter(x => x.ds_id !== ds.id).concat(relDraft.map((x, i) => ({ id: 'saved-' + i, ds_id: ds.id, ...x })));
    toast('已保存 ' + (r.count != null ? r.count : relDraft.length) + ' 条关联', 'success');
    renderRelations();
  } catch (e) { toast('保存失败：' + e.message, 'error'); }
}

function relDotCenter(fieldEl) {
  const dot = fieldEl.querySelector('.dot');
  const inner = $('#relInner');
  const cr = inner.getBoundingClientRect();
  const dr = dot.getBoundingClientRect();
  return { x: dr.left + dr.width / 2 - cr.left, y: dr.top + dr.height / 2 - cr.top };
}

function drawRelLines(rels) {
  const svg = $('#relSvg');
  if (!svg) return;
  let paths = '';
  rels.forEach(r => {
    const lfEl = document.querySelector(`.rel-field[data-table="${r.lt}"][data-field="${r.lf}"]`);
    const rfEl = document.querySelector(`.rel-field[data-table="${r.rt}"][data-field="${r.rf}"]`);
    if (lfEl && rfEl) {
      const a = relDotCenter(lfEl), b = relDotCenter(rfEl);
      const mx = (a.x + b.x) / 2;
      paths += `<path d="M${a.x},${a.y} C${mx},${a.y} ${mx},${b.y} ${b.x},${b.y}" fill="none" stroke="#2563EB" stroke-width="2" opacity="0.85"/>`;
    }
  });
  svg.innerHTML = paths;
}

function onNodeDown(e, node, tableName) {
  if (e.target.closest('.rel-field')) return;
  e.preventDefault();
  const startX = e.clientX, startY = e.clientY;
  const origX = parseFloat(node.style.left) || 0, origY = parseFloat(node.style.top) || 0;
  const move = ev => {
    const dx = ev.clientX - startX, dy = ev.clientY - startY;
    node.style.left = (origX + dx) + 'px';
    node.style.top = (origY + dy) + 'px';
    relPositions[tableName] = { x: origX + dx, y: origY + dy };
    drawRelLines(relDraft);
  };
  const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
}

function onFieldClick(e, fieldEl) {
  e.stopPropagation();
  const table = fieldEl.dataset.table, field = fieldEl.dataset.field;
  if (!relConn) {
    relConn = { table, field };
    $$('.rel-field').forEach(f => f.classList.remove('sel'));
    fieldEl.classList.add('sel');
    toast(`已选择 ${table}.${field}，请点击目标字段`, 'success');
  } else {
    const src = relConn;
    relConn = null;
    $$('.rel-field').forEach(f => f.classList.remove('sel'));
    if (src.table === table && src.field === field) { toast('已取消选择', 'success'); return; }
    const type = (src.table === table) ? '自关联' : '1:N';
    const dup = relDraft.some(r => r.lt === src.table && r.lf === src.field && r.rt === table && r.rf === field);
    if (dup) { toast('该关联已存在', 'error'); return; }
    relDraft.push({ lt: src.table, lf: src.field, rt: table, rf: field, type });
    toast(`已添加草稿关联 ${src.table}.${src.field} → ${table}.${field}，点击「保存关联」生效`, 'success');
    renderRelations();
  }
}

/* ---------- 术语配置 ---------- */
function renderTerms(filter) {
  const kw = (filter || '').toLowerCase();
  const list = state.terms.filter(t => !kw || (t.term + t.syn + t.logic).toLowerCase().includes(kw));
  $('#termsList').innerHTML = list.length ? `<table class="tbl"><thead><tr><th>术语</th><th>同义词</th><th>描述/计算逻辑</th><th>数据源</th><th>状态</th><th>操作</th></tr></thead><tbody>
    ${list.map(t => `<tr>
      <td><strong>${esc(t.term)}</strong></td>
      <td>${esc(t.syn)}</td>
      <td style="color:var(--gray-600);">${esc(t.logic)}</td>
      <td>${esc(dsName(t.ds_id))}</td>
      <td>${tag(t.status)}</td>
      <td><button class="btn btn-s btn-sm" onclick="openTermModal('${t.id}')">编辑</button> <button class="btn btn-s btn-sm" onclick="deleteTerm('${t.id}')">删除</button></td>
    </tr>`).join('')}</tbody></table>` : '<div class="empty"><div class="ei">📖</div>暂无匹配的术语</div>';
}
async function deleteTerm(id) {
  confirmModal('删除术语', '确定删除该术语吗？', async () => {
    await api('DELETE', '/terms/' + id).catch(() => {});
    state.terms = state.terms.filter(t => t.id !== id);
    renderTerms(); toast('已删除', 'success');
  });
}
function openTermModal(id) {
  const t = id ? state.terms.find(x => x.id === id) : { term: '', syn: '', logic: '', status: 'enabled', ds_id: state.active_datasource };
  const dsOpts = state.datasources.map(d => `<option value="${d.id}" ${d.id === t.ds_id ? 'selected' : ''}>${esc(d.name)}</option>`).join('');
  openModal(id ? '编辑术语' : '新增术语', `
    <div class="form-grid">
      <div class="field"><label>术语 <span class="req">*</span></label><input name="term" value="${esc(t.term)}" placeholder="例如：华南大区"></div>
      <div class="field"><label>同义词</label><input name="syn" value="${esc(t.syn)}" placeholder="多个用顿号分隔"></div>
      <div class="field" style="grid-column:1/-1;"><label>描述 / 计算逻辑</label><textarea name="logic">${esc(t.logic)}</textarea></div>
      <div class="field"><label>数据源</label><select name="ds_id">${dsOpts}</select></div>
      <div class="field"><label>状态</label><select name="status"><option value="enabled" ${t.status === 'enabled' ? 'selected' : ''}>启用</option><option value="pending" ${t.status === 'pending' ? 'selected' : ''}>待审核</option></select></div>
    </div>`, `<button class="btn btn-s" onclick="closeModal()">取消</button><button class="btn btn-p" id="saveTermBtn">保存</button>`);
  $('#saveTermBtn').onclick = async () => {
    const term = $('#modalBody [name=term]').value.trim();
    if (!term) { toast('请填写术语名称', 'error'); return; }
    const payload = { term, syn: $('#modalBody [name=syn]').value.trim(), logic: $('#modalBody [name=logic]').value.trim(), ds_id: $('#modalBody [name=ds_id]').value, status: $('#modalBody [name=status]').value };
    try {
      if (id) { await api('PUT', '/terms/' + id, payload); Object.assign(t, payload); }
      else { const r = await api('POST', '/terms', payload); state.terms.unshift(Object.assign({ id: r.id }, payload)); }
      closeModal(); renderTerms(); toast('术语已保存', 'success');
    } catch (e) { toast('保存失败：' + e.message, 'error'); }
  };
}

/* ---------- SQL示例库 ---------- */
function renderExamples() {
  $('#examplesList').innerHTML = `<table class="tbl"><thead><tr><th>问题描述</th><th>关联数据源</th><th>使用次数</th><th>状态</th><th>操作</th></tr></thead><tbody>
    ${state.examples.map(e => `<tr>
      <td><strong>${esc(e.q)}</strong></td>
      <td>${esc(dsName(e.ds_id))}</td>
      <td>${e.use_count}</td>
      <td>${tag(e.status)}</td>
      <td><button class="btn btn-s btn-sm" onclick="viewExample('${e.id}')">查看</button> <button class="btn btn-s btn-sm" onclick="openExampleModal('${e.id}')">编辑</button> <button class="btn btn-s btn-sm" onclick="deleteExample('${e.id}')">删除</button></td>
    </tr>`).join('')}</tbody></table>`;
}
function viewExample(id) {
  const e = state.examples.find(x => x.id === id);
  if (e) openModal(e.q, '<div style="font-size:12px;color:var(--gray-500);margin-bottom:8px;">标准答案 SQL</div><div class="code">' + highlightSQL(e.sql) + '</div>',
    '<button class="btn btn-s" onclick="closeModal()">关闭</button><button class="btn btn-p" onclick="runExample(\'' + id + '\')">在问数中执行</button>', 'lg');
}
async function deleteExample(id) {
  confirmModal('删除示例', '确定删除该SQL示例吗？', async () => {
    await api('DELETE', '/examples/' + id).catch(() => {});
    state.examples = state.examples.filter(e => e.id !== id);
    renderExamples(); toast('已删除', 'success');
  });
}
function openExampleModal(id) {
  const e = id ? state.examples.find(x => x.id === id) : { q: '', sql: '', status: 'enabled', ds_id: state.active_datasource };
  const dsOpts = state.datasources.map(d => `<option value="${d.id}" ${d.id === e.ds_id ? 'selected' : ''}>${esc(d.name)}</option>`).join('');
  openModal(id ? '编辑SQL示例' : '新增SQL示例', `
    <div class="form-grid">
      <div class="field" style="grid-column:1/-1;"><label>问题描述 <span class="req">*</span></label><input name="q" value="${esc(e.q)}"></div>
      <div class="field" style="grid-column:1/-1;"><label>标准答案 SQL</label><textarea name="sql" style="font-family:monospace;min-height:150px;">${esc(e.sql)}</textarea></div>
      <div class="field"><label>数据源</label><select name="ds_id">${dsOpts}</select></div>
      <div class="field"><label>状态</label><select name="status"><option value="enabled" ${e.status === 'enabled' ? 'selected' : ''}>启用</option><option value="pending" ${e.status === 'pending' ? 'selected' : ''}>待审核</option></select></div>
    </div>`, `<button class="btn btn-s" onclick="closeModal()">取消</button><button class="btn btn-p" id="saveExBtn">保存</button>`, 'lg');
  $('#saveExBtn').onclick = async () => {
    const q = $('#modalBody [name=q]').value.trim();
    if (!q) { toast('请填写问题描述', 'error'); return; }
    const payload = { q, sql: $('#modalBody [name=sql]').value, ds_id: $('#modalBody [name=ds_id]').value, status: $('#modalBody [name=status]').value, use_count: e.use_count || 0 };
    try {
      if (id) { await api('PUT', '/examples/' + id, payload); Object.assign(e, payload); }
      else { const r = await api('POST', '/examples', payload); state.examples.unshift(Object.assign({ id: r.id }, payload)); }
      closeModal(); renderExamples(); toast('SQL示例已保存', 'success');
    } catch (err) { toast('保存失败：' + err.message, 'error'); }
  };
}

/* ---------- 自定义提示词 ---------- */
function renderPrompts() {
  $('#promptsList').innerHTML = state.prompts.map(p => `
    <div style="background:var(--gray-50);border-radius:8px;padding:16px;margin-bottom:12px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
        <div style="font-size:12px;font-weight:600;color:var(--gray-600);">${esc(p.scope)} ${p.ds_id ? `<span class="tag t-blue" style="margin-left:6px;">${esc(dsName(p.ds_id))}</span>` : '<span class="tag t-gray" style="margin-left:6px;">全局</span>'}</div>
        <div style="display:flex;gap:6px;"><button class="btn btn-s btn-sm" onclick="openPromptModal('${p.id}')">编辑</button><button class="btn btn-s btn-sm" onclick="deletePrompt('${p.id}')">删除</button></div>
      </div>
      <div class="code" style="font-size:12px;">${esc(p.content)}</div>
    </div>`).join('') || '<div class="empty">暂无提示词</div>';
}
async function deletePrompt(id) {
  confirmModal('删除提示词', '确定删除该提示词吗？', async () => {
    await api('DELETE', '/prompts/' + id).catch(() => {});
    state.prompts = state.prompts.filter(p => p.id !== id);
    renderPrompts(); toast('已删除', 'success');
  });
}
function openPromptModal(id) {
  const p = id ? state.prompts.find(x => x.id === id) : { scope: '全局提示词（适用于所有数据源）', ds_id: '', content: '' };
  const dsOpts = '<option value="">全局（适用于所有数据源）</option>' + state.datasources.map(d => `<option value="${d.id}" ${d.id === p.ds_id ? 'selected' : ''}>${esc(d.name)}</option>`).join('');
  openModal(id ? '编辑提示词' : '新建提示词', `
    <div class="form-grid">
      <div class="field"><label>关联数据源</label><select name="ds_id">${dsOpts}</select></div>
      <div class="field" style="grid-column:1/-1;"><label>提示词内容</label><textarea name="content" style="font-family:monospace;min-height:160px;">${esc(p.content)}</textarea></div>
    </div>`, `<button class="btn btn-s" onclick="closeModal()">取消</button><button class="btn btn-p" id="savePromptBtn">保存</button>`, 'lg');
  $('#savePromptBtn').onclick = async () => {
    const ds_id = $('#modalBody [name=ds_id]').value;
    const scope = ds_id ? dsName(ds_id) + ' 数据源专属提示词' : '全局提示词（适用于所有数据源）';
    const payload = { scope, ds_id, content: $('#modalBody [name=content]').value };
    try {
      if (id) { await api('PUT', '/prompts/' + id, payload); Object.assign(p, payload); }
      else { const r = await api('POST', '/prompts', payload); state.prompts.push(Object.assign({ id: r.id }, payload)); }
      closeModal(); renderPrompts(); toast('提示词已保存', 'success');
    } catch (e) { toast('保存失败：' + e.message, 'error'); }
  };
}

/* ---------- 权限配置（结构化：数据源/表/列） ---------- */
function ruleDesc(it) {
  if (it.kind === 'col') {
    return `${dsName(it.ds_id)} · ${it.table || '—'} · 隐藏列：${(it.columns || []).join('、') || '—'}`;
  }
  return `${dsName(it.ds_id)} · ${it.table || '—'} · 筛选条件：${it.filter || '—'}`;
}
function renderRules() {
  $('#permissionsList').innerHTML = state.rules.map(r => `
    <div class="rule-group">
      <div class="rule-group-header">
        <div class="rule-group-name">${esc(r.name)}</div>
        <div style="display:flex;gap:6px;"><span class="tag t-blue">${r.items.length}个规则</span><button class="btn btn-s btn-sm" onclick="openRuleModal('${r.id}')">编辑</button><button class="btn btn-s btn-sm" onclick="deleteRule('${r.id}')">删除</button></div>
      </div>
      ${r.items.map(it => `<div class="rule-item"><span class="tag ${it.kind === 'col' ? 't-orange' : 't-blue'}">${it.kind === 'col' ? '列权限' : '行权限'}</span><span>${esc(ruleDesc(it))}</span></div>`).join('')}
    </div>`).join('') || '<div class="empty">暂无规则组</div>';
}
async function deleteRule(id) {
  confirmModal('删除规则组', '确定删除该规则组吗？', async () => {
    await api('DELETE', '/rules/' + id).catch(() => {});
    state.rules = state.rules.filter(r => r.id !== id);
    renderRules(); toast('已删除', 'success');
  });
}

let ruleDraft = [];
function openRuleModal(id) {
  const r = id ? state.rules.find(x => x.id === id) : { name: '', items: [] };
  ruleDraft = (r.items || []).map(it => ({
    kind: it.kind || 'row',
    ds_id: it.ds_id || (state.datasources[0] ? state.datasources[0].id : ''),
    table: it.table || '',
    filter: it.filter || '',
    columns: it.columns ? [...it.columns] : []
  }));
  openModal(id ? '编辑规则组' : '添加规则组', `
    <div class="form-grid">
      <div class="field"><label>规则组名称 <span class="req">*</span></label><input id="ruleName" value="${esc(r.name)}" placeholder="例如：华东区域"></div>
      <div class="field" style="grid-column:1/-1;"><label>权限规则（选择数据源 → 表 → 列/筛选条件）</label>
        <div id="ruleRows"></div>
        <button class="btn btn-s btn-sm" style="margin-top:8px;" onclick="addRuleRow()">＋ 添加规则</button>
      </div>
    </div>`, `<button class="btn btn-s" onclick="closeModal()">取消</button><button class="btn btn-p" id="saveRuleBtn">保存</button>`, 'lg');
  renderRuleRows();
  $('#saveRuleBtn').onclick = async () => {
    const name = $('#ruleName').value.trim();
    if (!name) { toast('请填写规则组名称', 'error'); return; }
    const items = ruleDraft.filter(x => x.ds_id && x.table).map(x => ({ kind: x.kind, ds_id: x.ds_id, table: x.table, filter: x.kind === 'row' ? x.filter : '', columns: x.kind === 'col' ? (x.columns || []) : [] }));
    if (!items.length) { toast('请至少添加一条规则', 'error'); return; }
    try {
      if (id) { await api('PUT', '/rules/' + id, { name, items }); Object.assign(r, { name, items }); }
      else { const resp = await api('POST', '/rules', { name, items }); state.rules.push({ id: resp.id, name, items }); }
      closeModal(); renderRules(); toast('规则组已保存', 'success');
    } catch (e) { toast('保存失败：' + e.message, 'error'); }
  };
}
function addRuleRow() {
  ruleDraft.push({ kind: 'row', ds_id: state.datasources[0] ? state.datasources[0].id : '', table: '', filter: '', columns: [] });
  renderRuleRows();
}
function removeRuleRow(i) { ruleDraft.splice(i, 1); renderRuleRows(); }
function setRuleField(i, field, value) {
  if (!ruleDraft[i]) return;
  ruleDraft[i][field] = value;
  if (field === 'ds_id') ruleDraft[i].table = '';
  renderRuleRows();
}
function toggleRuleCol(i, col) {
  const it = ruleDraft[i]; if (!it) return;
  it.columns = it.columns || [];
  const idx = it.columns.indexOf(col);
  if (idx >= 0) it.columns.splice(idx, 1); else it.columns.push(col);
}
function renderRuleRows() {
  const container = $('#ruleRows');
  if (!container) return;
  container.innerHTML = ruleDraft.map((it, i) => {
    const dsOpts = state.datasources.map(d => `<option value="${d.id}" ${d.id === it.ds_id ? 'selected' : ''}>${esc(d.name)}</option>`).join('');
    const tables = state.tables.filter(t => t.ds_id === it.ds_id);
    const tableOpts = tables.map(t => `<option value="${esc(t.name)}" ${t.name === it.table ? 'selected' : ''}>${esc(t.name)}</option>`).join('') || '<option value="">（无表）</option>';
    const tbl = tables.find(t => t.name === it.table);
    const cols = (state.table_fields || []).filter(f => f.table_id === (tbl || {}).id);
    const colChecks = cols.map(f => `<label style="display:inline-flex;align-items:center;gap:4px;margin-right:10px;font-size:12px;"><input type="checkbox" ${(it.columns || []).includes(f.name) ? 'checked' : ''} onchange="toggleRuleCol(${i}, '${esc(f.name)}')"> ${esc(f.name)}</label>`).join('');
    return `<div style="border:1px solid #E2E8F0;border-radius:8px;padding:10px;margin-bottom:8px;background:#F8FAFC;">
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap;">
        <select onchange="setRuleField(${i},'kind',this.value)" style="border:1px solid #E2E8F0;border-radius:6px;padding:5px 8px;font-size:12px;">
          <option value="row" ${it.kind === 'row' ? 'selected' : ''}>行权限</option>
          <option value="col" ${it.kind === 'col' ? 'selected' : ''}>列权限</option>
        </select>
        <select onchange="setRuleField(${i},'ds_id',this.value)" style="border:1px solid #E2E8F0;border-radius:6px;padding:5px 8px;font-size:12px;">${dsOpts}</select>
        <select onchange="setRuleField(${i},'table',this.value)" style="border:1px solid #E2E8F0;border-radius:6px;padding:5px 8px;font-size:12px;">${tableOpts}</select>
        <button class="btn btn-s btn-sm" onclick="removeRuleRow(${i})">删除</button>
      </div>
      ${it.kind === 'row'
        ? `<input placeholder="筛选条件，如：region = '华东'" value="${esc(it.filter)}" oninput="setRuleField(${i},'filter',this.value)" style="width:100%;border:1px solid #E2E8F0;border-radius:6px;padding:6px 10px;font-size:12px;box-sizing:border-box;">`
        : `<div style="font-size:12px;color:#374151;">隐藏列：${colChecks || '<span style="color:#94A3B8;">该表暂无字段</span>'}</div>`}
    </div>`;
  }).join('') || '<div style="color:#94A3B8;font-size:12px;padding:8px 0;">暂无规则，点击下方「添加规则」</div>';
}

/* ---------- 工作空间 ---------- */
function renderWorkspaces() {
  $('#workspaceGrid').innerHTML = state.workspaces.map(w => {
    const dsList = state.datasources.filter(d => (w.datasource_ids || []).includes(d.id));
    const tblList = state.tables.filter(t => (w.table_ids || []).includes(t.id));
    return `<div class="card"><div class="card-body">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;">
        <div><div style="font-size:14px;font-weight:600;">${esc(w.name)}</div><div style="font-size:11px;color:var(--gray-500);margin-top:2px;">${dsList.length}个数据源 · ${tblList.length}张表 · ${w.members}个成员</div></div>
        ${w.id === state.active_workspace ? '<span class="tag t-green">当前工作空间</span>' : '<span class="tag t-gray">可切换</span>'}
      </div>
      <div style="margin-top:12px;display:flex;gap:6px;flex-wrap:wrap;">${dsList.map(d => `<span class="tag t-blue">${esc(d.name)}</span>`).join('')}</div>
      <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;">${tblList.map(t => `<span class="tag t-gray">${esc(t.name)}</span>`).join('')}</div>
      <div style="margin-top:12px;display:flex;gap:6px;">
        ${w.id !== state.active_workspace ? `<button class="btn btn-p btn-sm" onclick="switchWorkspace('${w.id}')">切换到此空间</button>` : ''}
        <button class="btn btn-s btn-sm" onclick="openWorkspaceModal('${w.id}')">编辑</button>
        ${w.id !== state.active_workspace ? `<button class="btn btn-s btn-sm" onclick="deleteWorkspace('${w.id}')">删除</button>` : ''}
      </div>
    </div></div>`;
  }).join('');
}
async function switchWorkspace(id) {
  state.active_workspace = id;
  const ds = wsDatasources(id).find(d => d.status === 'enabled');
  if (ds) state.active_datasource = ds.id;
  await api('PUT', '/settings/active_workspace', { value: id }).catch(() => {});
  await api('PUT', '/settings/active_datasource', { value: state.active_datasource }).catch(() => {});
  syncWsLabel(); renderWorkspaceMenu(); renderChatDsSelect(); renderWorkspaces(); toast('已切换工作空间', 'success');
}
async function deleteWorkspace(id) {
  confirmModal('删除工作空间', '确定删除该工作空间吗？', async () => {
    await api('DELETE', '/workspaces/' + id).catch(() => {});
    state.workspaces = state.workspaces.filter(w => w.id !== id);
    renderWorkspaces(); toast('已删除', 'success');
  });
}
let wsModal = { id: null, tableIds: [] };
function openWorkspaceModal(id) {
  const w = id ? state.workspaces.find(x => x.id === id) : { name: '', desc: '', members: 1, sessions: 0, datasource_ids: [], table_ids: [] };
  wsModal = { id, tableIds: [...(w.table_ids || [])] };
  const dsCheck = state.datasources.map(d => `<label class="ds-check-item"><input type="checkbox" name="wsds" value="${d.id}" ${(w.datasource_ids || []).includes(d.id) ? 'checked' : ''} onchange="renderWsTablePicker()"><span>${esc(d.name)}</span><span style="color:#94A3B8;font-size:11px;margin-left:auto;">${esc(d.engine)}</span></label>`).join('');
  openModal(id ? '编辑工作空间' : '新建工作空间', `
    <div class="form-grid">
      <div class="field"><label>空间名称 <span class="req">*</span></label><input name="name" value="${esc(w.name)}"></div>
      <div class="field"><label>成员数</label><input name="members" type="number" value="${w.members || 1}"></div>
      <div class="field" style="grid-column:1/-1;"><label>描述</label><textarea name="desc">${esc(w.desc || '')}</textarea></div>
      <div class="field" style="grid-column:1/-1;"><label>数据源（勾选归属该空间的数据源）</label><div class="ds-check-list">${dsCheck || '<div style="color:#94A3B8;font-size:12px;">暂无数据源</div>'}</div></div>
      <div class="field" style="grid-column:1/-1;"><label>数据表（选择该数据源下的表）</label><div class="ds-check-list" id="wsTableList"></div></div>
    </div>`, `<button class="btn btn-s" onclick="closeModal()">取消</button><button class="btn btn-p" id="saveWsBtn">保存</button>`, 'lg');
  renderWsTablePicker();
  $('#saveWsBtn').onclick = async () => {
    const name = $('#modalBody [name=name]').value.trim();
    if (!name) { toast('请填写空间名称', 'error'); return; }
    const payload = { name, desc: $('#modalBody [name=desc]').value, members: +$('#modalBody [name=members]').value, sessions: w.sessions || 0 };
    const dsIds = wsSelectedDs();
    const tableIds = [...document.querySelectorAll('#modalBody input[name=wstbl]:checked')].map(i => i.value);
    try {
      let wid;
      if (id) { await api('PUT', '/workspaces/' + id, payload); Object.assign(w, payload); wid = id; }
      else { const r = await api('POST', '/workspaces', payload); state.workspaces.push(Object.assign({ id: r.id }, payload)); wid = r.id; }
      await api('POST', '/workspace-bindings', { ws_id: wid, datasource_ids: dsIds, table_ids: tableIds }).catch(() => {});
      w.datasource_ids = dsIds; w.table_ids = tableIds;
      closeModal(); renderWorkspaces(); renderWorkspaceMenu(); toast('工作空间已保存', 'success');
    } catch (e) { toast('保存失败：' + e.message, 'error'); }
  };
}
function wsSelectedDs() { return [...document.querySelectorAll('#modalBody input[name=wsds]:checked')].map(i => i.value); }
function renderWsTablePicker() {
  const tableList = $('#wsTableList');
  if (!tableList) return;
  const dsIds = wsSelectedDs();
  const tables = state.tables.filter(t => dsIds.includes(t.ds_id));
  tableList.innerHTML = tables.map(t => `<label class="ds-check-item"><input type="checkbox" name="wstbl" value="${t.id}" ${wsModal.tableIds.includes(t.id) ? 'checked' : ''} onchange="wsTableChecked()"><span>${esc(t.name)}</span><span style="color:#94A3B8;font-size:11px;margin-left:auto;">${esc(t.biz || '')}</span></label>`).join('') || '<div style="color:#94A3B8;font-size:12px;">该数据源下暂无表</div>';
}
function wsTableChecked() { wsModal.tableIds = [...document.querySelectorAll('#modalBody input[name=wstbl]:checked')].map(i => i.value); }

/* ---------- 小助手应用 ---------- */
function renderAssistants() {
  $('#assistantGrid').innerHTML = state.assistants.map(a => `
    <div class="card"><div class="card-body">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;">
        <div><div style="font-size:14px;font-weight:600;">${esc(a.name)}</div><div style="font-size:11px;color:var(--gray-500);margin-top:2px;">${esc(a.desc)}</div></div>
        ${a.enabled ? '<span class="tag t-green">已启用</span>' : '<span class="tag t-gray">已停用</span>'}
      </div>
      <div style="margin-top:10px;font-size:12px;color:var(--gray-600);">适用场景：${esc(a.scenario)}</div>
      <div style="margin-top:12px;display:flex;gap:6px;">
        <button class="btn btn-s btn-sm" onclick="toast('嵌入代码已复制到剪贴板','success')">获取嵌入代码</button>
        <button class="btn btn-s btn-sm" onclick="openAssistantModal('${a.id}')">配置</button>
        <button class="btn btn-s btn-sm" onclick="toggleAssistant('${a.id}')">${a.enabled ? '停用' : '启用'}</button>
      </div>
    </div></div>`).join('') || '<div class="empty" style="grid-column:1/-1;">暂无应用</div>';
}
async function toggleAssistant(id) { const a = state.assistants.find(x => x.id === id); a.enabled = !a.enabled; await api('PUT', '/assistants/' + id, a).catch(() => {}); renderAssistants(); toast(a.enabled ? '应用已启用' : '应用已停用', 'success'); }
function openAssistantModal(id) {
  const a = id ? state.assistants.find(x => x.id === id) : { name: '', desc: '', scenario: '', enabled: true };
  openModal(id ? '配置小助手应用' : '新建小助手应用', `
    <div class="form-grid">
      <div class="field"><label>应用名称 <span class="req">*</span></label><input name="name" value="${esc(a.name)}"></div>
      <div class="field"><label>应用类型</label><select name="type"><option>基础应用（免后端对接）</option><option>高级应用（需登录）</option></select></div>
      <div class="field" style="grid-column:1/-1;"><label>适用场景</label><textarea name="scenario">${esc(a.scenario)}</textarea></div>
    </div>`, `<button class="btn btn-s" onclick="closeModal()">取消</button><button class="btn btn-p" id="saveAsBtn">保存</button>`);
  $('#saveAsBtn').onclick = async () => {
    const name = $('#modalBody [name=name]').value.trim();
    if (!name) { toast('请填写应用名称', 'error'); return; }
    const payload = { name, desc: $('#modalBody [name=type]').value, scenario: $('#modalBody [name=scenario]').value, enabled: a.enabled };
    try {
      if (id) { await api('PUT', '/assistants/' + id, payload); Object.assign(a, payload); }
      else { const r = await api('POST', '/assistants', payload); state.assistants.push(Object.assign({ id: r.id }, payload)); }
      closeModal(); renderAssistants(); toast('应用已保存', 'success');
    } catch (e) { toast('保存失败：' + e.message, 'error'); }
  };
}

/* ---------- AI模型配置 ---------- */
function renderModels() {
  const banner = state.model_configured ? '' :
    '<div style="background:var(--orange-light);border:1px solid #FDBA74;border-radius:8px;padding:10px 14px;margin-bottom:14px;font-size:12px;color:#9A3412;">⚠️ 尚未配置大模型 API Key，当前使用内置规则引擎（真实 SQL 执行）。在下方「编辑」模型填入 API Key 即可启用大模型自然语言转 SQL。</div>';
  $('#modelsList').innerHTML = banner + `<table class="tbl"><thead><tr><th>模型名称</th><th>供应商</th><th>模型ID</th><th>状态</th><th>操作</th></tr></thead><tbody>
    ${state.models.map(m => `<tr>
      <td><strong>${esc(m.name)}</strong></td>
      <td>${esc(m.provider)}</td>
      <td><code>${esc(m.model_id)}</code></td>
      <td>${m.api_key_set ? '<span class="tag t-teal">Key已配置</span> ' : ''}${tag(m.status)}</td>
      <td><button class="btn btn-s btn-sm" onclick="openModelModal('${m.id}')">编辑</button>
      <button class="btn btn-s btn-sm" onclick="testModel('${m.id}')">测试</button>
      ${m.status !== 'default' ? `<button class="btn btn-p btn-sm" onclick="setDefaultModel('${m.id}')">设为默认</button>` : ''}
      <button class="btn btn-s btn-sm" onclick="deleteModel('${m.id}')">删除</button></td>
    </tr>`).join('')}</tbody></table>`;
}
async function testModel(id) {
  const m = state.models.find(x => x.id === id);
  toast('正在测试模型「' + m.name + '」…', 'success');
  try { const r = await api('POST', '/test-model', { id }); toast(r.message || '连接正常', 'success'); }
  catch (e) { toast('测试失败：' + e.message, 'error'); }
}
async function setDefaultModel(id) {
  const m = state.models.find(x => x.id === id);
  await api('PUT', '/models/' + id, { name: m.name, provider: m.provider, model_id: m.model_id, base_url: m.base_url, status: 'default' }).catch(() => {});
  state.models.forEach(x => x.status = x.id === id ? 'default' : (x.status === 'default' ? 'ready' : x.status));
  renderModels(); toast('默认模型已更新', 'success');
}
async function deleteModel(id) {
  confirmModal('删除模型', '确定删除该模型配置吗？', async () => {
    await api('DELETE', '/models/' + id).catch(() => {});
    state.models = state.models.filter(m => m.id !== id);
    renderModels(); toast('已删除', 'success');
  });
}
function openModelModal(id) {
  const m = id ? state.models.find(x => x.id === id) : { name: '', provider: 'DeepSeek', model_id: '', base_url: 'https://api.deepseek.com', status: 'ready', api_key_set: false };
  openModal(id ? '编辑模型' : '添加模型', `
    <div class="form-grid">
      <div class="field"><label>模型名称 <span class="req">*</span></label><input name="name" value="${esc(m.name)}" placeholder="例如：DeepSeek-V3"></div>
      <div class="field"><label>供应商</label><select name="provider">${['DeepSeek', 'OpenAI', 'MiniMax', '阿里云', 'Ollama', 'Anthropic', '智谱AI'].map(p => `<option ${p === m.provider ? 'selected' : ''}>${p}</option>`).join('')}</select></div>
      <div class="field"><label>模型ID</label><input name="model_id" value="${esc(m.model_id)}" placeholder="例如：deepseek-chat"></div>
      <div class="field"><label>Base URL</label><input name="base_url" value="${esc(m.base_url)}" placeholder="https://api.deepseek.com"></div>
      <div class="field" style="grid-column:1/-1;"><label>API Key ${m.api_key_set ? '<span class="tag t-teal" style="margin-left:6px;">已配置（留空则保持不变）</span>' : ''}</label><input name="api_key" type="password" placeholder="sk-..."></div>
      <div class="field" style="grid-column:1/-1;font-size:11px;color:var(--gray-400);">提示：DeepSeek 默认 Base URL 为 https://api.deepseek.com，Ollama 本地为 http://127.0.0.1:11434/v1</div>
    </div>`, `<button class="btn btn-s" onclick="closeModal()">取消</button><button class="btn btn-p" id="saveModelBtn">保存</button>`);
  $('#saveModelBtn').onclick = async () => {
    const name = $('#modalBody [name=name]').value.trim();
    if (!name) { toast('请填写模型名称', 'error'); return; }
    const apiKey = $('#modalBody [name=api_key]').value.trim();
    const payload = { name, provider: $('#modalBody [name=provider]').value, model_id: $('#modalBody [name=model_id]').value.trim(), base_url: $('#modalBody [name=base_url]').value.trim() || 'https://api.deepseek.com', status: m.status };
    if (apiKey) payload.api_key = apiKey;
    try {
      if (id) { await api('PUT', '/models/' + id, payload); Object.assign(m, payload); m.api_key_set = m.api_key_set || !!apiKey; }
      else { const r = await api('POST', '/models', payload); state.models.push({ id: r.id, ...payload, api_key_set: !!apiKey }); }
      state.model_configured = state.models.some(x => x.api_key_set);
      closeModal(); renderModels(); toast('模型保存成功', 'success');
    } catch (e) { toast('保存失败：' + e.message, 'error'); }
  };
}

/* ---------- SQL 高亮 ---------- */
function highlightSQL(sql) {
  const tokenRe = /('(?:[^']|'')*')|(--[^\n]*)|([A-Za-z_][A-Za-z0-9_]*)|(\d+(?:\.\d+)?)/g;
  const KW = /^(SELECT|FROM|WHERE|GROUP|BY|ORDER|HAVING|LIMIT|JOIN|ON|AS|AND|OR|IN|BETWEEN|UNION|DISTINCT|INTERVAL|DESC|ASC|CASE|WHEN|THEN|ELSE|END|WITH|OVER|LEFT|RIGHT|INNER|PARTITION|NOT|NULL|IS|STRFTIME|DATE)$/i;
  const FN = /^(SUM|COUNT|AVG|MAX|MIN|ROUND|COALESCE|CONCAT)$/i;
  let out = '', last = 0, m;
  while ((m = tokenRe.exec(sql)) !== null) {
    out += esc(sql.slice(last, m.index));
    const str = m[1], cm = m[2], word = m[3], num = m[4];
    if (str !== undefined) out += '<span class="str">' + esc(str) + '</span>';
    else if (cm !== undefined) out += '<span class="cm">' + esc(cm) + '</span>';
    else if (word !== undefined) {
      if (FN.test(word)) out += '<span class="fn">' + esc(word) + '</span>';
      else if (KW.test(word)) out += '<span class="kw">' + esc(word) + '</span>';
      else out += esc(word);
    } else out += '<span class="num">' + esc(num) + '</span>';
    last = m.index + m[0].length;
  }
  out += esc(sql.slice(last));
  return out;
}

/* ---------- 图表渲染（纯 SVG） ---------- */
const PALETTE = ['#2563EB', '#7C3AED', '#F97316', '#16A34A', '#0D9488', '#DC2626', '#CA8A04', '#0891B2', '#DB2777', '#4B5563'];
function axisLines(max, W, H, padL, padR, padT, padB) {
  const n = 4; let out = '';
  for (let i = 0; i <= n; i++) {
    const v = max * i / n;
    const y = H - padB - (H - padT - padB) * i / n;
    out += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="#F3F4F6" stroke-width="1"/><text x="${padL - 8}" y="${y + 3}" text-anchor="end" font-size="9" fill="#9CA3AF">${fmtNum(Math.round(v))}</text>`;
  }
  return out;
}
function barSVG(labels, values) {
  const W = 640, H = 250, padL = 56, padR = 16, padT = 26, padB = 40;
  const max = Math.max(...values) * 1.15 || 1;
  const bw = (W - padL - padR) / values.length;
  let bars = '', vals = '', labs = '';
  values.forEach((v, i) => {
    const h = (H - padT - padB) * (v / max);
    const x = padL + i * bw + bw * 0.16, y = H - padB - h, w = bw * 0.68;
    bars += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="4" fill="${PALETTE[i % PALETTE.length]}"/>`;
    vals += `<text x="${x + w / 2}" y="${y - 6}" text-anchor="middle" font-size="9" fill="#6B7280">${fmtNum(v)}</text>`;
    labs += `<text x="${x + w / 2}" y="${H - padB + 16}" text-anchor="middle" font-size="10" fill="#6B7280">${esc(labels[i])}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="240" preserveAspectRatio="xMidYMid meet">${axisLines(max, W, H, padL, padR, padT, padB)}${bars}${vals}${labs}</svg>`;
}
function lineSVG(labels, values) {
  const W = 640, H = 250, padL = 56, padR = 16, padT = 26, padB = 40;
  const max = Math.max(...values) * 1.15 || 1;
  const n = values.length;
  const px = i => padL + (W - padL - padR) * (n === 1 ? 0.5 : i / (n - 1));
  const py = v => H - padB - (H - padT - padB) * (v / max);
  const pts = values.map((v, i) => `${px(i)},${py(v)}`).join(' ');
  const area = `M${px(0)},${H - padB} L` + values.map((v, i) => `${px(i)},${py(v)}`).join(' L') + ` L${px(n - 1)},${H - padB} Z`;
  const dots = values.map((v, i) => `<circle cx="${px(i)}" cy="${py(v)}" r="3.5" fill="#2563EB" stroke="#fff" stroke-width="1.5"/>`).join('');
  const labs = labels.map((l, i) => `<text x="${px(i)}" y="${H - padB + 16}" text-anchor="middle" font-size="9" fill="#6B7280">${esc(l)}</text>`).join('');
  const vals = values.map((v, i) => `<text x="${px(i)}" y="${py(v) - 8}" text-anchor="middle" font-size="9" fill="#6B7280">${fmtNum(v)}</text>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="240" preserveAspectRatio="xMidYMid meet">${axisLines(max, W, H, padL, padR, padT, padB)}<path d="${area}" fill="#2563EB" fill-opacity="0.10"/><polyline points="${pts}" fill="none" stroke="#2563EB" stroke-width="2.5" stroke-linejoin="round"/>${dots}${vals}${labs}</svg>`;
}
function pieSVG(labels, values) {
  const total = values.reduce((a, b) => a + b, 0) || 1;
  const cx = 140, cy = 120, r = 82, ir = 44;
  let ang = -Math.PI / 2, slices = '';
  values.forEach((v, i) => {
    const a = v / total * Math.PI * 2;
    const x1 = cx + r * Math.cos(ang), y1 = cy + r * Math.sin(ang);
    const x2 = cx + r * Math.cos(ang + a), y2 = cy + r * Math.sin(ang + a);
    const large = a > Math.PI ? 1 : 0;
    slices += `<path d="M${cx},${cy} L${x1},${y1} A${r},${r} 0 ${large} 1 ${x2},${y2} Z" fill="${PALETTE[i % PALETTE.length]}" stroke="#fff" stroke-width="2"/>`;
    ang += a;
  });
  const legend = labels.map((l, i) => `<g transform="translate(258,${36 + i * 30})"><rect x="0" y="0" width="12" height="12" rx="3" fill="${PALETTE[i % PALETTE.length]}"/><text x="20" y="10" font-size="11" fill="#4B5563">${esc(l)} ${(values[i] / total * 100).toFixed(1)}%</text></g>`).join('');
  const center = `<text x="${cx}" y="${cy - 4}" text-anchor="middle" font-size="11" fill="#9CA3AF">总计</text><text x="${cx}" y="${cy + 16}" text-anchor="middle" font-size="16" font-weight="700" fill="#1F2937">${fmtNum(Math.round(total))}</text>`;
  return `<svg viewBox="0 0 460 250" width="100%" height="250" preserveAspectRatio="xMidYMid meet">${slices}${center}${legend}</svg>`;
}
function hbarSVG(labels, values) {
  const W = 640, H = 260, padL = 122, padR = 64, padT = 12, padB = 12;
  const max = Math.max(...values) * 1.15 || 1;
  const n = values.length, bh = (H - padT - padB) / n;
  let rows = '';
  values.forEach((v, i) => {
    const y = padT + i * bh + bh * 0.18, h = bh * 0.64, w = (W - padL - padR) * (v / max);
    rows += `<text x="${padL - 8}" y="${y + h * 0.7}" text-anchor="end" font-size="10" fill="#4B5563">${esc(labels[i])}</text>`
      + `<rect x="${padL}" y="${y}" width="${w}" height="${h}" rx="4" fill="${PALETTE[i % PALETTE.length]}"/>`
      + `<text x="${padL + w + 6}" y="${y + h * 0.7}" font-size="10" fill="#6B7280">${fmtNum(v)}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="260" preserveAspectRatio="xMidYMid meet">${rows}</svg>`;
}
const CHART_RENDERERS = { bar: barSVG, line: lineSVG, pie: pieSVG, hbar: hbarSVG };
const CHART_TABS = [['bar', '柱状图'], ['line', '折线图'], ['pie', '饼图'], ['hbar', '排行']];

/* ---------- 智能问数（聊天） ---------- */
const DEFAULT_SUGGESTIONS = ['近12个月销售额趋势', '各产品线销量占比', '销售额大于500万的区域有哪些', '销售人员业绩排名TOP10', '制造业客户数量统计'];
function suggestions() { return (state && state.suggestions) || DEFAULT_SUGGESTIONS; }

function renderSuggestChips() {
  $('#suggestChips').innerHTML = suggestions().map(s => `<span class="chip" onclick="ask('${esc(s)}')">${esc(s)}</span>`).join('');
}
function welcomeHTML() {
  return `<div class="msg bot"><div class="msg-av b">B</div><div class="msg-bubble" style="max-width:100%;">
    <div style="font-weight:600;margin-bottom:6px;">您好，我是 BondQL 智能问数助手 👋</div>
    <div style="color:var(--gray-600);font-size:13px;">基于大模型将自然语言转为 SQL 并真实执行。当前工作空间：<strong>${esc((curWs() || {}).name || '—')}</strong> · 数据源：<strong>${esc((curDs() || {}).name || '—')}</strong>。试试问我：</div>
    <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap;">${suggestions().map(s => `<span class="chip" onclick="ask('${esc(s)}')">💡 ${esc(s)}</span>`).join('')}</div>
  </div></div>`;
}

function stepsHTML(steps, activeIndex) {
  return `<div class="steps">${steps.map((s, i) => `<div class="step"><span class="dot ${i < activeIndex ? 'done' : i === activeIndex ? 'active' : 'pending'}"></span>${esc(s)}</div>`).join('')}</div>`;
}
function chartTabsHTML(id, type) {
  return `<div class="chart-tabs">${CHART_TABS.map(t => `<span class="chart-tab ${t[0] === type ? 'active' : ''}" onclick="switchChart('${id}','${t[0]}')">${t[1]}</span>`).join('')}</div>`;
}
function switchChart(id, type) {
  const r = chartCache[id]; if (!r) return;
  r.chart = type;
  const el = $('#res-' + id);
  if (el) el.innerHTML = chartTabsHTML(id, type) + `<div class="chart-area">${(CHART_RENDERERS[type] || barSVG)(r.labels, r.values)}</div>`;
}
function exportResult(id) {
  const r = chartCache[id]; if (!r) return;
  const csv = '\uFEFF' + r.cols.join(',') + '\n' + r.rows.map(rw => rw.map(c => '"' + String(c).replace(/"/g, '""') + '"').join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (r.title || 'bondql_export') + '.csv';
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(a.href);
  toast('已导出 CSV 文件', 'success');
}
function resultHTML(msg) {
  if (msg.error) {
    return `<div class="steps">${(msg.steps || []).map(s => `<div class="step"><span class="dot done"></span>${esc(s)}</div>`).join('')}</div>
      <div style="background:var(--red-light);border:1px solid #FECACA;border-radius:10px;padding:14px 16px;font-size:13px;color:#991B1B;line-height:1.7;">⚠️ ${esc(msg.error)}</div>`;
  }
  const id = msg._cid || (msg._cid = 'res-' + (++resSeq));
  chartCache[id] = { labels: msg.labels || [], values: msg.values || [], cols: msg.cols || [], rows: msg.rows || [], title: msg.title, chart: msg.chart || 'bar' };
  const rowCount = (msg.rows || []).length;
  const table = `<div class="tbl-wrap"><table class="tbl"><thead><tr>${(msg.cols || []).map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${(msg.rows || []).map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  const followups = msg.followups && msg.followups.length
    ? `<div style="margin-top:12px;"><div style="font-size:12px;color:var(--gray-500);margin-bottom:6px;">💡 继续追问：</div><div class="chips">${msg.followups.map(f => `<span class="chip follow" onclick="ask('${esc(f)}')">${esc(f)}</span>`).join('')}</div></div>` : '';
  const engineLabel = msg.engine === 'llm'
    ? `<span class="tag t-purple" style="margin-left:6px;">大模型${msg.model_name ? ' · ' + esc(msg.model_name) : ''}</span>`
    : `<span class="tag t-blue" style="margin-left:6px;">规则引擎</span>`;
  const analysis = (msg.analysis && msg.analysis.length)
    ? `<div class="analysis-box"><div class="analysis-title">📈 智能数据分析</div><ul class="analysis-list">${msg.analysis.map(a => `<li>${esc(a)}</li>`).join('')}</ul>${msg.ai_summary ? `<div class="ai-summary">🤖 ${esc(msg.ai_summary)}</div>` : ''}</div>` : '';
  return `<div class="steps">${(msg.steps || []).map(s => `<div class="step"><span class="dot done"></span>${esc(s)}</div>`).join('')}</div>
    <div class="result-card">
      <div class="result-hd"><span>📊 ${esc(msg.title || '查询结果')}</span><div style="display:flex;gap:6px;"><button class="btn btn-s btn-sm" onclick="exportResult('${id}')">导出</button></div></div>
      <div class="result-bd">
        ${chartTabsHTML(id, msg.chart || 'bar')}<div class="chart-area" id="res-${id}">${(CHART_RENDERERS[msg.chart || 'bar'] || barSVG)(msg.labels || [], msg.values || [])}</div>
        <div class="result-meta">共返回 <strong>${rowCount}</strong> 行数据，执行耗时 <strong>${msg.elapsed_ms || 0}ms</strong>${engineLabel}</div>
        <div style="margin-top:10px;">${table}</div>
        ${analysis}
      </div>
    </div>${followups}`;
}
function msgHTML(m, idx) {
  if (m.role === 'user') return `<div class="msg user"><div class="msg-av u">A</div><div class="msg-bubble">${esc(m.text)}</div></div>`;
  if (m.pending) return `<div class="msg bot"><div class="msg-av b">B</div><div class="msg-bubble"><div class="typing"><i></i><i></i><i></i></div><div style="font-size:12px;color:var(--gray-500);margin-top:4px;">BondQL 正在思考…</div></div></div>`;
  if (m.animating) return `<div class="msg bot"><div class="msg-av b">B</div><div class="msg-bubble" style="max-width:100%;">${stepsHTML(m.steps || [], m.animStep)}</div></div>`;
  return `<div class="msg bot"><div class="msg-av b">B</div><div class="msg-bubble" style="max-width:100%;">${resultHTML(m)}</div></div>`;
}
function renderChat() {
  const panel = $('#chatMsgs');
  panel.innerHTML = (!chatMessages.length) ? welcomeHTML() : chatMessages.map(msgHTML).join('');
  renderSuggestChips();
  scrollChat();
  const lastBot = [...chatMessages].reverse().find(m => m.role === 'bot' && !m.pending && !m.animating);
  renderEvidence(lastBot ? lastBot.evidence : null);
}
function scrollChat() { const p = $('#chatMsgs'); if (p) p.scrollTop = p.scrollHeight; }

/* ---------- 查询依据面板 ---------- */
function renderEvidence(meta) {
  const panel = $('#evidencePanel');
  if (!meta) {
    panel.innerHTML = `<div class="ev-card"><div class="ev-hd">📋 查询依据</div><div class="ev-bd" style="color:var(--gray-500);line-height:1.8;">发起提问后，这里将展示术语匹配、表关系、SQL 语句、提示词约束与权限校验的完整依据。</div></div>`;
    return;
  }
  panel.innerHTML = `
    <div class="ev-card">
      <div class="ev-hd"><span>📋 查询依据</span><span style="font-size:11px;color:var(--primary);cursor:pointer;" onclick="go('terms')">术语配置 ›</span></div>
      <div class="ev-bd">
        <div class="kv"><span class="kk">匹配术语</span><span class="kv2">${esc(meta.termText || '—')}</span></div>
        <div class="kv"><span class="kk">数据源</span><span class="kv2">${esc(meta.ds || '—')}</span></div>
        <div class="kv"><span class="kk">关联路径</span><span class="kv2">${esc(meta.path || '—')}</span></div>
        <div class="kv"><span class="kk">SQL示例</span><span class="kv2">${esc(meta.example || '—')}</span></div>
      </div>
    </div>
    <div class="ev-card">
      <div class="ev-hd"><span>🔍 生成SQL</span><span style="font-size:11px;color:var(--primary);cursor:pointer;" onclick="go('sql-examples')">SQL示例 ›</span></div>
      <div class="ev-bd"><div class="code">${highlightSQL(meta.sql || '')}</div></div>
    </div>
    <div class="ev-card">
      <div class="ev-hd"><span>⚙️ 提示词约束</span><span style="font-size:11px;color:var(--primary);cursor:pointer;" onclick="go('prompts')">提示词 ›</span></div>
      <div class="ev-bd" style="line-height:1.9;color:var(--gray-600);">${(meta.prompts || []).map(p => '• ' + esc(p)).join('<br>')}</div>
    </div>
    <div class="ev-card">
      <div class="ev-hd"><span>🔐 权限校验</span><span style="font-size:11px;color:var(--primary);cursor:pointer;" onclick="go('permissions')">权限配置 ›</span></div>
      <div class="ev-bd">
        <div class="kv"><span class="kk">行权限</span><span class="kv2">${esc(meta.rowPerm || '—')}</span></div>
        <div class="kv"><span class="kk">列权限</span><span class="kv2">${esc(meta.colPerm || '—')}</span></div>
      </div>
    </div>`;
}

/* ---------- 提问 ---------- */
function sendMessage() { const input = $('#chatInput'); const text = input.value.trim(); if (text) { ask(text); input.value = ''; } }
async function ask(text) {
  text = String(text).trim();
  if (!text || busy) return;
  busy = true;
  chatMessages.push({ role: 'user', text });
  const pending = { role: 'bot', pending: true };
  chatMessages.push(pending);
  renderChat();
  try {
    const result = await api('POST', '/chat', { question: text, chat_id: activeChatId, model_id: selectedModelId || undefined, datasource_id: state.active_datasource });
    activeChatId = result.chat_id;
    Object.assign(pending, result);
    delete pending.pending;
    animateSteps(pending);
  } catch (e) {
    chatMessages.pop();
    chatMessages.push({ role: 'bot', steps: ['查询失败'], title: '查询失败', chart: 'bar', labels: [], values: [], cols: [], rows: [], followups: [], evidence: null, engine: 'rule', elapsed_ms: 0, _error: true });
    renderChat();
    toast('查询失败：' + e.message, 'error');
    busy = false;
  }
}
function animateSteps(msg) {
  const steps = msg.steps || [];
  msg.animating = true;
  msg.animStep = 0;
  renderChat();
  let i = 0;
  const tick = () => {
    if (i < steps.length) {
      msg.animStep = i;
      renderChat();
      i++;
      setTimeout(tick, 280);
    } else {
      delete msg.animating;
      renderChat();
      busy = false;
    }
  };
  setTimeout(tick, 200);
}
function newChat() { activeChatId = null; chatMessages = []; renderChat(); $('#chatInput').value = ''; $('#chatInput').focus(); toast('已新建会话', 'success'); }
function runExample(id) { const e = state.examples.find(x => x.id === id); if (e) { closeModal(); ask(e.q); } }

/* ---------- 模型选择 ---------- */
function renderModelSelect() {
  const models = state.models || [];
  const sel = $('#chatModelSelect');
  if (!sel) return;
  if (!models.length) { sel.innerHTML = '<option value="">规则引擎（无模型）</option>'; updateModelHint(); return; }
  const def = models.find(m => m.status === 'default');
  if (!selectedModelId) selectedModelId = def ? def.id : models[0].id;
  sel.innerHTML = models.map(m => `<option value="${m.id}" ${m.id === selectedModelId ? 'selected' : ''}>${esc(m.name)}${m.api_key_set ? '' : '（未配Key）'}</option>`).join('');
  updateModelHint();
}
function selectModel(id) { selectedModelId = id; updateModelHint(); }
function updateModelHint() {
  const m = state && state.models.find(x => x.id === selectedModelId);
  $('#chatModelHint').textContent = m ? (m.api_key_set ? '· 将使用大模型生成 SQL' : '· 该模型未配 Key，将用规则引擎') : '· 将使用内置规则引擎';
}
function renderChatDsSelect() {
  const dsList = wsDatasources(state.active_workspace);
  const sel = $('#chatDsSelect');
  if ($('#chatWsLabel')) $('#chatWsLabel').textContent = curWs() ? curWs().name : '—';
  if (!sel) return;
  if (!dsList.length) { sel.innerHTML = '<option value="">（当前空间无数据源）</option>'; return; }
  if (!dsList.find(d => d.id === state.active_datasource)) {
    const ds = dsList.find(d => d.status === 'enabled') || dsList[0];
    state.active_datasource = ds.id;
  }
  sel.innerHTML = dsList.map(d => `<option value="${d.id}" ${d.id === state.active_datasource ? 'selected' : ''}>${esc(d.name)}${d.status === 'enabled' ? '' : '（未开启）'}</option>`).join('');
}
function selectChatDs(id) {
  state.active_datasource = id;
  api('PUT', '/settings/active_datasource', { value: id }).catch(() => {});
  if (!chatMessages.length) renderChat();
}

/* ---------- 推荐提问（大模型生成） ---------- */
async function loadSuggestions() {
  try {
    const r = await api('POST', '/suggestions');
    if (r.suggestions && r.suggestions.length) state.suggestions = r.suggestions;
  } catch (e) { /* 保留默认推荐 */ }
  renderSuggestChips();
  if (!chatMessages.length) renderChat();
}

/* ---------- 初始化 ---------- */
async function init() {
  if (token) {
    try { await loadApp(); return; }
    catch (e) { token = null; localStorage.removeItem('bondql_token'); }
  }
  showLogin();
}
async function loadApp() {
  try {
    state = await api('GET', '/bootstrap');
    currentUser = state.user;
  } catch (e) {
    toast('无法连接后端服务：' + e.message, 'error');
    $('#chatMsgs').innerHTML = '<div class="msg bot"><div class="msg-av b">B</div><div class="msg-bubble">⚠️ 后端服务未启动，请运行 <code>python server.py</code> 后刷新页面。</div></div>';
    return;
  }
  hideLogin();
  renderUserFooter();
  applyPermissions();
  renderWorkspaceMenu();
  renderModelSelect();
  renderChatDsSelect();
  syncWsLabel();
  go('chat');
  loadSuggestions();
}
document.addEventListener('DOMContentLoaded', init);
