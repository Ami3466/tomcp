/**
 * toMCP Worker
 * Converts any website to an MCP server + Chat with any website
 *
 * Usage: https://tomcp.org/docs.stripe.com
 * Chat: POST https://tomcp.org/chat
 */

export interface Env {
  AI: Ai; // Cloudflare Workers AI binding
}

// ========== RATE LIMITING ==========
// Protects free tier: 10,000 neurons/day ≈ 200 chat requests
const RATE_LIMIT = {
  maxPerIP: 5,                    // Max requests per IP per day
  maxGlobal: 200,                 // Max total requests per day (stay within free tier)
  windowMs: 24 * 60 * 60 * 1000,  // 24 hours
};

// Per-IP tracking
const rateLimitMap = new Map<string, { count: number; resetTime: number }>();

// Global daily counter
let globalCounter = { count: 0, resetTime: Date.now() + RATE_LIMIT.windowMs };

function isRateLimited(ip: string): { limited: boolean; remaining: number; resetIn: number; reason?: string } {
  const now = Date.now();

  // Reset global counter if window expired
  if (globalCounter.resetTime < now) {
    globalCounter = { count: 0, resetTime: now + RATE_LIMIT.windowMs };
  }

  // Check global limit first (to stay within free tier)
  if (globalCounter.count >= RATE_LIMIT.maxGlobal) {
    return {
      limited: true,
      remaining: 0,
      resetIn: globalCounter.resetTime - now,
      reason: 'Daily limit reached. Try again tomorrow!'
    };
  }

  // Clean up old IP entries periodically
  if (Math.random() < 0.01) {
    for (const [key, val] of rateLimitMap.entries()) {
      if (val.resetTime < now) rateLimitMap.delete(key);
    }
  }

  const record = rateLimitMap.get(ip);

  if (!record || record.resetTime < now) {
    // New window for this IP
    rateLimitMap.set(ip, { count: 1, resetTime: now + RATE_LIMIT.windowMs });
    globalCounter.count++;
    return { limited: false, remaining: RATE_LIMIT.maxPerIP - 1, resetIn: RATE_LIMIT.windowMs };
  }

  if (record.count >= RATE_LIMIT.maxPerIP) {
    return { limited: true, remaining: 0, resetIn: record.resetTime - now };
  }

  record.count++;
  globalCounter.count++;
  return { limited: false, remaining: RATE_LIMIT.maxPerIP - record.count, resetIn: record.resetTime - now };
}

function getClientIP(request: Request): string {
  return request.headers.get('CF-Connecting-IP') ||
         request.headers.get('X-Forwarded-For')?.split(',')[0].trim() ||
         'unknown';
}

// Simple HTML to Markdown converter
function htmlToMarkdown(html: string): string {
  return html
    // Remove scripts and styles
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    // Convert headers
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '# $1\n\n')
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '## $1\n\n')
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '### $1\n\n')
    .replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '#### $1\n\n')
    // Convert paragraphs
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '$1\n\n')
    // Convert links
    .replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
    // Convert bold/strong
    .replace(/<(strong|b)[^>]*>([\s\S]*?)<\/(strong|b)>/gi, '**$2**')
    // Convert italic/em
    .replace(/<(em|i)[^>]*>([\s\S]*?)<\/(em|i)>/gi, '*$2*')
    // Convert code blocks
    .replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, '```\n$1\n```\n\n')
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')
    // Convert lists
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n')
    .replace(/<\/?[uo]l[^>]*>/gi, '\n')
    // Remove remaining HTML tags
    .replace(/<[^>]+>/g, '')
    // Decode HTML entities
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    // Clean up whitespace
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Fetch website content
async function fetchWebsiteContent(url: string): Promise<string> {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'toMCP/1.0 (https://tomcp.org)',
      },
    });
    if (!response.ok) {
      return `Error: Could not fetch ${url} (${response.status})`;
    }
    const html = await response.text();
    return htmlToMarkdown(html).slice(0, 30000); // Limit context size
  } catch (error) {
    return `Error fetching ${url}: ${error instanceof Error ? error.message : 'Unknown error'}`;
  }
}

// Chat with Cloudflare Workers AI (free, no API key needed)
// Includes retry logic for transient failures
async function chatWithAI(
  ai: Ai,
  websiteUrl: string,
  websiteContent: string,
  userMessage: string,
  chatHistory: Array<{ role: string; content: string }>
): Promise<string> {
  const systemPrompt = `You are a helpful assistant that answers questions about the website ${websiteUrl}.
You have access to the website's content below. Answer questions based on this content.
If the answer isn't in the content, say so honestly.

Website Content:
${websiteContent}`;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...chatHistory.slice(-6), // Keep last 6 messages for context (smaller context for free tier)
    { role: 'user', content: userMessage },
  ];

  // Retry logic for transient AI failures
  const MAX_RETRIES = 3;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await ai.run('@cf/meta/llama-3.1-8b-instruct', {
        messages,
        max_tokens: 1024,
      });

      return (response as { response: string }).response || 'No response generated';
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Don't retry on the last attempt
      if (attempt < MAX_RETRIES) {
        // Wait before retrying (exponential backoff: 500ms, 1000ms)
        await new Promise(resolve => setTimeout(resolve, attempt * 500));
      }
    }
  }

  throw lastError || new Error('AI request failed after retries');
}

// MCP Protocol handlers
function createMcpResponse(id: number | string, result: unknown) {
  return {
    jsonrpc: '2.0',
    id,
    result,
  };
}

function createMcpError(id: number | string | null, code: number, message: string) {
  return {
    jsonrpc: '2.0',
    id,
    error: { code, message },
  };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.slice(1); // Remove leading slash

    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // ========== CHAT API ==========
    if (path === 'chat' && request.method === 'POST') {
      try {
        const body = await request.json() as {
          url: string;
          message: string;
          history?: Array<{ role: string; content: string }>;
          apiKey?: string; // Optional: user's own API key to bypass rate limits
        };

        const { apiKey } = body;
        const hasApiKey = !!apiKey && apiKey.length > 10;

        // Only check rate limit if no API key provided
        if (!hasApiKey) {
          const clientIP = getClientIP(request);
          const rateLimit = isRateLimited(clientIP);

          if (rateLimit.limited) {
            return Response.json(
              {
                error: rateLimit.reason || `Rate limit exceeded. Try again in ${Math.ceil(rateLimit.resetIn / 1000)} seconds.`,
                retryAfter: Math.ceil(rateLimit.resetIn / 1000)
              },
              {
                status: 429,
                headers: {
                  ...corsHeaders,
                  'Retry-After': String(Math.ceil(rateLimit.resetIn / 1000)),
                  'X-RateLimit-Remaining': '0',
                }
              }
            );
          }
        }

        const { url: websiteUrl, message, history = [] } = body;

        if (!websiteUrl || !message) {
          return Response.json(
            { error: 'Missing required fields: url and message' },
            { status: 400, headers: corsHeaders }
          );
        }

        // Check for AI binding
        if (!env.AI) {
          return Response.json(
            { error: 'Chat is not configured. AI binding missing.' },
            { status: 500, headers: corsHeaders }
          );
        }

        // Fetch website content
        const fullUrl = websiteUrl.startsWith('http') ? websiteUrl : `https://${websiteUrl}`;
        const content = await fetchWebsiteContent(fullUrl);

        // Chat with Cloudflare AI
        const response = await chatWithAI(
          env.AI,
          fullUrl,
          content,
          message,
          history
        );

        return Response.json(
          { response, url: fullUrl },
          { headers: corsHeaders }
        );
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : 'Chat failed' },
          { status: 500, headers: corsHeaders }
        );
      }
    }

    // Serve static assets from GitHub
    if (path === 'logo.svg' || path === 'logo.png') {
      const timestamp = Date.now();
      const assetUrl = `https://raw.githubusercontent.com/Ami3466/tomcp/main/${path}?t=${timestamp}`;
      const response = await fetch(assetUrl, { cf: { cacheTtl: 0 } });
      const contentType = path.endsWith('.svg') ? 'image/svg+xml' : 'image/png';
      return new Response(response.body, {
        headers: { ...corsHeaders, 'Content-Type': contentType, 'Cache-Control': 'no-cache, no-store, must-revalidate' },
      });
    }

    // Root path - serve website HTML
    if (!path) {
      const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>toMCP - Turn Any Website into an MCP Server</title>
  <meta name="description" content="Convert any website URL into an MCP server config. Works with Cursor, Claude, Windsurf, VS Code, and Cline.">
  <link rel="icon" type="image/png" href="/logo.png">
  <link rel="apple-touch-icon" href="/logo.png">
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwindcss.config = {
      theme: {
        extend: {
          colors: {
            gray: {
              900: '#111111',
              800: '#1a1a1a',
              700: '#2a2a2a',
              600: '#3a3a3a',
              500: '#6b7280',
              400: '#9ca3af',
            }
          }
        }
      }
    }
  </script>
  <style>
    body { background: #000; }
    .blur-effect {
      filter: blur(150px);
      opacity: 0.15;
    }
  </style>
</head>
<body class="min-h-screen text-white antialiased">
  <div class="fixed inset-0 overflow-hidden pointer-events-none">
    <div class="absolute -top-40 left-1/4 w-[500px] h-[500px] bg-blue-500 rounded-full blur-effect"></div>
    <div class="absolute top-60 right-1/4 w-[400px] h-[400px] bg-purple-500 rounded-full blur-effect"></div>
  </div>

  <div class="relative max-w-4xl mx-auto px-4 pt-2 pb-16">
    <header class="text-center mb-12">
      <!-- Big Logo + Title (no gap) -->
      <div class="flex flex-col items-center">
        <img src="/logo.png" alt="toMCP Logo" class="w-[360px] h-[360px] -mt-16 -mb-28">
        <h1 class="text-3xl font-semibold text-white tracking-tight">toMCP</h1>
      </div>

      <p class="text-2xl text-gray-300 mb-10 max-w-xl mx-auto">
        Convert any website or documentation into an MCP server for your AI tools
      </p>

      <!-- Examples -->
      <div class="mb-8">
        <p class="text-gray-500 text-lg mb-4">Convert any website into MCP server by adding tomcp.org/ before the URL:</p>
        <div class="flex flex-col items-center gap-3 text-xl font-mono">
          <span><span class="text-white">tomcp.org/</span><span class="text-blue-400">docs.stripe.com</span></span>
          <span><span class="text-white">tomcp.org/</span><span class="text-blue-400">react.dev</span></span>
          <span><span class="text-white">tomcp.org/</span><span class="text-blue-400">your-docs.com/api</span></span>
        </div>
      </div>

      <!-- OR divider -->
      <div class="flex items-center gap-4 max-w-sm mx-auto mb-8">
        <div class="flex-1 h-px bg-gray-800"></div>
        <span class="text-gray-500 text-lg">or</span>
        <div class="flex-1 h-px bg-gray-800"></div>
      </div>

      <!-- URL Input -->
      <div class="max-w-2xl mx-auto">
        <p class="text-gray-400 text-sm mb-3">Paste your URL here:</p>
        <div class="flex gap-2">
          <input type="text" id="urlInput" placeholder="docs.stripe.com" class="flex-1 px-4 py-3 bg-gray-900/50 border border-gray-800 rounded-lg text-white placeholder:text-gray-500 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 focus:outline-none transition-all">
          <button id="tryExample" class="px-4 py-3 rounded-lg bg-white hover:bg-gray-100 text-black font-medium transition-colors whitespace-nowrap">Try Example</button>
          <a href="https://github.com/Ami3466/tomcp" target="_blank" rel="noopener noreferrer" class="px-4 py-3 rounded-lg bg-gray-800 hover:bg-gray-700 text-white transition-colors flex items-center gap-2">
            <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path fill-rule="evenodd" clip-rule="evenodd" d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.17 6.839 9.49.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.604-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.464-1.11-1.464-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0112 6.836c.85.004 1.705.114 2.504.336 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.167 22 16.418 22 12c0-5.523-4.477-10-10-10z"/></svg>
            <span>GitHub</span>
          </a>
        </div>
      </div>
    </header>

    <main id="mcpSection" class="bg-gray-900/50 border border-gray-800 rounded-xl p-6 backdrop-blur-sm mb-8">
      <div class="mb-6">
        <label class="block text-sm font-medium text-white mb-3">Select your AI tool</label>
        <div id="toolsGrid" class="grid grid-cols-2 sm:grid-cols-5 gap-3"></div>
      </div>

      <div id="outputSection" class="hidden space-y-4">
        <div class="flex items-center justify-between">
          <div>
            <label class="block text-sm font-medium text-white">MCP Config for <span id="toolName">Cursor</span></label>
            <p id="configPath" class="text-gray-500 text-xs font-mono mt-1">~/.cursor/mcp.json</p>
          </div>
          <button id="copyBtn" class="flex items-center gap-2 px-4 py-2 bg-white text-black hover:bg-gray-100 rounded-lg text-sm font-medium transition-colors">
            <svg id="copyIcon" class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2" stroke-width="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" stroke-width="2"/></svg>
            <span id="copyText">Copy</span>
          </button>
        </div>
        <pre id="codeBlock" class="bg-gray-900/50 border border-gray-800 rounded-lg p-4 overflow-x-auto"><code class="text-sm text-green-400"></code></pre>
        <div class="bg-gray-800/30 border border-gray-700 rounded-lg p-4">
          <h3 class="text-white font-medium mb-3 flex items-center gap-2">
            <svg class="w-4 h-4 text-yellow-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>
            How to use
          </h3>
          <ol class="text-gray-400 text-sm space-y-2 list-decimal list-inside">
            <li>Copy the config above</li>
            <li>Open <code id="stepConfigPath" class="text-gray-300 bg-gray-800 px-1.5 py-0.5 rounded">~/.cursor/mcp.json</code></li>
            <li>Add or merge the config into your existing mcpServers</li>
            <li>Restart <span id="stepToolName">Cursor</span></li>
            <li>Ask your AI to fetch content from <span id="stepDomain">docs.stripe.com</span>!</li>
          </ol>
        </div>
        <a id="testLink" href="#" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-2 text-blue-400 hover:text-blue-300 text-sm transition-colors">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/></svg>
          Test MCP endpoint
        </a>
      </div>

      <div id="emptyState" class="text-center py-8 text-gray-500">
        <svg class="w-12 h-12 mx-auto mb-4 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" stroke-width="2"/><path stroke-width="2" d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
        <p>Enter a website URL to generate MCP config</p>
      </div>
    </main>

    <div class="bg-gradient-to-r from-blue-900/20 via-purple-900/20 to-pink-900/20 border border-blue-500/30 rounded-xl p-6 mb-8 text-center">
      <div class="flex items-center justify-center gap-2 mb-2">
        <svg class="w-5 h-5 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/></svg>
        <span class="text-sm font-medium text-blue-400">Coming Soon</span>
      </div>
      <h3 class="text-white font-semibold text-lg mb-1">Chat with Any Website</h3>
      <p class="text-gray-400 text-sm">Ask questions directly about any website's content - no config needed.</p>
    </div>

    <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mb-12">
      <div class="bg-gray-900/30 border border-gray-800/50 rounded-lg p-4">
        <h3 class="text-white font-medium mb-1">Any Website</h3>
        <p class="text-gray-500 text-sm">Works with any public URL - docs, blogs, APIs</p>
      </div>
      <div class="bg-gray-900/30 border border-gray-800/50 rounded-lg p-4">
        <h3 class="text-white font-medium mb-1">No Setup</h3>
        <p class="text-gray-500 text-sm">Just paste the config and restart your AI tool</p>
      </div>
      <div class="bg-gray-900/30 border border-gray-800/50 rounded-lg p-4">
        <h3 class="text-white font-medium mb-1">Free Forever</h3>
        <p class="text-gray-500 text-sm">Powered by Cloudflare Workers - no limits</p>
      </div>
    </div>

    <footer class="text-center text-gray-500 text-sm space-y-4">
      <a href="https://github.com/Ami3466/tomcp" target="_blank" class="inline-flex items-center gap-2 px-4 py-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg text-white text-sm font-medium transition-colors">
        <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg>
        GitHub
      </a>
      <p>
        <a href="https://github.com/Ami3466/tomcp" target="_blank" class="text-blue-400 hover:text-blue-300">What is MCP?</a>
        · Built with <a href="https://flowengine.cloud" target="_blank" class="text-blue-400 hover:text-blue-300">FlowEngine</a>
      </p>
    </footer>
  </div>

  <script>
    const MCP_BASE_URL = 'https://tomcp.org';
    const AI_TOOLS = [
      { id: 'cursor', name: 'Cursor', configPath: '~/.cursor/mcp.json', icon: 'https://cursor.sh/apple-touch-icon.png' },
      { id: 'claude', name: 'Claude', configPath: '~/.claude/claude_desktop_config.json', icon: 'https://www.anthropic.com/images/icons/apple-touch-icon.png' },
      { id: 'windsurf', name: 'Windsurf', configPath: '~/.codeium/windsurf/mcp_config.json', icon: 'https://codeium.com/favicon.svg' },
      { id: 'vscode', name: 'VS Code', configPath: '.vscode/mcp.json', icon: 'https://code.visualstudio.com/apple-touch-icon.png' },
      { id: 'cline', name: 'Cline', configPath: '~/.cline/mcp_settings.json', icon: 'https://cline.bot/assets/branding/favicons/apple-touch-icon.png' },
    ];
    let selectedTool = AI_TOOLS[0];
    let currentDomain = '';

    function renderTools() {
      const grid = document.getElementById('toolsGrid');
      grid.innerHTML = AI_TOOLS.map(tool => \`
        <button data-tool-id="\${tool.id}" class="tool-btn group relative flex flex-col items-center gap-2 p-3 rounded-xl border-2 transition-all duration-200 \${selectedTool.id === tool.id ? 'border-white/40 bg-white/10 scale-[1.02]' : 'border-gray-800 bg-gray-900/30 hover:border-gray-600 hover:bg-gray-800/50'}">
          <div class="w-8 h-8 rounded-lg bg-gray-800 flex items-center justify-center overflow-hidden">
            <img src="\${tool.icon}" alt="\${tool.name}" class="w-7 h-7 rounded" onerror="this.style.display='none'">
          </div>
          <span class="text-xs font-medium truncate w-full text-center transition-colors \${selectedTool.id === tool.id ? 'text-white' : 'text-gray-400 group-hover:text-gray-200'}">\${tool.name.split(' ')[0]}</span>
          \${selectedTool.id === tool.id ? '<div class="absolute -bottom-px left-1/2 -translate-x-1/2 w-6 h-0.5 bg-white rounded-full"></div>' : ''}
        </button>
      \`).join('');
      document.querySelectorAll('.tool-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          selectedTool = AI_TOOLS.find(t => t.id === btn.dataset.toolId);
          renderTools();
          updateOutput();
        });
      });
    }

    function cleanUrl(url) {
      if (!url) return { domain: '', fullPath: '' };
      let clean = url.trim().replace(/^https?:\\/\\//, '').replace(/^www\\./, '').replace(/\\/+$/, '');
      return { domain: clean.split('/')[0], fullPath: clean };
    }

    function generateConfig(fullPath) {
      const name = fullPath.split('/')[0].replace(/\\./g, '-');
      return JSON.stringify({ mcpServers: { [name]: { url: \`\${MCP_BASE_URL}/\${fullPath}\` } } }, null, 2);
    }

    function updateOutput() {
      const url = document.getElementById('urlInput').value;
      const { domain, fullPath } = cleanUrl(url);
      currentDomain = fullPath;
      const outputSection = document.getElementById('outputSection');
      const emptyState = document.getElementById('emptyState');
      const tryExampleBtn = document.getElementById('tryExample');
      if (domain) {
        outputSection.classList.remove('hidden');
        emptyState.classList.add('hidden');
        tryExampleBtn.classList.add('hidden');
        document.getElementById('toolName').textContent = selectedTool.name;
        document.getElementById('configPath').textContent = selectedTool.configPath;
        document.getElementById('stepConfigPath').textContent = selectedTool.configPath;
        document.getElementById('stepToolName').textContent = selectedTool.name;
        document.getElementById('stepDomain').textContent = domain;
        document.querySelector('#codeBlock code').textContent = generateConfig(fullPath);
        document.getElementById('testLink').href = \`\${MCP_BASE_URL}/\${fullPath}\`;
      } else {
        outputSection.classList.add('hidden');
        emptyState.classList.remove('hidden');
        tryExampleBtn.classList.remove('hidden');
      }
    }

    document.getElementById('copyBtn').addEventListener('click', async () => {
      await navigator.clipboard.writeText(generateConfig(currentDomain));
      document.getElementById('copyIcon').innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/>';
      document.getElementById('copyText').textContent = 'Copied!';
      setTimeout(() => {
        document.getElementById('copyIcon').innerHTML = '<rect x="9" y="9" width="13" height="13" rx="2" stroke-width="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" stroke-width="2"/>';
        document.getElementById('copyText').textContent = 'Copy';
      }, 2000);
    });

    document.getElementById('tryExample').addEventListener('click', () => {
      document.getElementById('urlInput').value = 'flowengine.cloud';
      updateOutput();
    });

    document.getElementById('urlInput').addEventListener('input', updateOutput);
    renderTools();

    // Check for URL param and pre-fill
    const urlParams = new URLSearchParams(window.location.search);
    const prefilledUrl = urlParams.get('url');
    if (prefilledUrl) {
      document.getElementById('urlInput').value = prefilledUrl;
      updateOutput();
    }
  </script>
</body>
</html>`;
      return new Response(html, {
        headers: { ...corsHeaders, 'Content-Type': 'text/html' },
      });
    }

    // Parse target URL from path
    const targetUrl = path.startsWith('http') ? path : `https://${path}`;

    // Handle MCP protocol (POST with JSON-RPC)
    if (request.method === 'POST') {
      try {
        const body = await request.json() as {
          jsonrpc: string;
          id: number | string;
          method: string;
          params?: Record<string, unknown>;
        };

        const { id, method, params } = body;

        // Handle MCP methods
        switch (method) {
          case 'initialize':
            return Response.json(createMcpResponse(id, {
              protocolVersion: '2024-11-05',
              capabilities: {
                tools: {},
              },
              serverInfo: {
                name: `toMCP - ${new URL(targetUrl).hostname}`,
                version: '1.0.0',
              },
            }), { headers: corsHeaders });

          case 'notifications/initialized':
            return Response.json(createMcpResponse(id, {}), { headers: corsHeaders });

          case 'tools/list':
            return Response.json(createMcpResponse(id, {
              tools: [
                {
                  name: 'fetch_page',
                  description: `Fetch a page from ${new URL(targetUrl).hostname}. Returns content as markdown.`,
                  inputSchema: {
                    type: 'object',
                    properties: {
                      path: {
                        type: 'string',
                        description: 'Path to fetch (e.g., "/docs/api" or leave empty for homepage)',
                        default: '',
                      },
                    },
                  },
                },
                {
                  name: 'search',
                  description: `Search for content on ${new URL(targetUrl).hostname}`,
                  inputSchema: {
                    type: 'object',
                    properties: {
                      query: {
                        type: 'string',
                        description: 'Search query',
                      },
                    },
                    required: ['query'],
                  },
                },
              ],
            }), { headers: corsHeaders });

          case 'tools/call': {
            const toolName = (params as { name: string })?.name;
            const toolArgs = (params as { arguments?: Record<string, string> })?.arguments || {};

            if (toolName === 'fetch_page') {
              const pagePath = toolArgs.path || '';
              const fullUrl = pagePath
                ? `${targetUrl}${pagePath.startsWith('/') ? '' : '/'}${pagePath}`
                : targetUrl;

              try {
                const response = await fetch(fullUrl, {
                  headers: {
                    'User-Agent': 'toMCP/1.0 (https://tomcp.org)',
                  },
                });

                if (!response.ok) {
                  return Response.json(createMcpResponse(id, {
                    content: [{
                      type: 'text',
                      text: `Error: Failed to fetch ${fullUrl} (${response.status})`,
                    }],
                  }), { headers: corsHeaders });
                }

                const html = await response.text();
                const markdown = htmlToMarkdown(html);

                return Response.json(createMcpResponse(id, {
                  content: [{
                    type: 'text',
                    text: markdown.slice(0, 50000), // Limit response size
                  }],
                }), { headers: corsHeaders });
              } catch (error) {
                return Response.json(createMcpResponse(id, {
                  content: [{
                    type: 'text',
                    text: `Error fetching page: ${error instanceof Error ? error.message : 'Unknown error'}`,
                  }],
                }), { headers: corsHeaders });
              }
            }

            if (toolName === 'search') {
              const query = toolArgs.query;
              // Try common search patterns
              const searchUrl = `${targetUrl}/search?q=${encodeURIComponent(query)}`;

              return Response.json(createMcpResponse(id, {
                content: [{
                  type: 'text',
                  text: `Search not directly supported. Try fetching: ${searchUrl}\n\nOr use fetch_page with a specific path.`,
                }],
              }), { headers: corsHeaders });
            }

            return Response.json(createMcpError(id, -32601, `Unknown tool: ${toolName}`), {
              headers: corsHeaders
            });
          }

          default:
            return Response.json(createMcpError(id, -32601, `Method not found: ${method}`), {
              headers: corsHeaders
            });
        }
      } catch (error) {
        return Response.json(createMcpError(null, -32700, 'Parse error'), {
          headers: corsHeaders
        });
      }
    }

    // GET request - redirect to homepage with URL pre-filled
    // The homepage JS will handle showing the config
    return Response.redirect(`https://tomcp.org/?url=${encodeURIComponent(path)}`, 302);
  },
};
