import type {
  AppData,
  Correction,
  FocusCycle,
  ReviewSummary,
  Session,
  SessionType,
  TrendDirection,
  UserState,
} from "./types";

const STATE_LABELS: Record<UserState, string> = {
  today: "今日やる",
  watch: "様子を見る",
  improving: "良くなっている",
  stable: "ほぼ定着",
  relapsed: "再発",
  stalled: "止まっている",
};

export function getStateLabel(state: UserState) {
  return STATE_LABELS[state];
}

export function formatDate(dateText: string) {
  return new Intl.DateTimeFormat("ja-JP", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(dateText));
}

export function createId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

const correctionLibrary = [
  {
    normalizedKey: "leaning-forward",
    matchers: ["前のめり", "頭から", "突っ込", "重心が前"],
    title: "前のめりになる",
    category: "balance" as const,
    cue: "頭ではなく足で入る",
    drill: "ジャブ後に1拍止まり、重心が真下か確認するシャドー1R",
    selfCheck: "打った後に腰の真下へ戻れたか",
    causeHypothesis: "踏み込みの前に上半身が先に出ている",
    coachPrompt: "前に流れた瞬間を教えてください",
  },
  {
    normalizedKey: "guard-return",
    matchers: ["ガード", "戻り", "戻ら", "頬"],
    title: "打った後にガードが戻らない",
    category: "guard" as const,
    cue: "打ったら頬",
    drill: "ワンツーのたびに頬へ戻るまで終わらない確認ドリル2分",
    selfCheck: "打ち終わりで拳は頬に戻ったか",
    causeHypothesis: "打ち終わりの回収動作が抜けている",
    coachPrompt: "戻りが遅い時だけ一言ください",
  },
  {
    normalizedKey: "right-shoulder-open",
    matchers: ["肩が開", "右を打つ時", "右ストレート"],
    title: "右を打つ時に肩が開く",
    category: "posture" as const,
    cue: "右肩は前に逃がさない",
    drill: "右ストレートを半分の力で打ち、左肩と顎の位置を固定する2分",
    selfCheck: "右を打つ瞬間に胸が開きすぎていないか",
    causeHypothesis: "強く打とうとして上体が先に開いている",
    coachPrompt: "右で肩が開いたら教えてください",
  },
  {
    normalizedKey: "footwork-drift",
    matchers: ["左足", "足が流", "足幅", "踏み込み"],
    title: "左足が流れる",
    category: "footwork" as const,
    cue: "足幅を保ったまま出入りする",
    drill: "ライン上で小さく出入りするフットワーク2分",
    selfCheck: "踏み込みで足幅が崩れていないか",
    causeHypothesis: "大きく入りすぎてベースが崩れている",
    coachPrompt: "足幅が崩れた時だけ見てください",
  },
];

function normalizeText(text: string) {
  return text.toLowerCase().replace(/\s+/g, "");
}

function detectDirection(note: string, fallback: TrendDirection): TrendDirection {
  if (/良い|まし|改善|できた|直って|良く/.test(note)) {
    return "better";
  }
  if (/悪い|ひど|崩れ|できない|戻った/.test(note)) {
    return "worse";
  }
  return fallback;
}

function inferSeverity(note: string) {
  if (/かなり|強く|何度も|毎回/.test(note)) {
    return 5;
  }
  if (/少し|やや/.test(note)) {
    return 2;
  }
  return 3;
}

function mapScoreToState(
  resolutionConfidence: number,
  stalledRisk: number,
  latestDirection: TrendDirection,
): UserState {
  if (stalledRisk >= 75) {
    return "stalled";
  }
  if (resolutionConfidence >= 85) {
    return "stable";
  }
  if (latestDirection === "worse" && resolutionConfidence < 40) {
    return "relapsed";
  }
  if (resolutionConfidence >= 55) {
    return "improving";
  }
  return "watch";
}

function getSignalsForCorrection(data: AppData, correctionId: string) {
  return data.observations.filter((observation) => observation.correctionId === correctionId);
}

export function scoreCorrection(data: AppData, correction: Correction): Correction {
  const signals = getSignalsForCorrection(data, correction.id);
  const latestSignal = signals.at(-1);
  const betterCount = signals.filter((signal) => signal.direction === "better").length;
  const worseCount = signals.filter((signal) => signal.direction === "worse").length;
  const sameCount = signals.filter((signal) => signal.direction === "same").length;
  const resolutionConfidence = Math.max(
    10,
    Math.min(
      95,
      30 + betterCount * 18 - worseCount * 12 - sameCount * 3 + (latestSignal?.severity ? 6 - latestSignal.severity : 0) * 2,
    ),
  );
  const stalledRisk = Math.max(
    5,
    Math.min(95, signals.length * 15 + sameCount * 10 + worseCount * 15 - betterCount * 12),
  );
  const currentState = correction.currentState === "today"
    ? "today"
    : mapScoreToState(resolutionConfidence, stalledRisk, latestSignal?.direction ?? "same");

  return {
    ...correction,
    resolutionConfidence,
    stalledRisk,
    currentState,
    lastSeenAt: latestSignal
      ? data.sessions.find((session) => session.id === latestSignal.sessionId)?.trainedAt ?? correction.lastSeenAt
      : correction.lastSeenAt,
  };
}

export function deriveData(data: AppData): AppData {
  return {
    ...data,
    corrections: data.corrections.map((correction) => scoreCorrection(data, correction)),
  };
}

export function analyzeSessionInput(
  note: string,
  sessionType: SessionType,
  fallbackDirection: TrendDirection,
) {
  const normalized = normalizeText(note);
  const matches = correctionLibrary.filter((item) =>
    item.matchers.some((matcher) => normalized.includes(normalizeText(matcher)))
  );
  const uniqueMatches = matches.length > 0 ? matches : [
    {
      normalizedKey: createId("custom"),
      title: "新しい課題候補",
      category: "other" as const,
      cue: "動きを一つだけ止めて確認する",
      drill: `${sessionType}で同じ場面をゆっくり3回繰り返して確認する`,
      selfCheck: "直前の1動作を言語化できるか",
      causeHypothesis: "まだ原因の切り分けができていない",
      coachPrompt: "何が一番崩れているか一言で教えてください",
      matchers: [],
    },
  ];
  const direction = detectDirection(note, fallbackDirection);
  const severity = inferSeverity(note);

  return uniqueMatches.map((item) => ({
    normalizedKey: item.normalizedKey,
    title: item.title,
    category: item.category,
    cue: item.cue,
    drill: item.drill,
    selfCheck: item.selfCheck,
    causeHypothesis: item.causeHypothesis,
    coachPrompt: item.coachPrompt,
    direction,
    severity,
  }));
}

export function upsertSessionData(
  data: AppData,
  payload: {
    trainedAt: string;
    sessionType: SessionType;
    coachName: string;
    rawNote: string;
    selfResult: TrendDirection;
  },
) {
  const session: Session = {
    id: createId("session"),
    ...payload,
  };
  const analysis = analyzeSessionInput(payload.rawNote, payload.sessionType, payload.selfResult);

  const nextCorrections = [...data.corrections];
  const nextObservations = [...data.observations];
  const nextFocusCycles = [...data.focusCycles];
  const nextInterventions = [...data.interventionChanges];

  analysis.forEach((item) => {
    let correction = nextCorrections.find((candidate) => candidate.normalizedKey === item.normalizedKey);
    const isNew = !correction;

    if (!correction) {
      correction = {
        id: createId("correction"),
        title: item.title,
        normalizedKey: item.normalizedKey,
        category: item.category,
        currentState: "watch",
        firstSeenAt: payload.trainedAt,
        lastSeenAt: payload.trainedAt,
        resolutionConfidence: 20,
        stalledRisk: 20,
      };
      nextCorrections.push(correction);
    }

    correction.lastSeenAt = payload.trainedAt;

    nextObservations.push({
      id: createId("observation"),
      sessionId: session.id,
      correctionId: correction.id,
      rawText: payload.rawNote,
      direction: item.direction,
      severity: item.severity,
    });

    const activeCycle = nextFocusCycles.find((cycle) => cycle.correctionId === correction?.id && cycle.cycleState === "active");
    if (!activeCycle) {
      nextFocusCycles.push({
        id: createId("focus"),
        correctionId: correction.id,
        startedAt: payload.trainedAt,
        endedAt: null,
        goalLabel: item.cue,
        causeHypothesis: item.causeHypothesis,
        cue: item.cue,
        drill: item.drill,
        selfCheck: item.selfCheck,
        coachPrompt: item.coachPrompt,
        evaluationRule: "次の3セッションで言及頻度と表現の変化を見る",
        cycleState: "active",
      });
    } else if (!isNew && correction.stalledRisk >= 70) {
      nextInterventions.push({
        id: createId("intervention"),
        focusCycleId: activeCycle.id,
        changedAt: payload.trainedAt,
        changeReason: "停滞リスクが高いため、介入を差し替え",
        oldCue: activeCycle.cue,
        newCue: item.cue,
        oldDrill: activeCycle.drill,
        newDrill: item.drill,
      });
      activeCycle.cue = item.cue;
      activeCycle.drill = item.drill;
      activeCycle.selfCheck = item.selfCheck;
      activeCycle.causeHypothesis = item.causeHypothesis;
      activeCycle.coachPrompt = item.coachPrompt;
    }
  });

  const rankedCorrections = [...nextCorrections].sort((left, right) => {
    const leftSignals = nextObservations.filter((observation) => observation.correctionId === left.id);
    const rightSignals = nextObservations.filter((observation) => observation.correctionId === right.id);
    const leftScore = leftSignals.length * 12 + (100 - left.resolutionConfidence) + left.stalledRisk;
    const rightScore = rightSignals.length * 12 + (100 - right.resolutionConfidence) + right.stalledRisk;
    return rightScore - leftScore;
  });

  const promotedIds = new Set(rankedCorrections.slice(0, 2).map((correction) => correction.id));
  nextCorrections.forEach((correction) => {
    correction.currentState = promotedIds.has(correction.id) ? "today" : correction.currentState;
  });

  return deriveData({
    sessions: [...data.sessions, session],
    corrections: nextCorrections,
    observations: nextObservations,
    focusCycles: nextFocusCycles,
    interventionChanges: nextInterventions,
  });
}

export function getCurrentFocus(data: AppData) {
  const ranked = [...data.corrections].sort((left, right) => {
    const leftScore = (100 - left.resolutionConfidence) + left.stalledRisk + (left.currentState === "today" ? 20 : 0);
    const rightScore = (100 - right.resolutionConfidence) + right.stalledRisk + (right.currentState === "today" ? 20 : 0);
    return rightScore - leftScore;
  });

  const [main, secondary] = ranked;
  const mainCycle = data.focusCycles.find((cycle) => cycle.correctionId === main?.id && cycle.cycleState === "active");
  const secondaryCycle = data.focusCycles.find((cycle) => cycle.correctionId === secondary?.id && cycle.cycleState === "active");

  return {
    main,
    mainCycle,
    secondary,
    secondaryCycle,
  };
}

export function getCorrectionTimeline(data: AppData, correctionId: string) {
  return data.observations
    .filter((observation) => observation.correctionId === correctionId)
    .map((observation) => {
      const session = data.sessions.find((candidate) => candidate.id === observation.sessionId);
      return {
        ...observation,
        trainedAt: session?.trainedAt ?? "",
      };
    })
    .sort((left, right) => left.trainedAt.localeCompare(right.trainedAt));
}

export function buildWeeklyReview(data: AppData): ReviewSummary {
  const sorted = [...data.corrections].sort((left, right) => right.resolutionConfidence - left.resolutionConfidence);
  const stalled = [...data.corrections].sort((left, right) => right.stalledRisk - left.stalledRisk);
  const relapsed = data.corrections.find((correction) => correction.currentState === "relapsed");
  const theme =
    sorted[0]?.category === "balance"
      ? "姿勢維持"
      : sorted[0]?.category === "guard"
        ? "打った後の回収"
        : "土台の安定";

  return {
    strongestImprovement: sorted[0]?.title ?? "まだ十分なデータがありません",
    stalledCorrection: stalled[0]?.title ?? "まだ十分なデータがありません",
    relapsedCorrection: relapsed?.title ?? "今週の再発はありません",
    weeklyTheme: theme,
    ignoreForNow: sorted.at(-1)?.title ?? "今は全て追う価値があります",
  };
}

export function getInterventionsForCycle(data: AppData, focusCycleId: string) {
  return data.interventionChanges.filter((item) => item.focusCycleId === focusCycleId);
}

export function getCycleByCorrection(data: AppData, correctionId: string): FocusCycle | undefined {
  return data.focusCycles.find((cycle) => cycle.correctionId === correctionId && cycle.cycleState === "active");
}
