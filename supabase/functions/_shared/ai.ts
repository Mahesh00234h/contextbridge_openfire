/**
 * Provider-neutral AI gateway helper.
 *
 * Works with any OpenAI-compatible chat-completions endpoint. Configure:
 *   AI_GATEWAY_URL      e.g. https://api.openai.com/v1/chat/completions
 *   AI_GATEWAY_API_KEY  provider key (OPENAI_API_KEY is also accepted)
 *   AI_MODEL            model id, defaults to gpt-4o-mini
 */

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type ChatOptions = {
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
  stream?: boolean;
};

export class AIGatewayError extends Error {
  status: number;
  body: string;

  constructor(message: string, status: number, body = "") {
    super(message);
    this.name = "AIGatewayError";
    this.status = status;
    this.body = body;
  }
}

export function getAIConfig() {
  const url =
    Deno.env.get("AI_GATEWAY_URL") ?? "https://api.openai.com/v1/chat/completions";
  const apiKey =
    Deno.env.get("AI_GATEWAY_API_KEY") ?? Deno.env.get("OPENAI_API_KEY") ?? "";
  const model = Deno.env.get("AI_MODEL") ?? "gpt-4o-mini";

  if (!apiKey) {
    throw new AIGatewayError("AI_GATEWAY_API_KEY is not configured", 503);
  }

  return { url, apiKey, model };
}

export async function chatCompletion(options: ChatOptions): Promise<Response> {
  const { url, apiKey, model } = getAIConfig();

  const payload: Record<string, unknown> = {
    model,
    messages: options.messages,
    temperature: options.temperature ?? 0.2,
    max_tokens: options.maxTokens ?? 1800,
  };

  if (options.jsonMode) payload.response_format = { type: "json_object" };
  if (options.stream) payload.stream = true;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new AIGatewayError(
      `AI gateway returned ${response.status}`,
      response.status,
      body,
    );
  }

  return response;
}

export function extractJson<T>(content: string): T {
  try {
    return JSON.parse(content) as T;
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Could not parse AI JSON response");
    return JSON.parse(match[0]) as T;
  }
}

export async function chatJson<T>(
  options: Omit<ChatOptions, "jsonMode" | "stream">,
): Promise<T> {
  const response = await chatCompletion({ ...options, jsonMode: true });
  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;

  if (!content) throw new Error("No content in AI response");
  return extractJson<T>(String(content));
}