import { supabase } from "./supabase";

export interface IssueMention {
  key: string;
  title: string;
  sourceText: string;
  date: string;
}

export const issueCatalog = [
  {
    key: "leaning-forward",
    title: "前のめりになる",
    patterns: ["前のめり", "重心が前", "重心が前に", "頭が前", "突っ込み", "前に流れ", "前にある"],
  },
  {
    key: "guard-return",
    title: "打った後にガードが戻らない",
    patterns: ["ガード", "戻り", "戻らない", "戻す", "手が下がる"],
  },
  {
    key: "right-shoulder-open",
    title: "右を打つ時に肩が開く",
    patterns: ["肩が開", "右を打つ", "右で肩", "右ストレート"],
  },
  {
    key: "footwork-balance",
    title: "足元が流れる",
    patterns: ["足が流", "左足", "足幅", "踏み込み", "ベース", "足を開きすぎ"],
  },
];

function splitSentences(note: string) {
  return note
    .split(/[。！？\n]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function normalizeCustomSentence(sentence: string) {
  return sentence.replace(/\s+/g, "").slice(0, 24);
}

export function extractIssuesLocally(note: string, date: string): IssueMention[] {
  const sentences = splitSentences(note);
  const mentions: IssueMention[] = [];

  sentences.forEach((sentence) => {
    const matchedIssues = issueCatalog.filter((issue) =>
      issue.patterns.some((pattern) => sentence.includes(pattern)),
    );

    if (matchedIssues.length > 0) {
      matchedIssues.forEach((matched) => {
        mentions.push({
          key: matched.key,
          title: matched.title,
          sourceText: sentence,
          date,
        });
      });
      return;
    }

    mentions.push({
      key: `custom:${normalizeCustomSentence(sentence)}`,
      title: sentence.length > 18 ? `${sentence.slice(0, 18)}...` : sentence,
      sourceText: sentence,
      date,
    });
  });

  return mentions;
}

export async function extractIssuesWithAI(note: string, date: string): Promise<IssueMention[] | null> {
  try {
    if (!supabase) {
      return null;
    }

    const {
      data: { session },
    } = await supabase.auth.getSession();

    const accessToken = session?.access_token;
    if (!accessToken) {
      return null;
    }

    const response = await fetch("/api/extract-issues", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ note }),
    });

    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as {
      issues?: Array<{ key: string; title: string; sourceText: string }>;
    };

    if (!payload.issues || payload.issues.length === 0) {
      return [];
    }

    return payload.issues.map((issue) => ({
      ...issue,
      date,
    }));
  } catch {
    return null;
  }
}
