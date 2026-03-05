import { createRemoteJWKSet, jwtVerify } from "jose";

type VerifyResult = { ok: true } | { ok: false; status: number; message: string };

function sendJson(res: any, status: number, body: unknown) {
  res.status(status).json(body);
}

function extractBearerToken(req: any) {
  const authorization = req.headers.authorization;
  if (!authorization || !authorization.startsWith("Bearer ")) {
    return null;
  }
  return authorization.slice("Bearer ".length).trim() || null;
}

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

async function verifySupabaseJwt(token: string): Promise<VerifyResult> {
  const supabaseUrl = process.env.VITE_SUPABASE_URL?.trim();
  const audience = process.env.SUPABASE_JWT_AUD?.trim() || "authenticated";

  if (!supabaseUrl) {
    return { ok: false, status: 503, message: "VITE_SUPABASE_URL is not set" };
  }

  const normalizedUrl = supabaseUrl.replace(/\/$/, "");
  const jwks = createRemoteJWKSet(new URL(`${normalizedUrl}/auth/v1/.well-known/jwks.json`));

  try {
    await jwtVerify(token, jwks, {
      issuer: `${normalizedUrl}/auth/v1`,
      audience,
    });
    return { ok: true };
  } catch {
    return { ok: false, status: 401, message: "認証に失敗しました" };
  }
}

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method Not Allowed" });
    return;
  }

  const token = extractBearerToken(req);
  if (!token) {
    sendJson(res, 401, { error: "ログインしてください" });
    return;
  }

  const verified = await verifySupabaseJwt(token);
  if (!verified.ok) {
    sendJson(res, verified.status, { error: verified.message });
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || "gpt-4.1-nano";
  if (!apiKey) {
    sendJson(res, 503, { error: "OPENAI_API_KEY is not set" });
    return;
  }

  try {
    const body = typeof req.body === "string" ? (JSON.parse(req.body) as { note?: string }) : (req.body ?? {});
    const note = typeof body.note === "string" ? body.note.trim() : "";

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
    sendJson(res, 500, { error: error instanceof Error ? error.message : "Unknown error" });
  }
}
