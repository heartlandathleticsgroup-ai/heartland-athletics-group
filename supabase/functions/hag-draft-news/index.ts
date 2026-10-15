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
    body: { type: "array", items: { type: "string" } },
    follow_up_questions: { type: "array", items: { type: "string" } }
  },
  required: ["title", "summary", "body", "follow_up_questions"]
};

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin") || "";
  if (req.method === "OPTIONS") return respond({ ok: true }, 200, origin);
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
  const storyAngle = typeof input.storyAngle === "string" ? input.storyAngle.trim().slice(0, 600) : "";
  const audience = typeof input.audience === "string" ? input.audience.trim().slice(0, 180) : "";
  if (points.length < 35 || points.length > 6000) {
    return respond({ error: "Provide 35–6,000 characters of factual focal points." }, 400, origin);
  }
  const apiKey = Deno.env.get("GROQ_API_KEY");
  if (!apiKey) return respond({
    error: "Groq free AI drafting is not yet activated. A project owner must set GROQ_API_KEY in Supabase Edge Function secrets."
  }, 503, origin);

  // Limit free-tier provider usage; record request timestamps and user IDs, never raw focal points.
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
    const result = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST", signal: controller.signal,
      headers: { Authorization: "Bearer " + apiKey, "content-type": "application/json" },
      body: JSON.stringify({
        model: "openai/gpt-oss-20b", max_completion_tokens: 2400,
        reasoning_effort: "low",
        messages: [{ role: "system", content: [
          "You are the senior newsroom editor for Heartland Athletics Group (H.A.G.), a community sports organization whose tagline is COMPETE. DEVELOP. INSPIRE.",
          "Craft PUBLICATION-QUALITY sports news that sounds like a confident, experienced local sports reporter: specific, credible, compelling, human, and clean.",
          "Ground every factual statement in the supplied notes. Do not invent details, schedules, prior history, crowd sizes, sponsors, registrations, achievements, motives, quotations, endorsements or organizational announcements.",
          "Interpret 'story angle' as a lens for presentation, NOT proof that a claim is true; only assert supplied, verified factual information.",
          "Use the strongest concrete fact or newsworthy development as the lead. Avoid generic leads like 'X is gearing up' or 'X is excited to announce'. Do not say 'has announced' unless the notes confirm a public announcement.",
          "Write a headline that carries the distinct news angle, not just the organization name. Make it clear and interesting without clickbait.",
          "A summary (deck) should add why readers should care without simply restating the headline or first sentence.",
          "Build paragraphs in this order where material permits: what is happening and when; why it matters, supported by the supplied notes; what is known next and what remains unconfirmed.",
          "Avoid repetition across headline, summary and body. Do not repeat dates or nearly identical sentences unnecessarily. No filler such as 'showcase the spirit of community' unless backed by specific factual detail.",
          "Use active voice, readable natural language, diverse sentence lengths, and selective vivid wording. No corporate jargon, generic boilerplate, exaggeration or manufactured drama.",
          "Use writing style deliberately: Professional = engaging impartial news reporting; Community-focused = accessible and warm without hype; Energetic = dynamic verbs without overclaiming; Press release = polished organizational announcement only when a public announcement is confirmed.",
          "Use H.A.G.'s values or tagline sparingly and only if directly relevant. Don't shoehorn branding into every paragraph.",
          "CRITICAL: Quality over length. If focal points are sparse, produce a crisp 90–140 word story, generally 2 short paragraphs, rather than padding it. With rich input, use 3–5 purposeful paragraphs.",
          "Never invent quotes. If the notes include an explicitly confirmed quotation, reproduce accurately with attribution; otherwise use no quotations.",
          "Never imply a venue, ticket price, sponsor, team count or registration details have been finalized unless the focal points confirm it.",
          "Do not include private contact information, medical records, or sensitive information about children in the output.",
          "Return 2–3 concise, practical reporting questions about missing details that would make THIS story more substantive. Questions are for editors only and must not appear in the article body.",
          "Deliver JSON with title (4–110 chars), summary (15–250 chars), body (array of 2–5 short paragraphs), follow_up_questions (array of 2–3 strings).",
          "This is a draft only; H.A.G. must fact-check, edit, approve, and publish it."
        ].join(" ") }, { role: "user", content:
          "Category: " + category + "\nTone: " + tone +
          "\nIntended readers: " + (audience || "Quincy-area families, athletes and community members") +
          "\nStory angle requested (not proof): " + (storyAngle || "Identify the strongest verified news angle") +
          "\nCONFIRMED FACTUAL FOCAL POINTS:\n" + points
        }],
        response_format: { type: "json_schema",
          json_schema: { name: "hag_news_draft", strict: true, schema: outputSchema }
        }
      })
    });
    const response = await result.json().catch(() => ({}));
    if (result.status === 429) return respond({ error: "Groq free-plan rate limit reached. Wait and retry later." }, 429, origin);
    if (!result.ok) return respond({ error: "Groq AI could not generate the draft. Confirm the Groq API key and free-plan quota." }, 502, origin);
    const raw = response.choices?.[0]?.message?.content;
    if (typeof raw !== "string" || !raw.trim()) throw Error("No article content returned");
    const draft = JSON.parse(raw);
    if (typeof draft.title !== "string" || typeof draft.summary !== "string" ||
        !Array.isArray(draft.body) || draft.body.some((p: unknown) => typeof p !== "string")) {
      throw Error("Unexpected AI response format");
    }
    const reportingQuestions = Array.isArray(draft.follow_up_questions) ?
      draft.follow_up_questions.filter((q: unknown) => typeof q === "string")
        .slice(0, 3).map((q: string) => q.slice(0, 220)) : [];
    return respond({ draft: { title: draft.title.slice(0, 200), summary: draft.summary.slice(0, 1200),
      body: draft.body.slice(0, 8).map((p: string) => p.slice(0, 3000)),
      reporting_questions: reportingQuestions },
      notice: "AI-created draft. Verify all facts and any guardian permissions before publishing." }, 200, origin);
  } catch (_error) {
    return respond({ error: "Groq AI draft generation failed or timed out. Try again later." }, 502, origin);
  } finally { clearTimeout(timer); }
});
