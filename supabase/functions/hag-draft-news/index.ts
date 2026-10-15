import { createClient } from "npm:@supabase/supabase-js@2";

const allowedOrigins = new Set([
  "https://heartlandathleticsgroup.com",
  "https://www.heartlandathleticsgroup.com"
]);
const respond = (body: unknown, status: number, origin: string) => new Response(
  JSON.stringify(body), { status, headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": allowedOrigins.has(origin) ? origin : "https://heartlandathleticsgroup.com",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "authorization, apikey, content-type, x-client-info",
    "vary": "Origin"
  } }
);
const tones = new Set(["Professional", "Community-focused", "Energetic", "Press release"]);
const categories = new Set(["Events", "Programs", "Community", "Enforcers"]);
const outputSchema = {
  type: "object", additionalProperties: false,
  properties: {
    title: { type: "string" },
    summary: { type: "string" },
    body: { type: "array", items: { type: "string" } }
  },
  required: ["title", "summary", "body"]
};

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin") || "";
  if (req.method === "OPTIONS") return respond({}, 204, origin);
  if (req.method !== "POST") return respond({ error: "Method not allowed." }, 405, origin);
  if (!allowedOrigins.has(origin)) return respond({ error: "Origin not allowed." }, 403, origin);

  const authorization = req.headers.get("authorization") || "";
  if (!authorization.startsWith("Bearer ")) return respond({ error: "Staff sign-in is required." }, 401, origin);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_ANON_KEY") ?? "",
    { global: { headers: { Authorization: authorization } }, auth: { persistSession: false, autoRefreshToken: false } }
  );
  const token = authorization.slice(7);
  const { data: userData, error: authError } = await supabase.auth.getUser(token);
  const user = userData?.user;
  if (authError || !user || !user.email_confirmed_at) return respond({ error: "A verified staff session is required." }, 401, origin);

  const { data: staff, error: staffError } = await supabase.from("hag_staff")
    .select("role,active").eq("user_id", user.id).maybeSingle();
  if (staffError || !staff?.active || !["admin", "editor"].includes(staff.role)) {
    return respond({ error: "H.A.G. editorial access required." }, 403, origin);
  }

  let input: Record<string, unknown>;
  try { input = await req.json(); } catch { return respond({ error: "Invalid request body." }, 400, origin); }
  const points = typeof input.points === "string" ? input.points.trim() : "";
  const tone = typeof input.tone === "string" && tones.has(input.tone) ? input.tone : "Professional";
  const category = typeof input.category === "string" && categories.has(input.category) ? input.category : "Community";
  if (points.length < 35 || points.length > 6000) {
    return respond({ error: "Provide 35–6,000 characters of factual focal points." }, 400, origin);
  }
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) return respond({
    error: "AI drafting is not yet activated. A project owner must set the OPENAI_API_KEY Edge Function secret in Supabase."
  }, 503, origin);

  // Limit AI model charges; log only request time and user identity, never prompts.
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const usage = await supabase.from("hag_ai_draft_requests").select("id", { count: "exact", head: true })
    .eq("staff_user_id", user.id).gte("requested_at", cutoff);
  if (usage.error) return respond({ error: "Unable to verify AI request limits." }, 503, origin);
  if ((usage.count ?? 0) >= 20) return respond({
    error: "Daily AI drafting limit reached (20 drafts per rolling 24 hours). Try again tomorrow."
  }, 429, origin);
  const claim = await supabase.from("hag_ai_draft_requests").insert({ staff_user_id: user.id });
  if (claim.error) return respond({ error: "Unable to reserve AI draft generation." }, 503, origin);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 23000);
  try {
    const result = await fetch("https://api.openai.com/v1/responses", {
      method: "POST", signal: controller.signal,
      headers: { Authorization: "Bearer " + apiKey, "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4.1-mini", store: false, max_output_tokens: 1250,
        instructions: [
          "You are H.A.G. News Assistant, editorial support for Heartland Athletics Group and Heartland Enforcers Basketball Club.",
          "Write a compelling, polished, accurate public news article based ONLY on supplied focal points.",
          "NEVER invent names, scores, quotes, awards, dates, prices, locations, sponsorships or affiliations.",
          "When vital information is missing, do not fill in fictional details; write around missing details.",
          "Use professional, community-oriented sports communications; no hypey manufactured quotes.",
          "Keep title 4–110 characters, summary 15–250 characters, and body 2–5 paragraphs.",
          "Do not include private contact info or sensitive identifying information about minors that may appear in notes.",
          "If athlete details are included, use only clearly public, guardian-approved details.",
          "The output is a DRAFT; H.A.G. staff must verify factual accuracy and approve it before publication.",
          "Return exactly the requested structured output."
        ].join(" "),
        input: "Category: " + category + "\nTone: " + tone + "\nApproved factual focal points:\n" + points,
        text: { format: { type: "json_schema", name: "hag_news_draft", strict: true, schema: outputSchema } }
      })
    });
    const response = await result.json();
    if (!result.ok) {
      return respond({ error: "AI service returned an error. Please check billing or the configured service key." }, 502, origin);
    }
    const raw = (response.output || []).filter((x: any) => x.type === "message")
      .flatMap((x: any) => x.content || []).filter((x: any) => x.type === "output_text")
      .map((x: any) => x.text).join("");
    const draft = JSON.parse(raw);
    if (typeof draft.title !== "string" || typeof draft.summary !== "string" ||
        !Array.isArray(draft.body) || draft.body.some((p: unknown) => typeof p !== "string")) {
      throw Error("Unexpected AI response format");
    }
    return respond({ draft: { title: draft.title.slice(0, 200), summary: draft.summary.slice(0, 1200),
      body: draft.body.slice(0, 8).map((p: string) => p.slice(0, 3000)) },
      notice: "AI-created draft. Verify all facts and any guardian permissions before publishing." }, 200, origin);
  } catch (_error) {
    return respond({ error: "AI draft generation failed or timed out. Try again later." }, 502, origin);
  } finally { clearTimeout(timer); }
});
