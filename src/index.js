export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(request, env) });
    }

    if (url.pathname === '/api/models' && request.method === 'GET') {
      return handleModels(request, env);
    }

    if (url.pathname === '/api/chat' && request.method === 'POST') {
      return handleChat(request, env);
    }

    return json({ error: 'Not found' }, 404, request, env);
  },
};

async function handleModels(request, env) {
  const authError = verifyAccessKey(request, env);
  if (authError) return authError;

  const upstream = await fetch(joinUrl(env.OPENAI_BASE_URL, '/v1/models'), {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
  });

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
    : [];

  return json({ models }, 200, request, env);
}

async function handleChat(request, env) {
  const authError = verifyAccessKey(request, env);
  if (authError) return authError;

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400, request, env);
  }

  const upstream = await fetch(joinUrl(env.OPENAI_BASE_URL, '/v1/chat/completions'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });

  const headers = new Headers(corsHeaders(request, env));
  const contentType = upstream.headers.get('content-type');
  if (contentType) headers.set('content-type', contentType);

  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  });
}

function verifyAccessKey(request, env) {
  const auth = request.headers.get('authorization') || '';
  const expected = `Bearer ${env.ACCESS_KEY}`;

  if (!env.ACCESS_KEY) {
    return json({ error: 'Server ACCESS_KEY is not configured' }, 500, request, env);
  }

  if (auth !== expected) {
    return json({ error: 'Unauthorized' }, 401, request, env);
  }

  return null;
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
    'Vary': 'Origin',
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
