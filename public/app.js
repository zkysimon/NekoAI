const STORAGE_KEY = 'nekoai.conversations';
const ACCESS_KEY_STORAGE = 'nekoai.accessKey';
const MODEL_STORAGE = 'nekoai.selectedModel';
const API_BASE_URL = (window.NEKOAI_CONFIG?.API_BASE_URL || '').replace(/\/$/, '');
const MAX_ATTACHMENT_SIZE = 15 * 1024 * 1024;
const MAX_CONTEXT_CHARS = 256 * 1024;
const MAX_STORED_TRACE_ITEMS = 8;
const MAX_STORED_TEXT_CHARS = 400;
const MAX_STORED_SOURCES = 5;
const MAX_DOC_IMAGES = 12;
const MAX_DOC_IMAGE_BYTES = 3 * 1024 * 1024;
const MAX_PDF_PAGES = 10;
const PDF_RENDER_SCALE = 1.6;

const state = {
  conversations: loadConversations(),
  activeId: null,
  models: [],
  selectedModel: localStorage.getItem(MODEL_STORAGE) || '',
  sending: false,
  pendingAttachments: [],
  authenticated: false,
  liveThinkTimer: null,
  searchAvailable: true,
  conversionAvailable: true,
};

const loginScreenEl = document.getElementById('loginScreen');
const appShellEl = document.getElementById('appShell');
const loginFormEl = document.getElementById('loginForm');
const loginAccessKeyInputEl = document.getElementById('loginAccessKeyInput');
const loginErrorEl = document.getElementById('loginError');
const conversationListEl = document.getElementById('conversationList');
const messagesEl = document.getElementById('messages');
const chatFormEl = document.getElementById('chatForm');
const messageInputEl = document.getElementById('messageInput');
const newChatBtnEl = document.getElementById('newChatBtn');
const sendBtnEl = document.getElementById('sendBtn');
const clearAllBtnEl = document.getElementById('clearAllBtn');
const modelDropdownEl = document.getElementById('modelDropdown');
const modelDropdownButtonEl = document.getElementById('modelDropdownButton');
const modelDropdownMenuEl = document.getElementById('modelDropdownMenu');
const modelDropdownLabelEl = document.getElementById('modelDropdownLabel');
const mobileSidebarToggleEl = document.getElementById('mobileSidebarToggle');
const mobileSidebarBackdropEl = document.getElementById('mobileSidebarBackdrop');
const fileInputEl = document.getElementById('fileInput');
const attachBtnEl = document.getElementById('attachBtn');
const attachmentListEl = document.getElementById('attachmentList');
const stopBtnEl = document.getElementById('stopBtn');
const exportBtnEl = document.getElementById('exportBtn');
const modalRootEl = document.getElementById('modalRoot');
const modalBackdropEl = document.getElementById('modalBackdrop');
const modalCardEl = document.getElementById('modalCard');
const modalIconEl = document.getElementById('modalIcon');
const modalTitleEl = document.getElementById('modalTitle');
const modalBodyEl = document.getElementById('modalBody');
const modalActionsEl = document.getElementById('modalActions');
const toastRootEl = document.getElementById('toastRoot');

function boot() {
  applyThemeByTime();

  const savedKey = localStorage.getItem(ACCESS_KEY_STORAGE) || '';
  loginAccessKeyInputEl.value = savedKey;

  if (!state.conversations.length) {
    const id = createConversation();
    state.activeId = id;
  } else {
    state.activeId = state.conversations[0].id;
  }

  bindEvents();
  autoResizeTextarea();
  renderConversationList();
  renderMessages();
  renderAttachments();
  renderModelDropdown();
  updateSendingState();

  if (savedKey) {
    loginWithKey(savedKey, false);
  } else {
    showLogin();
  }
}

function bindEvents() {
  loginFormEl.addEventListener('submit', async (event) => {
    event.preventDefault();
    const key = loginAccessKeyInputEl.value.trim();
    if (!key) {
      setLoginError('请先输入访问密钥');
      return;
    }
    await loginWithKey(key, true);
  });

  newChatBtnEl.addEventListener('click', () => {
    state.activeId = createConversation();
    persistConversations();
    renderConversationList();
    renderMessages();
    renderModelDropdown();
    focusComposer();
  });

  clearAllBtnEl.addEventListener('click', async () => {
    if (!state.conversations.length) return;
    const confirmed = await confirmDialog({
      icon: '🗑️',
      title: '清空全部会话',
      message: `将删除全部 ${state.conversations.length} 个会话，此操作无法恢复。`,
      confirmLabel: '全部清空',
      danger: true,
    });
    if (!confirmed) return;

    state.conversations = [];
    state.activeId = createConversation();
    persistConversations();
    renderConversationList();
    renderMessages();
    renderModelDropdown();
    focusComposer();
    showToast('已清空全部会话', 'success');
  });

  modelDropdownButtonEl.addEventListener('click', () => {
    if (!state.models.length) return;
    const expanded = modelDropdownEl.classList.toggle('open');
    modelDropdownButtonEl.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  });

  document.addEventListener('click', (event) => {
    if (!modelDropdownEl.contains(event.target)) {
      modelDropdownEl.classList.remove('open');
      modelDropdownButtonEl.setAttribute('aria-expanded', 'false');
    }
  });

  mobileSidebarToggleEl?.addEventListener('click', () => {
    appShellEl.classList.add('mobile-sidebar-open');
    mobileSidebarBackdropEl?.classList.remove('hidden');
  });

  mobileSidebarBackdropEl?.addEventListener('click', () => {
    closeMobileSidebar();
  });


  fileInputEl.addEventListener('change', async () => {
    const files = Array.from(fileInputEl.files || []);
    const accessKey = localStorage.getItem(ACCESS_KEY_STORAGE) || '';
    await addPendingFiles(files, accessKey);
    fileInputEl.value = '';
  });

  stopBtnEl.addEventListener('click', () => {
    if (state.abortController) {
      state.abortController.abort();
    }
  });

  exportBtnEl.addEventListener('click', () => {
    exportConversation();
  });

  modalBackdropEl?.addEventListener('click', () => {
    if (modalRootEl.dataset.dismissible === '1') closeModal(false);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !modalRootEl.classList.contains('hidden')) {
      if (modalRootEl.dataset.dismissible === '1') closeModal(false);
    }
  });

  messageInputEl.addEventListener('input', () => {
    autoResizeTextarea();
  });

  messageInputEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      chatFormEl.requestSubmit();
    }
  });

  chatFormEl.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (state.sending) return;

    const text = messageInputEl.value.trim();
    if (!text && !state.pendingAttachments.length) return;

    const accessKey = localStorage.getItem(ACCESS_KEY_STORAGE) || '';
    if (!accessKey) {
      showLogin();
      return;
    }

    const model = state.selectedModel;
    if (!model) {
      noticeDialog({ title: '没有可用模型', message: '当前没有可用模型，请先刷新页面重新加载模型列表。' });
      return;
    }

    const contextSize = estimateContextSize(getActiveConversation(), text);
    if (contextSize > MAX_CONTEXT_CHARS) {
      const startNew = await confirmDialog({
        icon: '📏',
        title: '会话过长',
        message:
          `当前会话内容约 ${formatBytes(contextSize)}，已超过 ${formatBytes(MAX_CONTEXT_CHARS)} 上限。\n\n` +
          '继续发送可能失败或产生高额费用，建议新开一个会话。是否现在新建会话？',
        confirmLabel: '新建会话',
        cancelLabel: '继续发送',
        danger: false,
      });
      if (startNew) {
        state.activeId = createConversation();
        persistConversations();
        renderConversationList();
        renderMessages();
        renderModelDropdown();
        focusComposer();
        return;
      }
    }

    const conversation = getActiveConversation();
    conversation.updatedAt = Date.now();
    conversation.model = model;

    const userMessage = {
      role: 'user',
      content: text,
      createdAt: Date.now(),
      attachments: state.pendingAttachments.map((item) => ({
        name: item.name,
        type: item.type,
        size: item.size,
        kind: item.kind,
      })),
    };

    conversation.messages.push(userMessage);

    if (!conversation.title || conversation.title === '新会话') {
      conversation.title = (text || state.pendingAttachments[0]?.name || '新会话').slice(0, 24);
    }

    const assistantMessage = { role: 'assistant', content: '', createdAt: Date.now() };
    conversation.messages.push(assistantMessage);

    const pendingAttachments = [...state.pendingAttachments];
    state.pendingAttachments = [];
    renderAttachments();
    messageInputEl.value = '';
    autoResizeTextarea();
    state.sending = true;
    updateSendingState();
    persistConversations();
    renderConversationList();
    renderMessages();

    try {
      await sendChat(accessKey, model, conversation, assistantMessage, pendingAttachments, text);
    } catch (error) {
      assistantMessage.content = `请求失败：${error.message}`;
    } finally {
      state.sending = false;
      updateSendingState();
      conversation.updatedAt = Date.now();
      persistConversations();
      renderConversationList();
      renderMessages();
      focusComposer();
    }
  });
}

async function loginWithKey(key, surfaceError = true) {
  setLoginError('');
  loginAccessKeyInputEl.value = key;

  try {
    const response = await fetch(`${API_BASE_URL}/api/models`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.error || '访问密钥无效');
    }

    localStorage.setItem(ACCESS_KEY_STORAGE, key);
    state.authenticated = true;
    state.models = Array.isArray(data.models) ? data.models : [];
    const activeConversation = getActiveConversation();
    const preferred = activeConversation?.model || state.selectedModel;
    state.selectedModel = state.models.find((item) => item.id === preferred)?.id || state.models[0]?.id || '';
    localStorage.setItem(MODEL_STORAGE, state.selectedModel);
    renderModelDropdown();
    showApp();
    focusComposer();
    refreshServerConfig(key);
    return true;
  } catch (error) {
    state.authenticated = false;
    state.models = [];
    state.selectedModel = '';
    localStorage.removeItem(MODEL_STORAGE);
    localStorage.removeItem(ACCESS_KEY_STORAGE);
    renderModelDropdown();
    if (surfaceError) {
      setLoginError(error.message || '登录失败');
      showLogin();
    }
    return false;
  }
}

function showLogin() {
  loginScreenEl.classList.remove('hidden');
  appShellEl.classList.add('hidden');
}

function showApp() {
  loginScreenEl.classList.add('hidden');
  appShellEl.classList.remove('hidden');
}

function closeMobileSidebar() {
  appShellEl.classList.remove('mobile-sidebar-open');
  mobileSidebarBackdropEl?.classList.add('hidden');
}

function setLoginError(text) {
  loginErrorEl.textContent = text || '';
}


async function refreshServerConfig(key) {
  try {
    const response = await fetch(`${API_BASE_URL}/api/config`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!response.ok) return;
    const data = await response.json().catch(() => ({}));
    state.searchAvailable = Boolean(data?.search?.enabled);
    if (data?.documentConversion) {
      state.conversionAvailable = Boolean(data.documentConversion.enabled);
    }
  } catch {
    // 配置读取失败时保持默认可用
  }
}

function renderModelDropdown() {
  const activeConversation = getActiveConversation();
  if (activeConversation?.model && state.models.find((item) => item.id === activeConversation.model)) {
    state.selectedModel = activeConversation.model;
  }

  const current = state.models.find((item) => item.id === state.selectedModel);
  modelDropdownLabelEl.textContent = current?.label || current?.id || '选择模型';
  modelDropdownMenuEl.innerHTML = '';
  modelDropdownButtonEl.disabled = !state.models.length;
  modelDropdownButtonEl.setAttribute('aria-expanded', modelDropdownEl.classList.contains('open') ? 'true' : 'false');

  if (!state.models.length) {
    modelDropdownEl.classList.remove('open');
    modelDropdownButtonEl.setAttribute('aria-expanded', 'false');
    const empty = document.createElement('div');
    empty.className = 'model-option empty';
    empty.textContent = '暂无模型';
    modelDropdownMenuEl.appendChild(empty);
    return;
  }

  state.models.forEach((model) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `model-option${model.id === state.selectedModel ? ' active' : ''}`;
    button.textContent = model.label || model.id;
    button.addEventListener('click', () => {
      state.selectedModel = model.id;
      localStorage.setItem(MODEL_STORAGE, model.id);
      const conversation = getActiveConversation();
      if (conversation) {
        conversation.model = model.id;
        conversation.updatedAt = Date.now();
        persistConversations();
        renderConversationList();
      }
      modelDropdownEl.classList.remove('open');
      modelDropdownButtonEl.setAttribute('aria-expanded', 'false');
      renderModelDropdown();
    });
    modelDropdownMenuEl.appendChild(button);
  });
}

async function addPendingFiles(files, accessKey) {
  for (const file of files) {
    if (file.size > MAX_ATTACHMENT_SIZE) {
      showToast(`${file.name} 超过 15MB，已跳过`, 'warn');
      continue;
    }

    const kind = getAttachmentKind(file);
    let parsedText = null;
    let parseError = null;
    let images = [];

    try {
      if (kind === 'archive') {
        parsedText = await extractArchiveText(file);
      } else if (kind === 'docx' || kind === 'xlsx' || kind === 'pptx') {
        const result = await extractOfficeContent(file, kind);
        parsedText = result.text;
        images = result.images;
      } else if (kind === 'pdf') {
        const result = await extractPdfContent(file);
        parsedText = result.text;
        images = result.images;
      } else if (kind === 'document') {
        parsedText = await extractServerDocument(file, accessKey);
      } else if (kind === 'text') {
        parsedText = await readFileAsText(file);
      }
    } catch (err) {
      parseError = err.message || String(err);
      console.warn('附件解析失败', file.name, err);
    }

    const dataUrl = await readFileAsDataURL(file);
    const base64 = dataUrl.split(',')[1] || '';
    state.pendingAttachments.push({
      id: crypto.randomUUID(),
      name: file.name,
      type: file.type || 'application/octet-stream',
      size: file.size,
      kind,
      dataUrl,
      base64,
      parsedText,
      parseError,
      images,
    });
  }

  renderAttachments();
}

async function extractOfficeContent(file, kind) {
  const arrayBuffer = await readFileAsArrayBuffer(file);

  if (kind === 'docx') {
    const result = await mammoth.extractRawText({ arrayBuffer });
    const images = await extractZipImages(arrayBuffer, /^word\/media\//i);
    return { text: (result.value || '').trim() || null, images };
  }

  if (kind === 'xlsx') {
    return {
      text: extractSpreadsheetText(arrayBuffer),
      images: await extractZipImages(arrayBuffer, /^xl\/media\//i),
    };
  }

  if (kind === 'pptx') {
    const { text, mediaOrder } = await extractPptxContent(arrayBuffer);
    const images = await extractZipImages(arrayBuffer, /^ppt\/media\//i, mediaOrder);
    return { text, images };
  }

  return { text: null, images: [] };
}

function extractSpreadsheetText(arrayBuffer) {
  const workbook = XLSX.read(arrayBuffer, { type: 'array' });
  const chunks = [];
  workbook.SheetNames.forEach((sheetName) => {
    const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[sheetName]);
    if (csv.trim()) chunks.push(`## Sheet: ${sheetName}\n${csv}`);
  });
  return chunks.join('\n\n').trim() || null;
}

// 提取 pptx 文字，并按「第几页用了哪张图」返回媒体文件顺序
async function extractPptxContent(arrayBuffer) {
  const zip = await JSZip.loadAsync(arrayBuffer);
  const slidePaths = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((a, b) => slideNumber(a) - slideNumber(b));

  const slides = [];
  const mediaOrder = [];
  const seen = new Set();

  for (const path of slidePaths) {
    const xml = await zip.file(path).async('string');
    const text = xmlToText(xml);
    if (text) slides.push(`## 第 ${slideNumber(path)} 页\n${text}`);

    // a:blip r:embed="rIdX" -> 记录该页图片资源
    const relPath = `ppt/slides/_rels/${path.split('/').pop()}.rels`;
    const relFile = zip.file(relPath);
    if (!relFile) continue;
    const relXml = await relFile.async('string');
    [...relXml.matchAll(/Id="([^"]+)"[^>]*Target="([^"]*media\/[^"]+)"/gi)].forEach((m) => {
      const target = m[2].replace(/^\.\.\//, 'ppt/').replace(/^\.\.\//, '');
      const normalized = target.startsWith('ppt/') ? target : `ppt/${target}`;
      if (seen.has(normalized)) return;
      seen.add(normalized);
      mediaOrder.push(normalized);
    });
  }

  const ordered = mediaOrder.filter((p) => /^ppt\/media\//i.test(p));
  return { text: slides.join('\n\n').trim() || null, mediaOrder: ordered };
}

// 按顺序提取 zip 里的图片并转成 data URL（带数量与体积上限）
async function extractZipImages(arrayBuffer, pattern, order = []) {
  if (typeof JSZip === 'undefined') return [];

  let zip;
  try {
    zip = await JSZip.loadAsync(arrayBuffer);
  } catch {
    return [];
  }

  const allPaths = Object.keys(zip.files).filter(
    (name) => pattern.test(name) && !zip.files[name].dir && isImagePath(name),
  );
  const paths = order && order.length
    ? [...order.filter((p) => allPaths.includes(p)), ...allPaths.filter((p) => !order.includes(p))]
    : allPaths;

  const images = [];
  let budget = MAX_DOC_IMAGE_BYTES * 4;

  for (const path of paths.slice(0, MAX_DOC_IMAGES * 2)) {
    if (images.length >= MAX_DOC_IMAGES) break;
    if (budget <= 0) break;

    let blob;
    try {
      blob = await zip.file(path).async('blob');
    } catch {
      continue;
    }
    const buffer = await blob.arrayBuffer();
    if (buffer.byteLength > MAX_DOC_IMAGE_BYTES) continue;
    budget -= buffer.byteLength;

    const mime = mimeFromPath(path) || blob.type || 'image/png';
    images.push({ name: path.split('/').pop(), dataUrl: `data:${mime};base64,${arrayBufferToBase64(buffer)}` });
  }

  return images;
}

function isImagePath(path) {
  return /\.(png|jpe?g|gif|webp|bmp|tiff?)$/i.test(path);
}

function mimeFromPath(path) {
  const ext = String(path).toLowerCase().split('.').pop();
  const map = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff' };
  return map[ext] || '';
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function canvasToDataUrl(canvas) {
  try {
    return canvas.toDataURL('image/jpeg', 0.82);
  } catch {
    return '';
  }
}

function slideNumber(path) {
  const match = String(path).match(/slide(\d+)\.xml$/i);
  return match ? Number(match[1]) : 0;
}

async function extractArchiveText(file) {
  const arrayBuffer = await readFileAsArrayBuffer(file);
  const zip = await JSZip.loadAsync(arrayBuffer);
  const entries = Object.values(zip.files).filter((entry) => !entry.dir);

  if (!entries.length) return null;

  const parts = [];
  const skipped = [];
  let budget = 400000;

  for (const entry of entries.slice(0, 100)) {
    const lower = entry.name.toLowerCase();
    const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.')) : '';

    if (TEXT_EXTENSIONS.includes(ext)) {
      const text = await entry.async('string');
      const clipped = text.slice(0, Math.min(text.length, 20000));
      budget -= clipped.length;
      parts.push(`### ${entry.name}\n\`\`\`\n${clipped}\n\`\`\``);
    } else {
      skipped.push(entry.name);
    }

    if (budget <= 0) break;
  }

  const summary = [`压缩包共 ${entries.length} 个文件。`];
  if (parts.length) summary.push('', '其中文本文件内容如下：', '', ...parts);
  if (skipped.length) {
    summary.push('', `未展开的二进制文件（${skipped.length} 个）：${skipped.slice(0, 30).join('、')}`);
  }

  return summary.join('\n').trim() || null;
}

async function extractPdfContent(file) {
  const arrayBuffer = await readFileAsArrayBuffer(file);
  const pdfjsLib = window['pdfjs-dist/build/pdf'];
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

  const pageTexts = [];
  const images = [];
  const renderPages = Math.min(pdf.numPages, MAX_PDF_PAGES);

  for (let i = 1; i <= pdf.numPages; i += 1) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    const pageText = textContent.items.map((item) => item.str).join(' ');
    if (pageText.trim()) pageTexts.push(`[第 ${i} 页]\n${pageText}`);

    if (i <= renderPages) {
      try {
        const viewport = page.getViewport({ scale: PDF_RENDER_SCALE });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const context = canvas.getContext('2d');
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: context, viewport }).promise;
        const dataUrl = canvasToDataUrl(canvas);
        if (dataUrl) images.push({ name: `page-${i}.jpg`, dataUrl });
        canvas.width = 0;
        canvas.height = 0;
      } catch (err) {
        console.warn(`PDF 第 ${i} 页渲染失败`, err);
      }
    }
  }

  return {
    text: pageTexts.join('\n\n').trim() || null,
    images,
  };
}

async function extractServerDocument(file, accessKey) {
  if (state.conversionAvailable === false || !accessKey) {
    return null;
  }

  const form = new FormData();
  form.append('files', file);

  let response;
  try {
    response = await fetch(`${API_BASE_URL}/api/convert`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessKey}` },
      body: form,
    });
  } catch (err) {
    throw new Error(`云端文档转换失败：${err.message}`);
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `云端文档转换失败（HTTP ${response.status}）`);
  }

  const result = Array.isArray(data?.results) ? data.results[0] : null;
  if (!result) return null;
  if (result.format === 'error') {
    throw new Error(result.error || '云端文档转换失败');
  }
  return (result.data || '').trim() || null;
}

function xmlToText(xml) {
  return String(xml || '')
    .replace(/<a:br\s*\/?>/gi, '\n')
    .replace(/<\/a:p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error(`读取文件失败：${file.name}`));
    reader.readAsText(file);
  });
}
function readFileAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error(`读取文件失败：${file.name}`));
    reader.readAsArrayBuffer(file);
  });
}

function renderAttachments() {
  attachmentListEl.innerHTML = '';
  if (!state.pendingAttachments.length) return;

  state.pendingAttachments.forEach((file) => {
    const item = document.createElement('div');
    const imageCount = Array.isArray(file.images) ? file.images.length : 0;
    const failed = file.parseError && file.parsedText == null && !imageCount;
    item.className = `attachment-chip${failed ? ' attachment-chip-error' : ''}`;
    const extras = [];
    if (imageCount) extras.push(`${imageCount} 张图`);
    if (failed) extras.push('解析失败');
    const meta = `${formatBytes(file.size)} · ${escapeHtml(file.kind)}${extras.length ? ` · ${extras.join(' · ')}` : ''}`;
    item.innerHTML = `
      <div class="attachment-chip-main">
        <div class="attachment-name">${escapeHtml(file.name)}</div>
        <div class="attachment-meta">${meta}</div>
      </div>
      <button class="attachment-remove" type="button">×</button>
    `;
    item.querySelector('.attachment-remove').addEventListener('click', () => {
      state.pendingAttachments = state.pendingAttachments.filter((entry) => entry.id !== file.id);
      renderAttachments();
    });
    attachmentListEl.appendChild(item);
  });
}

const MAX_AGENT_ROUNDS = 4;
const MAX_TOOL_RESULT_CHARS = 8000;
const MAX_CALLS_PER_ROUND = 2;
const MAX_SEARCHES_PER_MESSAGE = 4;
const MAX_FETCHES_PER_MESSAGE = 4;

function buildToolSpecs() {
  return [
    {
      type: 'function',
      function: {
        name: 'web_search',
        description:
          '联网搜索最新信息。只在问题确实依赖实时或近期数据时调用（新闻、天气、股价、比分、价格、最新版本、最近发生的事件、具体人物近况等）。' +
          '写作、翻译、代码、算法、数学计算、常识、闲聊、解释概念等请直接用你的知识回答，不要调用此工具。' +
          '调用前先想清楚是否真的需要联网；同一问题最多搜 3 次，换个措辞的相同查询不算新查询。',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string', description: '搜索关键词，尽量具体' } },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'web_fetch',
        description:
          '抓取指定网址的正文内容，用于阅读搜索结果中的具体页面。仅在摘要信息不足时使用，' +
          '同一网址不要重复抓取，最多抓 3 个页面。',
        parameters: {
          type: 'object',
          properties: { url: { type: 'string', description: '要抓取的 http(s) 网址' } },
          required: ['url'],
        },
      },
    },
  ];
}

async function sendChat(accessKey, model, conversation, assistantMessage, attachments, userText = '') {
  ensureTrace(assistantMessage);
  const toolsAvailable = state.searchAvailable !== false;
  const messages = buildChatPayload(model, conversation, assistantMessage, attachments).messages;
  const usedQueries = new Set();
  const usedUrls = new Set();

  // 先做一次兜底搜索：即使模型不会调用工具，也能拿到实时资料
  if (toolsAvailable && shouldSearchQuery(userText) && !attachments.length) {
    const query = userText.trim().slice(0, 200);
    const step = startStep(assistantMessage, { type: 'search', query });
    renderMessages();

    try {
      const search = await runWebSearch(accessKey, query);
      const results = Array.isArray(search?.results) ? search.results : [];
      finishStep(step, 'done', { results });
      assistantMessage.sources = results;
      usedQueries.add(query.toLowerCase().replace(/\s+/g, ' '));
    } catch (error) {
      finishStep(step, 'error', { error: error.message || '联网搜索失败' });
    }
    renderMessages();

    if (assistantMessage.sources?.length) {
      messages.unshift({ role: 'system', content: buildSearchSystemPrompt(assistantMessage.sources) });
      messages.unshift({
        role: 'system',
        content:
          '你能使用 web_search / web_fetch 工具。只在问题确实需要实时数据时才调用；写作、翻译、代码、算法、数学、常识等请直接回答，不要联网。' +
          '收到工具结果后应尽快给出最终回答，不要反复搜索相同内容。',
      });
    }
  }

  await streamAgent(accessKey, model, messages, assistantMessage, toolsAvailable, usedQueries, usedUrls);
  finishAssistant(assistantMessage);
}

async function streamAgent(accessKey, model, messages, assistantMessage, toolsAvailable, usedQueries, usedUrls) {
  let toolsEnabled = toolsAvailable;

  for (let round = 0; round < MAX_AGENT_ROUNDS; round += 1) {
    let result;
    try {
      result = await streamRound(accessKey, model, messages, assistantMessage, toolsEnabled);
    } catch (error) {
      if (toolsEnabled) {
        toolsEnabled = false;
        result = await streamRound(accessKey, model, messages, assistantMessage, false);
      } else {
        throw error;
      }
    }

    if (!result.toolCalls.length) {
      assistantMessage.content = result.content;
      return;
    }

    if (result.content.trim()) {
      const note = startStep(assistantMessage, { type: 'note' });
      finishStep(note, 'done', { text: result.content.trim() });
    }

    const normalized = result.toolCalls
      .slice(0, MAX_CALLS_PER_ROUND)
      .map((call, index) => normalizeToolCall(call, index));
    messages.push({
      role: 'assistant',
      content: result.content || '',
      // 必须用 OpenAI 规范的嵌套结构回传，扁平结构会被上游拒绝
      tool_calls: normalized.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments },
      })),
    });

    for (const call of normalized) {
      const plan = planToolCall(call, usedQueries, usedUrls);

      // 重复的查询/网址直接跳过，把结果换成提示，避免无意义地反复搜索
      if (plan.duplicate) {
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({ note: plan.reason }),
        });
        continue;
      }
      if (plan.limitReached) {
        const step = startStep(assistantMessage, stepFromToolCall(call));
        finishStep(step, 'error', { error: plan.reason });
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ error: plan.reason }) });
        renderMessages();
        continue;
      }

      const step = startStep(assistantMessage, stepFromToolCall(call));
      renderMessages();

      let output;
      try {
        output = await executeTool(accessKey, call);
        finishStep(step, output.error ? 'error' : 'done', output);
        if (!output.error) {
          if (plan.kind === 'fetch') usedUrls.add(plan.key);
          else usedQueries.add(plan.key);
        } else if (plan.kind === 'search') {
          // 失败的查询也记下来，避免重试同样的词
          usedQueries.add(plan.key);
        }
      } catch (error) {
        output = { error: error.message || '工具调用失败', content: JSON.stringify({ error: error.message || '工具调用失败' }) };
        finishStep(step, 'error', output);
      }

      messages.push({ role: 'tool', tool_call_id: call.id, content: output.content });
      renderMessages();
    }

    // 最后一轮之前提醒模型收尾，避免无限调用工具
    if (round === MAX_AGENT_ROUNDS - 2) {
      messages.push({ role: 'system', content: '信息已经足够，请基于已获取的资料直接给出最终回答，不要再调用工具。' });
    }
  }

  // 达到轮次上限仍未给答案：明确要求模型基于已获取资料直接给出结论
  messages.push({ role: 'system', content: '已经收集到足够资料，请立刻基于上述结果用文字给出最终回答，不要再调用任何工具。' });
  try {
    const final = await streamRound(accessKey, model, messages, assistantMessage, true, 'none');
    if (String(final.content || '').trim()) {
      assistantMessage.content = final.content;
    }
  } catch {
    // 忽略收尾失败
  }
  if (!String(assistantMessage.content || '').trim()) {
    assistantMessage.content = '（工具调用次数达到上限，未能生成最终回答。）';
  }
}

function shouldSearchQuery(text) {
  const value = String(text || '').trim();
  if (value.length < 4) return false;

  // 纯寒暄/闲聊不需要联网
  if (/^(你好|您好|hi|hello|hey|嗨|哈喽|在吗|谢谢|感谢|thanks|thank you|再见|bye)[!！。.~～\s]*$/i.test(value)) {
    return false;
  }

  // 写作/翻译/代码/数学等本地即可完成的请求，不必联网
  const skipPatterns = [
    /^(帮我|请|帮忙)?(写|改写|润色|翻译|总结下面|解释这段|实现|生成)(一[个下段遍篇])?(代码|函数|脚本|算法|正则|sql|python|javascript|typescript|java|c\+\+|golang|rust|html|css|组件)?/i,
    /(冒泡排序|快速排序|二叉树|链表|动态规划|递归|算法题|报错|debug|堆栈)/i,
    /^(翻译|把.+(翻译|译)成)/i,
    /^\s*[\d\s+\-*/()=<>.,]+$/, // 纯算式
  ];
  if (skipPatterns.some((re) => re.test(value))) return false;

  return true;
}

function planToolCall(call, usedQueries, usedUrls) {
  const args = parseToolArguments(call.arguments);

  if (call.name === 'web_fetch') {
    const url = String(args.url || '').trim();
    const key = url.toLowerCase().replace(/\/+$/, '');
    if (!url) return { kind: 'fetch', key, error: 'url 无效' };
    if (usedUrls.has(key)) return { duplicate: true, reason: '该网址已经抓取过，请改用其他来源或直接给出结论。' };
    if (usedUrls.size >= MAX_FETCHES_PER_MESSAGE) {
      return { kind: 'fetch', key, limitReached: true, reason: `本次回答最多抓取 ${MAX_FETCHES_PER_MESSAGE} 个网页，请基于已有资料作答。` };
    }
    return { kind: 'fetch', key };
  }

  const query = String(args.query || '').trim();
  const key = query.toLowerCase().replace(/\s+/g, ' ');
  if (!query) return { kind: 'search', key, error: 'query 为空' };
  if (usedQueries.has(key)) return { duplicate: true, reason: '这个关键词已经搜索过，请换个角度，或直接基于已有结果作答。' };
  if (usedQueries.size >= MAX_SEARCHES_PER_MESSAGE) {
    return { kind: 'search', key, limitReached: true, reason: `本次回答最多搜索 ${MAX_SEARCHES_PER_MESSAGE} 次，请基于已有资料作答。` };
  }
  return { kind: 'search', key };
}

async function streamRound(accessKey, model, messages, assistantMessage, toolsEnabled, toolChoice) {
  const body = { model, stream: true, messages };
  if (toolsEnabled) {
    body.tools = buildToolSpecs();
    if (toolChoice) body.tool_choice = toolChoice;
  }

  state.abortController = new AbortController();
  const signal = state.abortController.signal;

  let response;
  try {
    response = await fetch(`${API_BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessKey}` },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw err;
  }

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${response.status}`);
  }

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/event-stream')) {
    const data = await response.json();
    const message = data?.choices?.[0]?.message || {};
    if (typeof message.reasoning_content === 'string' && message.reasoning_content) {
      pushReasoning(assistantMessage, message.reasoning_content);
    }
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    return { content: extractAssistantText(data), toolCalls: calls, finishReason: data?.choices?.[0]?.finish_reason || '' };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let finishReason = '';
  const toolCalls = {};
  let anonToolIndex = 0;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() || '';

      for (const part of parts) {
        for (const line of part.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;

          try {
            const json = JSON.parse(data);
            const choice = json.choices?.[0];
            if (choice?.finish_reason) finishReason = choice.finish_reason;
            const delta = choice?.delta;
            if (!delta) continue;

            const reasoning = delta.reasoning_content ?? delta.reasoning;
            if (typeof reasoning === 'string' && reasoning) {
              pushReasoning(assistantMessage, reasoning);
              renderMessages();
            }

            if (typeof delta.content === 'string' && delta.content) {
              content += delta.content;
            } else if (Array.isArray(delta.content)) {
              content += delta.content.map((item) => item?.text || '').join('');
            }

            if (Array.isArray(delta.tool_calls)) {
              delta.tool_calls.forEach((call, position) => {
                // 没有 index 字段时按位置区分，避免多个并行调用被拼成一个
                let index;
                if (Number.isInteger(call.index)) {
                  index = call.index;
                } else if (call.id && call.function?.name) {
                  index = anonToolIndex++;
                } else {
                  index = anonToolIndex - 1;
                }
                if (index < 0) index = 0;

                toolCalls[index] = toolCalls[index] || { id: '', name: '', arguments: '' };
                if (call.id) toolCalls[index].id = call.id;
                if (call.function?.name) toolCalls[index].name = call.function.name;
                if (call.function?.arguments) toolCalls[index].arguments += call.function.arguments;
                void position;
              });
            }
          } catch {
            // ignore invalid chunk
          }
        }
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      closeRunningActivities(assistantMessage, 'stopped');
      throw err;
    }
    throw err;
  } finally {
    state.abortController = null;
  }

  closeReasoningStep(assistantMessage);
  return { content, toolCalls: Object.values(toolCalls), finishReason };
}

function normalizeToolCall(call, index) {
  let args = call.arguments ?? call.function?.arguments ?? '{}';
  if (typeof args !== 'string') {
    args = JSON.stringify(args);
  }

  // 上游要求回传的 arguments 必须是合法 JSON，否则整轮请求会 400
  try {
    const parsed = JSON.parse(args);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      args = '{}';
    }
  } catch {
    const repaired = parseToolArguments(args);
    args = Object.keys(repaired).length ? JSON.stringify(repaired) : '{}';
  }

  return {
    id: call.id || `call_${index}_${Date.now()}`,
    name: call.name || call.function?.name || 'unknown',
    arguments: args,
  };
}

function parseToolArguments(raw) {
  const text = String(raw || '').trim();
  if (!text) return {};

  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    // 有些模型会输出非法 JSON，尽量用正则把关键字段抠出来
    const extract = (key) => {
      const re = new RegExp(`["']?(?:${key})["']?\\s*[:=]\\s*(?:"([^"]+)"|'([^']+)'|([^\\n,}]+))`, 'i');
      const match = text.match(re);
      if (!match) return '';
      return (match[1] || match[2] || match[3] || '').trim();
    };

    const result = {};
    const query = extract('query|q');
    const url = extract('url|link|href');
    if (query) result.query = query;
    if (url) result.url = url;
    return result;
  }
}

function stepFromToolCall(call) {
  const args = parseToolArguments(call.arguments);

  if (call.name === 'web_fetch') {
    return { type: 'fetch', url: args.url || '', label: '抓取网页' };
  }
  return { type: 'search', query: args.query || '', label: '联网搜索' };
}

async function executeTool(accessKey, call) {
  const args = parseToolArguments(call.arguments);

  if (call.name === 'web_fetch') {
    const url = String(args.url || '').trim();
    if (!/^https?:\/\//i.test(url)) {
      return { error: 'url 无效', content: JSON.stringify({ error: 'url 无效' }) };
    }
    const data = await runWebFetch(accessKey, url);
    const text = String(data.text || '').slice(0, MAX_TOOL_RESULT_CHARS);
    return {
      title: data.title || url,
      url,
      excerpt: text.slice(0, 2000),
      content: JSON.stringify({ url, title: data.title || url, text }),
    };
  }

  const query = String(args.query || '').trim();
  if (!query) {
    return { error: 'query 为空', content: JSON.stringify({ error: 'query 为空' }) };
  }
  const data = await runWebSearch(accessKey, query);
  const results = (Array.isArray(data?.results) ? data.results : []).map((item) => ({
    title: item.title,
    url: item.url,
    text: String(item.text || '').slice(0, 1500),
  }));

  if (!results.length) {
    return {
      results,
      content: JSON.stringify({
        query,
        results: [],
        note: '该查询没有返回结果，请不要再重复搜索同类关键词，直接基于你已有的知识回答。',
      }),
    };
  }

  return {
    results,
    content: JSON.stringify({ query, results }),
  };
}

function startStep(message, step) {
  const activity = {
    id: crypto.randomUUID(),
    status: 'running',
    startedAt: Date.now(),
    ...step,
  };
  ensureTrace(message).push(activity);
  return activity;
}

function finishStep(activity, status, extra = {}) {
  Object.assign(activity, extra, { status });
  if (activity.startedAt) activity.ms = Date.now() - activity.startedAt;
}

function closeReasoningStep(message) {
  const activity = ensureTrace(message).find((item) => item.type === 'think' && item.status === 'running');
  if (activity) {
    activity.status = 'done';
    if (activity.startedAt) activity.ms = Date.now() - activity.startedAt;
  }
}

function finishAssistant(message) {
  const reasoningLen = (message.trace || [])
    .filter((activity) => activity.type === 'think')
    .reduce((sum, activity) => sum + String(activity.text || '').length, 0);

  if (!String(message.content || '').trim()) {
    message.content = reasoningLen
      ? '（模型只返回了思考内容，没有正文。可展开上方「思考过程」查看。）'
      : '（上游返回为空，请重试。）';
  }
}

function finalizeAssistant(message, finishReason) {
  const reasoningLen = (message.trace || [])
    .filter((activity) => activity.type === 'think')
    .reduce((sum, activity) => sum + String(activity.text || '').length, 0);

  if (!String(message.content || '').trim()) {
    if (finishReason === 'length') {
      message.content = reasoningLen
        ? '（模型把 token 预算全部用在思考上，正文还没开始就达到上限了。可提高 MAX_TOKENS，或换一个思考更简短的模型后重试。）'
        : '（达到 token 上限，但没有生成正文，请提高 MAX_TOKENS 或重试。）';
    } else if (reasoningLen) {
      message.content = '（模型只返回了思考内容，没有正文。可展开上方「思考过程」查看。）';
    } else {
      message.content = '（上游返回为空。）';
    }
    return;
  }

  if (finishReason === 'length') {
    message.content += '\n\n> ⚠️ 输出达到 token 上限被截断。可提高 MAX_TOKENS。';
  }
}

function ensureTrace(message) {
  if (!Array.isArray(message.trace)) message.trace = [];
  return message.trace;
}

function getThinkActivity(message, create) {
  const trace = ensureTrace(message);
  const last = trace[trace.length - 1];
  if (last && last.type === 'think' && last.status === 'running') return last;

  if (!create) return null;
  const activity = { id: crypto.randomUUID(), type: 'think', text: '', status: 'running', startedAt: Date.now() };
  trace.push(activity);
  return activity;
}

function pushReasoning(message, chunk) {
  const activity = getThinkActivity(message, true);
  activity.text = `${activity.text || ''}${chunk}`;
}

function closeRunningActivities(message, status) {
  ensureTrace(message).forEach((activity) => {
    if (activity.status === 'running') {
      activity.status = status;
      if (activity.startedAt) activity.ms = Date.now() - activity.startedAt;
    }
  });
}

function estimateContextSize(conversation, pendingText = '') {
  if (!conversation) return pendingText.length;

  let total = pendingText.length;

  // 只估算文本体量；图片有独立预算，不占用 256KB 文本上限
  state.pendingAttachments.forEach((file) => {
    if (file.parsedText) total += String(file.parsedText).length;
  });

  conversation.messages.forEach((message) => {
    const content = message.content;
    if (typeof content === 'string') {
      total += content.length;
    } else if (Array.isArray(content)) {
      content.forEach((part) => {
        if (part?.type === 'text') total += String(part.text || '').length;
      });
    }
  });

  return total;
}

function buildChatPayload(model, conversation, assistantMessage, attachments) {
  const messages = conversation.messages
    .filter((item) => item !== assistantMessage)
    .map((item, index, arr) => {
      if (item.role !== 'user') {
        return { role: item.role, content: item.content };
      }

      const isLastUserMessage = index === arr.length - 1;
      const attachedFiles = isLastUserMessage ? attachments : [];
      return buildUserMessage(item, attachedFiles);
    });

  return {
    model,
    stream: true,
    messages,
  };
}

function buildUserMessage(message, attachments) {
  if (!attachments.length) {
    return { role: 'user', content: message.content || '' };
  }

  const promptText = message.content || '请读取并处理这些附件。';
  const content = [];

  // 先放主文本
  if (promptText) {
    content.push({ type: 'text', text: promptText });
  }

  const nonInlineable = [];

  attachments.forEach((file) => {
    if (file.kind === 'image') {
      // 图片：用 image_url + base64 data URL（OpenAI 标准）
      content.push({
        type: 'image_url',
        image_url: { url: file.dataUrl },
      });
    } else if (file.kind === 'text') {
      // 文本类文件：解码 base64，内联为 text block
      let decoded = '';
      try {
        decoded = atob(file.base64);
        // 尝试 UTF-8 解码（处理多字节字符）
        decoded = new TextDecoder('utf-8').decode(
          Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0))
        );
      } catch {
        decoded = file.base64;
      }
      content.push({
        type: 'text',
        text: `文件名：${file.name}\n内容：\n\`\`\`\n${decoded}\n\`\`\``,
      });
    } else if (file.kind === 'document' || file.kind === 'pdf' || file.kind === 'docx' || file.kind === 'xlsx' || file.kind === 'pptx' || file.kind === 'archive') {
      // 文档 / 表格 / 演示 / 压缩包：文本 + 内嵌图片
      const images = Array.isArray(file.images) ? file.images : [];

      if (file.parsedText != null && file.parsedText !== '') {
        const imageNote = images.length ? `\n（该文档还包含 ${images.length} 张内嵌图片，随后附上）` : '';
        content.push({
          type: 'text',
          text: `文件名：${file.name}\n内容：\n\`\`\`\n${file.parsedText}\n\`\`\`${imageNote}`,
        });
      } else if (images.length) {
        content.push({ type: 'text', text: `文件名：${file.name}（无文字层，以下是其中的 ${images.length} 张图片）` });
      } else {
        const reason = file.parseError ? `解析失败（${file.parseError}）` : '未能提取到文本内容';
        nonInlineable.push({ name: file.name, type: file.type, size: file.size, note: reason });
      }

      images.forEach((image, index) => {
        if (index === 0) {
          content.push({ type: 'text', text: `【${file.name} 的图片】` });
        }
        content.push({ type: 'image_url', image_url: { url: image.dataUrl } });
      });
    } else {
      // 其他二进制：记录下来，后面统一追加描述
      nonInlineable.push(file);
    }
  });

  // 不可内联的文件：追加描述性文本
  if (nonInlineable.length) {
    const desc = nonInlineable
      .map((f) => `- ${f.name} (${f.type || 'application/octet-stream'}, ${formatBytes(f.size)})${f.note ? `：${f.note}` : ''}`)
      .join('\n');
    content.push({
      type: 'text',
      text: `以下附件无法直接内联，仅供参考：\n${desc}`,
    });
  }

  return { role: 'user', content };
}

async function runWebSearch(accessKey, query) {
  const response = await fetch(`${API_BASE_URL}/api/search`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessKey}`,
    },
    body: JSON.stringify({ query, fresh: true }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `搜索失败（HTTP ${response.status}）`);
  }
  return data;
}

async function runWebFetch(accessKey, url) {
  const response = await fetch(`${API_BASE_URL}/api/fetch`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessKey}`,
    },
    body: JSON.stringify({ url }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `抓取失败（HTTP ${response.status}）`);
  }
  return data;
}

function buildSearchSystemPrompt(results) {
  let budget = 6000;
  const lines = [];
  const today = new Date().toISOString().slice(0, 10);

  results.forEach((item, index) => {
    const snippet = String(item.text || '').replace(/\s+/g, ' ').trim();
    const clipped = snippet.slice(0, Math.min(1500, Math.max(0, budget)));
    budget -= clipped.length;
    const date = item.publishedDate ? `\n发布时间：${String(item.publishedDate).slice(0, 10)}` : '';
    lines.push(`[${index + 1}] ${item.title}\nURL: ${item.url}${date}\n${clipped}`);
  });

  return [
    `今天是 ${today}。你已获得以下实时联网搜索结果（已按查询抽取相关片段），请直接基于这些资料回答。`,
    '要求：',
    '1. 优先采信「发布时间」最新、且明确给出具体数值/结论的片段；把其中的关键信息直接写进回答，不要只说"资料不足"。',
    '2. 若片段之间互相矛盾（例如不同日期的天气），以最新日期为准，并说明差异。',
    '3. 引用处用 [序号] 标注来源。',
    '4. 只有在所有片段都确实缺少关键信息时，才说明资料不足，并指出具体缺什么。',
    '',
    ...lines,
  ].join('\n');
}

async function regenLastAssistant() {
  if (state.sending) return;
  const conversation = getActiveConversation();
  if (!conversation) return;

  // 找到最后一条 assistant 消息，删掉它，重新发
  const lastIdx = conversation.messages.map((m) => m.role).lastIndexOf('assistant');
  if (lastIdx === -1) return;
  conversation.messages.splice(lastIdx, 1);

  const accessKey = localStorage.getItem(ACCESS_KEY_STORAGE) || '';
  const model = state.selectedModel;
  if (!accessKey || !model) return;

  const assistantMessage = { role: 'assistant', content: '', createdAt: Date.now() };
  conversation.messages.push(assistantMessage);
  conversation.updatedAt = Date.now();

  state.sending = true;
  updateSendingState();
  renderMessages();

  const lastUser = [...conversation.messages].reverse().find((item) => item.role === 'user');
  try {
    await sendChat(accessKey, model, conversation, assistantMessage, [], lastUser?.content || '');
  } catch (err) {
    assistantMessage.content = `请求失败：${err.message}`;
  } finally {
    state.sending = false;
    updateSendingState();
    conversation.updatedAt = Date.now();
    persistConversations();
    renderConversationList();
    renderMessages();
    focusComposer();
  }
}

function exportConversation() {
  const conversation = getActiveConversation();
  if (!conversation || !conversation.messages.length) {
    showToast('当前会话没有内容可以导出', 'warn');
    return;
  }

  const lines = [`# ${conversation.title || '新会话'}`, ''];
  conversation.messages.forEach((msg) => {
    const role = msg.role === 'assistant' ? '**NekoAI**' : '**用户**';
    const content = msg.role === 'assistant'
      ? cleanAssistantText(msg.content)
      : String(msg.content || '').trim();
    lines.push(`${role}\n\n${content}`, '');
    if (msg.attachments?.length) {
      msg.attachments.forEach((f) => lines.push(`> 附件：${f.name} (${formatBytes(f.size)})`, ''));
    }
    if (msg.trace?.length) {
      lines.push('<details><summary>思考过程</summary>', '');
      msg.trace.forEach((activity) => {
        if (activity.type === 'search') {
          lines.push(`- 联网搜索：${activity.query}（${activity.results?.length || 0} 条）`);
          (activity.results || []).forEach((s, i) => lines.push(`  - [${i + 1}] ${s.title} — ${s.url}`));
        } else if (activity.type === 'fetch') {
          lines.push(`- 抓取网页：${activity.url}`, '');
        } else if (activity.type === 'note' && activity.text) {
          lines.push(`- 模型说明：`, '', activity.text, '');
        } else if (activity.type === 'think' && activity.text) {
          lines.push(`- 模型思考：`, '', activity.text, '');
        }
      });
      lines.push('</details>', '');
    } else if (msg.sources?.length) {
      msg.sources.forEach((s, i) => lines.push(`> [${i + 1}] ${s.title} — ${s.url}`, ''));
    }
    lines.push('---', '');
  });

  const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${(conversation.title || '会话').slice(0, 40)}.md`;
  a.click();
  URL.revokeObjectURL(url);
}

function extractAssistantText(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => item?.text || item?.content || '')
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function createConversation() {
  const conversation = {
    id: crypto.randomUUID(),
    title: '新会话',
    model: localStorage.getItem(MODEL_STORAGE) || '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
  };

  state.conversations.unshift(conversation);
  return conversation.id;
}

function sanitizeConversation(rawConversation) {
  if (!rawConversation || typeof rawConversation !== 'object') return null;

  const messages = Array.isArray(rawConversation.messages)
    ? rawConversation.messages
        .filter((message) => message && typeof message === 'object')
        .map((message) => ({
          role: message.role === 'assistant' ? 'assistant' : 'user',
          content: typeof message.content === 'string' ? message.content : '',
          createdAt: Number.isFinite(message.createdAt) ? message.createdAt : Date.now(),
          thinkMs: Number.isFinite(message.thinkMs) ? message.thinkMs : undefined,
          searchError: typeof message.searchError === 'string' ? message.searchError : undefined,
          trace: (Array.isArray(message.trace) ? message.trace : [])
            .filter((activity) => activity && typeof activity === 'object')
            .slice(-MAX_STORED_TRACE_ITEMS)
            .map((activity) => ({
              id: typeof activity.id === 'string' ? activity.id : crypto.randomUUID(),
              type: ['think', 'search', 'fetch', 'note'].includes(activity.type) ? activity.type : 'search',
              query: truncate(activity.query, MAX_STORED_TEXT_CHARS),
              url: truncate(activity.url, 500),
              label: typeof activity.label === 'string' ? activity.label : '',
              excerpt: truncate(activity.excerpt, MAX_STORED_TEXT_CHARS),
              text: truncate(activity.text, MAX_STORED_TEXT_CHARS),
              status: typeof activity.status === 'string' ? activity.status : 'done',
              ms: Number.isFinite(activity.ms) ? activity.ms : undefined,
              error: truncate(activity.error, MAX_STORED_TEXT_CHARS),
              results: (Array.isArray(activity.results) ? activity.results : [])
                .filter((source) => source && typeof source === 'object')
                .slice(0, MAX_STORED_SOURCES)
                .map((source) => ({
                  title: truncate(source.title, MAX_STORED_TEXT_CHARS),
                  url: truncate(source.url, 500),
                  text: '',
                })),
            })),
          // sources 与 trace.results 重复，持久化时不再单独保存大文本
          sources: [],
          attachments: Array.isArray(message.attachments)
            ? message.attachments
                .filter((file) => file && typeof file === 'object')
                .map((file) => ({
                  name: typeof file.name === 'string' ? file.name : '未命名附件',
                  type: typeof file.type === 'string' ? file.type : 'application/octet-stream',
                  size: Number.isFinite(file.size) ? file.size : 0,
                  kind: typeof file.kind === 'string' ? file.kind : 'file',
                  imageCount: Array.isArray(file.images) ? file.images.length : 0,
                }))
            : [],
        }))
    : [];

  return {
    id: typeof rawConversation.id === 'string' && rawConversation.id ? rawConversation.id : crypto.randomUUID(),
    title: typeof rawConversation.title === 'string' && rawConversation.title.trim() ? rawConversation.title.trim() : '新会话',
    model: typeof rawConversation.model === 'string' ? rawConversation.model : '',
    createdAt: Number.isFinite(rawConversation.createdAt) ? rawConversation.createdAt : Date.now(),
    updatedAt: Number.isFinite(rawConversation.updatedAt) ? rawConversation.updatedAt : Date.now(),
    messages,
  };
}

async function deleteConversation(id) {
  const target = state.conversations.find((item) => item.id === id);
  if (!target) return;

  const confirmed = await confirmDialog({
    icon: '🗑️',
    title: '删除会话',
    message: `将删除会话「${target.title || '新会话'}」，此操作无法恢复。`,
    confirmLabel: '删除',
    danger: true,
  });
  if (!confirmed) return;

  state.conversations = state.conversations.filter((item) => item.id !== id);

  if (!state.conversations.length) {
    state.activeId = createConversation();
  } else if (state.activeId === id) {
    state.activeId = state.conversations[0].id;
  }

  persistConversations();
  renderConversationList();
  renderMessages();
  renderModelDropdown();
  showToast('会话已删除', 'success');
}

function getActiveConversation() {
  return state.conversations.find((item) => item.id === state.activeId);
}

function renderConversationList() {
  conversationListEl.innerHTML = '';

  state.conversations
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .forEach((conversation) => {
      const item = document.createElement('div');
      item.className = `conversation-item${conversation.id === state.activeId ? ' active' : ''}`;
      item.innerHTML = `
        <button class="conversation-main" type="button">
          <div class="conversation-title">${escapeHtml(conversation.title || '新会话')}</div>
          <small class="conversation-time">${new Date(conversation.updatedAt).toLocaleString()}</small>
        </button>
        <button class="conversation-delete" type="button" aria-label="删除会话">×</button>
      `;

      item.querySelector('.conversation-main').addEventListener('click', () => {
        state.activeId = conversation.id;
        renderConversationList();
        renderMessages();
        renderModelDropdown();
        closeMobileSidebar();
      });

      item.querySelector('.conversation-delete').addEventListener('click', (event) => {
        event.stopPropagation();
        deleteConversation(conversation.id);
      });

      conversationListEl.appendChild(item);
    });
}

function renderMessages() {
  const conversation  = getActiveConversation();

  if (!conversation || !conversation.messages.length) {
    stopLiveThinkTicker();
    messagesEl.innerHTML = '';
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML = `
      <div class="empty-state-box">
        <h2>今天想聊点什么？</h2>
        <p>输入访问密钥，选择模型，然后直接开始对话。支持上传图片、文档、压缩包等附件。</p>
      </div>
    `;
    messagesEl.appendChild(empty);
    return;
  }

  // 工具执行期间（模型还没开始流式输出）只原地刷新摘要，避免打断流式内容
  const liveMsg = conversation.messages.find((m) => hasRunningActivity(m));
  const liveToolOnly = liveMsg &&
    Array.isArray(liveMsg.trace) &&
    liveMsg.trace.some((activity) => activity.status === 'running' && activity.type !== 'think') &&
    !liveMsg.trace.some((activity) => activity.type === 'think');
  if (liveToolOnly && messagesEl.children.length > 0) {
    const cot = messagesEl.querySelector('.cot.is-live');
    if (cot) {
      const titleEl = cot.querySelector('.cot-title');
      const durEl = cot.querySelector('.cot-duration');
      if (titleEl) titleEl.textContent = buildTraceSummary(liveMsg);
      if (durEl) durEl.textContent = buildTraceDuration(liveMsg);
      startLiveThinkTicker();
      return;
    }
  }

  // 全量重绘
  const scrollNearBottom = Math.abs(messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight) < 80;
  messagesEl.innerHTML = '';

  conversation.messages.forEach((message) => {
    const row = document.createElement('div');
    const isAssistant = message.role === 'assistant';
    row.className = `message-row ${isAssistant ? 'assistant-row' : 'user-row'}`;
    row.innerHTML = isAssistant
      ? `<div class="avatar assistant">N</div><div class="message-bubble"><div class="message-role">NekoAI</div><div class="message-content"></div><div class="message-attachments"></div></div>`
      : `<div class="message-bubble"><div class="message-role">用户</div><div class="message-content"></div><div class="message-attachments"></div></div>`;

    renderMessageContent(row.querySelector('.message-content'), message);

    // 用户消息内容为空时隐藏气泡（如纯附件消息）
    if (message.role === 'user') {
      const contentEl = row.querySelector('.message-content');
      if (!contentEl.children.length && !contentEl.textContent.trim()) {
        contentEl.style.display = 'none';
      }
    }

    const attachmentWrap = row.querySelector('.message-attachments');
    if (message.attachments?.length) {
      message.attachments.forEach((file) => {
        const chip = document.createElement('div');
        chip.className = 'message-attachment-chip';
        const images = file.imageCount ? ` · ${file.imageCount} 张图` : '';
        chip.textContent = `${file.name} · ${formatBytes(file.size)}${images}`;
        attachmentWrap.appendChild(chip);
      });
    }

    // 复制按钮（所有消息）
    const copyBtn = document.createElement('button');
    copyBtn.className = 'message-copy-btn';
    copyBtn.type = 'button';
    copyBtn.textContent = '复制';
    copyBtn.addEventListener('click', () => {
      const plainText = message.role === 'assistant'
        ? cleanAssistantText(message.content)
        : String(message.content || '').trim();
      navigator.clipboard.writeText(plainText).then(() => {
        copyBtn.textContent = '已复制';
        copyBtn.classList.add('copied');
        setTimeout(() => { copyBtn.textContent = '复制'; copyBtn.classList.remove('copied'); }, 1500);
      });
    });
    row.querySelector('.message-bubble').appendChild(copyBtn);

    // 重新生成按钮（仅 assistant 最后一条）
    const isLastAssistant = message.role === 'assistant' &&
      conversation.messages[conversation.messages.length - 1] === message;
    if (isLastAssistant && !state.sending) {
      const regenBtn = document.createElement('button');
      regenBtn.className = 'message-regen-btn';
      regenBtn.type = 'button';
      regenBtn.textContent = '重新生成';
      regenBtn.addEventListener('click', () => regenLastAssistant());
      row.querySelector('.message-bubble').appendChild(regenBtn);
    }

    messagesEl.appendChild(row);
  });

  // 代码块复制按钮事件委托
  messagesEl.querySelectorAll('.copy-code-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const code = btn.previousElementSibling?.querySelector('code')?.textContent || '';
      navigator.clipboard.writeText(code).then(() => {
        btn.textContent = '已复制';
        btn.classList.add('copied');
        setTimeout(() => { btn.textContent = '复制'; btn.classList.remove('copied'); }, 1500);
      });
    });
  });

  if (liveMsg) startLiveThinkTicker();
  else stopLiveThinkTicker();

  if (scrollNearBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
}

const THINK_OPEN = '<' + 'think' + '>';
const THINK_CLOSE = '<' + '/' + 'think' + '>';
const THINK_STRIP_RE = new RegExp(THINK_OPEN + '[\\s\\S]*?' + THINK_CLOSE, 'gi');
const THINK_TRAILING_RE = new RegExp(THINK_OPEN + '[\\s\\S]*$', 'i');
const THINK_ANY_RE = new RegExp(THINK_OPEN, 'i');
const THINK_CLOSED_RE = new RegExp(THINK_OPEN + '([\\s\\S]*?)' + THINK_CLOSE, 'gi');
const THINK_CLOSE_TEST_RE = new RegExp(THINK_CLOSE, 'i');

// 有些模型不会走原生 tool_calls，而是把 <tool_call>{...}</tool_call> 写进正文
const TOOL_CALL_STRIP_RE = new RegExp(String.fromCharCode(60) + 'tool_call' + String.fromCharCode(62) + '[\\s\\S]*?' + String.fromCharCode(60) + '/tool_call' + String.fromCharCode(62), 'gi');
const TOOL_CALL_CAPTURE_RE = new RegExp(String.fromCharCode(60) + 'tool_call' + String.fromCharCode(62) + '([\\s\\S]*?)' + String.fromCharCode(60) + '/tool_call' + String.fromCharCode(62), 'gi');

function stripThinkTags(text) {
  return String(text || '')
    .replace(THINK_STRIP_RE, '')
    .replace(THINK_TRAILING_RE, '')
    .trim();
}

function stripLeakedToolCalls(text) {
  return String(text || '')
    .replace(TOOL_CALL_STRIP_RE, '')
    .replace(/^\s*(?:web_search|web_fetch)\s*\([^\n]*\)\s*$/gim, '')
    .trim();
}

function cleanAssistantText(text) {
  return stripLeakedToolCalls(stripThinkTags(text));
}

function extractLeakedToolCalls(text) {
  const value = String(text || '');
  const calls = [];
  let match;
  const re = new RegExp(TOOL_CALL_CAPTURE_RE.source, 'gi');
  while ((match = re.exec(value))) {
    const raw = match[1].trim();
    try {
      const json = JSON.parse(raw);
      calls.push({ name: json.name || json.tool || '', args: json.arguments || json.args || json.parameters || {} });
    } catch {
      const nameMatch = raw.match(/"?(?:name|tool)"?\s*[:=]\s*"?([A-Za-z_][\w]*)"?/);
      const queryMatch = raw.match(/"(?:query|url)"\s*:\s*"([^"]*)"/);
      calls.push({ name: nameMatch ? nameMatch[1] : 'web_search', args: queryMatch ? { query: queryMatch[1] } : {} });
    }
  }
  return calls;
}

function renderMessageContent(container, message) {
  container.innerHTML = '';
  const mainText = cleanAssistantText(message.content);

  if (message.role === 'assistant' && hasTraceContent(message)) {
    container.appendChild(buildThinkBlock(message));
  }

  if (mainText) {
    const div = document.createElement('div');
    div.innerHTML = renderMarkdown(mainText);
    div.querySelectorAll('img').forEach((img) => {
      img.className = 'message-inline-image';
    });
    container.appendChild(div);
  }
}

function hasTraceContent(message) {
  if (Array.isArray(message.trace) && message.trace.length) return true;
  const content = String(message.content || '');
  if (THINK_ANY_RE.test(content)) return true;
  return extractLeakedToolCalls(content).length > 0;
}

/* ── Chain of Thought（参考 rikkahub：思考 + 工具调用合并为一个折叠块） ── */

function buildThinkBlock(message) {
  const trace = ensureTrace(message);
  const live = hasRunningActivity(message);
  const isOpen = Boolean(message._thinkOpen);
  const items = buildTraceItems(message, trace);

  const details = document.createElement('details');
  details.className = 'cot' + (live ? ' is-live' : '');
  if (isOpen) details.open = true;

  const summary = document.createElement('summary');
  summary.className = 'cot-summary';
  summary.innerHTML =
    '<span class="cot-spark">✦</span>' +
    '<span class="cot-title">' + escapeHtml(buildTraceSummary(message)) + '</span>' +
    '<span class="cot-duration">' + escapeHtml(buildTraceDuration(message)) + '</span>' +
    '<span class="cot-caret"></span>';
  details.appendChild(summary);
  details.addEventListener('toggle', () => {
    message._thinkOpen = details.open;
    if (details.open && hasRunningActivity(message)) renderMessages();
  });

  const body = document.createElement('div');
  body.className = 'cot-body';
  items.forEach((item) => body.appendChild(item));
  details.appendChild(body);

  return details;
}

function buildTraceItems(message, trace) {
  const items = [];

  trace.forEach((activity) => {
    switch (activity.type) {
      case 'search':
        items.push(buildStepItem({
          kind: 'search',
          status: activity.status,
          name: '联网搜索',
          detail: activity.query,
          meta: describeActivity(activity),
          results: activity.results,
          error: activity.error,
        }));
        break;
      case 'fetch':
        items.push(buildStepItem({
          kind: 'fetch',
          status: activity.status,
          name: '抓取网页',
          detail: activity.url,
          link: activity.url,
          meta: describeActivity(activity),
          excerpt: activity.excerpt,
          error: activity.error,
        }));
        break;
      case 'note':
        if (activity.text) {
          items.push(buildStepItem({
            kind: 'note',
            status: activity.status,
            name: '模型说明',
            markdown: activity.text,
            meta: describeActivity(activity),
          }));
        }
        break;
      case 'think': {
        const text = activity.text ? String(activity.text).trim() : '';
        if (text) {
          items.push(buildStepItem({
            kind: 'think',
            status: activity.status,
            name: '思考过程',
            markdown: text,
            meta: describeActivity(activity),
          }));
        }
        break;
      }
    }
  });

  // 正文里残留的 thinking / tool_call 文本也归入折叠块，避免露在外面
  const taggedThinking = extractTaggedThinking(message.content);
  if (taggedThinking && !trace.some((a) => a.type === 'think' && a.text)) {
    items.push(buildStepItem({ kind: 'think', status: 'done', name: '思考过程', markdown: taggedThinking, meta: '完成' }));
  }

  const leaked = extractLeakedToolCalls(message.content);
  if (leaked.length) {
    leaked.forEach((call) => {
      const isFetch = /fetch/i.test(call.name);
      items.push(buildStepItem({
        kind: isFetch ? 'fetch' : 'search',
        status: 'done',
        name: isFetch ? '抓取网页' : '联网搜索',
        detail: isFetch ? call.args.url : call.args.query,
        link: isFetch ? call.args.url : '',
        meta: '来自模型输出',
      }));
    });
  }

  return items;
}

function buildStepItem({ kind, status, name, detail, link, meta, markdown, results, excerpt, error }) {
  const item = document.createElement('div');
  item.className = 'cot-step cot-' + kind + ' status-' + (status || 'done');

  const head = document.createElement('div');
  head.className = 'cot-step-head';
  head.innerHTML =
    '<span class="cot-step-icon">' + stepIcon(kind, status) + '</span>' +
    '<span class="cot-step-name">' + escapeHtml(name) + '</span>' +
    '<span class="cot-step-meta">' + escapeHtml(meta || '') + '</span>';
  item.appendChild(head);

  const body = document.createElement('div');
  body.className = 'cot-step-body';

  if (kind === 'think' || kind === 'note') {
    if (markdown) {
      const div = document.createElement('div');
      div.className = 'cot-markdown';
      div.innerHTML = renderMarkdown(markdown);
      body.appendChild(div);
    }
  } else {
    if (detail) {
      const line = document.createElement('div');
      line.className = 'cot-step-detail';
      if (link) {
        const a = document.createElement('a');
        a.href = link;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = detail;
        line.appendChild(a);
      } else {
        line.textContent = detail;
      }
      body.appendChild(line);
    }

    if (excerpt) {
      const pre = document.createElement('div');
      pre.className = 'cot-step-excerpt';
      pre.textContent = String(excerpt).replace(/\s+/g, ' ').slice(0, 300);
      body.appendChild(pre);
    }

    if (results && results.length) {
      const list = document.createElement('div');
      list.className = 'cot-step-results';
      results.forEach((source, index) => {
        const a = document.createElement('a');
        a.className = 'cot-source';
        a.href = source.url || '#';
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = '[' + (index + 1) + '] ' + (source.title || source.url || '来源');
        list.appendChild(a);
      });
      body.appendChild(list);
    }
  }

  if (error) {
    const err = document.createElement('div');
    err.className = 'cot-step-error';
    err.textContent = error;
    body.appendChild(err);
  }

  if (body.childNodes.length) item.appendChild(body);
  return item;
}

function stepIcon(kind, status) {
  if (status === 'running') return '◍';
  if (status === 'error') return '⚠';
  if (kind === 'search') return '🔍';
  if (kind === 'fetch') return '🌐';
  if (kind === 'think') return '💭';
  return '•';
}

function describeActivity(activity) {
  const ms = activity.status === 'running' && activity.startedAt
    ? Date.now() - activity.startedAt
    : activity.ms || 0;

  if (activity.status === 'running') {
    if (activity.type === 'search') return '搜索中…';
    if (activity.type === 'fetch') return '抓取中…';
    return '思考中…';
  }
  if (activity.status === 'error') return '失败';
  if (activity.status === 'stopped') return '已停止';

  if (activity.type === 'search') {
    return (activity.results ? activity.results.length : 0) + ' 条 · ' + formatThinkDuration(ms);
  }
  return formatThinkDuration(ms);
}

function buildTraceSummary(message) {
  const trace = ensureTrace(message);
  const running = trace.find((activity) => activity.status === 'running');
  if (running) {
    if (running.type === 'search') return '正在联网搜索';
    if (running.type === 'fetch') return '正在抓取网页';
    return '正在思考';
  }

  const searches = trace.filter((activity) => activity.type === 'search');
  const fetches = trace.filter((activity) => activity.type === 'fetch');
  const hasThink = trace.some((activity) => activity.type === 'think' && activity.text);

  if (!trace.length) {
    return hasThink || THINK_ANY_RE.test(String(message.content || '')) ? '思考过程' : '思考过程';
  }

  const parts = [];
  if (hasThink || THINK_ANY_RE.test(String(message.content || ''))) parts.push('已深度思考');

  // 按 URL 去重，避免重复搜索把条数虚高
  const uniqueUrls = new Set();
  searches.forEach((activity) => {
    (activity.results || []).forEach((item) => {
      if (item?.url) uniqueUrls.add(String(item.url).replace(/\/+$/, ''));
    });
  });
  if (uniqueUrls.size) parts.push('联网 ' + uniqueUrls.size + ' 条');
  else if (searches.length) parts.push('联网 ' + searches.length + ' 次');

  const uniqueFetchUrls = new Set(fetches.map((activity) => String(activity.url || '').replace(/\/+$/, '')).filter(Boolean));
  if (uniqueFetchUrls.size) parts.push('抓取 ' + uniqueFetchUrls.size + ' 页');

  return parts.length ? parts.join(' · ') : '思考过程';
}

function buildTraceDuration(message) {
  const trace = ensureTrace(message);
  const total = trace.reduce((sum, activity) => sum + (Number(activity.ms) || 0), 0);
  if (hasRunningActivity(message)) return '进行中';
  if (!total) return '';
  return formatThinkDuration(total);
}

function hasRunningActivity(message) {
  return Array.isArray(message.trace) && message.trace.some((activity) => activity.status === 'running');
}

function extractTaggedThinking(text) {
  const value = String(text || '');
  const parts = [...value.matchAll(THINK_CLOSED_RE)].map((m) => m[1].trim());

  const lastOpen = value.toLowerCase().lastIndexOf(THINK_OPEN.toLowerCase());
  if (lastOpen !== -1) {
    const after = value.slice(lastOpen + THINK_OPEN.length);
    if (!THINK_CLOSE_TEST_RE.test(after)) parts.push(after.trim());
  }

  return parts.filter(Boolean).join('\n\n');
}

function renderMarkdown(input) {
  const renderer = new marked.Renderer();

  renderer.code = ({ text }) => {
    const escaped = escapeHtml(text);
    return `<div class="md-pre-wrap"><pre class="md-pre"><code>${escaped}</code></pre><button class="copy-code-btn" type="button">复制</button></div>`;
  };

  renderer.image = ({ href, title, text }) => {
    const url = safeUrl(href);
    if (!url) return escapeHtml(text || '');
    const isVideo = /\.(mp4|webm|ogg|mov)([?#]|$)/i.test(url) || /video/i.test(url);
    if (isVideo) {
      return `<video class="message-inline-video" controls playsinline preload="metadata"><source src="${escapeHtml(url)}"><a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">点击查看视频</a></video>`;
    }
    return `<img class="message-inline-image" src="${escapeHtml(url)}" alt="${escapeHtml(text || title || '')}">`;
  };

  renderer.link = ({ href, text }) => {
    const url = safeUrl(href);
    if (!url) return escapeHtml(text || '');
    const isVideo = /\.(mp4|webm|ogg|mov)([?#]|$)/i.test(url) || /video/i.test(url);
    if (isVideo) {
      return `<video class="message-inline-video" controls playsinline preload="metadata"><source src="${escapeHtml(url)}"><a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">点击查看视频</a></video>`;
    }
    return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(text || url)}</a>`;
  };

  return sanitizeHtml(marked.parse(String(input || ''), { renderer, breaks: true }));
}

function extractImageDataUrls(text) {
  const matches = String(text || '').match(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\n\r]+/g);
  return matches ? matches.map((item) => item.replace(/[\n\r]/g, '')) : [];
}

function formatThinkDuration(ms) {
  if (!ms) return '0.0 秒';
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} 秒`;
  const minutes = Math.floor(ms / 60000);
  const seconds = ((ms % 60000) / 1000).toFixed(1);
  return `${minutes} 分 ${seconds} 秒`;
}

function removeImageDataUrls(text) {
  return String(text || '').replace(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\n\r]+/g, '').trim();
}

function startLiveThinkTicker() {
  if (state.liveThinkTimer) return;
  state.liveThinkTimer = setInterval(() => {
    renderMessages();
  }, 1000);
}

function stopLiveThinkTicker() {
  if (!state.liveThinkTimer) return;
  clearInterval(state.liveThinkTimer);
  state.liveThinkTimer = null;
}

function updateSendingState() {
  sendBtnEl.disabled = state.sending;
  sendBtnEl.textContent = state.sending ? '发送中...' : '发送';
  if (state.sending) {
    stopBtnEl.classList.remove('hidden');
    sendBtnEl.classList.add('hidden');
  } else {
    stopBtnEl.classList.add('hidden');
    sendBtnEl.classList.remove('hidden');
  }
}

function autoResizeTextarea() {
  messageInputEl.style.height = '32px';
  const maxHeight = 220;
  const nextHeight = Math.min(Math.max(messageInputEl.scrollHeight, 32), maxHeight);
  messageInputEl.style.height = `${nextHeight}px`;
  messageInputEl.style.overflowY = messageInputEl.scrollHeight > maxHeight ? 'auto' : 'hidden';
}

function focusComposer() {
  messageInputEl.focus();
}

function applyThemeByTime() {
  const hour = new Date().getHours();
  const isLight = hour >= 7 && hour < 19;
  document.body.classList.toggle('theme-light', isLight);
}

function persistConversations() {
  const safeConversations = state.conversations.map((conversation) => sanitizeConversation(conversation)).filter(Boolean);

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(safeConversations));
    return true;
  } catch (error) {
    console.warn('本地存储写入失败', error);
  }

  // 空间不足：逐步丢弃最旧的会话后重试
  try {
    let trimmed = safeConversations.map((conversation) => ({
      ...conversation,
      messages: conversation.messages.slice(-20),
    }));

    while (trimmed.length > 1) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
        state.conversations = trimmed;
        showToast('本地存储空间不足，已清理较早的会话记录', 'warn');
        return true;
      } catch {
        trimmed = trimmed.slice(0, Math.max(1, trimmed.length - 10));
      }
    }

    localStorage.removeItem(STORAGE_KEY);
    showToast('本地存储空间不足，聊天记录未能保存', 'warn');
    return false;
  } catch (error) {
    console.warn('本地存储清理失败', error);
    return false;
  }
}

function loadConversations() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((conversation) => sanitizeConversation(conversation)).filter(Boolean);
  } catch {
    return [];
  }
}

const TEXT_EXTENSIONS = [
  '.txt', '.md', '.markdown', '.csv', '.json', '.xml', '.yaml', '.yml', '.toml', '.ini', '.cfg',
  '.conf', '.log', '.sh', '.bash', '.zsh', '.py', '.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx',
  '.java', '.c', '.cpp', '.h', '.hpp', '.cs', '.go', '.rs', '.rb', '.php', '.swift', '.kt',
  '.scala', '.r', '.sql', '.html', '.htm', '.css', '.scss', '.sass', '.less', '.vue', '.svelte',
];

const TEXT_EXT_RE = new RegExp(
  `\\.(${TEXT_EXTENSIONS.map((ext) => ext.slice(1)).join('|')})$`,
  'i',
);

const ARCHIVE_EXT_RE = /\.(zip|jar|apk|epub|whl|egg|aar)$/i;
const DOCUMENT_EXT_RE = /\.(doc|docx|xls|xlsx|xlsm|xlsb|et|ods|odt|numbers|rtf|html|htm|xml|csv)$/i;

function getAttachmentKind(file) {
  const name = String(file.name || '');
  if (file.type?.startsWith('image/')) return 'image';
  if (name.toLowerCase().endsWith('.pptx') || name.toLowerCase().endsWith('.ppt')) return 'pptx';
  if (name.toLowerCase().endsWith('.docx')) return 'docx';
  if (name.toLowerCase().endsWith('.xlsx') || name.toLowerCase().endsWith('.xls')) return 'xlsx';
  if (ARCHIVE_EXT_RE.test(name)) return 'archive';

  const textTypes = [
    'text/',
    'application/json',
    'application/xml',
    'application/javascript',
    'application/typescript',
    'application/x-yaml',
    'application/x-sh',
    'application/x-python',
  ];
  if (textTypes.some((t) => file.type?.startsWith(t))) return 'text';
  if (TEXT_EXT_RE.test(name)) return 'text';
  if (file.type === 'application/pdf' || /\.pdf$/i.test(name)) return 'pdf';
  if (DOCUMENT_EXT_RE.test(name)) return 'document';
  return 'file';
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error(`读取文件失败：${file.name}`));
    reader.readAsDataURL(file);
  });
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value >= 10 || idx === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[idx]}`;
}

function truncate(value, max) {
  if (typeof value !== 'string') return '';
  return value.length > max ? value.slice(0, max) : value;
}

function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/* ── 自定义弹窗与提示（替代原生 confirm/alert） ── */

let modalResolver = null;

function closeModal(result) {
  modalRootEl.classList.add('hidden');
  modalCardEl.classList.remove('modal-enter');
  const resolve = modalResolver;
  modalResolver = null;
  if (resolve) resolve(result);
}

function openModal({ icon, title, body, actions, dismissible = true }) {
  return new Promise((resolve) => {
    if (modalResolver) {
      const prev = modalResolver;
      modalResolver = null;
      prev(false);
    }
    modalResolver = resolve;

    modalIconEl.textContent = icon || '';
    modalIconEl.classList.toggle('hidden', !icon);
    modalTitleEl.textContent = title || '';
    modalBodyEl.innerHTML = '';
    if (typeof body === 'string') {
      modalBodyEl.innerHTML = body;
    } else if (body instanceof Node) {
      modalBodyEl.appendChild(body);
    }
    modalBodyEl.classList.toggle('hidden', !modalBodyEl.childNodes.length && !body);

    modalActionsEl.innerHTML = '';
    const list = actions && actions.length
      ? actions
      : [{ label: '知道了', value: true, variant: 'primary' }];

    list.forEach((action) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `modal-btn modal-btn-${action.variant || 'ghost'}`;
      btn.textContent = action.label;
      btn.addEventListener('click', () => {
        closeModal(action.value !== undefined ? action.value : true);
      });
      modalActionsEl.appendChild(btn);
    });

    modalRootEl.dataset.dismissible = dismissible ? '1' : '0';
    modalRootEl.classList.remove('hidden');
    requestAnimationFrame(() => modalCardEl.classList.add('modal-enter'));
    focusFirstModalButton();
  });
}

function focusFirstModalButton() {
  const btn = modalActionsEl.querySelector('.modal-btn-primary') || modalActionsEl.querySelector('.modal-btn');
  if (btn) btn.focus();
}

function confirmDialog({ title, message, confirmLabel = '确认', cancelLabel = '取消', danger = false, icon = '⚠️' }) {
  return openModal({
    icon,
    title,
    body: `<p>${escapeHtml(message)}</p>`,
    actions: [
      { label: cancelLabel, value: false, variant: 'ghost' },
      { label: confirmLabel, value: true, variant: danger ? 'danger' : 'primary' },
    ],
  });
}

function noticeDialog({ title, message, icon = 'ℹ️', confirmLabel = '知道了' }) {
  return openModal({
    icon,
    title,
    body: `<p>${escapeHtml(message)}</p>`,
    actions: [{ label: confirmLabel, value: true, variant: 'primary' }],
  });
}

function showToast(message, variant = 'info') {
  if (!toastRootEl) return;
  const toast = document.createElement('div');
  toast.className = `toast toast-${variant}`;
  toast.textContent = message;
  toastRootEl.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('toast-enter'));
  setTimeout(() => {
    toast.classList.remove('toast-enter');
    setTimeout(() => toast.remove(), 220);
  }, 2600);
}

/* ── HTML 净化（防 XSS） ── */

function sanitizeHtml(html) {
  if (window.DOMPurify) {
    return window.DOMPurify.sanitize(String(html || ''), {
      FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe', 'object', 'embed'],
      FORBID_ATTR: ['style', 'onerror', 'onload', 'onclick'],
      ALLOW_DATA_ATTR: false,
    });
  }

  // DOMPurify 未加载时的兜底：只放行最基础的标签
  const template = document.createElement('template');
  template.innerHTML = String(html || '');
  const allowed = new Set(['P', 'BR', 'STRONG', 'EM', 'B', 'I', 'U', 'S', 'CODE', 'PRE', 'SPAN',
    'UL', 'OL', 'LI', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'A', 'HR', 'TABLE',
    'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'DEL', 'DIV', 'IMG', 'DETAILS', 'SUMMARY']);
  const walk = (node) => {
    [...node.childNodes].forEach((child) => {
      if (child.nodeType === 1) {
        if (!allowed.has(child.tagName)) {
          child.replaceWith(document.createTextNode(child.textContent || ''));
          return;
        }
        [...child.attributes].forEach((attr) => {
          const name = attr.name.toLowerCase();
          if (name.startsWith('on') || name === 'style') child.removeAttribute(attr.name);
          if ((name === 'href' || name === 'src') && /^\s*javascript:/i.test(attr.value)) {
            child.removeAttribute(attr.name);
          }
        });
        walk(child);
      }
    });
  };
  walk(template.content);
  return template.innerHTML;
}

function safeUrl(url) {
  const value = String(url || '').trim();
  if (/^(https?:|mailto:|data:image\/)/i.test(value)) return value;
  return '';
}

// 在文件末尾启动，确保所有 const 常量都已初始化
boot();
