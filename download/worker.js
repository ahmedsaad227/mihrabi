/* MIHRABI AI — Cloudflare Worker (free plan, Workers AI binding)
 *
 * What this does: it is the only place a model is called. The app on GitHub Pages
 * posts the conversation here, this Worker asks Workers AI, and the answer streams
 * back. There is no API key anywhere: Workers AI is reached through the AI binding,
 * which lives inside the Cloudflare account and never reaches the browser.
 *
 * Deploy (see README.md in this folder): one free Cloudflare account, one Worker,
 * one AI binding. No card, no paid plan, no secret.
 */

const DEFAULT_MODEL = '@cf/meta/llama-3.1-8b-instruct';

const SYSTEM = `أنت "مِحرابي"، مساعد داخل تطبيق إسلامي عربي اسمه مِحرابي. مهمتك مساعدة المستخدم على فهم القرآن والعبادات الأساسية بلغة عربية بسيطة وواضحة.

قواعد صارمة:
1. لا تفتِ في الأحكام الشرعية. لو السؤال عن حكم (حلال/حرام/طلاق/ميراث/معاملات) قل بصراحة إن ده يحتاج شيخًا متخصصًا، واذكر المذهب أو الجهة اللي يسألها، ولا تخترع حكمًا.
2. لا تنسب حديثًا للنبي ﷺ إلا لو أنت واثق من نصه وتخريجه. لو مش واثق قل: "مش متأكد من نص الحديث، ارجع لصحيح البخاري أو مسلم".
3. لما تستشهد بآية اكتب مرجعها بالشكل ده بالظبط: [[quran:2:255]] — سورة:آية. التطبيق هيجيب نص الآية من المصحف بنفسه، فمتكتبش نص الآية بلفظك.
4. متخترعش أرقام آيات ولا أسماء سور. لو مش متأكد من الرقم، اكتب اسم السورة وسيب المستخدم يفتحها.
5. التفسير: اذكر أنه تفسير ميسّر بمعناك، ولو المستخدم عايز تفسيرًا معتمدًا وجّهه لتفاسير معروفة (الميسر، ابن كثير، الطبري) من غير ما تنقل نصًا طويلًا.
6. كن مختصرًا: 3 إلى 6 أسطر في الغالب، ووسّع بس لما السؤال يستاهل. استخدم العربية الفصحى المبسطة المصرية في الشرح.
7. لو السؤال خارج الموضوع الديني أو عن شيء لا تعرفه، قل ذلك بصراحة.
8. لا تطلب من المستخدم بيانات شخصية، ولا تعطه روابط دفع أو تبرعات.`;

function cors(env, origin) {
  const list = String(env.ALLOWED_ORIGINS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const allow = list.length === 0 ? '*' : (list.includes(origin) ? origin : list[0]);
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...headers, 'content-type': 'application/json; charset=utf-8' },
  });
}

/* a small per-isolate limiter: enough to stop one tab hammering the free allowance.
   It is per isolate, so it is a courtesy limit, not a wall. */
const hits = new Map();
function limited(ip, perMinute) {
  const now = Date.now();
  const slot = Math.floor(now / 60000);
  const key = ip + ':' + slot;
  const n = (hits.get(key) || 0) + 1;
  hits.set(key, n);
  if (hits.size > 5000) {
    for (const k of hits.keys()) if (!k.endsWith(':' + slot)) hits.delete(k);
  }
  return n > perMinute;
}

function clean(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-12)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const h = cors(env, origin);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });

    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return json({ ok: true, model: env.MODEL || DEFAULT_MODEL, ai: !!env.AI }, 200, h);
    }

    if (url.pathname !== '/chat') return json({ error: 'not_found' }, 404, h);
    if (request.method !== 'POST') return json({ error: 'method' }, 405, h);
    if (!env.AI) return json({ error: 'no_ai_binding' }, 500, h);

    const ip = request.headers.get('CF-Connecting-IP') || 'anon';
    const perMinute = parseInt(env.RATE_PER_MINUTE || '12', 10);
    if (limited(ip, perMinute)) return json({ error: 'rate_limited' }, 429, h);

    let body;
    try { body = await request.json(); } catch (e) { return json({ error: 'bad_json' }, 400, h); }
    const messages = clean(body && body.messages);
    if (!messages.length) return json({ error: 'no_messages' }, 400, h);

    const model = env.MODEL || DEFAULT_MODEL;
    const sys = SYSTEM + (body && body.lang && body.lang !== 'ar'
      ? '\n\nAnswer in the user\'s language (' + String(body.lang).slice(0, 8) + '), keeping the same rules.'
      : '');

    try {
      const out = await env.AI.run(model, {
        messages: [{ role: 'system', content: sys }, ...messages],
        max_tokens: 700,
        temperature: 0.3,
        stream: true,
      });
      return new Response(out, {
        headers: {
          ...h,
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          'x-model': model,
        },
      });
    } catch (e) {
      return json({ error: 'model_failed', detail: String(e && e.message || e).slice(0, 200) }, 502, h);
    }
  },
};
