import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { AIGatewayError, chatCompletion } from "../_shared/ai.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Input validation constants
const MAX_RAW_CONTENT_LENGTH = 500000;
const MAX_PLATFORM_LENGTH = 50;
const MAX_PAGE_TITLE_LENGTH = 200;

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Authentication check
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Missing Authorization header" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      throw new Error("Backend keys are not configured");
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: userData, error: userErr } = await supabase.auth.getUser();
    if (userErr || !userData?.user?.id) {
      return new Response(
        JSON.stringify({ error: "Invalid authentication" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const body = await req.json();
    
    // Input validation
    const rawContent = typeof body.rawContent === "string" ? body.rawContent : "";
    const platform = typeof body.platform === "string" ? body.platform.slice(0, MAX_PLATFORM_LENGTH) : null;
    const pageTitle = typeof body.pageTitle === "string" ? body.pageTitle.slice(0, MAX_PAGE_TITLE_LENGTH) : null;

    if (!rawContent || rawContent.length < 50) {
      return new Response(
        JSON.stringify({ error: "Content too short for analysis" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (rawContent.length > MAX_RAW_CONTENT_LENGTH) {
      return new Response(
        JSON.stringify({ error: `Content too long. Maximum ${MAX_RAW_CONTENT_LENGTH} characters allowed.` }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Send the FULL raw chat — only truncate if extremely large to fit token window
    const MAX_CHARS_FOR_AI = 90000;
    const truncatedContent = rawContent.length > MAX_CHARS_FOR_AI
      ? rawContent.substring(0, MAX_CHARS_FOR_AI) + "\n\n[...conversation truncated due to length, but analyze everything above thoroughly...]"
      : rawContent;

    const systemPrompt = `You are a context extraction engine. You receive an ENTIRE raw AI chat transcript and produce a single, dense, complete context document that another AI can read to instantly continue the work with ZERO loss of information.

Hard rules:
- READ THE ENTIRE TRANSCRIPT. Do not skim. Do not skip the middle.
- Be EXHAUSTIVE: capture every decision, every name, every file, every API, every number, every constraint, every preference, every requirement, every rejected option (and why), and every open thread.
- Use the EXACT terminology, identifiers, code names, file paths, function names, URLs, and people/role names from the transcript. Never paraphrase technical terms.
- Prefer SPECIFICITY over brevity. Length is fine. Vagueness is not.
- If the transcript contains code, list the files/components touched and what changed. Quote critical snippets verbatim if they encode a decision.
- If something is ambiguous in the transcript, say so explicitly rather than inventing.
- Output must be self-contained: another AI reading ONLY your output should be able to continue the conversation without ever seeing the original transcript.`;

    const userPrompt = `Platform: ${platform || 'Unknown'}
Page Title: ${pageTitle || 'Unknown'}
Total transcript length: ${rawContent.length} characters

=== FULL RAW CONVERSATION TRANSCRIPT (read it ALL, beginning to end) ===
${truncatedContent}
=== END OF TRANSCRIPT ===

Now produce a JSON object that another AI can read to fully continue this conversation. Be EXHAUSTIVE — long, dense, specific. Quote exact names/terms/files/URLs/numbers from the transcript. Do not generalize.

Return ONLY this JSON shape (no extra commentary):

{
  "title": "Clear specific title (max 60 chars) — name the actual project/topic, not generic words",

  "topic": "The exact subject/domain (specific, not vague)",

  "projectOrigin": "Why does this project/conversation exist? What problem? Who is the user? What was the initial ask? (3-5 sentences, specific)",

  "coreInsights": "The non-obvious realizations, reframings, or 'aha' moments that emerged. What makes the chosen approach right? (4-6 sentences)",

  "summary": "A long, detailed narrative summary covering the ENTIRE conversation arc from start to finish — what was asked, explored, tried, what worked, what didn't, and where things stand now. Include specific names, files, components, decisions. Aim for 8-15 sentences. This is the most important field — do NOT be brief.",

  "whatHasBeenBuilt": [
    "Every concrete artifact/feature/file/component/system created or modified. 5-20 specific items."
  ],

  "keyPoints": [
    "Every fact, requirement, preference, constraint, naming convention another AI MUST know. 8-15 specific items."
  ],

  "techStack": ["Every technology, library, framework, service, model, API, or tool — exact names and versions if given"],

  "decisions": [
    "Every decision locked in, with the WHY. Include rejected alternatives. 5-15 items."
  ],

  "strategicDirection": "The overall philosophy / design principles / 'north star' guiding the work. (3-5 sentences)",

  "currentStatus": "Exactly what is done, what is in progress, and the immediate next step. Reference specific files/features by name. (4-6 sentences)",

  "openQuestions": [
    "Every unresolved question, ambiguity, TODO, or pending decision. 3-10 specific items."
  ],

  "continuationPrompt": "Direct instructions to the next AI: 'You are picking up X. Do NOT re-explain Y. The user prefers Z. Focus on W next.' Concrete and prescriptive. (4-6 sentences)",

  "importantContext": "Critical nuances, hidden constraints, user preferences, conventions, gotchas, 'rules of the road' that would be lost otherwise. (5-10 sentences)"
}

Remember: another AI will rely SOLELY on your output. Missing detail = broken handoff. Be exhaustive.`;

    let response: Response;
    try {
      response = await chatCompletion({
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.2,
        maxTokens: 16000,
        jsonMode: true,
      });
    } catch (error) {
      if (error instanceof AIGatewayError) {
        if (error.status === 429) {
          return new Response(
            JSON.stringify({ error: "Rate limit exceeded, please try again later" }),
            { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
        if (error.status === 402) {
          return new Response(
            JSON.stringify({ error: "Payment required" }),
            { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
        console.error("AI gateway error:", error.status, error.body);
      }
      throw error;
    }

    const result = await response.json();
    const content = result.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error("No content in AI response");
    }

    // Parse the JSON response
    let analysis;
    try {
      analysis = JSON.parse(content);
    } catch (e) {
      // Try to extract JSON from the response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        analysis = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error("Could not parse AI response as JSON");
      }
    }

    // Validate and sanitize the response
    const sanitized = {
      title: (analysis.title || "Untitled Chat").substring(0, 60),
      topic: analysis.topic || null,
      projectOrigin: analysis.projectOrigin || null,
      coreInsights: analysis.coreInsights || null,
      summary: analysis.summary || null,
      whatHasBeenBuilt: Array.isArray(analysis.whatHasBeenBuilt) ? analysis.whatHasBeenBuilt.slice(0, 25) : [],
      keyPoints: Array.isArray(analysis.keyPoints) ? analysis.keyPoints.slice(0, 20) : [],
      techStack: Array.isArray(analysis.techStack) ? analysis.techStack.slice(0, 30) : [],
      decisions: Array.isArray(analysis.decisions) ? analysis.decisions.slice(0, 20) : [],
      strategicDirection: analysis.strategicDirection || null,
      currentStatus: analysis.currentStatus || null,
      openQuestions: Array.isArray(analysis.openQuestions) ? analysis.openQuestions.slice(0, 15) : [],
      continuationPrompt: analysis.continuationPrompt || null,
      importantContext: analysis.importantContext || null,
    };

    return new Response(
      JSON.stringify({ success: true, analysis: sanitized }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("analyze-context error:", e);
    return new Response(
      JSON.stringify({ error: "An error occurred. Please try again." }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
