import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';

type Env = {
  DB: D1Database;
  APP_SECRET: string;
  FROM_EMAIL: string;
  APP_URL: string;
  RESEND_API_KEY?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_PRICE_ID?: string;
  STRIPE_PRICE_ID_ANNUAL?: string;
  STRIPE_WEBHOOK_SECRET?: string;
};

const app = new Hono<{ Bindings: Env; Variables: { uid: number } }>();
const FREE_NOTIF_MONTH = 100;
const PRO_NOTIF_MONTH = 10000;

// ---------- helpers ----------
const enc = new TextEncoder();
const b64url = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(buf as ArrayBuffer))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function pbkdf2(password: string, salt: Uint8Array) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return b64url(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, key, 256));
}
async function hashPassword(p: string) { const s = crypto.getRandomValues(new Uint8Array(16)); return `${b64url(s)}.${await pbkdf2(p, s)}`; }
async function verifyPassword(p: string, stored: string) { const [s, h] = stored.split('.'); if (!s || !h) return false; return (await pbkdf2(p, fromB64url(s))) === h; }
async function hmac(secret: string, data: string) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}
async function makeToken(secret: string, uid: number) { const p = b64url(enc.encode(JSON.stringify({ uid, exp: Date.now() + 30 * 864e5 }))); return `${p}.${await hmac(secret, p)}`; }
async function readToken(secret: string, t?: string) {
  if (!t) return null; const [p, sig] = t.split('.'); if (!p || !sig) return null;
  if ((await hmac(secret, p)) !== sig) return null;
  try { const { uid, exp } = JSON.parse(new TextDecoder().decode(fromB64url(p))); if (!uid || Date.now() > exp) return null; return uid as number; } catch { return null; }
}
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
async function newApiKey() { return 'ap_' + hex(await crypto.subtle.digest('SHA-256', crypto.getRandomValues(new Uint8Array(20)))).slice(0, 40); }

function layout(title: string, body: string, user?: boolean) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(title)} · AgentPing</title>
  <meta name="description" content="${esc(title)} — AgentPing: let your AI agent notify you by email, Slack, Discord or webhook via MCP.">
  <style>
    :root{--brand:#7c3aed;--ink:#0f172a;--muted:#64748b;--border:#e2e8f0;--bg:#f7f7fb}
    *{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:var(--ink);background:var(--bg);line-height:1.6}
    a{color:var(--brand);text-decoration:none}.wrap{max-width:880px;margin:0 auto;padding:0 18px}
    header.nav{background:#fff;border-bottom:1px solid var(--border)}header.nav .wrap{display:flex;justify-content:space-between;align-items:center;height:58px}
    .logo{font-weight:800;font-size:20px;color:var(--ink)}.logo b{color:var(--brand)}
    .btn{display:inline-block;background:var(--brand);color:#fff;border:none;border-radius:8px;padding:10px 16px;font-weight:700;cursor:pointer;font-size:14px}
    .btn.ghost{background:#eef2f7;color:var(--ink)}
    .card{background:#fff;border:1px solid var(--border);border-radius:14px;padding:20px;margin:16px 0}
    input,textarea{width:100%;padding:10px;border:1px solid var(--border);border-radius:8px;font-size:14px;font-family:inherit;margin:6px 0 12px}
    label{font-size:13px;color:var(--muted);font-weight:600}
    h1{font-size:28px}h2{font-size:20px;margin-top:28px}.muted{color:var(--muted);font-size:14px}
    code,pre{background:#0f172a;color:#e2e8f0;border-radius:8px;font-size:13px}code{padding:2px 6px}pre{padding:14px;overflow:auto;white-space:pre}
    main{padding:24px 0 60px}
  </style></head><body>
  <header class="nav"><div class="wrap"><a class="logo" href="/">Agent<b>Ping</b></a><nav><a href="/docs">Docs</a> &nbsp; ${user ? '<a href="/dashboard">Dashboard</a> &nbsp; <a href="/logout">Log out</a>' : '<a href="/login">Log in</a> &nbsp; <a class="btn" href="/signup">Sign up free</a>'}</nav></div></header>
  <main><div class="wrap">${body}</div></main>
  <footer style="border-top:1px solid var(--border);background:#fff"><div class="wrap" style="padding:18px;font-size:13px;color:var(--muted)"><a href="/">Home</a> · <a href="/signup">Sign up</a> · <a href="/terms">Terms</a> · <a href="/privacy">Privacy</a> · © ${new Date().getFullYear()} AgentPing · MGM LLC</div></footer>
  </body></html>`;
}

async function requireAuth(c: any, next: any) {
  const uid = await readToken(c.env.APP_SECRET, getCookie(c, 'ap_session'));
  if (!uid) return c.redirect('/login');
  c.set('uid', uid); await next();
}
const getUser = (env: Env, uid: number) => env.DB.prepare('SELECT * FROM users WHERE id=?').bind(uid).first<any>();

// ---------- notifications ----------
async function sendEmail(env: Env, to: string, subject: string, text: string) {
  if (!env.RESEND_API_KEY || !to) return false;
  try {
    const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: env.FROM_EMAIL, to, subject, html: `<p>${esc(text).replace(/\n/g, '<br>')}</p>` }) });
    return r.ok;
  } catch { return false; }
}
async function postJson(url: string, payload: any) { try { const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); return r.ok; } catch { return false; } }

async function deliver(env: Env, user: any, title: string, message: string, channel: string) {
  const text = message ? `${title}\n\n${message}` : title;
  const sent: string[] = [];
  const want = (ch: string) => channel === 'all' || channel === ch;
  if (want('email') && user.dest_email) { if (await sendEmail(env, user.dest_email, `🔔 ${title}`, message || title)) sent.push('email'); }
  if (want('slack') && user.slack_webhook) { if (await postJson(user.slack_webhook, { text })) sent.push('slack'); }
  if (want('discord') && user.discord_webhook) { if (await postJson(user.discord_webhook, { content: text })) sent.push('discord'); }
  if (want('webhook') && user.webhook_url) { if (await postJson(user.webhook_url, { title, message, at: Date.now() })) sent.push('webhook'); }
  return sent;
}

// ---------- stripe ----------
async function hmacHex(secret: string, data: string) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}
async function stripeApi(env: Env, path: string, params: Record<string, string>) {
  const r = await fetch('https://api.stripe.com/v1/' + path, { method: 'POST', headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });
  return r.json() as any;
}
async function notifCount(env: Env, uid: number) {
  const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id=? AND created_at>?').bind(uid, Date.now() - 30 * 864e5).first<any>();
  return (r && r.n) || 0;
}

// =================== MARKETING / AUTH / DASHBOARD ===================
app.get('/', async (c) => {
  if (await readToken(c.env.APP_SECRET, getCookie(c, 'ap_session'))) return c.redirect('/dashboard');
  return c.html(layout('Let your AI agent notify you', `
    <h1>Give your AI agent a way to reach you.</h1>
    <p class="muted" style="font-size:17px">AgentPing is an MCP server that lets your AI agent send you a notification — by email, Slack, Discord, or webhook. Perfect for "tell me when the task is done", "ask for approval", or "send me the result".</p>
    <p><a class="btn" href="/signup">Get your MCP key — free</a></p>
    <div class="card"><strong>Add it to your MCP client</strong>
      <pre>{
  "mcpServers": {
    "agentping": {
      "url": "${esc(c.env.APP_URL)}/mcp",
      "headers": { "Authorization": "Bearer YOUR_API_KEY" }
    }
  }
}</pre>
      <p class="muted">Then your agent has a <code>send_notification</code> tool. Works with Claude, Cursor, and any MCP-compatible client.</p>
    </div>
    <h2>Why AgentPing</h2>
    <ul class="muted"><li>One tool: <code>send_notification(title, message, channel)</code></li><li>Email · Slack · Discord · custom webhook</li><li>Private: your destinations stay in your account</li></ul>
    <h2>Pricing</h2>
    <div class="card"><strong>Free</strong> — <span class="muted">${FREE_NOTIF_MONTH} notifications/month, all channels (email/Slack/Discord/webhook).</span></div>
    <div class="card"><strong>Pro — $9/mo or $90/yr</strong><ul class="muted" style="margin:6px 0 0"><li><strong>${PRO_NOTIF_MONTH.toLocaleString()} notifications/month</strong> (100× Free)</li><li>For agents that run at scale, around the clock</li><li>Priority email support</li></ul></div>
    <h2>Example uses</h2>
    <ul class="muted"><li>"Email me when the deployment finishes."</li><li>"Ping Slack if the scraper hits an error."</li><li>"Send me the summary when the research is done."</li><li>"Ask for my approval before spending money."</li></ul>
    <p><a class="btn" href="/signup">Get started free</a> &nbsp; <a href="/docs">Read the docs →</a></p>
  `));
});

app.get('/signup', (c) => c.html(layout('Sign up', `
  <h1>Create your account</h1>
  <form method="POST" action="/signup" class="card" style="max-width:420px">
    <label>Email</label><input name="email" type="email" required>
    <label>Password (8+ chars)</label><input name="password" type="password" minlength="8" required>
    <label style="display:flex;gap:6px;align-items:flex-start;font-weight:400;font-size:13px"><input type="checkbox" name="agree" value="1" required style="width:auto;margin-top:3px"> <span>I agree to the <a href="/terms" target="_blank">Terms</a> and <a href="/privacy" target="_blank">Privacy Policy</a>.</span></label>
    <button class="btn" type="submit">Sign up free</button>
    <p class="muted">Have an account? <a href="/login">Log in</a></p>
  </form>`)));

app.post('/signup', async (c) => {
  const b = await c.req.parseBody();
  const email = String(b.email || '').trim().toLowerCase();
  const password = String(b.password || '');
  if (!email || password.length < 8) return c.html(layout('Sign up', `<div class="card">Invalid email or password too short. <a href="/signup">Back</a></div>`));
  if (!b.agree) return c.html(layout('Sign up', `<div class="card">You must agree to the Terms and Privacy Policy. <a href="/signup">Back</a></div>`));
  if (await c.env.DB.prepare('SELECT id FROM users WHERE email=?').bind(email).first()) return c.html(layout('Sign up', `<div class="card">Email already registered. <a href="/login">Log in</a></div>`));
  const key = await newApiKey();
  const res = await c.env.DB.prepare('INSERT INTO users (email,password,api_key,dest_email,created_at) VALUES (?,?,?,?,?)').bind(email, await hashPassword(password), key, email, Date.now()).run();
  setCookie(c, 'ap_session', await makeToken(c.env.APP_SECRET, res.meta.last_row_id as number), { httpOnly: true, secure: c.env.APP_URL.startsWith('https'), sameSite: 'Lax', path: '/', maxAge: 30 * 864e2 });
  return c.redirect('/dashboard');
});

app.get('/login', (c) => c.html(layout('Log in', `
  <h1>Log in</h1>
  <form method="POST" action="/login" class="card" style="max-width:420px">
    <label>Email</label><input name="email" type="email" required>
    <label>Password</label><input name="password" type="password" required>
    <button class="btn" type="submit">Log in</button>
    <p class="muted">No account? <a href="/signup">Sign up</a></p>
  </form>`)));

app.post('/login', async (c) => {
  const b = await c.req.parseBody();
  const user = await c.env.DB.prepare('SELECT * FROM users WHERE email=?').bind(String(b.email || '').trim().toLowerCase()).first<any>();
  if (!user || !(await verifyPassword(String(b.password || ''), user.password))) return c.html(layout('Log in', `<div class="card">Invalid email or password. <a href="/login">Back</a></div>`));
  setCookie(c, 'ap_session', await makeToken(c.env.APP_SECRET, user.id), { httpOnly: true, secure: c.env.APP_URL.startsWith('https'), sameSite: 'Lax', path: '/', maxAge: 30 * 864e2 });
  return c.redirect('/dashboard');
});
app.get('/logout', (c) => { deleteCookie(c, 'ap_session', { path: '/' }); return c.redirect('/'); });

app.get('/dashboard', requireAuth, async (c) => {
  const u = await getUser(c.env, c.get('uid'));
  const since = Date.now() - 30 * 864e5;
  const cnt = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id=? AND created_at>?').bind(u.id, since).first<any>();
  const recent = await c.env.DB.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 10').bind(u.id).all();
  const recentRows = (recent.results || []).map((n: any) => `<div class="muted" style="font-size:13px">${new Date(n.created_at).toLocaleString('en-US')} · ${esc(n.channel)} · ${esc(n.title)}</div>`).join('') || '<span class="muted">No notifications yet.</span>';
  const isPro = u.plan === 'pro';
  const cap = isPro ? PRO_NOTIF_MONTH : FREE_NOTIF_MONTH;
  const used = (cnt && cnt.n) || 0;
  const billing = isPro
    ? `<form method="POST" action="/billing/portal" style="margin-top:8px"><button class="btn ghost">Manage billing</button></form>`
    : `<p class="muted" style="margin:10px 0 4px"><strong>Upgrade to Pro ($9/mo or $90/yr) for:</strong></p>
       <ul class="muted" style="margin:0 0 10px"><li><strong>${PRO_NOTIF_MONTH.toLocaleString()} notifications/month</strong> — 100× the Free tier (${FREE_NOTIF_MONTH}/mo)</li><li>Never miss an alert when an agent runs at scale</li><li>Priority email support</li></ul>
       <form method="POST" action="/billing/checkout" style="display:inline-block"><button class="btn">Upgrade to Pro — $9/mo</button></form> <form method="POST" action="/billing/checkout?plan=annual" style="display:inline-block;margin-left:8px"><button class="btn ghost">Annual $90/yr</button></form>`;
  return c.html(layout('Dashboard', `
    <h1>Dashboard</h1>
    <div class="card"><strong>Plan: ${isPro ? 'Pro' : 'Free'}</strong> <span class="muted">— ${used}/${cap} notifications (30d)</span><br>${billing}</div>
    <div class="card"><strong>Your MCP key</strong>
      <pre>${esc(u.api_key)}</pre>
      <form method="POST" action="/regenerate-key" onsubmit="return confirm('Regenerate key? Old key stops working.')"><button class="btn ghost" type="submit">Regenerate key</button></form>
      <p class="muted" style="margin-top:10px"><strong>Cursor</strong> & clients with native Streamable HTTP:</p>
      <pre>{
  "mcpServers": {
    "agentping": {
      "url": "${esc(c.env.APP_URL)}/mcp",
      "headers": { "Authorization": "Bearer ${esc(u.api_key)}" }
    }
  }
}</pre>
      <p class="muted" style="margin-top:10px"><strong>Cline, Claude Desktop</strong> & others (stdio bridge, needs Node.js — recommended for maximum compatibility):</p>
      <pre>{
  "mcpServers": {
    "agentping": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "${esc(c.env.APP_URL)}/mcp", "--header", "Authorization: Bearer ${esc(u.api_key)}"]
    }
  }
}</pre>
      <p class="muted" style="font-size:13px">See the <a href="/docs">docs</a> for per-client steps.</p>
    </div>
    <div class="card" style="max-width:560px"><strong>Where to notify you</strong>
      <form method="POST" action="/settings">
        <label>Email</label><input name="dest_email" type="email" value="${esc(u.dest_email)}">
        <label>Slack webhook URL</label><input name="slack_webhook" value="${esc(u.slack_webhook)}">
        <label>Discord webhook URL</label><input name="discord_webhook" value="${esc(u.discord_webhook)}">
        <label>Custom webhook URL</label><input name="webhook_url" value="${esc(u.webhook_url)}">
        <button class="btn" type="submit">Save</button>
      </form>
    </div>
    <h2>Recent notifications</h2><div class="card">${recentRows}</div>
  `, true));
});

app.post('/settings', requireAuth, async (c) => {
  const b = await c.req.parseBody();
  await c.env.DB.prepare('UPDATE users SET dest_email=?,slack_webhook=?,discord_webhook=?,webhook_url=? WHERE id=?')
    .bind(String(b.dest_email || ''), String(b.slack_webhook || ''), String(b.discord_webhook || ''), String(b.webhook_url || ''), c.get('uid')).run();
  return c.redirect('/dashboard');
});
app.post('/regenerate-key', requireAuth, async (c) => {
  await c.env.DB.prepare('UPDATE users SET api_key=? WHERE id=?').bind(await newApiKey(), c.get('uid')).run();
  return c.redirect('/dashboard');
});

// ----- legal (brief) -----
app.get('/terms', (c) => c.html(layout('Terms of Service', `
  <h1>Terms of Service</h1><p class="muted">Last updated: 2026-06-09. Operated by MGM LLC (MGM合同会社).</p>
  <p class="muted">AgentPing is provided "AS IS" without warranties of any kind. We do not guarantee delivery of notifications or uninterrupted service. To the maximum extent permitted by law, our total liability is limited to the greater of fees you paid in the prior 12 months or USD 100, and we are not liable for indirect or consequential damages. You are responsible for your use and your configured destinations. Governed by the laws of Japan; exclusive jurisdiction: Tokyo District Court. Contact: contact@mgm-llc.org</p>`)));
app.get('/privacy', (c) => c.html(layout('Privacy Policy', `
  <h1>Privacy Policy</h1><p class="muted">Last updated: 2026-06-09.</p>
  <p class="muted">We store your account email, a hashed password, your API key, and your notification destinations (email/Slack/Discord/webhook). Notification titles are logged for usage history. We do not sell data. Sub-processors: Cloudflare (hosting/DB) and Resend (email). Contact: contact@mgm-llc.org for access or deletion.</p>`)));

// =================== MCP (Streamable HTTP, stateless) ===================
const TOOLS = [{
  name: 'send_notification',
  description: 'Send a notification to the human who owns this AgentPing account (email/Slack/Discord/webhook). Use to report task completion, ask for approval, or deliver a result/summary.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Short title/subject of the notification' },
      message: { type: 'string', description: 'Body text of the notification' },
      channel: { type: 'string', enum: ['all', 'email', 'slack', 'discord', 'webhook'], description: 'Which channel to use. Default: all configured.' },
    },
    required: ['title'],
  },
}];

const rpcOk = (id: any, result: any) => ({ jsonrpc: '2.0', id, result });
const rpcErr = (id: any, code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });

async function handleRpc(c: any, user: any, msg: any): Promise<any | null> {
  const { id, method, params } = msg || {};
  if (method === 'initialize') {
    return rpcOk(id, { protocolVersion: (params && params.protocolVersion) || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'AgentPing', version: '0.1.0' } });
  }
  if (method === 'ping') return rpcOk(id, {});
  if (method === 'tools/list') return rpcOk(id, { tools: TOOLS });
  if (method === 'tools/call') {
    const name = params?.name; const args = params?.arguments || {};
    if (name !== 'send_notification') return rpcErr(id, -32602, `Unknown tool: ${name}`);
    const title = String(args.title || '').slice(0, 200);
    const message = String(args.message || '').slice(0, 4000);
    const channel = ['all', 'email', 'slack', 'discord', 'webhook'].includes(args.channel) ? args.channel : 'all';
    if (!title) return rpcOk(id, { content: [{ type: 'text', text: 'Error: title is required.' }], isError: true });
    // monthly cap (plan-aware)
    const cap = user.plan === 'pro' ? PRO_NOTIF_MONTH : FREE_NOTIF_MONTH;
    const used = await notifCount(c.env, user.id);
    if (used >= cap) {
      const text = user.plan === 'pro' ? `Monthly limit (${PRO_NOTIF_MONTH}) reached.` : `Free limit (${FREE_NOTIF_MONTH}/month) reached. Upgrade to Pro at ${c.env.APP_URL}/dashboard.`;
      return rpcOk(id, { content: [{ type: 'text', text }], isError: true });
    }
    const sent = await deliver(c.env, user, title, message, channel);
    await c.env.DB.prepare('INSERT INTO notifications (user_id,channel,title,created_at) VALUES (?,?,?,?)').bind(user.id, sent.join(',') || 'none', title, Date.now()).run();
    const text = sent.length ? `Notification sent via: ${sent.join(', ')}.` : 'No destination configured (or all failed). Set up a destination in your AgentPing dashboard.';
    return rpcOk(id, { content: [{ type: 'text', text }], isError: sent.length === 0 });
  }
  // notifications/* and unknown methods: no response for notifications (no id)
  if (id === undefined || id === null) return null;
  return rpcErr(id, -32601, `Method not found: ${method}`);
}

async function authMcp(c: any) {
  const auth = c.req.header('Authorization') || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const key = bearer || c.req.query('key') || '';
  if (!key) return null;
  return c.env.DB.prepare('SELECT * FROM users WHERE api_key=?').bind(key).first<any>();
}

app.post('/mcp', async (c) => {
  const user = await authMcp(c);
  if (!user) return c.json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized: missing or invalid API key' } }, 401);
  let body: any;
  try { body = await c.req.json(); } catch { return c.json(rpcErr(null, -32700, 'Parse error'), 400); }
  if (Array.isArray(body)) {
    const out: any[] = [];
    for (const m of body) { const r = await handleRpc(c, user, m); if (r) out.push(r); }
    return out.length ? c.json(out) : c.body(null, 202);
  }
  const r = await handleRpc(c, user, body);
  if (!r) return c.body(null, 202);
  return c.json(r);
});
app.get('/mcp', (c) => c.text('AgentPing MCP endpoint. Use POST (Streamable HTTP) with Authorization: Bearer <key>.', 405));

// ----- billing (Stripe) -----
app.post('/billing/checkout', requireAuth, async (c) => {
  if (!c.env.STRIPE_SECRET_KEY || !c.env.STRIPE_PRICE_ID) return c.html(layout('Billing', `<div class="card">Billing is not configured yet. <a href="/dashboard">Back</a></div>`, true));
  const u = await getUser(c.env, c.get('uid'));
  const price = c.req.query('plan') === 'annual' && c.env.STRIPE_PRICE_ID_ANNUAL ? c.env.STRIPE_PRICE_ID_ANNUAL : c.env.STRIPE_PRICE_ID;
  const s = await stripeApi(c.env, 'checkout/sessions', {
    mode: 'subscription', 'line_items[0][price]': price, 'line_items[0][quantity]': '1',
    success_url: `${c.env.APP_URL}/billing/success`, cancel_url: `${c.env.APP_URL}/dashboard`,
    client_reference_id: String(u.id), customer_email: u.email, allow_promotion_codes: 'true',
  });
  if (s && s.url) return c.redirect(s.url, 303);
  return c.html(layout('Billing', `<div class="card">Could not start checkout. <a href="/dashboard">Back</a></div>`, true));
});
app.post('/billing/portal', requireAuth, async (c) => {
  const u = await getUser(c.env, c.get('uid'));
  if (!c.env.STRIPE_SECRET_KEY || !u?.stripe_customer_id) return c.redirect('/dashboard');
  const p = await stripeApi(c.env, 'billing_portal/sessions', { customer: u.stripe_customer_id, return_url: `${c.env.APP_URL}/dashboard` });
  return c.redirect(p && p.url ? p.url : '/dashboard', 303);
});
app.get('/billing/success', requireAuth, (c) => c.html(layout('Welcome to Pro', `<div class="card"><h1>🎉 You're on Pro!</h1><p class="muted">Activation may take a few seconds.</p><a class="btn" href="/dashboard">Dashboard</a></div>`, true)));
app.post('/stripe/webhook', async (c) => {
  const secret = c.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return c.text('webhook not configured', 503);
  const body = await c.req.text();
  const parts = Object.fromEntries((c.req.header('Stripe-Signature') || '').split(',').map((p) => p.split('=')));
  if (!parts.v1 || parts.v1 !== (await hmacHex(secret, `${parts.t}.${body}`))) return c.text('bad signature', 400);
  let ev: any; try { ev = JSON.parse(body); } catch { return c.text('bad json', 400); }
  const o = ev?.data?.object || {};
  try {
    if (ev.type === 'checkout.session.completed' && o.client_reference_id) {
      await c.env.DB.prepare('UPDATE users SET plan=?,stripe_customer_id=?,stripe_subscription_id=? WHERE id=?').bind('pro', o.customer || '', o.subscription || '', Number(o.client_reference_id)).run();
    } else if (ev.type === 'customer.subscription.deleted') {
      await c.env.DB.prepare('UPDATE users SET plan=? WHERE stripe_customer_id=?').bind('free', o.customer || '').run();
    } else if (ev.type === 'customer.subscription.updated') {
      await c.env.DB.prepare('UPDATE users SET plan=? WHERE stripe_customer_id=?').bind(['active', 'trialing', 'past_due'].includes(o.status) ? 'pro' : 'free', o.customer || '').run();
    }
  } catch {}
  return c.json({ received: true });
});

// ----- docs -----
app.get('/docs', (c) => {
  const url = `${c.env.APP_URL}/mcp`;
  return c.html(layout('Docs — set up AgentPing', `
    <h1>AgentPing documentation</h1>
    <p class="muted">Give your AI agent a <code>send_notification</code> tool so it can reach you by email, Slack, Discord, or webhook.</p>

    <h2>Quickstart</h2>
    <ol class="muted">
      <li><a href="/signup">Sign up</a> and copy your API key from the <a href="/dashboard">dashboard</a>.</li>
      <li>Set at least one destination (email is set to your account email by default).</li>
      <li>Add AgentPing to your MCP client (below). Your agent now has <code>send_notification</code>.</li>
    </ol>

    <h2>Connect your MCP client</h2>
    <p class="muted">Most clients support remote MCP servers. Use your API key as a Bearer token.</p>
    <p><strong>A. Direct remote URL</strong> (Cursor, and clients that support Streamable HTTP):</p>
    <pre>{
  "mcpServers": {
    "agentping": {
      "url": "${esc(url)}",
      "headers": { "Authorization": "Bearer YOUR_API_KEY" }
    }
  }
}</pre>
    <p><strong>B. Stdio bridge</strong> (for clients that only support local servers, e.g. some Claude Desktop setups):</p>
    <pre>{
  "mcpServers": {
    "agentping": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "${esc(url)}", "--header", "Authorization: Bearer YOUR_API_KEY"]
    }
  }
}</pre>
    <h3>Per-client notes</h3>
    <ul class="muted">
      <li><strong>Cursor</strong>: add the JSON (form A) to <code>~/.cursor/mcp.json</code> or project <code>.cursor/mcp.json</code>.</li>
      <li><strong>Claude Desktop</strong>: Settings → Developer → Edit Config → add form B (mcp-remote), then restart.</li>
      <li><strong>Cline / VS Code</strong>: open the MCP Servers panel → Add server → paste form A (URL + header) or form B.</li>
      <li><strong>Any other MCP client</strong>: use form A if it accepts a URL + headers; otherwise the form B bridge works everywhere.</li>
    </ul>

    <h2>Set up your notification channels</h2>
    <ul class="muted">
      <li><strong>Email</strong> — set in your dashboard (defaults to your account email).</li>
      <li><strong>Slack</strong> — create an Incoming Webhook at api.slack.com/apps → your app → Incoming Webhooks → Add to Workspace, then paste the URL in the dashboard.</li>
      <li><strong>Discord</strong> — Server Settings → Integrations → Webhooks → New Webhook → Copy URL, then paste it in the dashboard.</li>
      <li><strong>Custom webhook</strong> — any HTTPS URL; we POST JSON <code>{ title, message, at }</code>.</li>
    </ul>

    <h2>Tool reference</h2>
    <div class="card"><strong>send_notification(title, message?, channel?)</strong>
      <ul class="muted">
        <li><code>title</code> (string, required) — short subject.</li>
        <li><code>message</code> (string, optional) — body text.</li>
        <li><code>channel</code> (optional) — <code>all</code> (default) | <code>email</code> | <code>slack</code> | <code>discord</code> | <code>webhook</code>.</li>
      </ul>
      <p class="muted">Returns a confirmation of which channels were used.</p>
    </div>

    <h2>FAQ</h2>
    <div class="card"><strong>What does it cost?</strong><p class="muted">Free: ${FREE_NOTIF_MONTH} notifications/month. Pro ($9/mo or $90/yr): ${PRO_NOTIF_MONTH}/month.</p></div>
    <div class="card"><strong>Can the agent read my data?</strong><p class="muted">No. AgentPing only sends notifications you trigger. It has no read access to your inbox or accounts.</p></div>
    <div class="card"><strong>Which clients work?</strong><p class="muted">Any MCP-compatible client (Claude, Cursor, Cline, and others). Use the stdio bridge (form B) for maximum compatibility.</p></div>
    <p><a class="btn" href="/signup">Get your API key — free</a></p>
  `));
});

app.get('/robots.txt', (c) => c.text(`User-agent: *\nAllow: /\nSitemap: ${c.env.APP_URL}/sitemap.xml\n`));
app.get('/sitemap.xml', (c) => {
  const urls = ['/', '/docs', '/signup', '/terms', '/privacy'];
  return c.body(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${c.env.APP_URL}${u}</loc></url>`).join('\n')}\n</urlset>`, 200, { 'Content-Type': 'application/xml' });
});

export default app;
