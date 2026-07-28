// ════════════════════════════════════════
// SCRAPPIE WORKER
// A thin CORS relay for Scrappie's two calls that browsers can't
// make directly: AI post-scoring (Groq, with a multi-model fallback
// chain) and email enrichment (Prospeo).
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
      return json({ error: "Not found. Use POST /score or POST /email." }, 404);
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

  const prompt = `You are a B2B sales lead qualifier. Read this LinkedIn post and judge how likely the author is a warm lead looking to hire someone to build custom software, an app, automation, or a similar tech solution.

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
