# Marketplace listing copy — AgentPing

Paste-ready text for each registry. Logo: `assets/logo-512.png` (use `logo-256.png` where smaller is needed).

---

## Common fields

- **Name:** AgentPing
- **Tagline / short description:** Let your AI agent notify you by email, Slack, Discord, or webhook.
- **Homepage:** https://ping.mgm-llc.org
- **Docs:** https://ping.mgm-llc.org/docs
- **Repository:** https://github.com/Noriget/agentping
- **MCP endpoint:** https://ping.mgm-llc.org/mcp  (Streamable HTTP, JSON-RPC 2.0)
- **Auth:** `Authorization: Bearer <api_key>` — free key at https://ping.mgm-llc.org/signup
- **License:** MIT
- **Categories/tags:** notifications, alerts, communication, productivity, email, slack, discord, webhook, devops, monitoring
- **Tools:** `send_notification(title, message?, channel?)`

### Long description

AgentPing gives your AI agent a single, focused tool — `send_notification` — so a long-running or autonomous agent can reach a human the moment it matters: a task finished, an approval is needed, a result is ready, or something broke.

Notifications are delivered to whatever channels you configure in your dashboard: email, Slack, Discord, or a custom webhook. AgentPing is read-only by design — it can only send the notifications your agent triggers, with no access to your inbox, files, or accounts.

It's a hosted remote MCP server (Streamable HTTP), so there's nothing to run locally: add the URL and your API key to any MCP client. Free tier includes 100 notifications/month; Pro is $9/mo (or $90/yr) for 10,000/month.

---

## mcp.so

Submit via the "Submit" flow (links the GitHub repo). Use the common fields above. mcp.so reads the README, so the polished README + `server.json` should populate most fields automatically.

- Server type: **Remote (hosted)**
- Connection: `https://ping.mgm-llc.org/mcp`

## Glama (glama.ai/mcp)

Glama auto-indexes public GitHub repos that look like MCP servers. Action: just make the repo **public** — it should be picked up. Ensure `README.md` and `server.json` are present (done). Optionally claim/verify the listing afterward.

## Cline MCP Marketplace

Submit a PR / issue to the Cline marketplace repo with:
- Repo URL: https://github.com/Noriget/agentping
- Logo: `assets/logo-256.png`
- Short description + the **Remote URL** config block (form A in the docs).

## Smithery (smithery.ai)

Smithery focuses on connectable servers. Add via "Add Server" / GitHub connect.
- Connection type: **HTTP (remote)** → `https://ping.mgm-llc.org/mcp`
- Auth header: `Authorization: Bearer <api_key>`

---

## Client config snippets (for any listing's "How to use")

**Remote URL (Cursor, Streamable-HTTP clients):**
```json
{ "mcpServers": { "agentping": {
  "url": "https://ping.mgm-llc.org/mcp",
  "headers": { "Authorization": "Bearer YOUR_API_KEY" } } } }
```

**Stdio bridge (every client, incl. Claude Desktop):**
```json
{ "mcpServers": { "agentping": {
  "command": "npx",
  "args": ["-y", "mcp-remote", "https://ping.mgm-llc.org/mcp", "--header", "Authorization: Bearer YOUR_API_KEY"] } } }
```
