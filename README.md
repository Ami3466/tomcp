# toMCP

**Turn any website into an MCP server + Chat with any website.**

Convert any website URL into an MCP (Model Context Protocol) server config for your AI tools, or chat directly with any website's content.

## Usage

### MCP Server
Simply add `tomcp.org/` before any URL:

```
tomcp.org/docs.stripe.com
tomcp.org/react.dev
tomcp.org/your-docs.com/api
```

### Chat with Website
Visit [tomcp.org](https://tomcp.org), paste a URL, and start chatting with any website's content using AI.

## Supported AI Tools

- **Cursor** - `~/.cursor/mcp.json`
- **Claude Desktop** - `~/.claude/claude_desktop_config.json`
- **Windsurf** - `~/.codeium/windsurf/mcp_config.json`
- **VS Code** - `.vscode/mcp.json`
- **Cline** - `~/.cline/mcp_settings.json`

## How It Works

### MCP Config
1. Visit [tomcp.org](https://tomcp.org)
2. Enter any website URL
3. Select your AI tool
4. Copy the generated MCP config
5. Add it to your tool's config file
6. Restart your AI tool

### Chat
1. Visit [tomcp.org](https://tomcp.org)
2. Paste any website URL
3. Click "Start Chat"
4. Ask questions about the website's content

## Example Config

```json
{
  "mcpServers": {
    "docs-stripe-com": {
      "url": "https://tomcp.org/docs.stripe.com"
    }
  }
}
```

## Chat API

```bash
curl -X POST https://tomcp.org/chat \
  -H "Content-Type: application/json" \
  -d '{"url": "docs.stripe.com", "message": "How do I create a payment intent?"}'
```

### Rate Limits
- 5 requests per IP per day
- 200 total requests per day (global)

## Tech Stack

- **Frontend**: Vanilla HTML/CSS/JS with Tailwind CSS
- **Backend**: Cloudflare Workers
- **AI**: Cloudflare Workers AI (Llama 3.1 8B)

## Features

- Works with any public URL
- No setup required - just paste the config
- Free forever - powered by Cloudflare Workers
- Chat with any website using AI
- Side-by-side MCP Config + Chat interface

## License

MIT
