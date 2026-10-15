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
function editorialChecks(draft: {title: string, summary: string, body: string[]}, confirmed: string, format: string): string[] {
  const warnings: string[] = [];
  const text = [draft.title, draft.summary, ...draft.body].join(" ");
  const grounded = confirmed.toLowerCase();
  const unsupported = [
    [/\bbasketball bash\b/i, "Invented or unofficial event nickname: basketball bash"],
    [/\bfostering camaraderie\b/i, "Generic promotional filler rather than a reported fact"],
    [/\blaying the groundwork\b/i, "Generic filler: laying the groundwork"],
    [/\bfriendly rivalry\b/i, "Unsupported promotional description: friendly rivalry"],
    [/\bspirited competition\b/i, "Generic promotional language: spirited competition"],
    [/\bcommunity.centric\b/i, "Generic marketing phrase: community-centric"],
    [/\bfamily.friendly atmosphere\b/i, "Unsupported atmosphere claim"],
    [/\bcontinues? (?:its|H\.A\.G\.'s) commitment\b/i, "Unsubstantiated organizational commitment claim"],
    [/\b(?:has not released|have not been disclosed|no other operational details|ticketing details|ticketing or registration processes)\b/i, "Unsupported claim about missing information or ticketing"],
    [/\b(?:has announced|announces|is excited to announce)\b/i, "Unverified announcement claim"],
    [/\b(?:arrangements are finalized|once arrangements are finalized)\b/i, "Implies unverified arrangements or timelines"]
  ] as const;
  for (const [pattern, warning] of unsupported) {
    const found = text.match(pattern);
    if (found && !grounded.includes(found[0].toLowerCase())) warnings.push(warning);
  }
  const wordCount = draft.body.join(" ").trim().split(/\s+/).filter(Boolean).length;
  if (format === "brief" && draft.body.length > 2) warnings.push("News brief contains more than two paragraphs. Condense it.");
  if (format === "brief" && wordCount > 125) warnings.push("News brief is too long for the supplied facts; reduce to 115 words or less.");
  if (draft.body.some(p => p.length < 15)) warnings.push("An article paragraph is unusually short; check for fragmented writing.");
  const normalized = (value:string) => value.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(w=>w.length>3);
  const deck = normalized(draft.summary), lead=normalized(draft.body[0]||"");
  if (deck.length && lead.length) {
    const leadSet = new Set(lead);
    if (deck.filter(w=>leadSet.has(w)).length / deck.length > 0.65) warnings.push("Summary repeats most of the lead instead of adding useful context.");
  }
  return [...new Set(warnings)].slice(0,8);
}


function editorialWords(value: string): string[] {
  return value.toLowerCase().replace(/[^a-z0-9 ]/g," ").split(/\s+/).filter(w=>w.length>3);
}
function editorialOverlap(a: string,b: string): number {
  const aWords=editorialWords(a),bWords=new Set(editorialWords(b));
  return aWords.length ? aWords.filter(w=>bWords.has(w)).length/aWords.length : 0;
}
function splitNewsSentences(text:string): string[] {
  return (text.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g)||[])
    .map(v=>v.trim()).filter(Boolean);
}
function deduplicateNewsBrief(draft:{
  title:string;summary:string;body:string[];follow_up_questions?:string[]
}, format:string):{draft:typeof draft;changed:boolean} {
  if(format!=="brief" || !draft.body.length) return {draft,changed:false};
  const body=draft.body.map(p=>p.trim()).filter(Boolean);
  if(!body.length)return {draft,changed:false};
  let summary=draft.summary.trim();
  if(editorialOverlap(summary,body[0])<=0.65)return {draft,changed:false};

  const firstParagraphSentences=splitNewsSentences(body[0]);
  let remainder="";
  if(firstParagraphSentences.length>=2){
    // Use the first factual sentence as a short deck; remove it from the article body.
    summary=firstParagraphSentences[0];
    remainder=firstParagraphSentences.slice(1).join(" ");
  }else if(body.length>=2){
    // One-sentence lead and separate context; never render the lead twice.
    summary=body[0];
  }else{
    // Insufficient independent facts to create both an excerpt and a separate article.
    return {draft,changed:false};
  }
  const remaining = [...(remainder?[remainder]:[]),...body.slice(1)]
    .filter(p=>p.length>=15).slice(0,2);
  if(!remaining.length||editorialOverlap(summary,remaining[0])>0.68){
    return {draft,changed:false};
  }
  return {draft:{...draft,summary,body:remaining},changed:true};
}

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
  const format = input.format === "article" ? "article" : "brief";
  const storyAngle = typeof input.storyAngle === "string" ? input.storyAngle.trim().slice(0, 600) : "";
  const audience = typeof input.audience === "string" ? input.audience.trim().slice(0, 180) : "";
  const verifiedBackground = typeof input.verifiedBackground === "string" ? input.verifiedBackground.trim().slice(0, 1500) : "";
  const backgroundVerified = input.backgroundVerified === true;
  if (verifiedBackground && !backgroundVerified) return respond({ error: "Confirm that historical background is verified and approved for publication before using it as a factual source." }, 422, origin);
  const confirmedFacts = verifiedBackground ? points + "\nVerified background: " + verifiedBackground : points;
  const pendingDetails = typeof input.pendingDetails === "string" ? input.pendingDetails.trim().slice(0, 1000) : "";
  const editorialBoundaries = typeof input.editorialBoundaries === "string" ? input.editorialBoundaries.trim().slice(0, 1000) : "";
  // An unverified historical claim belongs in verified background, not only the preferred angle.
  const angleHistory = /\b(?:\d{1,3}[\s-]+years?\b|tradition\b|before\s+(?:its\s+)?departure\b)/i.test(storyAngle);
  const historyNotInFacts = angleHistory && !verifiedBackground &&
    !/\b(?:\d{1,3}[\s-]+years?\b|tradition\b|before\s+(?:its\s+)?departure\b)/i.test(points);
  if (historyNotInFacts) {
    return respond({ error: "Your story angle mentions historical claims. Please enter those details under Verified history or background and confirm their accuracy, or remove them from the angle. This prevents the assistant from treating unverified history as fact." }, 422, origin);
  }
  if (points.length < 35 || points.length > 6000) {
    return respond({ error: "Provide 35–6,000 characters of factual focal points." }, 400, origin);
  }
  if (format === "article" && points.length < 450) {
    return respond({ error: "A full article needs more reporting. Please add at least 450 characters of specific, confirmed facts or choose News brief instead. More generic wording will not substitute for reporting." }, 422, origin);
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
  const timer = setTimeout(() => controller.abort(), 45000);
  try {
    const result = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST", signal: controller.signal,
      headers: { Authorization: "Bearer " + apiKey, "content-type": "application/json" },
      body: JSON.stringify({
        model: "openai/gpt-oss-20b", max_completion_tokens: 2400,
        reasoning_effort: "low",
        messages: [{ role: "system", content: [
          "You are the lead sports editor for Heartland Athletics Group (H.A.G.), serving Quincy and surrounding communities. The H.A.G. tagline is COMPETE. DEVELOP. INSPIRE.",
          "Write authentic local sports journalism suitable for a credible newsroom. You are NOT a marketing-copy assistant, and your goal is not to make sparse notes sound bigger than they are.",
          "The provided notes are your ONLY factual source. You have NO automatic access to H.A.G. sponsor records, news, history, confirmations, previous conversations, events, or the web. Never imply you know information you have not been given.",
          "Respect three types of input separately: CONFIRMED FACTS may support claims; PENDING/UNKNOWN DETAILS are context for cautious omission, not facts to imply finalized; DO NOT INCLUDE boundaries are hard prohibitions.",
          "A requested STORY ANGLE describes the desired framing, not evidence. If an angle is not supported by confirmed facts, do not assert it. Instead use the most concrete verifiable news fact.",
          "HARD FACT CHECK: No invented nicknames, branding, event subtitles, slogans, quotations, history, sponsors, dates, venues, basketball format, participant ages, benefits, promises, or definitive statements about pending arrangements.",
          "Use the exact official event and organization names in the supplied notes. Never attach invented descriptors such as 'Bash', 'Spectacular', 'Festival', 'celebration', or 'family-friendly' unless explicitly supported.",
          "No guarantees about what the event will deliver. Plans and goals may be attributed to H.A.G. only when the notes explicitly describe them.",
          "No 'has announced' or 'is excited to announce' unless the confirmed facts explicitly describe a public announcement.",
          "Don't turn a known absence into a story: do not state that venues, registration, sponsorship terms or timelines are being 'finalized' unless confirmed facts say that. Simply omit unsupported operational details.",
          "Your first sentence must convey the genuinely newsworthy supported fact and when relevant the location/date. Do not repeat the same lead in the deck and first paragraph.",
          "Avoid corporate padding and generic claims: 'laying the groundwork', 'spirited competition', 'fostering camaraderie', 'family engagement', 'bringing communities together', 'showcase', 'gearing up', 'community-centric', 'more details as plans solidify'. If a phrase adds no distinct verified information, cut it.",
          "Headline should be clear, specific and credible—never clickbait, no invented naming. Summary adds context, not a paraphrase of the headline.",
          "NEWS BRIEF mode is the DEFAULT and MUST contain only 1 or 2 paragraphs, with a maximum of 115 words across the body. For sparse notes, 35–70 words is better than padding. State the principal verifiable development without another paragraph restating it.",
          "FULL ARTICLE mode is allowed only when the notes contain substantive specific reporting; write up to 3–5 short paragraphs grounded in those facts. No padding to fill the target length.",
          "Style Professional = polished, concise news; Community-focused = warm and specific; Energetic = brisk and vivid but factual; Press release = official H.A.G. tone ONLY when an announcement or release is appropriate. All must follow the same factual limits.",
          "Use exact quotations only when attribution and publication permission are supplied. Do not fabricate speaker remarks or attach quotes to minors.",
          "Do not publish private information about minors, addresses, guardian contacts, medical details or identifying information not explicitly intended for public release.",
          "Think through factual claims against supplied notes before producing final JSON. If unsupported, remove the phrase, not merely soften it. Don't make the article sound like an advertisement.",
          "Give 2–3 targeted questions that would genuinely improve the reader's understanding: specific verified historical context, confirmed features of the format, community implications, or permission-cleared firsthand perspectives.",
          "Do NOT ask repeatedly about something the editor has ALREADY marked pending or explicitly unconfirmed; ask what substance could be verified instead. These questions are internal to staff, never included in body.",
          "Deliver exactly JSON: title (4–110 chars), summary (15–200 chars), body (for brief 1–2 paragraphs; for full article 2–5 short paragraphs), follow_up_questions (2–3 concise actionable editor questions).",
          "It is a draft only. H.A.G. must review every fact and explicitly approve before publication."
        ].join(" ") }, { role: "user", content:
          "Category: " + category + "\nTone: " + tone + 
          "\nDELIVERY FORMAT (strict): " + (format === "brief" ? "NEWS BRIEF. One to two short paragraphs, maximum 115 body words, no fabricated extra details. Avoid repeating the deck." : "FULL ARTICLE. Three to five short, specific paragraphs only if facts support them.") +
          "\nReaders: " + (audience || "Quincy-area athletes, families and community members") +
          "\nPreferred story angle (NOT PROOF): " + (storyAngle || "Choose strongest supported news angle") +
          "\nCONFIRMED, PUBLICLY SHAREABLE FACTS:\n" + points +
          "\nVERIFIED HISTORICAL CONTEXT (editor-confirmed; may be used in story lead):\n" + (verifiedBackground || "None provided") +
          "\nCURRENTLY PENDING / NOT YET CONFIRMED (do not present as finalized):\n" + (pendingDetails || "No additional details were provided") +
          "\nDO NOT SAY / DO NOT ASSUME:\n" + (editorialBoundaries || "Anything unsupported by confirmed facts")
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
    let draft = JSON.parse(raw);
    if (typeof draft.title !== "string" || typeof draft.summary !== "string" ||
        !Array.isArray(draft.body) || draft.body.some((p: unknown) => typeof p !== "string")) {
      throw Error("Unexpected AI response format");
    }
    let revisionPerformed = false;
    let briefDeduplicated = false;
    const normalizedInitial = deduplicateNewsBrief(draft,format);
    if(normalizedInitial.changed){draft=normalizedInitial.draft;briefDeduplicated=true}
    const originalWarnings = editorialChecks(draft, confirmedFacts, format);
    if (originalWarnings.length) {
      try {
        const repairResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST", signal: controller.signal,
          headers: { Authorization: "Bearer " + apiKey, "content-type": "application/json" },
          body: JSON.stringify({
            model: "openai/gpt-oss-20b",
            max_completion_tokens: 1600,
            reasoning_effort: "low",
            messages: [
              { role: "system", content:
                "You are a rigorous H.A.G. newsroom copy editor. Rewrite the supplied DRAFT into concise, factual, high-quality news using ONLY VERIFIED_FACTS. Do not turn editorial angles or pending items into facts. Remove every flagged phrase and unsupported claim entirely, do not replace them with speculation. Respect the exact official names. Keep a NEWS BRIEF to 1–2 substantive paragraphs and maximum 115 body words, with no generic filler, invented announcements or repetitive headline/summary/lead. Historical details may be included only when listed in VERIFIED_FACTS. Return only the structured JSON schema. Keep useful follow-up reporting questions." },
              { role: "user", content: JSON.stringify({
                VERIFIED_FACTS: confirmedFacts,
                STORY_ANGLE_NOT_FACT: storyAngle,
                PENDING_NOT_CONFIRMED: pendingDetails,
                DO_NOT_SAY: editorialBoundaries,
                FORMAT: format,
                EDITORIAL_WARNINGS_TO_FIX: originalWarnings,
                DRAFT_TO_REVISE: draft
              }) }
            ],
            response_format: { type: "json_schema",
              json_schema: { name: "hag_news_draft", strict: true, schema: outputSchema } }
          })
        });
        if (repairResponse.ok) {
          const repairJson = await repairResponse.json();
          const repairedText = repairJson.choices?.[0]?.message?.content;
          if (typeof repairedText === "string") {
            const revised = JSON.parse(repairedText);
            if (typeof revised.title === "string" && typeof revised.summary === "string" &&
                Array.isArray(revised.body) && revised.body.every((p: unknown) => typeof p === "string")) {
              draft = revised;
              revisionPerformed = true;
            }
          }
        }
      } catch (_repairError) { /* Keep flagged draft blocked for editorial review. */ }
    }
    const normalizedFinal = deduplicateNewsBrief(draft,format);
    if(normalizedFinal.changed){draft=normalizedFinal.draft;briefDeduplicated=true}
    const trimmedDraft = {
      title: draft.title.slice(0, 200),
      summary: draft.summary.slice(0, 1200),
      body: draft.body.slice(0, 8).map((p: string) => p.slice(0, 3000))
    };
    const qualityWarnings = editorialChecks(trimmedDraft, confirmedFacts, format);
    const reportingQuestions = Array.isArray(draft.follow_up_questions) ?
      draft.follow_up_questions.filter((q: unknown) => typeof q === "string")
        .slice(0, 3).map((q: string) => q.slice(0, 220)) : [];
    return respond({ draft: { ...trimmedDraft, reporting_questions: reportingQuestions },
      format, quality_warnings: qualityWarnings, ready_for_editor: qualityWarnings.length === 0, automatically_revised: revisionPerformed, brief_deduplicated: briefDeduplicated,
      notice: "AI-created draft only; editorial checks flag common problems but cannot prove every claim. Verify facts, quotes, event terminology and guardian permissions." }, 200, origin);
  } catch (_error) {
    return respond({ error: "Groq AI draft generation failed or timed out. Try again later." }, 502, origin);
  } finally { clearTimeout(timer); }
});
