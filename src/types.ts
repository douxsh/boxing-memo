export type SessionType = "mitt" | "bag" | "sparring" | "shadow" | "footwork";

export type UserState =
  | "today"
  | "watch"
  | "improving"
  | "stable"
  | "relapsed"
  | "stalled";

export type TrendDirection = "better" | "same" | "worse";

export interface Session {
  id: string;
  trainedAt: string;
  sessionType: SessionType;
  coachName: string;
  rawNote: string;
  selfResult: TrendDirection;
}

export interface Observation {
  id: string;
  sessionId: string;
  correctionId: string;
  rawText: string;
  direction: TrendDirection;
  severity: number;
}

export interface InterventionChange {
  id: string;
  focusCycleId: string;
  changedAt: string;
  changeReason: string;
  oldCue: string;
  newCue: string;
  oldDrill: string;
  newDrill: string;
}

export interface FocusCycle {
  id: string;
  correctionId: string;
  startedAt: string;
  endedAt: string | null;
  goalLabel: string;
  causeHypothesis: string;
  cue: string;
  drill: string;
  selfCheck: string;
  coachPrompt: string;
  evaluationRule: string;
  cycleState: "active" | "completed";
}

export interface Correction {
  id: string;
  title: string;
  normalizedKey: string;
  category: "posture" | "guard" | "balance" | "timing" | "footwork" | "other";
  currentState: UserState;
  firstSeenAt: string;
  lastSeenAt: string;
  resolutionConfidence: number;
  stalledRisk: number;
}

export interface AppData {
  sessions: Session[];
  corrections: Correction[];
  observations: Observation[];
  focusCycles: FocusCycle[];
  interventionChanges: InterventionChange[];
}

export interface ReviewSummary {
  strongestImprovement: string;
  stalledCorrection: string;
  relapsedCorrection: string;
  weeklyTheme: string;
  ignoreForNow: string;
}
