import { createRemoteJWKSet, jwtVerify } from "jose";
import { defineConfig, loadEnv, type Connect, type Plugin } from "vite";
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

function sendJson(res: Connect.ServerResponse, statusCode: number, body: unknown) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function parseJsonBody(req: Connect.IncomingMessage) {
  return new Promise<unknown>((resolve, reject) => {
    let rawBody = "";

    req.on("data", (chunk) => {
      rawBody += chunk;
    });

    req.on("end", () => {
      if (!rawBody) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(rawBody) as unknown);
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });

    req.on("error", (error) => {
      reject(error);
    });
  });
}

function extractBearerToken(req: Connect.IncomingMessage) {
  const authorization = req.headers.authorization;
  if (!authorization || !authorization.startsWith("Bearer ")) {
    return null;
  }

  return authorization.slice("Bearer ".length).trim() || null;
}

function supabaseAuthGuard(mode: string) {
  const env = loadEnv(mode, process.cwd(), "");
  const supabaseUrl = env.VITE_SUPABASE_URL?.trim();
  const requiredAudience = env.SUPABASE_JWT_AUD?.trim() || "authenticated";

  if (!supabaseUrl) {
    return {
      verify: async () => ({ ok: false as const, reason: "VITE_SUPABASE_URL is not set" }),
    };
  }

  const normalizedUrl = supabaseUrl.replace(/\/$/, "");
  const jwks = createRemoteJWKSet(new URL(`${normalizedUrl}/auth/v1/.well-known/jwks.json`));

  return {
    verify: async (token: string) => {
      try {
        await jwtVerify(token, jwks, {
          issuer: `${normalizedUrl}/auth/v1`,
          audience: requiredAudience,
        });
        return { ok: true as const };
      } catch {
        return { ok: false as const, reason: "invalid token" };
      }
    },
  };
}

function openAIExtractionPlugin(): Plugin {
  function attach(middlewares: Connect.Server, mode: string) {
    const authGuard = supabaseAuthGuard(mode);

    middlewares.use("/api/extract-issues", async (req, res, next) => {
      if (req.method !== "POST") {
        next();
        return;
      }

      const token = extractBearerToken(req);
      if (!token) {
        sendJson(res, 401, { error: "ログインしてください" });
        return;
      }

      const authResult = await authGuard.verify(token);
      if (!authResult.ok) {
        const statusCode = authResult.reason === "VITE_SUPABASE_URL is not set" ? 503 : 401;
        sendJson(res, statusCode, {
          error: authResult.reason === "VITE_SUPABASE_URL is not set" ? authResult.reason : "認証に失敗しました",
        });
        return;
      }

      const env = loadEnv(mode, process.cwd(), "");
      const apiKey = env.OPENAI_API_KEY;
      const model = env.OPENAI_MODEL || "gpt-4.1-nano";

      if (!apiKey) {
        sendJson(res, 503, { error: "OPENAI_API_KEY is not set" });
        return;
      }

      try {
        const parsed = (await parseJsonBody(req)) as { note?: string };
        const note = parsed.note?.trim();

        if (!note) {
          sendJson(res, 200, { issues: [] });
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
          sendJson(res, response.status, { error: errorText });
          return;
        }

        const payload = (await response.json()) as unknown;
        const text = extractTextFromResponse(payload);
        const parsedOutput = JSON.parse(text) as {
          issues?: Array<{ key: string; title: string; sourceText: string }>;
        };

        sendJson(res, 200, { issues: parsedOutput.issues ?? [] });
      } catch (error) {
        sendJson(res, 500, {
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    });
  }

  return {
    name: "openai-extraction-api",
    configureServer(server) {
      attach(server.middlewares, server.config.mode);
    },
    configurePreviewServer(server) {
      attach(server.middlewares, server.config.mode);
    },
  };
}

export default defineConfig({
  plugins: [react(), openAIExtractionPlugin()],
});
