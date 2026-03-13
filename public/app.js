const STORAGE_KEY = 'nekoai.conversations';
const ACCESS_KEY_STORAGE = 'nekoai.accessKey';
const MODEL_STORAGE = 'nekoai.selectedModel';
const API_BASE_URL = (window.NEKOAI_CONFIG?.API_BASE_URL || '').replace(/\/$/, '');
const MAX_ATTACHMENT_SIZE = 15 * 1024 * 1024;

const state = {
  conversations: loadConversations(),
  activeId: null,
  models: [],
  selectedModel: localStorage.getItem(MODEL_STORAGE) || '',
  sending: false,
  pendingAttachments: [],
  authenticated: false,
  liveThinkTimer: null,
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

boot();

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

  clearAllBtnEl.addEventListener('click', () => {
    if (!state.conversations.length) return;
    const confirmed = window.confirm('确认清空全部会话吗？清空后当前浏览器中的聊天记录将无法恢复。');
    if (!confirmed) return;

    state.conversations = [];
    state.activeId = createConversation();
    persistConversations();
    renderConversationList();
    renderMessages();
    renderModelDropdown();
    focusComposer();
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
    await addPendingFiles(files);
    fileInputEl.value = '';
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
      alert('当前没有可用模型，请先刷新模型列表');
      return;
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
      await sendChat(accessKey, model, conversation, assistantMessage, pendingAttachments);
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
    return true;
  } catch (error) {
    state.authenticated = false;
    state.models = [];
    state.selectedModel = '';
    localStorage.removeItem(MODEL_STORAGE);
    localStorage.removeItem(ACCESS_KEY_STORAGE);
    renderModelDropdown();
    if (surfaceError) setLoginError(error.message || '登录失败');
    showLogin();
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

async function addPendingFiles(files) {
  for (const file of files) {
    if (file.size > MAX_ATTACHMENT_SIZE) {
      alert(`${file.name} 超过 15MB，先跳过了。`);
      continue;
    }

    const dataUrl = await readFileAsDataURL(file);
    const base64 = dataUrl.split(',')[1] || '';
    state.pendingAttachments.push({
      id: crypto.randomUUID(),
      name: file.name,
      type: file.type || 'application/octet-stream',
      size: file.size,
      kind: getAttachmentKind(file),
      dataUrl,
      base64,
    });
  }

  renderAttachments();
}

function renderAttachments() {
  attachmentListEl.innerHTML = '';
  if (!state.pendingAttachments.length) return;

  state.pendingAttachments.forEach((file) => {
    const item = document.createElement('div');
    item.className = 'attachment-chip';
    item.innerHTML = `
      <div class="attachment-chip-main">
        <div class="attachment-name">${escapeHtml(file.name)}</div>
        <div class="attachment-meta">${formatBytes(file.size)} · ${escapeHtml(file.kind)}</div>
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

async function sendChat(accessKey, model, conversation, assistantMessage, attachments) {
  const payload = buildChatPayload(model, conversation, assistantMessage, attachments);

  const response = await fetch(`${API_BASE_URL}/api/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${response.status}`);
  }

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/event-stream')) {
    const data = await response.json();
    assistantMessage.content = extractAssistantText(data) || '上游返回为空';
    updateThinkTiming(assistantMessage, true);
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() || '';

    for (const part of parts) {
      const lines = part.split('\n');
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;

        try {
          const json = JSON.parse(data);
          const delta = json.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta) {
            assistantMessage.content += delta;
            updateThinkTiming(assistantMessage);
            renderMessages();
          } else if (Array.isArray(delta)) {
            const text = delta.map((item) => item?.text || '').join('');
            if (text) {
              assistantMessage.content += text;
              updateThinkTiming(assistantMessage);
              renderMessages();
            }
          }
        } catch {
          // ignore invalid chunk
        }
      }
    }
  }
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

  const attachmentText = attachments
    .map((file) => `- ${file.name} (${file.type || 'application/octet-stream'}, ${formatBytes(file.size)})`)
    .join('\n');

  const promptText = message.content || '请读取并处理这些附件。';
  const content = [
    {
      type: 'text',
      text: `${promptText}\n\n附件列表：\n${attachmentText}`,
    },
  ];

  attachments.forEach((file) => {
    content.push({
      type: 'image_url',
      image_url: {
        url: file.dataUrl,
      },
    });
  });

  return {
    role: 'user',
    content,
  };
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
          attachments: Array.isArray(message.attachments)
            ? message.attachments
                .filter((file) => file && typeof file === 'object')
                .map((file) => ({
                  name: typeof file.name === 'string' ? file.name : '未命名附件',
                  type: typeof file.type === 'string' ? file.type : 'application/octet-stream',
                  size: Number.isFinite(file.size) ? file.size : 0,
                  kind: typeof file.kind === 'string' ? file.kind : 'file',
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

function deleteConversation(id) {
  const target = state.conversations.find((item) => item.id === id);
  if (!target) return;

  const confirmed = window.confirm(`确认删除会话「${target.title || '新会话'}」吗？删除后无法恢复。`);
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

// ── 思考计时 ──────────────────────────────────────────────────────────────
// assistantMessage.thinkStart  : <think> 出现时记录的 Date.now()
// assistantMessage.thinkMs     : </think> 出现时写入的耗时毫秒，写入后删除 thinkStart

function updateThinkTiming(message, forceClose = false) {
  const text = String(message.content || '');
  const hasOpen  = /<think>/i.test(text);
  const hasClose = /<\/think>/i.test(text);

  if (hasOpen && !message.thinkStart && !('thinkMs' in message)) {
    message.thinkStart = Date.now();
  }

  if ((hasClose || forceClose) && message.thinkStart && !('thinkMs' in message)) {
    message.thinkMs    = Date.now() - message.thinkStart;
    delete message.thinkStart;
  }
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

  // 如果有正在思考的消息，只更新计时器文字，不重绘整个列表
  const thinkingMsg = conversation.messages.find((m) => m.thinkStart);
  if (thinkingMsg && messagesEl.children.length > 0) {
    const elapsed = Date.now() - thinkingMsg.thinkStart;
    const timerEl = messagesEl.querySelector('.message-think.is-live .think-timer');
    if (timerEl) {
      timerEl.textContent = formatThinkDuration(elapsed);
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
        chip.textContent = `${file.name} · ${formatBytes(file.size)}`;
        attachmentWrap.appendChild(chip);
      });
    }

    messagesEl.appendChild(row);
  });

  if (thinkingMsg) startLiveThinkTicker();
  else stopLiveThinkTicker();

  if (scrollNearBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderMessageContent(container, message) {
  container.innerHTML = '';
  const raw  = String(message.content || '');
  const isThinking = Boolean(message.thinkStart);

  // 剥离思考内容，主文本永远不含 <think> 块
  const mainText = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/gi, '')
    .trim();

  // 思考框：只对 assistant 消息，且确实含有 <think> 标记才渲染
  const hasThink = message.role === 'assistant' && (
    isThinking || Number.isFinite(message.thinkMs) || /<think>/i.test(raw)
  );
  if (hasThink) {
    // 提取已收到的思考内容（无论是否完成）
    let thinkContent = '';
    if (isThinking) {
      // 还在思考中：提取 <think> 之后的所有内容（不需要闭合标签）
      const m = raw.match(/<think>([\s\S]*)$/i);
      thinkContent = m ? m[1].trim() : '';
    } else {
      // 思考完成：提取 <think>...</think> 中间的内容
      thinkContent = [...raw.matchAll(/<think>([\s\S]*?)<\/think>/gi)]
        .map((m) => m[1].trim()).join('\n\n');
    }

    const ms     = isThinking ? (Date.now() - message.thinkStart) : (message.thinkMs || 0);
    const isOpen = Boolean(message._thinkOpen);

    const details = document.createElement('details');
    details.className = `message-think${isThinking ? ' is-live' : ''}`;
    if (isOpen) details.open = true;
    details.innerHTML = `
      <summary>
        <span>思考过程</span>
        <span class="think-timer">${formatThinkDuration(ms)}</span>
      </summary>
      ${thinkContent ? `<div class="message-think-body">${renderMarkdown(thinkContent)}</div>` : ''}
    `;
    details.addEventListener('toggle', () => { message._thinkOpen = details.open; });
    container.appendChild(details);
  }

  // 主文本
  const images = extractImageDataUrls(mainText);
  const textOnly = removeImageDataUrls(mainText).trim();
  if (textOnly) {
    const div = document.createElement('div');
    div.innerHTML = renderMarkdown(textOnly);
    container.appendChild(div);
  }
  if (images.length) {
    const gallery = document.createElement('div');
    gallery.className = 'message-image-gallery';
    images.forEach((src) => {
      const img = document.createElement('img');
      img.src = src;
      img.className = 'message-inline-image';
      gallery.appendChild(img);
    });
    container.appendChild(gallery);
  }
}

function renderMarkdown(input) {
  return marked.parse(String(input || ''), {
    renderer: (() => {
      const r = new marked.Renderer();
      r.code = ({ text, lang }) => {
        const escaped = text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        return `<pre class="md-pre"><code>${escaped}</code></pre>`;
      };
      return r;
    })(),
    breaks: true,
  });
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
  localStorage.setItem(STORAGE_KEY, JSON.stringify(safeConversations));
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

function getAttachmentKind(file) {
  if (file.type?.startsWith('image/')) return 'image';
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

function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
