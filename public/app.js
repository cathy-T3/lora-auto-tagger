// ===== 全局状态 =====
const state = {
  projects: [],
  currentProject: null,
  settings: {},
  currentImageId: null,
  isProcessing: false,
  filter: { status: 'all', sort: 'default' },
  presets: {
    templates: {},
    glcCarPresets: { views: {}, colors: {}, parts: {} },
  },
};

// 笔记规定：整车图（带 view angle 的）期望至少有 1 个部件；特写图不强制。
// 用于「缺部件」筛选：找出那些应该被标了部件但没标的图。
function isMissingPart(img) {
  const cap = img.captionEn || '';
  const parts = state.presets.glcCarPresets?.parts || {};
  const partKeys = Object.keys(parts).filter(k => k !== 'motor vehicle');
  const hasPart = partKeys.some(k => cap.includes(k));
  if (hasPart) return false;
  // 如果是特写（没有 view angle），则视情况
  const viewKeys = Object.keys(state.presets.glcCarPresets?.views || {});
  const hasView = viewKeys.some(k => cap.includes(k));
  // 整车但完全没部件 → 标记为「需人工修」
  return hasView;
}

// ===== API 辅助函数 =====
async function api(url, options = {}) {
  const res = await fetch(url, options);
  if (res.status === 401) {
    showLogin();
    throw new Error('未登录');
  }
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch (e) {
    data = { error: '响应解析失败' };
  }
  if (!res.ok) {
    throw new Error(data.error || data.message || `HTTP ${res.status}`);
  }
  return data;
}

// ===== 认证 =====
let currentUser = null;

async function checkAuth() {
  try {
    const res = await fetch('/api/auth/check');
    if (res.ok) {
      const data = await res.json();
      currentUser = data;
      updateUserBadge();
      hideLogin();
      return true;
    }
  } catch (e) {}
  currentUser = null;
  showLogin();
  return false;
}

function showLogin() {
  const overlay = document.getElementById('loginOverlay');
  if (overlay) overlay.classList.remove('hidden');
}

function hideLogin() {
  const overlay = document.getElementById('loginOverlay');
  if (overlay) overlay.classList.add('hidden');
}

function updateUserBadge() {
  const badge = document.getElementById('userBadge');
  if (!badge) return;
  if (currentUser) {
    badge.textContent = currentUser.role === 'admin' ? '管理员: ' + currentUser.username : currentUser.username;
  } else {
    badge.textContent = '';
  }
}

async function doLogin() {
  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value;
  const errEl = document.getElementById('loginError');
  errEl.textContent = '';
  if (!password) {
    errEl.textContent = '请输入密码';
    return;
  }
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) {
      errEl.textContent = data.error || '登录失败';
      return;
    }
    currentUser = data;
    updateUserBadge();
    hideLogin();
    document.getElementById('loginPassword').value = '';
    await initApp();
  } catch (e) {
    errEl.textContent = '登录失败: ' + e.message;
  }
}

async function doLogout() {
  try {
    await fetch('/api/logout', { method: 'POST' });
  } catch (e) {}
  currentUser = null;
  updateUserBadge();
  state.projects = [];
  state.currentProject = null;
  document.getElementById('contentActive').style.display = 'none';
  document.getElementById('contentEmpty').style.display = 'flex';
  document.getElementById('projectList').innerHTML = '';
  showLogin();
}

function setupLoginEnter() {
  const pwd = document.getElementById('loginPassword');
  if (pwd) {
    pwd.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doLogin();
    });
  }
}

// ===== 初始化 =====
async function init() {
  setupLoginEnter();
  const ok = await checkAuth();
  if (ok) {
    await initApp();
  }
}

async function initApp() {
  await loadSettings();
  await loadPresets();
  await fetchProjects();
  setupDragDrop();
  setupFilters();
}

// 筛选器事件绑定
function setupFilters() {
  const statusSel = document.getElementById('filterStatus');
  const sortSel = document.getElementById('filterSort');
  if (statusSel) {
    statusSel.addEventListener('change', (e) => {
      state.filter.status = e.target.value;
      if (state.currentProject) renderImages();
    });
  }
  if (sortSel) {
    sortSel.addEventListener('change', (e) => {
      state.filter.sort = e.target.value;
      if (state.currentProject) renderImages();
    });
  }
}

// 加载打标预设
async function loadPresets() {
  try {
    const data = await api('/api/presets');
    state.presets = data;
  } catch (e) {
    console.error('加载预设失败:', e);
  }
}

// ===== 设置管理 =====
async function loadSettings() {
  try {
    const data = await api('/api/settings');
    state.settings = data;
    updateApiStatus(!!data.apiKeyConfigured);
  } catch (e) {
    console.error('加载设置失败:', e);
  }
}

function updateApiStatus(configured) {
  const dot = document.getElementById('statusDot');
  const text = document.getElementById('statusText');
  if (configured) {
    dot.classList.add('configured');
    text.textContent = `已连接 (${state.settings.model || 'gpt-4o'})`;
  } else {
    dot.classList.remove('configured');
    text.textContent = '未配置 API';
  }
}

function openSettings() {
  document.getElementById('settingsApiUrl').value = state.settings.apiBaseUrl || '';
  document.getElementById('settingsApiKey').value = '';
  document.getElementById('settingsApiKey').placeholder = state.settings.apiKey || 'sk-...';
  document.getElementById('settingsModel').value = state.settings.model || 'gpt-4o';
  document.getElementById('settingsCropMode').value = state.settings.cropMode || 'attention';
  openModal('settingsModal');
}

async function saveSettings() {
  const data = {
    apiBaseUrl: document.getElementById('settingsApiUrl').value.trim() || 'https://api.openai.com/v1',
    model: document.getElementById('settingsModel').value.trim() || 'gpt-4o',
    cropMode: document.getElementById('settingsCropMode').value,
  };
  const apiKey = document.getElementById('settingsApiKey').value.trim();
  if (apiKey) {
    data.apiKey = apiKey;
  }

  try {
    await api('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    await loadSettings();
    closeModal('settingsModal');
    showToast('设置已保存', 'success');
  } catch (e) {
    showToast('保存失败: ' + e.message, 'error');
  }
}

// ===== 项目管理 =====
async function fetchProjects() {
  try {
    const data = await api('/api/projects');
    state.projects = Array.isArray(data) ? data : [];
    renderProjectList();
  } catch (e) {
    state.projects = [];
    showToast('加载项目失败: ' + e.message, 'error');
    renderProjectList();
  }
}

function renderProjectList() {
  const list = document.getElementById('projectList');
  if (state.projects.length === 0) {
    list.innerHTML = `<div class="empty-state"><p>暂无项目</p><p class="hint">点击「新建项目」开始</p></div>`;
    return;
  }

  list.innerHTML = state.projects.map(p => `
    <div class="project-item ${state.currentProject?.id === p.id ? 'active' : ''}" onclick="selectProject('${p.id}')">
      <div class="project-item-name">${escapeHtml(p.name)}</div>
      <div class="project-item-meta">${p.imageCount} 张图片 · ${p.triggerWord || '无触发词'}</div>
    </div>
  `).join('');
}

async function selectProject(id) {
  try {
    const data = await api(`/api/projects/${id}`);
    state.currentProject = data;
    renderProjectList();
    showProjectContent();
    renderImages();
    updateStats();
  } catch (e) {
    showToast('加载项目失败: ' + e.message, 'error');
  }
}

function showProjectContent() {
  document.getElementById('contentEmpty').style.display = 'none';
  document.getElementById('contentActive').style.display = 'flex';
  document.getElementById('contentActive').style.flexDirection = 'column';

  const p = state.currentProject;
  document.getElementById('projectTitle').textContent = p.name;
  const cropModeText = { attention: '智能裁剪', center: '中心裁剪', contain: '包含模式' }[p.cropMode] || '智能裁剪';
  const templateText = p.captionTemplate === 'glc-car' ? '汽车打标模板' : '通用模板';
  document.getElementById('projectMeta').textContent =
    `${p.images.length} 张图片 · 触发词: ${p.triggerWord || '无'} · ${cropModeText} · ${templateText}`;
}

function openNewProject() {
  document.getElementById('newProjectName').value = '';
  document.getElementById('newProjectDesc').value = '';
  document.getElementById('newProjectTrigger').value = '';
  document.getElementById('newProjectTemplate').value = 'general';
  document.getElementById('newProjectCrop').value = state.settings.cropMode || 'attention';
  openModal('newProjectModal');
}

async function createProject() {
  const name = document.getElementById('newProjectName').value.trim();
  if (!name) {
    showToast('请输入项目名称', 'warning');
    return;
  }

  const data = {
    name,
    description: document.getElementById('newProjectDesc').value.trim(),
    triggerWord: document.getElementById('newProjectTrigger').value.trim(),
    captionTemplate: document.getElementById('newProjectTemplate').value,
    cropMode: document.getElementById('newProjectCrop').value,
  };

  try {
    await api('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    closeModal('newProjectModal');
    await fetchProjects();
    showToast('项目创建成功', 'success');
  } catch (e) {
    showToast('创建失败: ' + e.message, 'error');
  }
}

function openProjectSettings() {
  const p = state.currentProject;
  document.getElementById('editProjectName').value = p.name;
  document.getElementById('editProjectDesc').value = p.description || '';
  document.getElementById('editProjectTrigger').value = p.triggerWord || '';
  document.getElementById('editProjectTemplate').value = p.captionTemplate || 'general';
  document.getElementById('editProjectCrop').value = p.cropMode || 'attention';
  openModal('projectSettingsModal');
}

async function updateProject() {
  const data = {
    name: document.getElementById('editProjectName').value.trim(),
    description: document.getElementById('editProjectDesc').value.trim(),
    triggerWord: document.getElementById('editProjectTrigger').value.trim(),
    captionTemplate: document.getElementById('editProjectTemplate').value,
    cropMode: document.getElementById('editProjectCrop').value,
  };

  try {
    await api(`/api/projects/${state.currentProject.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    closeModal('projectSettingsModal');
    await selectProject(state.currentProject.id);
    await fetchProjects();
    showToast('项目设置已更新', 'success');
  } catch (e) {
    showToast('更新失败: ' + e.message, 'error');
  }
}

async function deleteProject() {
  if (!confirm('确定要删除此项目及其所有图片吗？此操作不可恢复。')) return;

  try {
    await api(`/api/projects/${state.currentProject.id}`, { method: 'DELETE' });
    closeModal('projectSettingsModal');
    state.currentProject = null;
    document.getElementById('contentEmpty').style.display = 'flex';
    document.getElementById('contentActive').style.display = 'none';
    await fetchProjects();
    showToast('项目已删除', 'success');
  } catch (e) {
    showToast('删除失败: ' + e.message, 'error');
  }
}

// ===== 图片上传 =====
async function handleUpload(input) {
  const files = Array.from(input.files);
  if (files.length === 0) return;

  await uploadFiles(files);
  input.value = '';
}

async function uploadFiles(files) {
  if (!state.currentProject) {
    showToast('请先选择或创建项目', 'warning');
    return;
  }

  const formData = new FormData();
  files.forEach(f => formData.append('images', f));

  showToast(`正在上传 ${files.length} 张图片...`, 'info');

  try {
    const results = await api(`/api/projects/${state.currentProject.id}/images`, {
      method: 'POST',
      body: formData,
    });
    await selectProject(state.currentProject.id);
    showToast(`成功上传 ${results.length} 张图片，已自动裁剪为 1024×1024`, 'success');
  } catch (e) {
    showToast('上传失败: ' + e.message, 'error');
  }
}

// 拖放上传
function setupDragDrop() {
  const zone = document.getElementById('uploadZone');
  const content = document.getElementById('content');

  ['dragenter', 'dragover'].forEach(evt => {
    content.addEventListener(evt, (e) => {
      e.preventDefault();
      if (state.currentProject) {
        zone.classList.add('dragover');
      }
    });
  });

  ['dragleave', 'drop'].forEach(evt => {
    content.addEventListener(evt, (e) => {
      e.preventDefault();
      zone.classList.remove('dragover');
    });
  });

  content.addEventListener('drop', async (e) => {
    e.preventDefault();
    zone.classList.remove('dragover');
    if (!state.currentProject) return;

    const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
    if (files.length > 0) {
      await uploadFiles(files);
    }
  });
}

// ===== 图片渲染 =====
function renderImages() {
  const grid = document.getElementById('imageGrid');
  const uploadZone = document.getElementById('uploadZone');
  const images = state.currentProject?.images || [];

  if (images.length === 0) {
    uploadZone.style.display = 'block';
    grid.innerHTML = '';
    return;
  }
  uploadZone.style.display = 'none';

  // 1. 过滤
  let filtered = [...images];
  if (state.filter.status === 'missing-part') {
    filtered = filtered.filter(isMissingPart);
  } else if (state.filter.status !== 'all') {
    filtered = filtered.filter(i => i.verificationStatus === state.filter.status);
  }

  // 2. 排序
  const numOf = (img) => parseInt(img.originalName.split('.')[0], 10) || 0;
  const statusOrder = { error: 0, uncertain: 1, pending: 2, verified: 3 };

  if (state.filter.sort === 'number-asc') {
    filtered.sort((a, b) => numOf(a) - numOf(b));
  } else if (state.filter.sort === 'number-desc') {
    filtered.sort((a, b) => numOf(b) - numOf(a));
  } else if (state.filter.sort === 'status') {
    filtered.sort((a, b) => (statusOrder[a.verificationStatus] || 2) - (statusOrder[b.verificationStatus] || 2));
  } else {
    // 默认：按问题优先级，再按文件号
    filtered.sort((a, b) => {
      const sa = statusOrder[a.verificationStatus] || 2;
      const sb = statusOrder[b.verificationStatus] || 2;
      if (sa !== sb) return sa - sb;
      return numOf(a) - numOf(b);
    });
  }

  // 3. 渲染
  grid.innerHTML = filtered.map(img => {
    const statusInfo = getStatusInfo(img.verificationStatus);
    const needsFix = isMissingPart(img);
    const fixBadge = needsFix ? `<span class="image-card-flag" title="整车图未标任何部件，建议人工补 headlight / car logo / front grille 等">⚠ 待补部件</span>` : '';
    return `
      <div class="image-card" onclick="openImageDetail('${img.id}')">
        <div class="image-card-thumb">
          <img src="/api/projects/${state.currentProject.id}/images/${img.id}/file" loading="lazy" alt="${escapeHtml(img.originalName)}">
          <span class="image-card-badge badge-${img.verificationStatus}">${statusInfo.label}</span>
          ${fixBadge}
        </div>
        <div class="image-card-body">
          <div class="image-card-name">${escapeHtml(img.originalName)}</div>
          ${img.captionEn
            ? `<div class="image-card-caption">${escapeHtml(img.captionEn)}</div>
               <div class="image-card-caption-zh">${escapeHtml(img.captionZh)}</div>`
            : `<div class="image-card-caption" style="color:var(--text-muted)">尚未打标</div>`
          }
        </div>
        <div class="image-card-actions" onclick="event.stopPropagation()">
          <button onclick="generateCaption('${img.id}')" title="AI 打标 / 重新打标">打标</button>
          <button onclick="verifyImage('${img.id}')" title="AI 验证">验证</button>
          <button onclick="openImageDetail('${img.id}')" title="打开详情手动编辑">✎ 修正</button>
          <button onclick="deleteImage('${img.id}')" title="删除">删除</button>
        </div>
      </div>
    `;
  }).join('');

  // 4. 空筛选提示
  const tip = document.getElementById('filterTip');
  if (filtered.length === 0) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1;"><p>当前筛选条件下没有图</p><p class="hint">试试改回「全部」</p></div>`;
    if (tip) tip.textContent = '';
  } else if (tip) {
    tip.textContent = `显示 ${filtered.length} / ${images.length}`;
  }

  // 5. 按钮启用
  const hasImages = images.length > 0;
  document.getElementById('btnAutoCaptionAll').disabled = !hasImages;
  document.getElementById('btnVerifyAll').disabled = !hasImages;
  document.getElementById('btnExport').disabled = !hasImages;
}

function getStatusInfo(status) {
  const map = {
    pending: { label: '待验证', color: 'var(--text-muted)' },
    verified: { label: '已验证', color: 'var(--success)' },
    uncertain: { label: '不确定', color: 'var(--warning)' },
    error: { label: '有错误', color: 'var(--danger)' },
  };
  return map[status] || map.pending;
}

function updateStats() {
  const images = state.currentProject?.images || [];
  document.getElementById('statTotal').textContent = images.length;
  document.getElementById('statCaptioned').textContent = images.filter(i => i.captionEn).length;
  document.getElementById('statVerified').textContent = images.filter(i => i.verificationStatus === 'verified').length;
  document.getElementById('statUncertain').textContent = images.filter(i => i.verificationStatus === 'uncertain').length;
  document.getElementById('statError').textContent = images.filter(i => i.verificationStatus === 'error').length;
  document.getElementById('statNeedsFix').textContent = images.filter(isMissingPart).length;
}

// ===== 图片详情弹窗 =====
function openImageDetail(imageId) {
  const img = state.currentProject.images.find(i => i.id === imageId);
  if (!img) return;

  state.currentImageId = imageId;
  const statusInfo = getStatusInfo(img.verificationStatus);

  // 解析验证信息
  let verificationNote = null;
  if (img.verificationNote) {
    try {
      verificationNote = JSON.parse(img.verificationNote);
    } catch (e) {}
  }

  document.getElementById('imageDetailTitle').textContent = img.originalName;

  const isCarTemplate = state.currentProject.captionTemplate === 'glc-car';

  document.getElementById('imageDetailBody').innerHTML = `
    <div class="detail-layout">
      <div class="detail-image-section">
        <img src="/api/projects/${state.currentProject.id}/images/${img.id}/file" alt="${escapeHtml(img.originalName)}">
        <div style="margin-top:12px; display:flex; gap:8px; flex-wrap:wrap;">
          <button class="btn btn-primary btn-sm" onclick="generateCaption('${img.id}', true)">
            ${img.captionEn ? '重新打标' : 'AI 打标'}
          </button>
          <button class="btn btn-secondary btn-sm" onclick="verifyImage('${img.id}', true)">
            ${img.verificationStatus !== 'pending' ? '重新验证' : 'AI 验证'}
          </button>
          <a class="btn btn-secondary btn-sm" href="/api/projects/${state.currentProject.id}/images/${img.id}/original" target="_blank">
            查看原图
          </a>
        </div>
        <div style="margin-top:8px; font-size:12px; color:var(--text-muted);">
          原始尺寸: ${img.originalSize.width}×${img.originalSize.height} → 裁剪: 1024×1024
        </div>
      </div>
      <div class="detail-caption-section">
        <div class="detail-caption-box">
          <label>英文标语 (English Caption) - FLUX 训练用</label>
          <textarea id="captionEn_${img.id}" rows="4">${escapeHtml(img.captionEn)}</textarea>
        </div>
        <div class="detail-caption-box">
          <label>中文翻译 (Chinese Translation) - 核查对照用</label>
          <textarea id="captionZh_${img.id}" rows="4">${escapeHtml(img.captionZh)}</textarea>
        </div>
        <button class="btn btn-success btn-sm" onclick="saveCaption('${img.id}')">保存修改</button>

        ${isCarTemplate ? renderCarPresetsPanel(img.id) : ''}

        ${renderVerificationBox(img, statusInfo, verificationNote)}
      </div>
    </div>
  `;

  openModal('imageDetailModal');
}

// 渲染汽车标签快捷面板
function renderCarPresetsPanel(imgId) {
  const presets = state.presets.glcCarPresets || { views: {}, colors: {}, parts: {} };

  const makeChips = (obj, category) => Object.entries(obj).map(([en, zh]) =>
    `<button type="button" class="chip" data-en="${escapeHtml(en)}" data-zh="${escapeHtml(zh)}" data-cat="${category}">${zh} · ${en}</button>`
  ).join('');

  return `
    <div class="car-presets-panel">
      <div class="presets-header">
        <strong>🚗 汽车标签快捷插入（打标规范）</strong>
        <div style="display:flex; gap:6px; margin-top:4px;">
          <button class="btn btn-secondary btn-sm" onclick="appendCarTags('${imgId}')">追加选中到标语</button>
          <button class="btn btn-secondary btn-sm" onclick="replaceWithCarTags('${imgId}')">替换为标准格式</button>
        </div>
      </div>
      <div class="presets-group">
        <label>视角 VIEW ANGLES（单选）</label>
        <div class="chips">${makeChips(presets.views, 'view')}</div>
      </div>
      <div class="presets-group">
        <label>颜色 COLORS</label>
        <div class="chips">${makeChips(presets.colors, 'color')}</div>
      </div>
      <div class="presets-group">
        <label>部件 CAR PARTS（特写用）</label>
        <div class="chips">${makeChips(presets.parts, 'part')}</div>
      </div>
    </div>
  `;
}

// 芯片选中状态切换（点击切换）
document.addEventListener('click', (e) => {
  if (e.target.classList.contains('chip')) {
    e.target.classList.toggle('chip-active');
  }
});

// 获取所有激活芯片的 en/zh
function getActiveChips(imgId) {
  const container = document.getElementById('imageDetailBody');
  if (!container) return { ens: [], zhs: [] };
  const chips = container.querySelectorAll('.chip-active');
  const ens = [], zhs = [];
  chips.forEach(c => {
    ens.push(c.dataset.en);
    zhs.push(c.dataset.zh);
  });
  return { ens, zhs };
}

// 追加选中标签到现有标语（英文追加英文，中文追加中文）
function appendCarTags(imgId) {
  const { ens, zhs } = getActiveChips(imgId);
  if (ens.length === 0) {
    showToast('请先点击下方标签选中', 'warning');
    return;
  }
  const tw = state.currentProject.triggerWord || '';
  const enInput = document.getElementById(`captionEn_${imgId}`);
  const zhInput = document.getElementById(`captionZh_${imgId}`);

  // 合并标签（去重）
  const existingEn = enInput.value ? enInput.value.split(/\s*,\s*/).filter(Boolean) : [];
  const existingZh = zhInput.value ? zhInput.value.split(/\s*，\s*/).filter(Boolean) : [];

  // 确保触发词在最前
  let baseEn = existingEn.filter(t => t !== tw);
  let baseZh = existingZh;

  // 过滤掉 motor vehicle 单独处理
  baseEn = baseEn.filter(t => t !== 'motor vehicle');
  const newEns = [...new Set([...baseEn, ...ens])];
  const newZhs = [...new Set([...baseZh, ...zhs])];

  // 如果新标签里有 motor vehicle，确保放在最后
  const mvIdx = newEns.indexOf('motor vehicle');
  if (mvIdx > -1) {
    newEns.splice(mvIdx, 1);
    newEns.push('motor vehicle');
  } else {
    newEns.push('motor vehicle');
  }

  let finalEnList = newEns;
  if (tw) {
    finalEnList = [tw, ...finalEnList.filter(t => t !== tw)];
    // 再次确保 motor vehicle 在最后
    const mvIdx2 = finalEnList.indexOf('motor vehicle');
    if (mvIdx2 > -1 && mvIdx2 !== finalEnList.length - 1) {
      finalEnList.splice(mvIdx2, 1);
      finalEnList.push('motor vehicle');
    }
  }
  enInput.value = finalEnList.join(', ');

  // 中文保持顺序
  zhInput.value = newZhs.join('，');

  showToast('已追加标签', 'success');
}

// 替换为标准汽车格式（触发词 + motor vehicle + 选的标签）
function replaceWithCarTags(imgId) {
  const { ens, zhs } = getActiveChips(imgId);
  const tw = state.currentProject.triggerWord || '';
  const enInput = document.getElementById(`captionEn_${imgId}`);
  const zhInput = document.getElementById(`captionZh_${imgId}`);

  // 构建：触发词 + 选中标签 + motor vehicle 放在最后
  let finalEns = ens.filter(t => t !== 'motor vehicle' && t !== tw);
  finalEns = [...new Set(finalEns)];
  finalEns.push('motor vehicle');
  if (tw) finalEns = [tw, ...finalEns];

  const finalZhs = [...new Set(zhs)];

  enInput.value = finalEns.join(', ');
  zhInput.value = finalZhs.join('，');

  showToast('已替换为标准格式', 'success');
}

function renderVerificationBox(img, statusInfo, note) {
  if (img.verificationStatus === 'pending') {
    return `
      <div class="detail-verification verification-pending">
        <div class="verification-header">
          <span class="verification-status" style="color:var(--text-muted)">验证状态：待验证</span>
        </div>
        <div class="verification-issues">点击「AI 验证」按钮进行自动核查</div>
      </div>
    `;
  }

  const confidenceColor = img.verificationConfidence >= 80 ? 'var(--success)' :
                          img.verificationConfidence >= 50 ? 'var(--warning)' : 'var(--danger)';

  let issuesHtml = '';
  if (note && note.issues && note.issues.length > 0) {
    issuesHtml = '<ul class="verification-issues">' +
      note.issues.map(i => `<li>${escapeHtml(i)}</li>`).join('') + '</ul>';
  }

  let suggestionHtml = '';
  if (note && note.suggestion) {
    suggestionHtml = `<div class="verification-suggestion"><strong>建议:</strong> ${escapeHtml(note.suggestion)}</div>`;
  }

  return `
    <div class="detail-verification verification-${img.verificationStatus}">
      <div class="verification-header">
        <span class="verification-status" style="color:${statusInfo.color}">
          验证状态：${statusInfo.label}
        </span>
        <span class="verification-confidence" style="color:${confidenceColor}">
          置信度: ${img.verificationConfidence}%
        </span>
      </div>
      ${issuesHtml}
      ${suggestionHtml}
    </div>
  `;
}

// ===== 打标功能 =====
async function generateCaption(imageId, fromDetail = false) {
  if (state.isProcessing) return;

  // 检查 API 配置
  if (!state.settings.apiKey || state.settings.apiKey.includes('****')) {
    showToast('请先在设置中配置 API Key', 'warning');
    openSettings();
    return;
  }

  state.isProcessing = true;
  showToast('正在生成标语...', 'info');

  try {
    const result = await api(`/api/projects/${state.currentProject.id}/images/${imageId}/caption`, {
      method: 'POST',
    });

    // 更新本地数据
    const img = state.currentProject.images.find(i => i.id === imageId);
    if (img) {
      Object.assign(img, result);
    }

    renderImages();
    updateStats();

    if (fromDetail) {
      openImageDetail(imageId);
    }

    showToast('标语生成成功', 'success');
  } catch (e) {
    showToast('打标失败: ' + e.message, 'error');
  } finally {
    state.isProcessing = false;
  }
}

async function autoCaptionAll() {
  if (state.isProcessing) return;

  const pendingImages = state.currentProject.images.filter(i => !i.captionEn);
  if (pendingImages.length === 0) {
    showToast('所有图片已打标', 'info');
    return;
  }

  if (!state.settings.apiKey || state.settings.apiKey.includes('****')) {
    showToast('请先在设置中配置 API Key', 'warning');
    openSettings();
    return;
  }

  state.isProcessing = true;
  showProgress('批量打标中', 0, pendingImages.length);

  let success = 0;
  let fail = 0;

  for (let i = 0; i < pendingImages.length; i++) {
    const img = pendingImages[i];
    updateProgress(i, pendingImages.length, `正在打标: ${img.originalName}`);

    try {
      const result = await api(`/api/projects/${state.currentProject.id}/images/${img.id}/caption`, {
        method: 'POST',
      });
      Object.assign(img, result);
      success++;
      appendProgressLog(`✓ ${img.originalName}`, 'success');
    } catch (e) {
      fail++;
      appendProgressLog(`✗ ${img.originalName}: ${e.message}`, 'error');
    }

    renderImages();
    updateStats();
  }

  updateProgress(pendingImages.length, pendingImages.length, '完成');
  appendProgressLog(`\n打标完成: 成功 ${success} 张, 失败 ${fail} 张`, 'info');

  state.isProcessing = false;
  showToast(`批量打标完成: 成功 ${success}, 失败 ${fail}`, success > 0 ? 'success' : 'error');
}

async function saveCaption(imageId) {
  const captionEn = document.getElementById(`captionEn_${imageId}`).value;
  const captionZh = document.getElementById(`captionZh_${imageId}`).value;

  try {
    const result = await api(`/api/projects/${state.currentProject.id}/images/${imageId}/caption`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ captionEn, captionZh }),
    });

    const img = state.currentProject.images.find(i => i.id === imageId);
    if (img) {
      Object.assign(img, result);
    }

    renderImages();
    updateStats();
    showToast('标语已保存', 'success');
  } catch (e) {
    showToast('保存失败: ' + e.message, 'error');
  }
}

// ===== 验证功能 =====
async function verifyImage(imageId, fromDetail = false) {
  if (state.isProcessing) return;

  const img = state.currentProject.images.find(i => i.id === imageId);
  if (!img || !img.captionEn) {
    showToast('请先生成标语再验证', 'warning');
    return;
  }

  if (!state.settings.apiKey || state.settings.apiKey.includes('****')) {
    showToast('请先在设置中配置 API Key', 'warning');
    openSettings();
    return;
  }

  state.isProcessing = true;
  showToast('正在验证标语...', 'info');

  try {
    const result = await api(`/api/projects/${state.currentProject.id}/images/${imageId}/verify`, {
      method: 'POST',
    });

    Object.assign(img, result);
    renderImages();
    updateStats();

    if (fromDetail) {
      openImageDetail(imageId);
    }

    const statusInfo = getStatusInfo(img.verificationStatus);
    if (img.verificationStatus === 'verified') {
      showToast(`验证通过 (${img.verificationConfidence}%)`, 'success');
    } else if (img.verificationStatus === 'uncertain') {
      showToast(`验证不确定 (${img.verificationConfidence}%) - 请人工核查`, 'warning');
    } else {
      showToast(`验证发现错误 (${img.verificationConfidence}%) - 请检查`, 'error');
    }
  } catch (e) {
    showToast('验证失败: ' + e.message, 'error');
  } finally {
    state.isProcessing = false;
  }
}

async function verifyAll() {
  if (state.isProcessing) return;

  const toVerify = state.currentProject.images.filter(i => i.captionEn);
  if (toVerify.length === 0) {
    showToast('没有可验证的图片（请先打标）', 'info');
    return;
  }

  if (!state.settings.apiKey || state.settings.apiKey.includes('****')) {
    showToast('请先在设置中配置 API Key', 'warning');
    openSettings();
    return;
  }

  state.isProcessing = true;
  showProgress('批量验证中', 0, toVerify.length);

  let verified = 0, uncertain = 0, error = 0;

  for (let i = 0; i < toVerify.length; i++) {
    const img = toVerify[i];
    updateProgress(i, toVerify.length, `正在验证: ${img.originalName}`);

    try {
      const result = await api(`/api/projects/${state.currentProject.id}/images/${img.id}/verify`, {
        method: 'POST',
      });
      Object.assign(img, result);

      if (result.verificationStatus === 'verified') {
        verified++;
        appendProgressLog(`✓ ${img.originalName} - 通过 (${result.verificationConfidence}%)`, 'success');
      } else if (result.verificationStatus === 'uncertain') {
        uncertain++;
        appendProgressLog(`⚠ ${img.originalName} - 不确定 (${result.verificationConfidence}%)`, 'warning');
      } else {
        error++;
        appendProgressLog(`✗ ${img.originalName} - 错误 (${result.verificationConfidence}%)`, 'error');
      }
    } catch (e) {
      error++;
      appendProgressLog(`✗ ${img.originalName}: ${e.message}`, 'error');
    }

    renderImages();
    updateStats();
  }

  updateProgress(toVerify.length, toVerify.length, '完成');
  appendProgressLog(`\n验证完成: 通过 ${verified}, 不确定 ${uncertain}, 错误 ${error}`, 'info');

  state.isProcessing = false;
  showToast(`验证完成: 通过 ${verified}, 不确定 ${uncertain}, 错误 ${error}`, 'info');
}

// ===== 删除图片 =====
async function deleteImage(imageId) {
  if (!confirm('确定要删除此图片吗？')) return;

  try {
    await api(`/api/projects/${state.currentProject.id}/images/${imageId}`, { method: 'DELETE' });
    await selectProject(state.currentProject.id);
    showToast('图片已删除', 'success');

    // 如果详情弹窗打开，关闭它
    if (state.currentImageId === imageId) {
      closeModal('imageDetailModal');
    }
  } catch (e) {
    showToast('删除失败: ' + e.message, 'error');
  }
}

// ===== 导出 =====
function exportProject() {
  const projectId = state.currentProject.id;
  const projectName = state.currentProject.name;

  showToast('正在打包导出...', 'info');

  // 触发下载
  const link = document.createElement('a');
  link.href = `/api/projects/${projectId}/export`;
  link.download = `${projectName}_flux_training_data.zip`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  showToast('导出已开始下载', 'success');
}

// ===== 工具函数 =====
function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.animation = 'slideIn 0.3s ease reverse';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

function openModal(id) {
  document.getElementById(id).style.display = 'flex';
}

function closeModal(id) {
  document.getElementById(id).style.display = 'none';
}

// 点击遮罩关闭弹窗
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      overlay.style.display = 'none';
    }
  });
});

// ===== 进度弹窗 =====
function showProgress(title, current, total) {
  document.getElementById('progressTitle').textContent = title;
  document.getElementById('progressBar').style.width = '0%';
  document.getElementById('progressText').textContent = `0 / ${total}`;
  document.getElementById('progressLog').innerHTML = '';
  openModal('progressModal');
}

function updateProgress(current, total, text) {
  const pct = total > 0 ? (current / total) * 100 : 0;
  document.getElementById('progressBar').style.width = pct + '%';
  document.getElementById('progressText').textContent = `${current} / ${total}`;
  if (text) {
    document.getElementById('progressTitle').textContent = text;
  }
}

function appendProgressLog(message, type) {
  const log = document.getElementById('progressLog');
  const div = document.createElement('div');
  const colors = {
    success: 'var(--success)',
    error: 'var(--danger)',
    warning: 'var(--warning)',
    info: 'var(--text-secondary)',
  };
  div.style.color = colors[type] || 'var(--text-secondary)';
  div.textContent = message;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

// ===== 启动 =====
init();
