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

## AI Models

### Free Models (No API Key Required)
These models are available for everyone with no setup:
- **Llama 3.1 8B** (Meta) - Default model, fast and capable
- **Hermes 2 Pro** (NousResearch) - Great for reasoning
- **Mistral 7B** (Mistral) - Efficient instruction-following
- **Gemma 7B LoRA** (Google) - Lightweight and fast

### Premium Models (API Key Required)
Add your Cloudflare Workers AI API key to unlock these models:
- **Llama 3.3 70B** (Meta) - Most powerful Llama model
- **DeepSeek R1 32B** (DeepSeek) - Advanced reasoning
- **Mistral Large** (Mistral) - Enterprise-grade
- **Gemma 3 12B** (Google) - Latest Gemma
- **GPT OSS 120B/20B** (OpenAI) - Open-source GPT variants

## Adding Your API Key

You can add your own Cloudflare Workers AI API key to:
1. **Unlock all premium models** - Access larger, more capable models
2. **Bypass rate limits** - No daily request limits
3. **Use your own quota** - Charges go to your Cloudflare account

### How to Get an API Key
1. Go to [Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/get-started/rest-api/#1-get-api-token-and-account-id)
2. Create an API token with Workers AI permissions
3. Copy the token

### How to Add Your Key
1. Start a chat session on [tomcp.org](https://tomcp.org)
2. Below the chat input, you'll see "Add API key from Cloudflare Workers AI"
3. Paste your API key and click "Save"
4. Premium models will now be unlocked in the dropdown

### Where Is the API Key Stored?
- Your API key is stored **locally in your browser** using `localStorage`
- Key name: `tomcp_api_key`
- The key is sent with each chat request but **never stored on our servers**
- You can remove it anytime by clicking "Remove" in the API key section

## How It Works (Technical)

### Model Fetching
The available models are fetched dynamically from the Cloudflare Workers AI API:
1. Frontend calls `GET /models` endpoint on page load
2. Worker fetches models from `api.cloudflare.com/client/v4/accounts/{id}/ai/models/search`
3. Models are filtered to "Text Generation" tasks and cached for 5 minutes
4. Frontend displays free models as enabled, premium models as disabled (until API key is added)

### Chat Flow
1. User enters a URL and starts chatting
2. Worker fetches the website content and converts HTML to Markdown
3. Content is sent to the selected AI model with the user's message
4. Response is returned to the user

### Rate Limiting
Without an API key:
- 5 requests per IP per day

With your API key:
- No rate limits (uses your Cloudflare account quota)

## Tech Stack

- **Frontend**: Vanilla HTML/CSS/JS with Tailwind CSS
- **Backend**: Cloudflare Workers
- **AI**: Cloudflare Workers AI (multiple models)

## Features

- Works with any public URL
- No setup required - just paste the config
- Free forever - powered by Cloudflare Workers
- Chat with any website using AI
- Side-by-side MCP Config + Chat interface
- **Multiple AI models** - Choose from Llama, Mistral, Gemma, and more
- **Bring your own API key** - Unlock premium models and bypass rate limits

## License

Apache 2.0
