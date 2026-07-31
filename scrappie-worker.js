// ════════════════════════════════════════
// SCRAPPIE WORKER
// A thin CORS relay for Scrappie's calls that browsers can't make
// directly: AI post-scoring (Groq, multi-model fallback), email
// enrichment (Prospeo), and free multi-source scraping (Reddit,
// Hacker News, and arbitrary RSS/Atom feeds).
//
// IMPORTANT: This worker holds NO secrets of its own. Every request
// carries the API key you already saved in Scrappie's Settings page.
// That means if you ever lose this worker again, redeploying this
// exact file is the entire fix — nothing to configure.
//
// DEPLOY:
//   1. Go to https://dash.cloudflare.com -> Workers & Pages -> Create -> Worker
//   2. Paste this whole file into the editor, replacing the default code.
//   3. Deploy. Copy the worker URL (looks like https://scrappie-worker.<you>.workers.dev)
//   4. Paste that URL into Scrappie -> Settings -> Worker URL.
// ════════════════════════════════════════

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    try {
      if (request.method === "POST" && url.pathname === "/score") {
        return await handleScore(request);
      }
      if (request.method === "POST" && url.pathname === "/email") {
        return await handleEmail(request);
      }
      if (request.method === "POST" && url.pathname === "/reddit") {
        return await handleReddit(request);
      }
      if (request.method === "POST" && url.pathname === "/hn") {
        return await handleHN(request);
      }
      if (request.method === "POST" && url.pathname === "/rss") {
        return await handleRSS(request);
      }
      return json({ error: "Not found. Use POST /score, /email, /reddit, /hn, or /rss." }, 404);
    } catch (err) {
      return json({ error: err.message || "Worker error" }, 500);
    }
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

// Models to try, in order. If one fails outright (bad request, model
// retired) or gets rate-limited / runs out of tokens, we fall through
// to the next. All are current Groq production models capable of
// fast structured-JSON output.
const SCORING_MODELS = [
  "openai/gpt-oss-120b",       // best quality, still very fast
  "llama-3.3-70b-versatile",   // strong general-purpose fallback
  "openai/gpt-oss-20b",        // fast + cheap fallback
  "llama-3.1-8b-instant",      // fastest, last resort
];

async function handleScore(request) {
  const { postText, apiKey } = await request.json();
  if (!postText) return json({ error: "Missing postText" }, 400);
  if (!apiKey) return json({ error: "Missing apiKey" }, 400);

  const prompt = `You are a strict B2B sales lead qualifier. Read this LinkedIn post and judge whether the AUTHOR is currently looking to hire/pay someone to build them custom software, an app, automation, or a similar tech solution for their own business.

Score LOW (0-30) if the post is just:
- General commentary, opinions, or news about tech/AI/software topics
- The author announcing, launching, or promoting their OWN product, tool, or SaaS
- A developer/founder sharing what they built, learned, or shipped
- Thought leadership, listicles, "hot takes", or industry trend discussion
- Case studies or success stories that don't ask for anything
- Job postings for the author's own company hiring an in-house employee (not a contractor/agency)

Score MEDIUM (31-69) only if there's an ambiguous or soft signal, e.g. the author is exploring options, comparing tools, or hints at a future project without a clear ask.

Score HIGH (70-100) only if the author explicitly signals unmet need and buying/hiring intent for THEIR OWN business — e.g. asking for recommendations for a developer/agency, saying they need something built, describing a problem they want automated/solved and inviting outreach, or asking who can help.

Mentioning words like "SaaS", "API", "automation", "dashboard", "CRM", or "workflow" is NOT by itself a signal of buying intent — most such posts are just talking about tech, not seeking a vendor. Judge intent, not vocabulary.

Post:
"""${String(postText).slice(0, 2000)}"""

Reply with ONLY a raw JSON object (no markdown fences, no commentary) in exactly this shape:
{"score": <integer 0-100>, "intent": "high" | "medium" | "low", "reason": "<one short sentence explaining the score>", "buyerType": "<e.g. Founder, Marketer, Ops Lead, Unknown>", "urgency": "high" | "medium" | "low", "keywords": ["<matched phrase>", "..."]}`;

  const errors = [];

  for (const model of SCORING_MODELS) {
    try {
      const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          response_format: { type: "json_object" },
          temperature: 0.2,
          max_tokens: 300,
        }),
      });

      // Retryable conditions: rate limited (429), token/quota exhausted (429/403),
      // model decommissioned (404/400), or a transient server error (5xx).
      // Anything else that's not ok, also just move on to the next model.
      if (!r.ok) {
        const t = await r.text().catch(() => "");
        errors.push(`${model}: ${r.status} ${t.slice(0, 150)}`);
        continue;
      }

      const data = await r.json();
      const content = data.choices?.[0]?.message?.content || "{}";
      let parsed = {};
      try {
        parsed = JSON.parse(content);
      } catch (_) {
        errors.push(`${model}: response was not valid JSON`);
        continue;
      }

      return json({
        score: typeof parsed.score === "number" ? Math.max(0, Math.min(100, parsed.score)) : 20,
        intent: parsed.intent || "low",
        reason: parsed.reason || "",
        buyerType: parsed.buyerType || "Unknown",
        urgency: parsed.urgency || "low",
        keywords: Array.isArray(parsed.keywords) ? parsed.keywords.slice(0, 4) : [],
        modelUsed: model,
      });
    } catch (err) {
      // Network error, timeout, etc — try the next model.
      errors.push(`${model}: ${err.message || "request failed"}`);
      continue;
    }
  }

  // Every model in the chain failed — the client will fall back to
  // its local keyword-based scoring automatically.
  return json({ error: "All scoring models failed: " + errors.join(" | ") }, 502);
}

// ── EMAIL ENRICHMENT ───────────────────────────────────────
async function handleEmail(request) {
  const { firstName, lastName, company, linkedinUrl, service, apiKey } = await request.json();
  if (!apiKey) return json({ email: null, error: "Missing apiKey" });
  if (!service) return json({ email: null, error: "Missing service" });

  if (service === "prospeo") return handleProspeo({ firstName, lastName, company, linkedinUrl, apiKey });

  return json({ email: null, error: "Unknown service: " + service });
}

// Prospeo — https://api.prospeo.io/enrich-person
async function handleProspeo({ firstName, lastName, company, linkedinUrl, apiKey }) {
  const data = {};
  if (firstName) data.first_name = firstName;
  if (lastName) data.last_name = lastName;
  if (company) data.company_name = company;
  if (linkedinUrl && linkedinUrl !== "#") data.linkedin_url = linkedinUrl;

  // Needs at least (first+last+company) or a linkedin_url to match — see Prospeo docs.
  if (!data.linkedin_url && !(data.first_name && data.last_name && data.company_name)) {
    return json({ email: null });
  }

  const r = await fetch("https://api.prospeo.io/enrich-person", {
    method: "POST",
    headers: { "X-KEY": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ only_verified_email: true, data }),
  });

  if (!r.ok) return json({ email: null });
  const d = await r.json();
  if (d.error || !d.person?.email?.email) return json({ email: null });

  const phone = d.person.mobile?.revealed ? d.person.mobile.mobile : null;
  return json({
    email: d.person.email.email,
    phone,
    confidence: d.person.email.status === "VERIFIED" ? 90 : 60,
  });
}

// ── REDDIT (free, no auth, public JSON API) ────────────────
// Reddit blocks requests without a descriptive User-Agent, so this
// must be relayed server-side rather than called from the browser.
async function handleReddit(request) {
  const { query, subreddit, limit } = await request.json();
  if (!query) return json({ items: [], error: "Missing query" });

  const n = Math.min(limit || 25, 50);
  const base = subreddit
    ? `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/search.json?restrict_sr=1&sort=new&limit=${n}&q=${encodeURIComponent(query)}`
    : `https://www.reddit.com/search.json?sort=new&limit=${n}&q=${encodeURIComponent(query)}`;

  const r = await fetch(base, {
    headers: { "User-Agent": "Scrappie-Lead-Scanner/1.0 (by /u/scrappie-app)" },
  });
  if (!r.ok) return json({ items: [], error: `Reddit ${r.status}` });

  const d = await r.json();
  const items = (d.data?.children || []).map((c) => {
    const p = c.data;
    return {
      id: "reddit_" + p.id,
      author: p.author,
      text: (p.title || "") + (p.selftext ? "\n" + p.selftext : ""),
      url: "https://reddit.com" + p.permalink,
      profileUrl: "https://reddit.com/u/" + p.author,
      date: p.created_utc ? new Date(p.created_utc * 1000).toISOString() : "",
      subreddit: p.subreddit,
    };
  });
  return json({ items });
}

// ── HACKER NEWS (free, no auth, Algolia search API) ────────
async function handleHN(request) {
  const { query, limit } = await request.json();
  if (!query) return json({ items: [], error: "Missing query" });

  const n = Math.min(limit || 25, 50);
  const r = await fetch(
    `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=story,comment&hitsPerPage=${n}`
  );
  if (!r.ok) return json({ items: [], error: `HN ${r.status}` });

  const d = await r.json();
  const items = (d.hits || []).map((h) => ({
    id: "hn_" + h.objectID,
    author: h.author,
    text: h.title ? h.title + (h.story_text ? "\n" + h.story_text : "") : h.comment_text || "",
    url: `https://news.ycombinator.com/item?id=${h.objectID}`,
    profileUrl: `https://news.ycombinator.com/user?id=${h.author}`,
    date: h.created_at || "",
  }));
  return json({ items: items.filter((i) => i.text && i.text.length > 10) });
}

// ── RSS / ATOM FEEDS (free, any public feed URL) ───────────
async function handleRSS(request) {
  const { url } = await request.json();
  if (!url) return json({ items: [], error: "Missing url" });

  let r;
  try {
    r = await fetch(url, { headers: { "User-Agent": "Scrappie-Lead-Scanner/1.0" } });
  } catch (err) {
    return json({ items: [], error: "Could not fetch feed: " + err.message });
  }
  if (!r.ok) return json({ items: [], error: `Feed returned ${r.status}` });

  const xml = await r.text();
  const items = parseFeed(xml).slice(0, 40);
  return json({ items });
}

// Lightweight RSS/Atom parser — no external deps available in Workers,
// so this extracts fields with regex rather than a full XML parser.
// Good enough for well-formed feeds; malformed feeds may yield partial results.
function parseFeed(xml) {
  const items = [];
  const blocks = xml.match(/<item[\s\S]*?<\/item>/gi) || xml.match(/<entry[\s\S]*?<\/entry>/gi) || [];
  for (const block of blocks) {
    const title = extractTag(block, "title");
    const description = extractTag(block, "description") || extractTag(block, "summary") || extractTag(block, "content");
    const link = extractLink(block);
    const pubDate = extractTag(block, "pubDate") || extractTag(block, "published") || extractTag(block, "updated");
    if (title || description) {
      items.push({
        id: "rss_" + (link || title || Math.random().toString(36).slice(2)),
        author: extractTag(block, "author") || extractTag(block, "dc:creator") || "",
        text: stripHtml(title) + (description ? "\n" + stripHtml(description) : ""),
        url: link || "",
        profileUrl: link || "",
        date: pubDate || "",
      });
    }
  }
  return items;
}
function extractTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  if (!m) return "";
  return m[1].replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "").trim();
}
function extractLink(block) {
  // RSS: <link>https://...</link>  |  Atom: <link href="https://..."/>
  const hrefMatch = block.match(/<link[^>]*href=["']([^"']+)["']/i);
  if (hrefMatch) return hrefMatch[1];
  const plainMatch = block.match(/<link[^>]*>([\s\S]*?)<\/link>/i);
  return plainMatch ? plainMatch[1].trim() : "";
}
function stripHtml(s) {
  return String(s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
