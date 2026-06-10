// Provider-neutral model access: the worker calls the OWNER's model with the
// owner's own key, locally. Detection order per PROTOCOL/§6.1: Anthropic key →
// OpenAI key → local Ollama → (ask). One small fetch helper per provider —
// auditable in one screen.

export interface ModelBackend {
  model_class: string;
  complete: (prompt: string) => Promise<string>;
}

const ANTHROPIC_MODEL = process.env.SWARMING_ANTHROPIC_MODEL ?? "claude-opus-4-8";
const OPENAI_MODEL = process.env.SWARMING_OPENAI_MODEL ?? "gpt-4o";

export async function detectModel(): Promise<ModelBackend | null> {
  if (process.env.SWARMING_MODEL === "mock") return mockBackend();
  if (process.env.ANTHROPIC_API_KEY) return anthropicBackend(process.env.ANTHROPIC_API_KEY);
  if (process.env.OPENAI_API_KEY) return openaiBackend(process.env.OPENAI_API_KEY);
  const ollama = await detectOllama();
  if (ollama) return ollama;
  return null;
}

function anthropicBackend(apiKey: string): ModelBackend {
  return {
    model_class: `anthropic/${ANTHROPIC_MODEL}`,
    complete: async (prompt) => {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: ANTHROPIC_MODEL,
          max_tokens: 4096,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const json = (await res.json()) as { content: { type: string; text?: string }[] };
      return json.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    },
  };
}

function openaiBackend(apiKey: string): ModelBackend {
  return {
    model_class: `openai/${OPENAI_MODEL}`,
    complete: async (prompt) => {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: OPENAI_MODEL, messages: [{ role: "user", content: prompt }] }),
      });
      if (!res.ok) throw new Error(`OpenAI API ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const json = (await res.json()) as { choices: { message: { content: string } }[] };
      return json.choices[0].message.content;
    },
  };
}

async function detectOllama(): Promise<ModelBackend | null> {
  const base = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";
  try {
    const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const json = (await res.json()) as { models?: { name: string }[] };
    const model = process.env.SWARMING_OLLAMA_MODEL ?? json.models?.[0]?.name;
    if (!model) return null;
    return {
      model_class: `ollama/${model}`,
      complete: async (prompt) => {
        const res2 = await fetch(`${base}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], stream: false }),
        });
        if (!res2.ok) throw new Error(`Ollama ${res2.status}`);
        const j = (await res2.json()) as { message: { content: string } };
        return j.message.content;
      },
    };
  } catch {
    return null;
  }
}

function mockBackend(): ModelBackend {
  // Deterministic test backend — answers 0.5 / first choice. Honest model_class.
  return {
    model_class: "mock",
    complete: async (prompt) => {
      const section = prompt.split("Questions (JSON):")[1]?.split("Respond with ONLY")[0] ?? "[]";
      const questions = JSON.parse(section.trim()) as { q_id: string; type: string; choices?: string[] }[];
      const answers = questions.map((q) =>
        q.type === "binary"
          ? { q_id: q.q_id, p: 0.5, rationale: "mock: maximum uncertainty" }
          : { q_id: q.q_id, choice: q.choices?.[0], rationale: "mock: first option" },
      );
      return JSON.stringify(answers);
    },
  };
}
