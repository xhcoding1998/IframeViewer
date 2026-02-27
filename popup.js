/**
 * popup.js
 * 核心流程：
 * 1. 扫描当前页面所有 iframe → content.js
 * 2. 渲染 iframe 卡片（显示 src、解析 URL 参数标签）
 * 3. 点击「快照」→ 让 content.js 滚动到该 iframe → background.js 截取 tab → 裁剪图像
 * 4. 弹出模态框展示：截图快照 / 完整 URL 参数表 / 属性信息
 */

// ===== 工具 =====
const $ = (id) => document.getElementById(id);
const escHtml = (s) => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

/**
 * 自定义二次确认弹窗，返回 Promise<boolean>
 * @param {string} message - 支持 HTML，关键词用 <strong> 高亮
 */
const CONFIRM_ICONS = {
  delete: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
    <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M10 11v4M14 11v4" stroke-linecap="round"/>
  </svg>`,
  reload: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
    <path d="M3 12a9 9 0 1 0 2.6-6.4" stroke-linecap="round"/>
    <path d="M3 4v5h5" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M12 8v4l3 2" stroke-linecap="round"/>
  </svg>`,
};

/**
 * 自定义二次确认弹窗，返回 Promise<boolean>
 * @param {string} message       - 支持 HTML，关键词用 <strong> 高亮
 * @param {object} [opts]
 * @param {string} [opts.title]        - 弹窗标题，默认「确认删除」
 * @param {string} [opts.confirmText]  - 确认按钮文字，默认「删除」
 * @param {string} [opts.confirmClass] - 确认按钮额外 class，默认「btn-danger」
 * @param {string} [opts.icon]         - 图标类型：'delete'（默认）| 'reload'
 */
function showConfirm(message, opts = {}) {
  const {
    title        = '确认删除',
    confirmText  = '删除',
    confirmClass = 'btn-danger',
    icon         = 'delete',
  } = opts;

  return new Promise((resolve) => {
    const dialog = $('confirm-dialog');

    // 更新标题
    $('confirm-title').textContent = title;

    // 更新图标
    const iconEl = dialog.querySelector('.confirm-icon');
    iconEl.innerHTML = CONFIRM_ICONS[icon] ?? CONFIRM_ICONS.delete;
    iconEl.className = `confirm-icon confirm-icon--${icon}`;

    // 更新内容
    $('confirm-message').innerHTML = message;

    // 更新确认按钮
    const btnOk = $('confirm-ok');
    btnOk.textContent = confirmText;
    btnOk.className = `btn ${confirmClass}`;

    dialog.classList.remove('hidden');

    const finish = (result) => {
      dialog.classList.add('hidden');
      btnOk.removeEventListener('click', onOk);
      btnCancel.removeEventListener('click', onCancel);
      backdrop.removeEventListener('click', onCancel);
      document.removeEventListener('keydown', onKey);
      resolve(result);
    };

    const onOk     = () => finish(true);
    const onCancel = () => finish(false);
    const onKey    = (e) => { if (e.key === 'Escape') finish(false); };

    const btnCancel = $('confirm-cancel');
    const backdrop  = $('confirm-backdrop');

    btnOk.addEventListener('click', onOk);
    btnCancel.addEventListener('click', onCancel);
    backdrop.addEventListener('click', onCancel);
    document.addEventListener('keydown', onKey);

    btnCancel.focus();
  });
}

// ===== 全局状态 =====
let iframeList = [];        // 扫描到的 iframe 数组
let currentTabId = null;
let currentWindowId = null;
let activeModalIndex = -1;  // 当前打开模态框对应的 iframe 索引
let lastSnapshotUrl = '';    // 最新截图的 data URL（用于保存）
let _highlightTimer = null;  // 卡片 hover 高亮防抖计时器

// ===== 初始化 =====
async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab?.id ?? null;
  currentWindowId = tab?.windowId ?? null;

  if (tab?.url) {
    try {
      $('page-host').textContent = new URL(tab.url).hostname;
    } catch {
      $('page-host').textContent = tab.url.slice(0, 40);
    }
  }

  // 这些元素理论上都在 popup.html 中，但为防止模板变更导致空引用，这里加一层存在性判断
  const btnScan = $('btn-scan');
  if (btnScan) btnScan.addEventListener('click', handleScan);

  // 打开插件时自动扫描，无需手动点击
  handleScan();

  const modalBackdrop = $('modal-backdrop');
  if (modalBackdrop) modalBackdrop.addEventListener('click', closeModal);

  const modalClose = $('modal-close');
  if (modalClose) modalClose.addEventListener('click', closeModal);

  const btnCapture = $('btn-capture');
  if (btnCapture) btnCapture.addEventListener('click', handleCapture);

  const btnSaveSnapshot = $('btn-save-snapshot');
  if (btnSaveSnapshot) btnSaveSnapshot.addEventListener('click', handleSaveSnapshot);

  const modalOpenUrl = $('modal-open-url');
  if (modalOpenUrl) modalOpenUrl.addEventListener('click', handleOpenUrl);

  // 缩放按钮
  const btnZoomIn = $('btn-zoom-in');
  if (btnZoomIn) btnZoomIn.addEventListener('click', () => zoomBy(1.25));

  const btnZoomOut = $('btn-zoom-out');
  if (btnZoomOut) btnZoomOut.addEventListener('click', () => zoomBy(0.8));

  const btnZoomFit = $('btn-zoom-fit');
  if (btnZoomFit) btnZoomFit.addEventListener('click', zoomFit);

  // 标签页切换
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // 全局复制按钮（参数面板）
  document.addEventListener('click', handleCopyClick);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
  });

  // 鼠标移出 popup 窗口 / popup 失焦 / popup 关闭时，清除页面高亮
  document.addEventListener('mouseleave', clearPageIframeHighlight);
  window.addEventListener('blur', clearPageIframeHighlight);
  window.addEventListener('beforeunload', clearPageIframeHighlight);

  // 初始化缩放交互
  initZoomInteraction();
}

// ===== 扫描 iframe =====
async function handleScan() {
  if (!currentTabId) { showState('empty'); return; }

  showState('loading');
  $('btn-scan').disabled = true;

  try {
    // 直接注入函数到页面执行，不依赖 content script 是否已注入
    const injected = await chrome.scripting.executeScript({
      target: { tabId: currentTabId },
      func: collectIframes,
    });

    const rawList = injected[0]?.result || [];
    // 过滤无效元素：src 为空且无 srcdoc 的 iframe 视为无效，不展示
    iframeList = rawList.filter(({ src, srcdoc }) => src || srcdoc);
    renderIframeList(iframeList);

    if (iframeList.length === 0) {
      showState('empty');
    } else {
      $('result-count').textContent = iframeList.length;
      showState('result');
    }
  } catch (err) {
    // 将真实错误原因显示给用户，方便排查（如 chrome:// 页面无法注入等）
    showState('error', err.message);
    console.error('扫描失败:', err);
  } finally {
    $('btn-scan').disabled = false;
  }
}

/** 在页面上下文中执行：收集所有 iframe 信息（不经过消息通道） */
function collectIframes() {
  const iframes = document.querySelectorAll('iframe');
  return Array.from(iframes).map((iframe, index) => {
    const rect = iframe.getBoundingClientRect();
    const src  = iframe.src || iframe.getAttribute('src') || '';
    return {
      index,
      src,
      srcdoc   : iframe.hasAttribute('srcdoc'),
      id       : iframe.id    || '',
      name     : iframe.name  || '',
      title    : iframe.title || '',
      width    : Math.round(rect.width),
      height   : Math.round(rect.height),
      inViewport: (
        rect.top    >= 0 &&
        rect.left   >= 0 &&
        rect.bottom <= window.innerHeight &&
        rect.right  <= window.innerWidth
      ),
    };
  });
}

// ===== 渲染卡片列表 =====
function renderIframeList(list) {
  const container = $('iframe-list');
  container.innerHTML = '';

  if (list.length === 0) {
    container.innerHTML = `
      <div class="empty-list">
        <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.3">
          <rect x="4" y="4" width="40" height="40" rx="6" stroke-dasharray="4 3"/>
          <path d="M16 20h16M16 28h10" stroke-linecap="round"/>
        </svg>
        <div class="empty-list-title">页面中没有 iframe</div>
        <div class="empty-list-hint">当前页面未检测到任何 iframe 元素</div>
      </div>`;
    return;
  }

  list.forEach((iframe) => {
    container.appendChild(createIframeCard(iframe));
  });
}

function createIframeCard(iframe) {
  const { index, src, srcdoc, id, name, title, width, height } = iframe;
  const params = src ? parseUrlParams(src) : null;
  const cardOriginalSrc = src || '';

  const card = document.createElement('div');
  card.className = 'iframe-card';
  card.dataset.index = index;

  const sizeText = (width > 0 && height > 0) ? `${width} × ${height} px` : '尺寸未知';

  let srcBlockHtml = '';
  if (srcdoc) {
    srcBlockHtml = `<span class="srcdoc-badge">
      <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" style="width:11px;height:11px">
        <path d="M4 5l-3 2 3 2M10 5l3 2-3 2M8 3l-2 8" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      srcdoc（内联 HTML，无 URL）
    </span>`;
  } else if (!src) {
    srcBlockHtml = `<span class="card-empty-hint">src 为空</span>`;
  } else {
    srcBlockHtml = `<code class="card-src-url">${escHtml(src)}</code>`;
  }

  const copySrcBtn = src && !srcdoc
    ? `<button class="src-copy-btn" data-src="${escHtml(src)}" title="复制 src">
        <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8">
          <rect x="4" y="4" width="8" height="8" rx="1.2"/>
          <path d="M2 10V2h8" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
       </button>`
    : '';

  card.innerHTML = `
    <div class="card-header">
      <span class="card-index-badge">IFRAME #${index}</span>
      <span class="card-size">${escHtml(sizeText)}</span>
      <div class="card-actions">
        <button class="btn btn-sm btn-outline btn-detail" data-index="${index}">
          <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8">
            <circle cx="7" cy="7" r="5.5"/>
            <path d="M7 6v4M7 4.5v.5" stroke-linecap="round"/>
          </svg>
          详情 / 快照
        </button>
      </div>
    </div>
    <div class="card-body">

      <!-- ① SRC 区块 -->
      <div class="card-section">
        <div class="card-section-head">
          <span class="card-section-title">SRC</span>
          ${copySrcBtn}
        </div>
        <div class="card-section-content">${srcBlockHtml}</div>
      </div>

      <!-- ② 参数可编辑区块 -->
      ${src && !srcdoc ? `
      <div class="card-section">
        <div class="card-section-head">
          <span class="card-section-title">查询参数</span>
          <span class="card-param-count">${params ? params.entries.length : 0}</span>
          <button class="btn btn-sm btn-ghost card-add-param" title="添加参数">
            <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2" style="width:10px;height:10px;flex-shrink:0">
              <path d="M7 2v10M2 7h10" stroke-linecap="round"/>
            </svg>
            添加
          </button>
        </div>
        <div class="card-section-content card-params-content">
          <div class="card-param-rows"></div>
          <div class="card-no-params${params && params.entries.length > 0 ? ' hidden' : ''}">暂无查询参数，点击「添加」新增</div>
        </div>
      </div>` : ''}

    </div>
    <div class="card-footer">
      ${src && !srcdoc ? `
        <button class="btn btn-sm btn-primary btn-reload-iframe" data-index="${index}">
          <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8">
            <path d="M1.5 7A5.5 5.5 0 1 0 3.4 3.4" stroke-linecap="round"/>
            <path d="M1.5 2v3h3" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          页面重载
        </button>
        <button class="btn btn-sm btn-outline btn-open-src">
          <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8">
            <path d="M6 2H2a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V8"/>
            <path d="M9 1h4v4M13 1 7 7" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          预览地址
        </button>
      ` : ''}
    </div>
  `;

  // 填充可编辑参数行
  if (src && !srcdoc) {
    const rowsContainer = card.querySelector('.card-param-rows');
    if (params && params.entries.length > 0) {
      params.entries.forEach(([k, v]) => addCardParamRow(rowsContainer, k, v, card, cardOriginalSrc, false));
    }
  }

  // 事件绑定
  card.querySelector('.btn-detail')?.addEventListener('click', () => openModalAndCapture(index));
  card.querySelector('.src-copy-btn')?.addEventListener('click', (e) => {
    copyText(e.currentTarget.dataset.src);
  });
  card.querySelector('.card-add-param')?.addEventListener('click', () => {
    const container = card.querySelector('.card-param-rows');
    card.querySelector('.card-no-params')?.classList.add('hidden');
    addCardParamRow(container, '', '', card, cardOriginalSrc, true);
  });
  card.querySelector('.btn-reload-iframe')?.addEventListener('click', async () => {
    const confirmed = await showConfirm(
      `即将用当前参数重新加载页面中的 <strong>IFRAME #${index}</strong>，` +
      `该操作会直接替换页面对应元素的 <code>src</code> 并触发重新渲染，` +
      `<strong>无法撤销</strong>，确认继续？`,
      { title: '确认重载', confirmText: '确认重载', confirmClass: 'btn-warning', icon: 'reload' }
    );
    if (!confirmed) return;
    reloadCardIframe(card, index, cardOriginalSrc);
  });
  card.querySelector('.btn-open-src')?.addEventListener('click', () => {
    const url = getCurrentCardUrl(card, cardOriginalSrc);
    openIframePreview(url, width, height);
  });

  // 悬停高亮页面 iframe
  card.addEventListener('mouseenter', () => highlightPageIframe(index));
  card.addEventListener('mouseleave', () => clearPageIframeHighlight());

  return card;
}

// ===== 卡片参数编辑辅助函数 =====

/** 新增一行可编辑参数到卡片 */
function addCardParamRow(container, key, value, card, originalSrc, shouldFocus = true) {
  const row = document.createElement('div');
  row.className = 'param-row';
  row.innerHTML = `
    <div class="param-row-key">
      <input class="param-key-input" type="text" value="${escHtml(key)}" placeholder="参数名" spellcheck="false"/>
    </div>
    <div class="param-row-val">
      <input class="param-val-input" type="text" value="${escHtml(value)}" placeholder="参数值" spellcheck="false"/>
    </div>
    <div class="param-row-del">
      <button class="icon-btn danger" title="删除此参数">
        <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M2 2l10 10M12 2 2 12" stroke-linecap="round"/>
        </svg>
      </button>
    </div>`;

  row.querySelectorAll('input').forEach((inp) => {
    inp.addEventListener('input', () => refreshCardUrl(card, originalSrc));
  });

  row.querySelector('.icon-btn.danger').addEventListener('click', async function () {
    const keyVal = row.querySelector('.param-key-input')?.value || '该参数';
    const confirmed = await showConfirm(`确认删除参数 <strong>${escHtml(keyVal)}</strong> ？`);
    if (!confirmed) return;
    row.remove();
    if (container.querySelectorAll('.param-row').length === 0) {
      card.querySelector('.card-no-params')?.classList.remove('hidden');
    }
    refreshCardUrl(card, originalSrc);
    updateCardParamCount(card);
  });

  container.appendChild(row);
  updateCardParamCount(card);

  if (shouldFocus) {
    row.querySelector('.param-key-input').focus();
  }
}

/** 读取卡片所有参数行，重建 URL，同步更新 src 显示，返回新 URL */
function refreshCardUrl(card, originalSrc) {
  const rows = card.querySelectorAll('.card-param-rows .param-row');
  const parsed = parseUrlParams(originalSrc);
  const searchParams = new URLSearchParams();

  rows.forEach((row) => {
    const k = row.querySelector('.param-key-input').value.trim();
    const v = row.querySelector('.param-val-input').value;
    if (k) searchParams.append(k, v);
  });

  const hash = parsed.hash ? `#${parsed.hash}` : '';
  const query = searchParams.toString();
  const newUrl = parsed.base + (query ? `?${query}` : '') + hash;

  const srcEl = card.querySelector('.card-src-url');
  if (srcEl) srcEl.textContent = newUrl;

  updateCardParamCount(card);
  return newUrl;
}

/** 更新卡片参数计数徽章 */
function updateCardParamCount(card) {
  const count = card.querySelectorAll('.card-param-rows .param-row').length;
  const countEl = card.querySelector('.card-param-count');
  if (countEl) countEl.textContent = count;
}

/** 获取当前卡片 URL（含已编辑内容） */
function getCurrentCardUrl(card, originalSrc) {
  return refreshCardUrl(card, originalSrc);
}

/** 将当前编辑后的 URL 应用到页面 iframe 并重新加载 */
async function reloadCardIframe(card, index, originalSrc) {
  const newUrl = refreshCardUrl(card, originalSrc);
  const btn = card.querySelector('.btn-reload-iframe');
  if (btn) btn.disabled = true;

  if (iframeList[index]) {
    iframeList[index] = { ...iframeList[index], src: newUrl };
  }

  if (currentTabId) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: currentTabId },
        func: (idx, url) => {
          const iframes = document.querySelectorAll('iframe');
          if (iframes[idx]) iframes[idx].src = url;
        },
        args: [index, newUrl],
      });
      showToast('iframe 已重新加载', 'success');
    } catch {
      showToast('重新加载失败', 'error');
    }
  }

  if (btn) btn.disabled = false;
}

// ===== 页面 iframe 悬停高亮 =====

/**
 * 鼠标悬停卡片时，向页面注入高亮覆盖层
 * - 若 iframe 在视口外，先平滑滚动到中央，再定位覆盖层
 * - 80ms 防抖，避免快速扫过多卡片时频繁注入
 */
function highlightPageIframe(index) {
  clearTimeout(_highlightTimer);
  _highlightTimer = setTimeout(async () => {
    if (!currentTabId) return;
    try {
      await chrome.scripting.executeScript({
        target: { tabId: currentTabId },
        func: (idx) => {
          // 注入一次样式
          if (!document.getElementById('__ifi_style__')) {
            const s = document.createElement('style');
            s.id = '__ifi_style__';
            s.textContent = `
              #__ifi_hl__ {
                position: fixed;
                pointer-events: none;
                z-index: 2147483646;
                border: 2px solid #1d6ae5;
                border-radius: 4px;
                box-shadow: 0 0 0 4px rgba(29,106,229,0.18);
                animation: __ifi_pulse__ 1.8s ease-in-out infinite;
              }
              @keyframes __ifi_pulse__ {
                0%,100% { box-shadow: 0 0 0 4px rgba(29,106,229,0.18); }
                50%      { box-shadow: 0 0 0 8px rgba(29,106,229,0.08); }
              }
              #__ifi_hl_label__ {
                position: absolute;
                top: -24px; left: -2px;
                background: #1d6ae5;
                color: #fff;
                font: 600 11px/20px "Consolas","SF Mono",monospace;
                padding: 0 8px;
                border-radius: 4px 4px 4px 0;
                white-space: nowrap;
                letter-spacing: 0.3px;
              }
            `;
            document.head.appendChild(s);
          }

          const iframe = document.querySelectorAll('iframe')[idx];
          if (!iframe) return;

          function placeBox() {
            const r = iframe.getBoundingClientRect();
            let box = document.getElementById('__ifi_hl__');
            if (!box) {
              box = document.createElement('div');
              box.id = '__ifi_hl__';
              const lbl = document.createElement('div');
              lbl.id = '__ifi_hl_label__';
              box.appendChild(lbl);
              document.body.appendChild(box);
            }
            box.querySelector('#__ifi_hl_label__').textContent = `IFRAME #${idx}`;
            box.style.left   = (r.left - 3) + 'px';
            box.style.top    = (r.top  - 3) + 'px';
            box.style.width  = (r.width  + 6) + 'px';
            box.style.height = (r.height + 6) + 'px';
          }

          const r = iframe.getBoundingClientRect();
          const inView = r.top > -10 && r.bottom < window.innerHeight + 10
                      && r.left > -10 && r.right  < window.innerWidth  + 10;

          if (inView) {
            placeBox();
          } else {
            // 先滚动到视口中央，滚动完成后再定位高亮框
            iframe.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
            setTimeout(placeBox, 480);
          }
        },
        args: [index],
      });
    } catch { /* 页面可能无法注入，忽略 */ }
  }, 80);
}

/** 鼠标离开卡片 / popup 失焦 / popup 关闭时，移除页面高亮层 */
function clearPageIframeHighlight() {
  clearTimeout(_highlightTimer);
  if (!currentTabId) return;
  // 使用 sendMessage 发给 background 同步注入，确保 popup 关闭前能及时执行
  chrome.scripting.executeScript({
    target: { tabId: currentTabId },
    func: () => {
      document.getElementById('__ifi_hl__')?.remove();
      document.getElementById('__ifi_style__')?.remove();
    },
  }).catch(() => {});
}

// ===== 打开详情 Modal =====
function openModal(index) {
  const iframe = iframeList[index];
  if (!iframe) return;

  activeModalIndex = index;
  lastSnapshotUrl = '';

  // 标题
  $('modal-index').textContent = index;
  $('modal-title').textContent = iframe.title || iframe.id || iframe.name || `iframe #${index}`;

  // 打开链接按钮
  if (iframe.src && !iframe.srcdoc) {
    $('modal-open-url').style.display = '';
    $('modal-open-url').dataset.url = iframe.src;
  } else {
    $('modal-open-url').style.display = 'none';
  }

  // 重置快照面板
  resetSnapshotPanel();

  // 填充参数面板
  fillParamsPanel(iframe);

  // 填充属性面板
  fillInfoPanel(iframe);

  // 默认显示快照 tab
  switchTab('snapshot');

  $('snapshot-modal').classList.remove('hidden');
}

async function openModalAndCapture(index) {
  openModal(index);
  // 稍等模态框动画后自动触发截图
  setTimeout(() => handleCapture(), 150);
}

function closeModal() {
  $('snapshot-modal').classList.add('hidden');
  activeModalIndex = -1;
}

// ===== Tab 切换 =====
function switchTab(tabName) {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });
  document.querySelectorAll('.tab-panel').forEach((panel) => {
    panel.classList.toggle('active', panel.id === `panel-${tabName}`);
  });
}

// ===== 截图 =====
async function handleCapture() {
  if (activeModalIndex < 0 || !currentTabId) return;

  $('btn-capture').disabled = true;

  // 显示加载态，隐藏旧快照和缩放控件
  $('snap-idle').classList.add('hidden');
  $('snap-loading').classList.remove('hidden');
  $('zoom-viewport').classList.add('hidden');
  $('zoom-controls').classList.add('hidden');
  $('snapshot-size-hint').textContent = '滚轮缩放 · 拖拽平移 · 双击还原';

  try {
    // 1. 注入函数：将目标 iframe 滚动到视口并返回精确位置
    const captureIndex = activeModalIndex;
    const injected = await chrome.scripting.executeScript({
      target: { tabId: currentTabId },
      func: scrollAndGetRect,
      args: [captureIndex],
    });

    const rect = injected[0]?.result;
    if (!rect)                              throw new Error('无法定位 iframe 元素');
    if (rect.width <= 0 || rect.height <= 0) throw new Error('iframe 尺寸为零，无法截图');

    // 2. 让 background 截取整个 tab
    const result = await chrome.runtime.sendMessage({
      type: 'CAPTURE_TAB',
      tabId: currentTabId,
      windowId: currentWindowId,
    });

    if (result?.error)  throw new Error(result.error);
    if (!result?.dataUrl) throw new Error('截图失败：未返回图像数据');

    // 3. Canvas 裁剪 iframe 区域
    const croppedUrl = await cropImage(result.dataUrl, rect);

    // 4. 渲染到缩放视口
    lastSnapshotUrl = croppedUrl;
    const img = $('snapshot-img');

    await new Promise((resolve) => {
      img.onload = resolve;
      img.src = croppedUrl;
    });

    // 显示视口，截图按钮缩小贴左，展开缩放控件
    $('zoom-viewport').classList.remove('hidden');
    $('btn-capture').classList.remove('btn-full');
    $('btn-capture').classList.add('btn-sm');
    $('zoom-controls').classList.remove('hidden');
    $('snapshot-size-hint').textContent =
      `原始尺寸 ${img.naturalWidth} × ${img.naturalHeight} px · 滚轮缩放 · 双击还原`;

    // 计算适应比例并居中展示
    zoomFit();

  } catch (err) {
    // 失败时重置为全宽截图按钮初始态
    $('snap-idle').classList.remove('hidden');
    $('zoom-controls').classList.add('hidden');
    $('btn-capture').classList.add('btn-full');
    $('btn-capture').classList.remove('btn-sm');
    $('snapshot-size-hint').textContent = `截图失败：${err.message}`;
    console.error('截图错误:', err);
  } finally {
    $('snap-loading').classList.add('hidden');
    $('btn-capture').disabled = false;
  }
}

/**
 * 用 Canvas 将截图裁剪到 iframe 区域
 * @param {string} dataUrl 全屏截图
 * @param {{x,y,width,height,devicePixelRatio}} rect iframe 在视口中的位置（CSS px）
 */
function cropImage(dataUrl, rect) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const dpr = rect.devicePixelRatio || 1;
      // 源坐标需乘以 dpr（截图分辨率 = 视口尺寸 × dpr）
      const sx = Math.round(rect.x * dpr);
      const sy = Math.round(rect.y * dpr);
      const sw = Math.round(rect.width * dpr);
      const sh = Math.round(rect.height * dpr);

      // 防止越界
      const clampedSw = Math.min(sw, img.width - sx);
      const clampedSh = Math.min(sh, img.height - sy);

      if (clampedSw <= 0 || clampedSh <= 0) {
        reject(new Error('裁剪区域超出截图范围'));
        return;
      }

      const canvas = document.createElement('canvas');
      canvas.width = clampedSw;
      canvas.height = clampedSh;

      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, sx, sy, clampedSw, clampedSh, 0, 0, clampedSw, clampedSh);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => reject(new Error('截图图像加载失败'));
    img.src = dataUrl;
  });
}

// ===== 保存截图 =====
function handleSaveSnapshot() {
  if (!lastSnapshotUrl) return;
  const iframe = iframeList[activeModalIndex];
  const domain = iframe?.src ? getDomain(iframe.src) : 'iframe';
  const filename = `iframe_${activeModalIndex}_${domain}_${Date.now()}.png`;

  const a = document.createElement('a');
  a.href = lastSnapshotUrl;
  a.download = filename;
  a.click();
}

function handleOpenUrl(e) {
  const url = e.currentTarget.dataset.url;
  if (url) chrome.tabs.create({ url });
}

// ===== 参数编辑器状态 =====
let peOriginalSrc = '';   // 原始 src，用于对比是否修改

// ===== 填充 URL 参数面板（只读展示版）=====
function fillParamsPanel(iframe) {
  peOriginalSrc = iframe.src || '';

  if (!iframe.src || iframe.srcdoc) {
    $('param-base-url').textContent = iframe.srcdoc ? '（srcdoc 内联 HTML，无 URL）' : '（无 src）';
    $('param-rows').innerHTML = '';
    $('no-params').classList.remove('hidden');
    $('param-tab-count').textContent = '0';
    $('params-hint').textContent = '0';
    $('pe-result-url').textContent = '—';
    const copyFullBtn = $('btn-copy-full-url');
    if (copyFullBtn) copyFullBtn.onclick = null;
    return;
  }

  const parsed = parseUrlParams(iframe.src);
  // Base URL 显示完整路径（含协议和域名，不含查询参数）
  $('param-base-url').textContent = parsed.base;
  $('param-tab-count').textContent = parsed.entries.length;
  $('params-hint').textContent = parsed.entries.length;

  // 复制 Base URL 按钮
  const copyBaseBtn = document.querySelector('[data-copy="base-url"]');
  if (copyBaseBtn) copyBaseBtn.onclick = () => copyText(parsed.base);

  // 渲染只读参数行
  renderParamRows(parsed.entries);

  // Full URL 显示完整链接
  $('pe-result-url').textContent = iframe.src;

  // 复制完整链接按钮
  const copyFullBtn = $('btn-copy-full-url');
  if (copyFullBtn) copyFullBtn.onclick = () => copyText(iframe.src);
}

/** 渲染全部参数行（只读） */
function renderParamRows(entries) {
  const container = $('param-rows');
  container.innerHTML = '';

  if (entries.length === 0) {
    $('no-params').classList.remove('hidden');
  } else {
    $('no-params').classList.add('hidden');
    entries.forEach(([k, v]) => addParamRow(k, v));
  }
}

/** 新增一行只读参数展示 */
function addParamRow(key = '', value = '') {
  $('no-params').classList.add('hidden');

  const row = document.createElement('div');
  row.className = 'param-row param-row-ro';
  row.innerHTML = `
    <div class="param-row-key">
      <span class="param-key-ro">${escHtml(key)}</span>
    </div>
    <div class="param-row-val">
      <span class="param-val-ro">${escHtml(value)}</span>
    </div>
    <div class="param-row-copy">
      <button class="icon-btn" title="复制参数值" data-val="${escHtml(value)}">
        <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8">
          <rect x="4" y="4" width="8" height="8" rx="1.2"/>
          <path d="M2 10V2h8" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
    </div>`;

  row.querySelector('.icon-btn').addEventListener('click', function () {
    copyText(this.dataset.val);
  });

  $('param-rows').appendChild(row);
}

/** 从所有参数行读取当前值，重建 URL 并显示 */
function refreshResultUrl() {
  const parsed = parseUrlParams(peOriginalSrc);
  const rows   = $('param-rows').querySelectorAll('.param-row');
  const params = new URLSearchParams();

  rows.forEach((row) => {
    const k = row.querySelector('.param-key-input').value.trim();
    const v = row.querySelector('.param-val-input').value;
    if (k) params.append(k, v);
  });

  const hash     = parsed.hash ? `#${parsed.hash}` : '';
  const query    = params.toString();
  const newUrl   = parsed.base + (query ? `?${query}` : '') + hash;

  $('pe-result-url').textContent = newUrl;

  // 对比是否有修改
  const changed = (newUrl !== peOriginalSrc);
  $('pe-changed-badge').classList.toggle('hidden', !changed);
  $('param-tab-count').textContent = rows.length;
  $('params-hint').textContent     = rows.length;
}

/**
 * 「保存更改」：将编辑后的 URL 注入页面 iframe，更新本地记录
 * 不切换 tab，不触发截图
 */
async function handleSaveParams() {
  const newUrl = $('pe-result-url').textContent;
  if (!newUrl || newUrl === '—') return;

  const btn = $('btn-apply-save');
  btn.disabled = true;

  // 更新本地 iframeList
  if (activeModalIndex >= 0 && iframeList[activeModalIndex]) {
    iframeList[activeModalIndex] = { ...iframeList[activeModalIndex], src: newUrl };
    peOriginalSrc = newUrl;
    $('pe-changed-badge').classList.add('hidden');
    // 同步更新 base-url 显示
    const parsed = parseUrlParams(newUrl);
    $('param-base-url').textContent = parsed.base;
  }

  // 将页面中 iframe 的 src 更新
  if (currentTabId) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: currentTabId },
        func: (index, url) => {
          const iframes = document.querySelectorAll('iframe');
          if (iframes[index]) iframes[index].src = url;
        },
        args: [activeModalIndex, newUrl],
      });
      showToast('已更新 iframe src', 'success');
    } catch {
      showToast('页面 iframe src 更新失败', 'error');
    }
  }

  btn.disabled = false;
}

/** 显示 toast（兼容旧调用） */
function showToast(msg, type = '') {
  const tip = $('copy-tip');
  tip.textContent = msg;
  tip.className = `copy-tip${type === 'error' ? ' tip-error' : ''}`;
  tip.classList.remove('hidden');
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => tip.classList.add('hidden'), 1800);
}

// ===== 填充属性信息面板 =====
function fillInfoPanel(iframe) {
  const rows = [
    ['index',      `#${iframe.index}`],
    ['src',        iframe.src || null],
    ['srcdoc',     iframe.srcdoc],
    ['id',         iframe.id || null],
    ['name',       iframe.name || null],
    ['title',      iframe.title || null],
    ['宽度 (CSS)',  iframe.width ? `${iframe.width} px` : null],
    ['高度 (CSS)',  iframe.height ? `${iframe.height} px` : null],
    ['在视口内',    iframe.inViewport],
    ['域名',        iframe.src ? getDomain(iframe.src) : null],
    ['协议',        iframe.src ? getProtocol(iframe.src) : null],
  ];

  const tbody = $('info-table').querySelector('tbody');
  tbody.innerHTML = '';

  rows.forEach(([label, value]) => {
    const tr = document.createElement('tr');
    let valHtml;
    if (value === null || value === undefined || value === '') {
      valHtml = `<span class="info-val-empty">—</span>`;
    } else if (value === true) {
      valHtml = `<span class="info-val-bool-true">true</span>`;
    } else if (value === false) {
      valHtml = `<span class="info-val-bool-false">false</span>`;
    } else {
      valHtml = escHtml(String(value));
    }
    tr.innerHTML = `<td>${escHtml(label)}</td><td>${valHtml}</td>`;
    tbody.appendChild(tr);
  });
}

// ===== 重置快照面板 =====
function resetSnapshotPanel() {
  $('snap-idle').classList.remove('hidden');
  $('snap-loading').classList.add('hidden');
  $('zoom-viewport').classList.add('hidden');
  $('zoom-controls').classList.add('hidden');
  $('btn-capture').classList.add('btn-full');
  $('btn-capture').classList.remove('btn-sm');
  $('snapshot-size-hint').textContent = '滚轮缩放 · 拖拽平移 · 双击还原';
  lastSnapshotUrl = '';
}

// ===== 全局复制点击处理 =====
function handleCopyClick(e) {
  const btn = e.target.closest('.copy-btn[data-val]');
  if (btn) copyText(btn.dataset.val);
}

// ===== URL 解析 =====
function parseUrlParams(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const entries = [...url.searchParams.entries()];
    return {
      base: url.origin + url.pathname,
      entries,
      hash: url.hash ? url.hash.slice(1) : '',
    };
  } catch {
    return { base: rawUrl, entries: [], hash: '' };
  }
}

// ===== 工具 =====
function getDomain(url) {
  try { return new URL(url).hostname; } catch { return url; }
}

function getProtocol(url) {
  try { return new URL(url).protocol; } catch { return ''; }
}

function truncate(str, max) {
  if (!str) return '';
  return str.length > max ? str.slice(0, max) + '…' : str;
}

function copyText(text) {
  navigator.clipboard.writeText(text ?? '').then(() => showToast('已复制'));
}

function showState(name, errorMsg = '') {
  ['idle', 'loading', 'result', 'empty'].forEach((s) => {
    $(`state-${s}`).classList.toggle('hidden', s !== name);
  });
  if (name === 'error') {
    // 复用 empty 态，但改变文字提示
    $('state-empty').classList.remove('hidden');
    const hint = $('state-empty').querySelector('svg');
    const prev = $('state-empty').querySelector('.err-text');
    if (prev) prev.remove();
    const span = document.createElement('span');
    span.className = 'err-text';
    span.style.color = 'var(--danger, #e03e3e)';
    span.textContent = errorMsg || '无法注入脚本（该页面可能不支持扩展注入）';
    hint?.insertAdjacentElement('afterend', span);
  }
}

// ===== 缩放引擎 =====

/** 缩放状态（transform-origin: 0 0 坐标系） */
const zoom = { scale: 1, tx: 0, ty: 0, fitScale: 1 };

/** 将变换写入 img 元素 */
function applyTransform() {
  $('snapshot-img').style.transform =
    `translate(${zoom.tx}px, ${zoom.ty}px) scale(${zoom.scale})`;
  $('zoom-label').textContent = `${Math.round(zoom.scale * 100)}%`;
}

/** 以容器为基准，计算让图片完整居中的适应比例 */
function zoomFit() {
  const vp  = $('zoom-viewport');
  const img = $('snapshot-img');
  if (!img.naturalWidth) return;

  const scaleX = vp.clientWidth  / img.naturalWidth;
  const scaleY = vp.clientHeight / img.naturalHeight;
  // 取较小值保证完整显示，但不超过 1（不放大小图）
  zoom.fitScale = Math.min(scaleX, scaleY, 1);
  zoom.scale    = zoom.fitScale;

  // 居中
  zoom.tx = (vp.clientWidth  - img.naturalWidth  * zoom.scale) / 2;
  zoom.ty = (vp.clientHeight - img.naturalHeight * zoom.scale) / 2;
  applyTransform();
}

/** 以视口中心为基点缩放 */
function zoomBy(factor) {
  const vp       = $('zoom-viewport');
  const centerX  = vp.clientWidth  / 2;
  const centerY  = vp.clientHeight / 2;
  zoomAtPoint(zoom.scale * factor, centerX, centerY);
}

/** 以指定视口坐标为锚点缩放 */
function zoomAtPoint(newScale, vpX, vpY) {
  const MIN = 0.05, MAX = 10;
  newScale = Math.max(MIN, Math.min(MAX, newScale));

  // 保持 vpX/vpY 在图像上对应的像素不变：
  // imgX = (vpX - tx) / scale  →  vpX - imgX * newScale
  const imgX = (vpX - zoom.tx) / zoom.scale;
  const imgY = (vpY - zoom.ty) / zoom.scale;

  zoom.tx    = vpX - imgX * newScale;
  zoom.ty    = vpY - imgY * newScale;
  zoom.scale = newScale;
  applyTransform();
}

/** 注册缩放 & 拖拽交互（只调用一次） */
function initZoomInteraction() {
  const vp = $('zoom-viewport');

  // ── 滚轮缩放 ──
  vp.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect   = vp.getBoundingClientRect();
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    zoomAtPoint(zoom.scale * factor, e.clientX - rect.left, e.clientY - rect.top);
  }, { passive: false });

  // ── 拖拽平移 ──
  let drag = null;
  vp.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    drag = { startX: e.clientX, startY: e.clientY, tx0: zoom.tx, ty0: zoom.ty };
    vp.classList.add('dragging');
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!drag) return;
    zoom.tx = drag.tx0 + (e.clientX - drag.startX);
    zoom.ty = drag.ty0 + (e.clientY - drag.startY);
    applyTransform();
  });
  window.addEventListener('mouseup', () => {
    drag = null;
    vp.classList.remove('dragging');
  });

  // ── 双击还原 ──
  vp.addEventListener('dblclick', zoomFit);
}

/**
 * 在页面上下文中执行：将第 index 个 iframe 滚动到视口中央，
 * 等待渲染稳定后返回其可见区域坐标（用于截图裁剪）
 */
function scrollAndGetRect(index) {
  return new Promise((resolve) => {
    const iframes = document.querySelectorAll('iframe');
    const iframe  = iframes[index];

    if (!iframe) { resolve(null); return; }

    iframe.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });

    // 等待浏览器完成滚动 + 重新布局
    requestAnimationFrame(() => {
      setTimeout(() => {
        const rect = iframe.getBoundingClientRect();

        // 计算与视口的交集（iframe 可能只有部分可见）
        const x = Math.max(rect.left, 0);
        const y = Math.max(rect.top,  0);
        const r = Math.min(rect.right,  window.innerWidth);
        const b = Math.min(rect.bottom, window.innerHeight);

        resolve({
          x, y,
          width  : Math.round(r - x),
          height : Math.round(b - y),
          fullWidth  : Math.round(rect.width),
          fullHeight : Math.round(rect.height),
          devicePixelRatio: window.devicePixelRatio || 1,
        });
      }, 200);
    });
  });
}

// ===== iframe 内嵌预览弹窗 =====
function openIframePreview(url, origWidth = 0, origHeight = 0) {
  const modal      = $('iframe-preview-modal');
  const iframe     = $('ipm-iframe');
  const scaleWrap  = $('ipm-scale-wrap');
  const loading    = $('ipm-loading');
  const blocked    = $('ipm-blocked');
  const titleEl    = $('ipm-title');
  const urlEl      = $('ipm-url');
  const favicon    = $('ipm-favicon');
  const scaleBadge = $('ipm-scale-badge');

  /** 按原始尺寸渲染 iframe，等比缩放适应容器并居中 */
  function applyScale() {
    const body = modal.querySelector('.ipm-body');
    const bw = body.clientWidth;
    const bh = body.clientHeight;
    const iw = origWidth  > 0 ? origWidth  : bw;
    const ih = origHeight > 0 ? origHeight : bh;
    const scale = Math.min(bw / iw, bh / ih, 1);

    iframe.style.width        = `${iw}px`;
    iframe.style.height       = `${ih}px`;
    scaleWrap.style.width     = `${iw}px`;
    scaleWrap.style.height    = `${ih}px`;
    scaleWrap.style.transform = `scale(${scale})`;
    scaleWrap.style.left      = `${(bw - iw * scale) / 2}px`;
    scaleWrap.style.top       = `${(bh - ih * scale) / 2}px`;
    scaleBadge.textContent    = `${Math.round(scale * 100)}%`;
  }

  // 重置状态
  iframe.src = '';
  loading.classList.remove('hidden');
  blocked.classList.add('hidden');
  titleEl.textContent = '加载中...';
  urlEl.textContent = url;

  // 尝试从 URL 提取域名作为标题，并加载 favicon
  try {
    const u = new URL(url);
    titleEl.textContent = u.hostname;
    const faviconUrl = `${u.origin}/favicon.ico`;
    favicon.innerHTML = `<img src="${escHtml(faviconUrl)}" onerror="this.parentNode.innerHTML='<svg viewBox=\\'0 0 14 14\\' fill=\\'none\\' stroke=\\'currentColor\\' stroke-width=\\'1.8\\'><rect x=\\'1\\' y=\\'1\\' width=\\'12\\' height=\\'12\\' rx=\\'2\\'/><path d=\\'M1 5h12\\' stroke-linecap=\\'round\\'/><circle cx=\\'3.5\\' cy=\\'3\\' r=\\'0.7\\' fill=\\'currentColor\\' stroke=\\'none\\'/><circle cx=\\'5.5\\' cy=\\'3\\' r=\\'0.7\\' fill=\\'currentColor\\' stroke=\\'none\\'/></svg>'" />`;
  } catch (_) {}

  modal.classList.remove('hidden');

  // 等 DOM 渲染后再取容器尺寸
  requestAnimationFrame(applyScale);

  // 加载超时检测（部分跨域页面 load 事件不会触发）
  let loadTimer = setTimeout(() => {
    loading.classList.add('hidden');
    blocked.classList.remove('hidden');
  }, 8000);

  const onLoad = () => {
    clearTimeout(loadTimer);
    loading.classList.add('hidden');
    applyScale();
    // 尝试读取 iframe 标题（同源时有效）
    try {
      const t = iframe.contentDocument?.title;
      if (t) titleEl.textContent = t;
    } catch (_) {}
  };

  const onError = () => {
    clearTimeout(loadTimer);
    loading.classList.add('hidden');
    blocked.classList.remove('hidden');
  };

  iframe.removeEventListener('load', iframe._loadHandler);
  iframe.removeEventListener('error', iframe._errorHandler);
  iframe._loadHandler  = onLoad;
  iframe._errorHandler = onError;
  iframe.addEventListener('load', onLoad);
  iframe.addEventListener('error', onError);

  iframe.src = url;

  // 头部按钮事件
  $('ipm-btn-reload').onclick = () => {
    loading.classList.remove('hidden');
    blocked.classList.add('hidden');
    iframe.src = url;
    loadTimer = setTimeout(() => {
      loading.classList.add('hidden');
      blocked.classList.remove('hidden');
    }, 8000);
  };
  $('ipm-btn-newtab').onclick  = () => chrome.tabs.create({ url });
  $('ipm-btn-fallback').onclick = () => chrome.tabs.create({ url });
  $('ipm-btn-close').onclick = () => {
    modal.classList.add('hidden');
    iframe.src = '';
    clearTimeout(loadTimer);
  };
}

// ===== 启动 =====
init();
