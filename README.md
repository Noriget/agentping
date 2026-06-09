<p align="center">
  <img src="assets/logo-256.png" width="96" alt="AgentPing logo">
</p>

<h1 align="center">AgentPing</h1>

<p align="center">
  <b>Let your AI agent notify you — by email, Slack, Discord, or webhook.</b><br>
  A hosted, remote <a href="https://modelcontextprotocol.io">MCP</a> server. One tool: <code>send_notification</code>.
</p>

<p align="center">
  <a href="https://ping.mgm-llc.org">Website</a> ·
  <a href="https://ping.mgm-llc.org/docs">Docs</a> ·
  <a href="https://ping.mgm-llc.org/signup">Get an API key (free)</a>
</p>

---

## What it does

Long-running agents work while you're away. AgentPing gives them a `send_notification` tool so they can reach you the moment something matters:

- ✅ **Task done** — "Migration finished, 3,412 rows updated."
- 🙋 **Approval needed** — "Ready to deploy to prod. Confirm?"
- 📊 **Here's the result** — daily summary, scrape output, build status.
- 🚨 **Something broke** — error alerts from an autonomous run.

Notifications go to any channel you configure: **email, Slack, Discord, or a custom webhook**.

> 🔒 **Read-only by design.** AgentPing can only *send* the notifications your agent triggers. It has no access to your inbox, files, or accounts.

## Connect it (MCP client config)

**A. Remote URL** — Cursor and any client that supports Streamable HTTP:

```json
{
  "mcpServers": {
    "agentping": {
      "url": "https://ping.mgm-llc.org/mcp",
      "headers": { "Authorization": "Bearer YOUR_API_KEY" }
    }
  }
}
```

**B. Stdio bridge** — works with every MCP client (incl. Claude Desktop):

```json
{
  "mcpServers": {
    "agentping": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://ping.mgm-llc.org/mcp", "--header", "Authorization: Bearer YOUR_API_KEY"]
    }
  }
}
```

Get your API key by signing up at [ping.mgm-llc.org](https://ping.mgm-llc.org/signup) and setting your destinations. See the [full docs](https://ping.mgm-llc.org/docs) for per-client steps and Slack/Discord webhook setup.

## Tool

| Tool | Arguments | Notes |
|---|---|---|
| `send_notification` | `title` (string, required), `message` (string, optional), `channel` (optional) | `channel` ∈ `all` \| `email` \| `slack` \| `discord` \| `webhook`. Default: all configured channels. |

## Pricing

- **Free** — 100 notifications/month.
- **Pro** — $9/mo or $90/yr — 10,000 notifications/month.

## Protocol

Stateless **Streamable HTTP** (JSON-RPC 2.0): `initialize`, `tools/list`, `tools/call`, `ping`. Auth via `Authorization: Bearer <api_key>` (or `?key=` for clients that can't set headers).

## Self-hosting

Built on Cloudflare Workers + D1 + Hono. To run your own instance:

```bash
npm install
npm run db:local
npm run dev            # http://localhost:8787
```

`.dev.vars` needs `APP_SECRET` (and `RESEND_API_KEY` to enable email).

```bash
npx wrangler login
npx wrangler d1 create agentping       # put database_id in wrangler.jsonc
npm run db:remote
npx wrangler secret put APP_SECRET
npx wrangler secret put RESEND_API_KEY
# Stripe billing (optional):
npx wrangler secret put STRIPE_SECRET_KEY
npx wrangler secret put STRIPE_WEBHOOK_SECRET
npx wrangler deploy
```

Set `vars.APP_URL` to the production URL and attach a custom domain.

## License

MIT · Operated by MGM LLC.
