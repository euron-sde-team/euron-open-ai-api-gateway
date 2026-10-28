/**
 * Copy-paste snippets for calling the gateway with the official SDKs. Pure (tested in
 * test/lib/snippets.test.ts). The key placeholder is used whenever the real secret is not
 * in hand, so a snippet never invites pasting a key into a shared screen by accident.
 */
export type SnippetLang = "curl" | "python" | "node" | "anthropic-python" | "anthropic-node";

export const SNIPPET_LABEL: Record<SnippetLang, string> = {
  curl: "curl",
  python: "Python (OpenAI SDK)",
  node: "Node.js (OpenAI SDK)",
  "anthropic-python": "Python (Anthropic SDK)",
  "anthropic-node": "Node.js (Anthropic SDK)",
};

/** The Anthropic SDKs add /v1 themselves: they want the root. */
export function rootOf(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

export function snippet(lang: SnippetLang, o: { baseUrl: string; key?: string | null; keyPrefix: string; model: string }): string {
  const base = o.baseUrl.replace(/\/+$/, "");
  const key = o.key || `${o.keyPrefix}your-key`;
  switch (lang) {
    case "curl":
      return `curl ${base}/chat/completions \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${o.model}",
    "messages": [{ "role": "user", "content": "Say hello in five words." }]
  }'`;
    case "python":
      return `from openai import OpenAI

client = OpenAI(base_url="${base}", api_key="${key}")

reply = client.chat.completions.create(
    model="${o.model}",
    messages=[{"role": "user", "content": "Say hello in five words."}],
)
print(reply.choices[0].message.content)`;
    case "node":
      return `import OpenAI from "openai";

const client = new OpenAI({ baseURL: "${base}", apiKey: "${key}" });

const reply = await client.chat.completions.create({
  model: "${o.model}",
  messages: [{ role: "user", content: "Say hello in five words." }],
});
console.log(reply.choices[0].message.content);`;
    case "anthropic-python":
      return `import anthropic

client = anthropic.Anthropic(base_url="${rootOf(base)}", api_key="${key}")

message = client.messages.create(
    model="${o.model}",
    max_tokens=256,
    messages=[{"role": "user", "content": "Say hello in five words."}],
)
print(message.content[0].text)`;
    case "anthropic-node":
      return `import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ baseURL: "${rootOf(base)}", apiKey: "${key}" });

const message = await client.messages.create({
  model: "${o.model}",
  max_tokens: 256,
  messages: [{ role: "user", content: "Say hello in five words." }],
});
console.log(message.content[0].type === "text" ? message.content[0].text : "");`;
  }
}
