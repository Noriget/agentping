import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';

type Env = {
  DB: D1Database;
  APP_SECRET: string;
  FROM_EMAIL: string;
  APP_URL: string;
  RESEND_API_KEY?: string;
};

const app = new Hono<{ Bindings: Env; Variables: { uid: number } }>();
const FREE_NOTIF_MONTH = 100;

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
  <header class="nav"><div class="wrap"><a class="logo" href="/">Agent<b>Ping</b></a><nav>${user ? '<a href="/dashboard">Dashboard</a> &nbsp; <a href="/logout">Log out</a>' : '<a href="/login">Log in</a> &nbsp; <a class="btn" href="/signup">Sign up free</a>'}</nav></div></header>
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
    <ul class="muted"><li>One tool: <code>send_notification(title, message, channel)</code></li><li>Email · Slack · Discord · custom webhook</li><li>Free tier — ${FREE_NOTIF_MONTH} notifications/month</li><li>Private: your destinations stay in your account</li></ul>
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
  return c.html(layout('Dashboard', `
    <h1>Dashboard</h1>
    <div class="card"><strong>Plan: ${u.plan === 'pro' ? 'Pro' : 'Free'}</strong> <span class="muted">— ${(cnt && cnt.n) || 0}/${FREE_NOTIF_MONTH} notifications (last 30 days)</span></div>
    <div class="card"><strong>Your MCP key</strong>
      <pre>${esc(u.api_key)}</pre>
      <form method="POST" action="/regenerate-key" onsubmit="return confirm('Regenerate key? Old key stops working.')"><button class="btn ghost" type="submit">Regenerate key</button></form>
      <p class="muted" style="margin-top:10px">Add to your MCP client (Claude, Cursor, …):</p>
      <pre>{
  "mcpServers": {
    "agentping": {
      "url": "${esc(c.env.APP_URL)}/mcp",
      "headers": { "Authorization": "Bearer ${esc(u.api_key)}" }
    }
  }
}</pre>
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
    // free monthly cap
    const since = Date.now() - 30 * 864e5;
    const cnt = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id=? AND created_at>?').bind(user.id, since).first<any>();
    if (user.plan !== 'pro' && cnt && cnt.n >= FREE_NOTIF_MONTH) {
      return rpcOk(id, { content: [{ type: 'text', text: `Monthly free limit (${FREE_NOTIF_MONTH}) reached. Upgrade to Pro for more.` }], isError: true });
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

export default app;
