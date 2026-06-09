# AgentPing

A remote **MCP server** that lets an AI agent notify a human — by **email, Slack, Discord, or webhook**. Give your agent a `send_notification` tool for "task done", "approval needed", or "here's the result".

Built on Cloudflare Workers + D1 + Hono. Freemium (free tier: 100 notifications/month).

## How users connect it (MCP client config)
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
Get the API key by signing up at the site and setting your notification destinations.

## Tool
- `send_notification(title, message?, channel?)` — channel ∈ all|email|slack|discord|webhook (default all configured).

## MCP protocol
Stateless **Streamable HTTP** (JSON-RPC 2.0): `initialize`, `tools/list`, `tools/call`, `ping`. Auth via `Authorization: Bearer <api_key>` (or `?key=`).

## Local dev
```bash
npm install
npm run db:local
npm run dev   # http://localhost:8787
```
`.dev.vars`: `APP_SECRET` (and `RESEND_API_KEY` to enable email).

## Deploy
```bash
npx wrangler login
npx wrangler d1 create agentping     # put database_id in wrangler.jsonc
npm run db:remote
npx wrangler secret put APP_SECRET
npx wrangler secret put RESEND_API_KEY
npx wrangler deploy
```
Set `vars.APP_URL` to the production URL and attach a custom domain (e.g. ping.mgm-llc.org).

## Stack
Cloudflare Workers / D1 / Hono / Resend (email). Operated by MGM LLC.
