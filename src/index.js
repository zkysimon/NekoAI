const DEFAULT_MAX_TOKENS = 8192;
const DEFAULT_EXA_SEARCH_PATH = '/search';
const DEFAULT_EXA_NUM_RESULTS = 5;
const MAX_SEARCH_QUERY_LENGTH = 400;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(request, env) });
    }

    try {
      switch (url.pathname) {
        case '/api/config':
          if (request.method === 'GET') return handleConfig(request, env);
          break;
        case '/api/models':
          if (request.method === 'GET') return handleModels(request, env);
          break;
        case '/api/chat':
          if (request.method === 'POST') return handleChat(request, env);
          break;
        case '/api/search':
          if (request.method === 'POST') return handleSearch(request, env);
          break;
        case '/api/fetch':
          if (request.method === 'POST') return handleFetch(request, env);
          break;
        case '/api/convert':
          if (request.method === 'POST') return handleConvert(request, env);
          break;
      }
    } catch (error) {
      return json({ error: error?.message || 'Internal error' }, 500, request, env);
    }

    return json({ error: 'Not found' }, 404, request, env);
  },
};

function handleConfig(request, env) {
  return json(
    {
      maxTokens: getMaxTokens(env),
      search: {
        enabled: Boolean(env.EXA_API_KEY || env.EXA_BASE_URL),
        configured: Boolean(env.EXA_API_KEY),
      },
      documentConversion: {
        enabled: Boolean(env.AI && typeof env.AI.toMarkdown === 'function'),
      },
    },
    200,
    request,
    env,
  );
}

async function handleConvert(request, env) {
  const authError = verifyAccessKey(request, env);
  if (authError) return authError;

  if (!env.AI || typeof env.AI.toMarkdown !== 'function') {
    return json({ error: 'Server AI binding is not configured' }, 500, request, env);
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ error: 'Expected multipart/form-data' }, 400, request, env);
  }

  const files = form.getAll('files').filter((entry) => entry instanceof File && entry.size > 0);
  if (!files.length) {
    return json({ error: 'files is required' }, 400, request, env);
  }

  const docs = [];
  for (const file of files) {
    const buffer = await file.arrayBuffer();
    docs.push({
      name: file.name || 'file',
      blob: new Blob([buffer], { type: file.type || 'application/octet-stream' }),
    });
  }

  let converted;
  try {
    converted = await env.AI.toMarkdown(docs);
  } catch (error) {
    return json({ error: `文档转换失败：${error?.message || error}` }, 502, request, env);
  }

  const list = Array.isArray(converted) ? converted : [converted];
  const results = list.map((item) => ({
    name: item?.name || '',
    format: item?.format || 'error',
    mimetype: item?.mimetype || '',
    tokens: Number.isFinite(item?.tokens) ? item.tokens : null,
    data: typeof item?.data === 'string' ? item.data : '',
    error: typeof item?.error === 'string' ? item.error : '',
  }));

  return json({ results }, 200, request, env);
}

async function handleModels(request, env) {
  const authError = verifyAccessKey(request, env);
  if (authError) return authError;

  let upstream;
  try {
    upstream = await fetch(joinUrl(env.OPENAI_BASE_URL, '/v1/models'), {
      method: 'GET',
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
    });
  } catch (error) {
    return json({ error: `无法连接上游 /v1/models：${error.message}` }, 502, request, env);
  }

  const text = await upstream.text();
  let data;

  try {
    data = JSON.parse(text);
  } catch {
    return json({ error: 'Invalid upstream /v1/models response', raw: text.slice(0, 500) }, 502, request, env);
  }

  if (!upstream.ok) {
    return json(
      {
        error: data?.error?.message || data?.error || `Upstream /v1/models failed with HTTP ${upstream.status}`,
        upstreamStatus: upstream.status,
      },
      upstream.status,
      request,
      env,
    );
  }

  const models = Array.isArray(data?.data)
    ? data.data
        .filter((item) => item && typeof item.id === 'string' && item.id.trim())
        .map((item) => ({ id: item.id, label: item.id }))
        .sort((a, b) => compareModelId(a.id, b.id))
    : [];

  return json({ models }, 200, request, env);
}

async function handleChat(request, env) {
  const authError = verifyAccessKey(request, env);
  if (authError) return authError;

  if (!env.OPENAI_BASE_URL) {
    return json({ error: 'Server OPENAI_BASE_URL is not configured' }, 500, request, env);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400, request, env);
  }

  if (!Array.isArray(payload?.messages) || !payload.messages.length) {
    return json({ error: 'messages is required' }, 400, request, env);
  }

  const requestedMaxTokens = Number(payload.max_tokens);
  payload.max_tokens = clampNumber(requestedMaxTokens, 1, 128000, getMaxTokens(env));
  payload.stream = true;

  let upstream;
  try {
    upstream = await fetch(joinUrl(env.OPENAI_BASE_URL, '/v1/chat/completions'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    return json({ error: `无法连接上游 /v1/chat/completions：${error.message}` }, 502, request, env);
  }

  const headers = new Headers(corsHeaders(request, env));
  const contentType = upstream.headers.get('content-type');
  if (contentType) headers.set('content-type', contentType);

  if (!upstream.ok && !contentType?.includes('text/event-stream')) {
    const text = await upstream.text();
    let message = `Upstream chat failed with HTTP ${upstream.status}`;
    try {
      const parsed = JSON.parse(text);
      message = parsed?.error?.message || parsed?.error || message;
    } catch {
      if (text) message = text.slice(0, 500);
    }
    return json({ error: message, upstreamStatus: upstream.status }, upstream.status, request, env);
  }

  headers.set('Cache-Control', 'no-cache, no-transform');

  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  });
}

async function handleSearch(request, env) {
  const authError = verifyAccessKey(request, env);
  if (authError) return authError;

  if (!env.EXA_API_KEY) {
    return json({ error: 'Server EXA_API_KEY is not configured' }, 500, request, env);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400, request, env);
  }

  const query = String(body?.query || '').trim();
  if (!query) {
    return json({ error: 'query is required' }, 400, request, env);
  }

  const numResults = clampNumber(body?.numResults, 1, 20, DEFAULT_EXA_NUM_RESULTS);
  const searchType = normalizeSearchType(body?.type, env);
  const fresh = body?.fresh !== false;
  const exaBase = normalizeBaseUrl(env.EXA_BASE_URL) || 'https://api.exa.ai';
  const searchPath = normalizePath(env.EXA_SEARCH_PATH) || DEFAULT_EXA_SEARCH_PATH;

  const searchPayload = {
    query: query.slice(0, MAX_SEARCH_QUERY_LENGTH),
    type: searchType,
    numResults,
    // highlights 是 Exa 针对查询抽取的「相关片段」，比整页正文（大量导航/模板噪音）更干净
    contents: {
      highlights: { query: query.slice(0, MAX_SEARCH_QUERY_LENGTH), maxCharacters: 2000 },
      text: { maxCharacters: 3000, verbosity: 'compact' },
    },
  };

  // 天气 / 股价 / 新闻这类需要最新数据的场景，强制抓取新鲜内容
  if (fresh) searchPayload.contents.maxAgeHours = 0;

  if (Array.isArray(body?.includeDomains) && body.includeDomains.length) {
    searchPayload.includeDomains = body.includeDomains.slice(0, 20).map(String);
  }
  if (body?.category) {
    searchPayload.category = String(body.category);
  }
  if (typeof body?.userLocation === 'string' && body.userLocation) {
    searchPayload.userLocation = String(body.userLocation).slice(0, 2);
  }

  let upstream;
  try {
    upstream = await fetch(joinUrl(exaBase, searchPath), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'x-api-key': env.EXA_API_KEY,
      },
      body: JSON.stringify(searchPayload),
    });
  } catch (error) {
    return json({ error: `无法连接 Exa：${error.message}` }, 502, request, env);
  }

  const text = await upstream.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return json({ error: 'Invalid Exa response', raw: text.slice(0, 500) }, 502, request, env);
  }

  if (!upstream.ok) {
    return json(
      {
        error: data?.error || data?.message || `Exa search failed with HTTP ${upstream.status}`,
        upstreamStatus: upstream.status,
      },
      upstream.status,
      request,
      env,
    );
  }

  const results = Array.isArray(data?.results)
    ? data.results.map((item) => {
        const highlights = Array.isArray(item?.highlights)
          ? item.highlights.map((h) => String(h || '').trim()).filter(Boolean)
          : [];
        // 优先给模型「高亮片段」，没有再用整页正文
        const text = highlights.length
          ? highlights.join('\n…\n')
          : String(item?.text || item?.summary || '');

        return {
          title: item?.title || item?.url || '未命名结果',
          url: item?.url || '',
          publishedDate: item?.publishedDate || null,
          author: item?.author || null,
          highlights,
          text: truncateText(text, 2500),
        };
      })
    : [];

  return json({ query: searchPayload.query, results }, 200, request, env);
}

function normalizeSearchType(value, env) {
  const allowed = ['instant', 'fast', 'auto', 'deep-lite', 'deep', 'deep-reasoning'];
  const raw = String(value || '').trim();
  if (allowed.includes(raw)) return raw;
  const fallback = String(env.EXA_SEARCH_TYPE || 'auto').trim();
  return allowed.includes(fallback) ? fallback : 'auto';
}

async function handleFetch(request, env) {
  const authError = verifyAccessKey(request, env);
  if (authError) return authError;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400, request, env);
  }

  const url = String(body?.url || '').trim();
  if (!/^https?:\/\//i.test(url)) {
    return json({ error: 'url must be an http(s) URL' }, 400, request, env);
  }

  if (!env.EXA_API_KEY) {
    return json({ error: 'Server EXA_API_KEY is not configured' }, 500, request, env);
  }

  const exaBase = normalizeBaseUrl(env.EXA_BASE_URL) || 'https://api.exa.ai';
  const contentsPath = normalizePath(env.EXA_CONTENTS_PATH) || '/contents';
  const maxChars = clampNumber(body?.maxCharacters, 500, 20000, 4000);

  let upstream;
  try {
    upstream = await fetch(joinUrl(exaBase, contentsPath), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'x-api-key': env.EXA_API_KEY,
      },
      body: JSON.stringify({ urls: [url], text: { maxCharacters: maxChars } }),
    });
  } catch (error) {
    return json({ error: `无法连接 Exa：${error.message}` }, 502, request, env);
  }

  const text = await upstream.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return json({ error: 'Invalid Exa response', raw: text.slice(0, 500) }, 502, request, env);
  }

  if (!upstream.ok) {
    return json(
      { error: data?.error || data?.message || `Exa contents failed with HTTP ${upstream.status}`, upstreamStatus: upstream.status },
      upstream.status,
      request,
      env,
    );
  }

  const item = Array.isArray(data?.results) ? data.results[0] : null;
  return json(
    {
      url: item?.url || url,
      title: item?.title || item?.url || url,
      publishedDate: item?.publishedDate || null,
      text: truncateText(item?.text || '', maxChars),
    },
    200,
    request,
    env,
  );
}

function verifyAccessKey(request, env) {
  const auth = request.headers.get('authorization') || '';
  const expected = `Bearer ${env.ACCESS_KEY}`;

  if (!env.ACCESS_KEY) {
    return json({ error: 'Server ACCESS_KEY is not configured' }, 500, request, env);
  }

  const provided = auth.replace(/^Bearer\s+/i, '').trim();
  if (!provided || !timingSafeEqual(provided, String(env.ACCESS_KEY))) {
    return json({ error: 'Unauthorized' }, 401, request, env);
  }

  return null;
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function getMaxTokens(env) {
  return clampNumber(env.MAX_TOKENS, 1, 128000, DEFAULT_MAX_TOKENS);
}

function compareModelId(a, b) {
  return String(a).localeCompare(String(b), 'en', { numeric: true, sensitivity: 'base' });
}

function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(Math.max(Math.floor(num), min), max);
}

function normalizeBaseUrl(base) {
  const value = String(base || '').trim();
  if (!value) return '';
  return value.replace(/\/+$/, '');
}

function normalizePath(path) {
  const value = String(path || '').trim();
  if (!value) return '';
  return value.startsWith('/') ? value : `/${value}`;
}

function truncateText(text, max) {
  const value = String(text || '').trim();
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function joinUrl(base, path) {
  return `${String(base || '').replace(/\/$/, '')}${path}`;
}

function corsHeaders(request, env) {
  const origin = request?.headers?.get('origin');
  const allowedOrigin = env.ALLOWED_ORIGIN || '*';
  const finalOrigin = allowedOrigin === '*' ? '*' : origin || allowedOrigin;

  return {
    'Access-Control-Allow-Origin': finalOrigin,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    Vary: 'Origin',
  };
}

function json(data, status = 200, request, env) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(request, env),
    },
  });
}
