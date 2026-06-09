# Installing AgentPing (for Cline and other AI agents)

AgentPing is a **hosted remote MCP server**. There is **nothing to clone, build, or run locally** — installation is purely adding a config entry that points at the hosted endpoint with an API key.

## Step 1 — Get an API key

The user must sign up (free) and copy their API key:

1. Open https://ping.mgm-llc.org/signup and create an account.
2. On the dashboard, set at least one destination (email is pre-filled with the account email).
3. Copy the API key (looks like `ap_...`).

Ask the user to paste their API key. Do not invent one — the server rejects unknown keys with HTTP 401.

## Step 2 — Add the MCP server config

Add this to the user's MCP settings (`cline_mcp_settings.json`):

```json
{
  "mcpServers": {
    "agentping": {
      "url": "https://ping.mgm-llc.org/mcp",
      "headers": { "Authorization": "Bearer <USER_API_KEY>" }
    }
  }
}
```

Replace `<USER_API_KEY>` with the key from Step 1.

If this Cline build does not support remote (`url`) servers, use the stdio bridge instead (requires Node.js):

```json
{
  "mcpServers": {
    "agentping": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://ping.mgm-llc.org/mcp", "--header", "Authorization: Bearer <USER_API_KEY>"]
    }
  }
}
```

## Step 3 — Verify

After reloading MCP servers, the `send_notification` tool should be available. A quick test:

> Call `send_notification` with `title: "AgentPing connected"`.

The user should receive it on their configured channel(s).

## Notes

- **No environment variables, no build, no dependencies** beyond Node (only if using the stdio bridge).
- The only secret is the user's API key, passed as a Bearer token.
- Transport: stateless Streamable HTTP (JSON-RPC 2.0). Endpoint: `https://ping.mgm-llc.org/mcp`.
- Tool: `send_notification(title, message?, channel?)` where `channel ∈ all|email|slack|discord|webhook`.
