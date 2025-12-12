# toMCP Worker

Cloudflare Worker that powers [tomcp.org](https://tomcp.org) - convert any website to an MCP server + Chat with any website.

## Features

- **MCP Server**: Turn any URL into an MCP server for AI tools (Cursor, Claude, Windsurf, VS Code, Cline)
- **Chat API**: Chat with any website's content using Llama 3.1
- **Rate Limited**: 10 requests/IP/day, 100 total/day (protects free tier)

## Setup

```bash
cd worker
npm install
```

## Development

```bash
npm run dev    # Local dev on http://localhost:8787
```

## Deploy

```bash
npx wrangler login   # Login to Cloudflare
npm run deploy       # Deploy to production
```

## API Endpoints

### MCP Protocol
```
POST https://tomcp.org/{website-url}
```
Implements MCP JSON-RPC protocol with `fetch_page` and `search` tools.

### Chat API
```
POST https://tomcp.org/chat
Content-Type: application/json

{
  "url": "docs.stripe.com",
  "message": "How do I create a payment intent?",
  "history": []  // optional
}
```

## Rate Limits

- 5 requests per IP per day
- 200 total requests per day (global)
- Resets at midnight UTC
- Bypass with your own API key (coming soon)

## Tech Stack

- Cloudflare Workers
- Cloudflare Workers AI (Llama 3.1 8B)
- TypeScript
