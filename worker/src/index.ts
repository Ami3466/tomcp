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
    if (path === 'logo.svg' || path === 'logo.png' || path === 'logowhite.svg') {
      const timestamp = Date.now();
      const assetUrl = `https://raw.githubusercontent.com/Ami3466/tomcp/main/${path}?t=${timestamp}`;
      const response = await fetch(assetUrl, { cf: { cacheTtl: 0 } });
      const contentType = path.endsWith('.svg') ? 'image/svg+xml' : 'image/png';
      return new Response(response.body, {
        headers: { ...corsHeaders, 'Content-Type': contentType, 'Cache-Control': 'no-cache, no-store, must-revalidate' },
      });
    }


    // Root path - serve website HTML from GitHub
    if (!path) {
      try {
        const timestamp = Date.now();
        const htmlUrl = `https://raw.githubusercontent.com/Ami3466/tomcp/main/index.html?t=${timestamp}`;
        const response = await fetch(htmlUrl, { cf: { cacheTtl: 0 } });
        if (!response.ok) {
          throw new Error(`Failed to fetch HTML: ${response.status}`);
        }
        const html = await response.text();
        return new Response(html, {
          headers: { ...corsHeaders, 'Content-Type': 'text/html', 'Cache-Control': 'no-cache, no-store, must-revalidate' },
        });
      } catch (error) {
        return new Response('Error loading page', { status: 500, headers: corsHeaders });
      }
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
