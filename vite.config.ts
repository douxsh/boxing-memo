import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

function extractTextFromResponse(payload: unknown) {
  if (!payload || typeof payload !== "object" || !("output" in payload)) {
    return "";
  }

  const output = (payload as { output?: Array<{ content?: Array<{ type?: string; text?: string }> }> }).output ?? [];
  return output
    .flatMap((item) => item.content ?? [])
    .filter((item) => item.type === "output_text" && typeof item.text === "string")
    .map((item) => item.text ?? "")
    .join("");
}

function openAIExtractionPlugin(): Plugin {
  return {
    name: "openai-extraction-api",
    configureServer(server) {
      server.middlewares.use("/api/extract-issues", async (req, res, next) => {
        if (req.method !== "POST") {
          next();
          return;
        }

        const env = loadEnv(server.config.mode, process.cwd(), "");
        const apiKey = env.OPENAI_API_KEY;
        const model = env.OPENAI_MODEL || "gpt-4.1-nano";

        if (!apiKey) {
          res.statusCode = 503;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "OPENAI_API_KEY is not set" }));
          return;
        }

        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
        });

        req.on("end", async () => {
          try {
            const parsed = JSON.parse(body) as { note?: string };
            const note = parsed.note?.trim();

            if (!note) {
              res.statusCode = 200;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ issues: [] }));
              return;
            }

            const prompt = `
You classify boxing coaching feedback into one or more issue items.

Rules:
- A single note may contain multiple issues. Return all of them.
- Merge paraphrases into canonical issue titles when possible.
- Use short Japanese titles.
- Keep sourceText as the original phrase or sentence fragment.
- Return strict JSON only.

Known canonical issues:
- leaning-forward: 前のめりになる
- guard-return: 打った後にガードが戻らない
- right-shoulder-open: 右を打つ時に肩が開く
- footwork-balance: 足元が流れる

If nothing fits, create a custom key like "custom:short-slug" and a short Japanese title.

Output schema:
{"issues":[{"key":"string","title":"string","sourceText":"string"}]}

Feedback:
${note}
            `.trim();

            const response = await fetch("https://api.openai.com/v1/responses", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
              },
              body: JSON.stringify({
                model,
                store: false,
                input: prompt,
              }),
            });

            if (!response.ok) {
              const errorText = await response.text();
              res.statusCode = response.status;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ error: errorText }));
              return;
            }

            const payload = (await response.json()) as unknown;
            const text = extractTextFromResponse(payload);
            const parsedOutput = JSON.parse(text) as {
              issues?: Array<{ key: string; title: string; sourceText: string }>;
            };

            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ issues: parsedOutput.issues ?? [] }));
          } catch (error) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(
              JSON.stringify({
                error: error instanceof Error ? error.message : "Unknown error",
              }),
            );
          }
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), openAIExtractionPlugin()],
});
