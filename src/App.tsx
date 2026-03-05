import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { extractIssuesLocally, extractIssuesWithAI, issueCatalog, type IssueMention } from "./issueExtraction";
import { hasSupabaseConfig, supabase } from "./supabase";

interface EntryItem {
  id: string;
  date: string;
  attended: boolean;
  note: string;
  issues?: Array<{
    key: string;
    title: string;
    sourceText: string;
  }>;
}

interface AggregatedIssue {
  key: string;
  title: string;
  count: number;
  lastSeenDate: string;
  mentions: IssueMention[];
}

type Screen = "record" | "focus" | "done" | "calendar" | "settings";

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

function shiftMonth(date: Date, offset: number) {
  return new Date(date.getFullYear(), date.getMonth() + offset, 1);
}

function formatDay(value: string) {
  return new Intl.DateTimeFormat("ja-JP", {
    month: "numeric",
    day: "numeric",
    weekday: "short",
  }).format(new Date(`${value}T00:00:00`));
}

function formatMonthLabel(value: string) {
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "long",
  }).format(new Date(`${value}T00:00:00`));
}

function buildMonthDays(baseDate: Date) {
  const year = baseDate.getFullYear();
  const month = baseDate.getMonth();
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const daysInMonth = lastDay.getDate();
  const startOffset = (firstDay.getDay() + 6) % 7;
  const cells: Array<{ key: string; dayNumber: number | null }> = [];

  for (let index = 0; index < startOffset; index += 1) {
    cells.push({ key: `empty-start-${index}`, dayNumber: null });
  }

  for (let day = 1; day <= daysInMonth; day += 1) {
    const monthText = `${month + 1}`.padStart(2, "0");
    const dayText = `${day}`.padStart(2, "0");
    cells.push({
      key: `${year}-${monthText}-${dayText}`,
      dayNumber: day,
    });
  }

  while (cells.length % 7 !== 0) {
    cells.push({ key: `empty-end-${cells.length}`, dayNumber: null });
  }

  return cells;
}

function getIssuesFromEntry(entry: EntryItem): IssueMention[] {
  if (!entry.attended || !entry.note.trim()) {
    return [];
  }

  if (entry.issues && entry.issues.length > 0) {
    return entry.issues.map((issue) => ({
      ...issue,
      date: entry.date,
    }));
  }

  return extractIssuesLocally(entry.note, entry.date);
}

function aggregateIssues(entries: EntryItem[]) {
  const map = new Map<string, AggregatedIssue>();

  entries.forEach((entry) => {
    getIssuesFromEntry(entry).forEach((mention) => {
      const current = map.get(mention.key);
      if (!current) {
        map.set(mention.key, {
          key: mention.key,
          title: mention.title,
          count: 1,
          lastSeenDate: mention.date,
          mentions: [mention],
        });
        return;
      }

      current.count += 1;
      current.mentions.push(mention);
      if (mention.date > current.lastSeenDate) {
        current.lastSeenDate = mention.date;
      }
    });
  });

  return [...map.values()].sort((a, b) => {
    if (a.lastSeenDate !== b.lastSeenDate) {
      return b.lastSeenDate.localeCompare(a.lastSeenDate);
    }
    return b.count - a.count;
  });
}

function uniqueMentionTexts(issue: AggregatedIssue) {
  const seen = new Set<string>();
  return issue.mentions
    .map((mention) => mention.sourceText.trim())
    .filter((text) => {
      if (!text || seen.has(text)) {
        return false;
      }
      seen.add(text);
      return true;
    });
}

function sameKeys(left: string[], right: string[]) {
  if (left.length !== right.length) {
    return false;
  }

  const normalizedLeft = [...left].sort();
  const normalizedRight = [...right].sort();
  return normalizedLeft.every((key, index) => key === normalizedRight[index]);
}

function normalizeStoredIssues(value: unknown) {
  if (!Array.isArray(value)) {
    return [] as EntryItem["issues"];
  }

  return value
    .filter((item): item is { key: string; title: string; sourceText: string } => {
      if (!item || typeof item !== "object") {
        return false;
      }
      const issue = item as { key?: unknown; title?: unknown; sourceText?: unknown };
      return (
        typeof issue.key === "string" &&
        typeof issue.title === "string" &&
        typeof issue.sourceText === "string"
      );
    })
    .map((item) => ({
      key: item.key,
      title: item.title,
      sourceText: item.sourceText,
    }));
}

function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [authChecking, setAuthChecking] = useState(true);
  const [authUserId, setAuthUserId] = useState("");
  const [authUid, setAuthUid] = useState("");
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginPending, setLoginPending] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [nextEmail, setNextEmail] = useState("");
  const [nextPassword, setNextPassword] = useState("");
  const [profilePending, setProfilePending] = useState(false);
  const [profileMessage, setProfileMessage] = useState<string | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [screen, setScreen] = useState<Screen>("record");
  const [entries, setEntries] = useState<EntryItem[]>([]);
  const [achievedIssueKeys, setAchievedIssueKeys] = useState<string[]>([]);
  const [selectedDate, setSelectedDate] = useState(todayDate());
  const [note, setNote] = useState("");
  const [selectedIssueKeys, setSelectedIssueKeys] = useState<string[]>([]);
  const [issuesTouched, setIssuesTouched] = useState(false);
  const [query, setQuery] = useState("");
  const [sortOrder, setSortOrder] = useState<"newest" | "oldest">("newest");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [selectedCalendarDate, setSelectedCalendarDate] = useState<string | null>(null);
  const [calendarMonth, setCalendarMonth] = useState<Date>(() => new Date());
  const [isDatePickerOpen, setIsDatePickerOpen] = useState(false);
  const [pickerMonth, setPickerMonth] = useState<Date>(() => new Date());
  const [leavingActiveIssueKeys, setLeavingActiveIssueKeys] = useState<string[]>([]);
  const [leavingDoneIssueKeys, setLeavingDoneIssueKeys] = useState<string[]>([]);
  const [isDataLoading, setIsDataLoading] = useState(false);
  const [dataError, setDataError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const tabOrder: Screen[] = ["record", "focus", "done", "calendar", "settings"];
  const activeTabIndex = tabOrder.indexOf(screen);

  useEffect(() => {
    let cancelled = false;

    async function loadSession() {
      try {
        if (!supabase) {
          setIsAuthenticated(false);
          setAuthUserId("");
          return;
        }

        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (cancelled) {
          return;
        }

        setIsAuthenticated(Boolean(session));
        setAuthUserId(session?.user.email ?? "");
        setAuthUid(session?.user.id ?? "");
      } catch {
        if (!cancelled) {
          setIsAuthenticated(false);
          setAuthUserId("");
          setAuthUid("");
        }
      } finally {
        if (!cancelled) {
          setAuthChecking(false);
        }
      }
    }

    loadSession();
    if (!supabase) {
      setAuthChecking(false);
      return () => {
        cancelled = true;
      };
    }

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!cancelled) {
        setIsAuthenticated(Boolean(session));
        setAuthUserId(session?.user.email ?? "");
        setAuthUid(session?.user.id ?? "");
      }
    });

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (editingId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.setSelectionRange(inputRef.current.value.length, inputRef.current.value.length);
    }
  }, [editingId]);

  const sortedEntries = useMemo(() => {
    return [...entries].sort((a, b) =>
      sortOrder === "newest" ? b.date.localeCompare(a.date) : a.date.localeCompare(b.date),
    );
  }, [entries, sortOrder]);

  const aggregatedIssues = useMemo(() => aggregateIssues(sortedEntries), [sortedEntries]);

  const activeIssues = useMemo(
    () => aggregatedIssues.filter((issue) => !achievedIssueKeys.includes(issue.key)),
    [achievedIssueKeys, aggregatedIssues],
  );

  const achievedIssues = useMemo(
    () => aggregatedIssues.filter((issue) => achievedIssueKeys.includes(issue.key)),
    [achievedIssueKeys, aggregatedIssues],
  );

  const filteredEntries = useMemo(() => {
    const normalizedQuery = query.trim();
    return sortedEntries.filter((entry) => {
      const matchesQuery = !normalizedQuery || entry.note.includes(normalizedQuery);
      const matchesDate = !selectedCalendarDate || entry.date === selectedCalendarDate;
      return matchesQuery && matchesDate;
    });
  }, [query, selectedCalendarDate, sortedEntries]);

  const monthCells = useMemo(() => buildMonthDays(calendarMonth), [calendarMonth]);
  const pickerMonthCells = useMemo(() => buildMonthDays(pickerMonth), [pickerMonth]);

  const entryByDate = useMemo(() => {
    const map = new Map<string, EntryItem>();
    entries.forEach((entry) => {
      map.set(entry.date, entry);
    });
    return map;
  }, [entries]);

  const loadUserData = useCallback(async () => {
    if (!supabase || !isAuthenticated || !authUid) {
      setEntries([]);
      setAchievedIssueKeys([]);
      return;
    }

    setIsDataLoading(true);
    setDataError(null);

    const [{ data: entryRows, error: entryError }, { data: achievedRows, error: achievedError }] = await Promise.all([
      supabase
        .from("boxing_entries")
        .select("id, entry_date, note, issues")
        .eq("user_id", authUid)
        .order("entry_date", { ascending: false }),
      supabase.from("boxing_achieved_issues").select("issue_key").eq("user_id", authUid),
    ]);

    if (entryError || achievedError) {
      setDataError("DBの読み込みに失敗しました。テーブル作成とRLS設定を確認してください。");
      setIsDataLoading(false);
      return;
    }

    const mappedEntries = (entryRows ?? []).map((row) => ({
      id: row.id as string,
      date: row.entry_date as string,
      attended: true,
      note: (row.note as string) ?? "",
      issues: normalizeStoredIssues(row.issues),
    }));

    setEntries(mappedEntries);
    setAchievedIssueKeys((achievedRows ?? []).map((row) => row.issue_key as string));
    setIsDataLoading(false);
  }, [authUid, isAuthenticated]);

  useEffect(() => {
    void loadUserData();
  }, [loadUserData]);

  function resetForm() {
    setSelectedDate(todayDate());
    setNote("");
    setSelectedIssueKeys([]);
    setIssuesTouched(false);
    setEditingId(null);
    setIsDatePickerOpen(false);
    setPickerMonth(new Date());
  }

  async function buildIssuesForNote(entryNote: string, date: string) {
    if (!entryNote.trim()) {
      return [];
    }

    const aiIssues = await extractIssuesWithAI(entryNote, date);
    if (aiIssues) {
      return aiIssues.map(({ key, title, sourceText }) => ({ key, title, sourceText }));
    }

    return extractIssuesLocally(entryNote, date).map(({ key, title, sourceText }) => ({ key, title, sourceText }));
  }

  function buildIssuesFromSelection(entryNote: string, keys: string[]) {
    return keys.map((key) => {
      const issue = issueCatalog.find((item) => item.key === key);
      return {
        key,
        title: issue?.title ?? key,
        sourceText: entryNote.trim(),
      };
    });
  }

  async function saveEntry() {
    if (!supabase || !authUid) {
      setSaveError("ログイン情報を確認してください。");
      return;
    }

    setIsSaving(true);
    setSaveError(null);

    try {
      if (editingId) {
        const currentEntry = entries.find((entry) => entry.id === editingId);
        const trimmedNote = note.trim();
        const currentIssueKeys = (currentEntry?.issues ?? []).map((issue) => issue.key);
        const noteChanged = currentEntry ? currentEntry.note.trim() !== trimmedNote : true;
        const dateChanged = currentEntry ? currentEntry.date !== selectedDate : true;
        const issueSelectionChanged = issuesTouched && !sameKeys(currentIssueKeys, selectedIssueKeys);

        const issues =
          !noteChanged && !dateChanged
            ? issueSelectionChanged
              ? buildIssuesFromSelection(trimmedNote, selectedIssueKeys)
              : (currentEntry?.issues ?? [])
            : issuesTouched
              ? buildIssuesFromSelection(trimmedNote, selectedIssueKeys)
              : await buildIssuesForNote(trimmedNote, selectedDate);

        const { error } = await supabase
          .from("boxing_entries")
          .update({
            entry_date: selectedDate,
            note: trimmedNote,
            issues,
          })
          .eq("id", editingId)
          .eq("user_id", authUid);

        if (error) {
          throw error;
        }

        await loadUserData();
        resetForm();
        return;
      }

      const existing = entries.find((entry) => entry.date === selectedDate);
      if (existing) {
        const trimmedNote = note.trim();
        const issues =
          existing.note.trim() === trimmedNote
            ? issuesTouched
              ? buildIssuesFromSelection(trimmedNote, selectedIssueKeys)
              : (existing.issues ?? [])
            : issuesTouched
              ? buildIssuesFromSelection(trimmedNote, selectedIssueKeys)
              : await buildIssuesForNote(trimmedNote, selectedDate);

        const { error } = await supabase
          .from("boxing_entries")
          .update({
            note: trimmedNote,
            issues,
          })
          .eq("id", existing.id)
          .eq("user_id", authUid);

        if (error) {
          throw error;
        }

        await loadUserData();
        resetForm();
        return;
      }

      const trimmedNote = note.trim();
      const issues = issuesTouched
        ? buildIssuesFromSelection(trimmedNote, selectedIssueKeys)
        : await buildIssuesForNote(trimmedNote, selectedDate);

      const { error } = await supabase.from("boxing_entries").insert({
        user_id: authUid,
        entry_date: selectedDate,
        note: trimmedNote,
        issues,
      });

      if (error) {
        throw error;
      }

      await loadUserData();
      resetForm();
    } catch {
      setSaveError("保存に失敗しました。DB設定を確認してください。");
    } finally {
      setIsSaving(false);
    }
  }

  function startEdit(entry: EntryItem) {
    setEditingId(entry.id);
    setSelectedDate(entry.date);
    setNote(entry.note);
    setSelectedIssueKeys((entry.issues ?? []).map((issue) => issue.key));
    setIssuesTouched(false);
    setScreen("record");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function toggleIssueSelection(issueKey: string) {
    setIssuesTouched(true);
    setSelectedIssueKeys((current) =>
      current.includes(issueKey) ? current.filter((key) => key !== issueKey) : [...current, issueKey],
    );
  }

  function markAchieved(issueKey: string) {
    if (leavingActiveIssueKeys.includes(issueKey)) {
      return;
    }
    setLeavingActiveIssueKeys((current) => [...current, issueKey]);
    window.setTimeout(() => {
      void (async () => {
        if (!supabase || !authUid) {
          setSaveError("ログイン情報を確認してください。");
          setLeavingActiveIssueKeys((current) => current.filter((key) => key !== issueKey));
          return;
        }

        const { error } = await supabase.from("boxing_achieved_issues").upsert(
          {
            user_id: authUid,
            issue_key: issueKey,
          },
          { onConflict: "user_id,issue_key" },
        );

        if (error) {
          setSaveError("達成状態の保存に失敗しました。");
          setLeavingActiveIssueKeys((current) => current.filter((key) => key !== issueKey));
          return;
        }

        setAchievedIssueKeys((current) => (current.includes(issueKey) ? current : [...current, issueKey]));
        setLeavingActiveIssueKeys((current) => current.filter((key) => key !== issueKey));
      })();
    }, 280);
  }

  function reopenIssue(issueKey: string) {
    if (leavingDoneIssueKeys.includes(issueKey)) {
      return;
    }
    setLeavingDoneIssueKeys((current) => [...current, issueKey]);
    window.setTimeout(() => {
      void (async () => {
        if (!supabase || !authUid) {
          setSaveError("ログイン情報を確認してください。");
          setLeavingDoneIssueKeys((current) => current.filter((key) => key !== issueKey));
          return;
        }

        const { error } = await supabase
          .from("boxing_achieved_issues")
          .delete()
          .eq("user_id", authUid)
          .eq("issue_key", issueKey);

        if (error) {
          setSaveError("達成状態の更新に失敗しました。");
          setLeavingDoneIssueKeys((current) => current.filter((key) => key !== issueKey));
          return;
        }

        setAchievedIssueKeys((current) => current.filter((key) => key !== issueKey));
        setLeavingDoneIssueKeys((current) => current.filter((key) => key !== issueKey));
      })();
    }, 280);
  }

  async function deleteEntry(id: string) {
    const shouldDelete = window.confirm("この記録を削除しますか？");
    if (!shouldDelete) {
      return;
    }

    if (!supabase || !authUid) {
      setSaveError("ログイン情報を確認してください。");
      return;
    }

    const { error } = await supabase.from("boxing_entries").delete().eq("id", id).eq("user_id", authUid);
    if (error) {
      setSaveError("削除に失敗しました。");
      return;
    }

    setEntries((current) => current.filter((entry) => entry.id !== id));
    if (editingId === id) {
      resetForm();
    }
  }

  function openDatePicker() {
    setPickerMonth(new Date(`${selectedDate}T00:00:00`));
    setIsDatePickerOpen(true);
  }

  function chooseDate(date: string) {
    setSelectedDate(date);
    setPickerMonth(new Date(`${date}T00:00:00`));
    setIsDatePickerOpen(false);
  }

  async function submitLogin(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoginPending(true);
    setLoginError(null);

    try {
      if (!supabase) {
        setLoginError("Supabase設定が不足しています");
        setLoginPending(false);
        return;
      }

      const { error } = await supabase.auth.signInWithPassword({
        email: loginEmail,
        password: loginPassword,
      });

      if (error) {
        setLoginError("ログインに失敗しました。メールアドレスとパスワードを確認してください。");
        setLoginPending(false);
        return;
      }

      setIsAuthenticated(true);
      setAuthUserId(loginEmail);
      setLoginPassword("");
      setLoginPending(false);
    } catch {
      setLoginError("ログインに失敗しました");
      setLoginPending(false);
    }
  }

  async function logout() {
    if (!supabase) {
      return;
    }

    await supabase.auth.signOut();
    setIsAuthenticated(false);
    setAuthUserId("");
    setAuthUid("");
    setEntries([]);
    setAchievedIssueKeys([]);
    setLoginPassword("");
    setNextEmail("");
    setNextPassword("");
    setProfileMessage(null);
    setProfileError(null);
  }

  async function updateEmail(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || !nextEmail.trim()) {
      return;
    }

    setProfilePending(true);
    setProfileMessage(null);
    setProfileError(null);

    const { error } = await supabase.auth.updateUser({ email: nextEmail.trim() });
    if (error) {
      setProfileError("メールアドレス変更に失敗しました。");
      setProfilePending(false);
      return;
    }

    setProfileMessage("確認メールを送信しました。メール内リンクで変更を確定してください。");
    setProfilePending(false);
  }

  async function updatePassword(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || !nextPassword.trim()) {
      return;
    }

    setProfilePending(true);
    setProfileMessage(null);
    setProfileError(null);

    const { error } = await supabase.auth.updateUser({ password: nextPassword });
    if (error) {
      setProfileError("パスワード変更に失敗しました。");
      setProfilePending(false);
      return;
    }

    setNextPassword("");
    setProfileMessage("パスワードを更新しました。");
    setProfilePending(false);
  }

  if (authChecking) {
    return (
      <div className="auth-shell">
        <section className="auth-card">
          <p className="eyebrow">BOXING MEMO</p>
          <h1>認証を確認しています</h1>
        </section>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="auth-shell">
        <section className="auth-card">
          <p className="eyebrow">BOXING MEMO</p>
          <h1>ログイン</h1>
          <p className="auth-copy">
            {hasSupabaseConfig
              ? "既存アカウントのみ利用できます。新規登録はできません。"
              : "環境変数 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY を設定してください。"}
          </p>

          <form className="auth-form" onSubmit={submitLogin}>
            <label className="field-block">
              <span>メールアドレス</span>
              <input
                className="auth-input"
                type="email"
                value={loginEmail}
                onChange={(event) => setLoginEmail(event.target.value)}
                autoComplete="email"
                required
              />
            </label>
            <label className="field-block">
              <span>パスワード</span>
              <input
                className="auth-input"
                type="password"
                value={loginPassword}
                onChange={(event) => setLoginPassword(event.target.value)}
                autoComplete="current-password"
                required
              />
            </label>
            {loginError && <p className="inline-error">{loginError}</p>}
            <button type="submit" className="primary-button full-width" disabled={loginPending || !hasSupabaseConfig}>
              {loginPending ? "ログイン中..." : "ログイン"}
            </button>
          </form>
        </section>
      </div>
    );
  }

  return (
    <div className="app-shell simple">
      <header className="simple-header">
        <div className="hero-surface">
          <p className="hero-badge">BOXING MEMO</p>
          <h1 className="hero-title">あなた専用の練習ログ</h1>
          <p className="hero-copy">
            今日の指摘を記録して、意識中へ自動集約。積み上げを見える化して、達成まで追える設計です。
          </p>
        </div>
      </header>

      <nav className="main-tabs">
        <span
          className="tab-indicator"
          style={{
            width: `calc((100% - 12px) / ${tabOrder.length})`,
            transform: `translateX(${activeTabIndex * 100}%)`,
          }}
        />
        <button type="button" className={screen === "record" ? "active" : ""} onClick={() => setScreen("record")}>
          記録
        </button>
        <button type="button" className={screen === "focus" ? "active" : ""} onClick={() => setScreen("focus")}>
          意識中
        </button>
        <button type="button" className={screen === "done" ? "active" : ""} onClick={() => setScreen("done")}>
          達成
        </button>
        <button type="button" className={screen === "calendar" ? "active" : ""} onClick={() => setScreen("calendar")}>
          カレンダー
        </button>
        <button type="button" className={screen === "settings" ? "active" : ""} onClick={() => setScreen("settings")}>
          設定
        </button>
      </nav>

      <main className="single-screen">
        {dataError && (
          <section className="list-card">
            <p className="inline-error">{dataError}</p>
          </section>
        )}
        {isDataLoading && (
          <section className="list-card">
            <p className="section-label">読み込み中</p>
            <p>DBからデータを取得しています。</p>
          </section>
        )}
        {screen === "record" && (
          <section className="screen-panel record-panel">
            <section className="composer-card">
              <div className="composer-top">
                <div>
                  <p className="section-label">記録する</p>
                  <h2>{editingId ? "記録を直す" : "今日の記録"}</h2>
                </div>
                {editingId && (
                  <button type="button" className="text-button" onClick={resetForm}>
                    キャンセル
                  </button>
                )}
              </div>

              {editingId && (
                <div className="editing-banner">
                  <strong>編集中</strong>
                  <span>内容を直したら更新するを押してください</span>
                </div>
              )}

              <label className="field-block">
                <span>日付</span>
                <button type="button" className="date-trigger" onClick={openDatePicker}>
                  <span className="date-trigger-main">{formatDay(selectedDate)}</span>
                </button>
              </label>

              <label className="field-block">
                <span>メモ</span>
                <textarea
                  ref={inputRef}
                  className="memo-input"
                  rows={7}
                  placeholder="言われたことがあればそのまま書く"
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                />
              </label>

              <div className="field-block">
                <span>所属を手動で調整</span>
                <div className="issue-chip-row">
                  {issueCatalog.map((issue) => (
                    <button
                      key={issue.key}
                      type="button"
                      className={selectedIssueKeys.includes(issue.key) ? "issue-chip active" : "issue-chip"}
                      onClick={() => toggleIssueSelection(issue.key)}
                    >
                      {issue.title}
                    </button>
                  ))}
                </div>
              </div>

              {saveError && <p className="inline-error">{saveError}</p>}

              <button type="button" className="primary-button full-width" onClick={saveEntry} disabled={isSaving}>
                {isSaving
                  ? issuesTouched
                    ? editingId
                      ? "更新中..."
                      : "保存中..."
                    : "AIで整理中..."
                  : editingId
                    ? "更新する"
                    : "保存する"}
              </button>
            </section>

            <section className="list-card">
              <div className="section-head">
                <div>
                  <p className="section-label">記録を見る</p>
                  <h2>履歴</h2>
                </div>
                <div className="history-tools">
                  <span>{filteredEntries.length}件</span>
                  <select
                    className="sort-select"
                    value={sortOrder}
                    onChange={(event) => setSortOrder(event.target.value as "newest" | "oldest")}
                  >
                    <option value="newest">新しい順</option>
                    <option value="oldest">古い順</option>
                  </select>
                </div>
              </div>

              <input
                className="search-input"
                placeholder="メモを検索"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />

              <div className="timeline-list">
                {filteredEntries.length === 0 ? (
                  <div className="empty-card">
                    <strong>見つかりません</strong>
                    <p>検索条件を変えてください。</p>
                  </div>
                ) : (
                  <div className="memo-list">
                    {filteredEntries.map((entry) => (
                      <article key={entry.id} className={editingId === entry.id ? "memo-card editing" : "memo-card"}>
                        <div className="memo-meta">
                          <span>{entry.date}</span>
                        </div>
                        {entry.note ? (
                          <p className="memo-text">{entry.note}</p>
                        ) : (
                          <p className="memo-empty">メモなし</p>
                        )}
                        <div className="memo-actions">
                          <button type="button" className="text-button" onClick={() => startEdit(entry)}>
                            編集
                          </button>
                          <button type="button" className="text-button danger" onClick={() => deleteEntry(entry.id)}>
                            削除
                          </button>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </div>
            </section>
          </section>
        )}

        {screen === "focus" && (
          <section className="screen-panel full-panel">
            <section className="focus-card">
              <div className="section-head">
                <div>
                  <p className="section-label">自動で集約</p>
                  <h2>いま意識していること</h2>
                </div>
                <span>{activeIssues.length}件</span>
              </div>

              {activeIssues.length === 0 ? (
                <div className="empty-card">
                  <strong>いま意識中の項目はありません</strong>
                  <p>記録を書けば、自動でここにまとめられます。</p>
                </div>
              ) : (
                <div className="focus-list">
                  {activeIssues.map((issue) => (
                    <article
                      key={issue.key}
                      className={`focus-memo aggregated ${leavingActiveIssueKeys.includes(issue.key) ? "leaving" : ""}`}
                    >
                      <div className="memo-meta">
                        <span>{issue.lastSeenDate}</span>
                        <span>{issue.count}回</span>
                      </div>
                      <h3 className="issue-title">{issue.title}</h3>
                      {uniqueMentionTexts(issue)[0] && uniqueMentionTexts(issue)[0] !== issue.title && (
                        <p className="focus-text primary">{uniqueMentionTexts(issue)[0]}</p>
                      )}
                      {uniqueMentionTexts(issue).filter((text) => text !== issue.title).length > 1 && (
                        <div className="mention-stack">
                          {uniqueMentionTexts(issue)
                            .filter((text) => text !== issue.title)
                            .slice(1, 3)
                            .map((text) => (
                            <small key={`${issue.key}-${text}`}>{text}</small>
                          ))}
                        </div>
                      )}
                      <div className="memo-actions">
                        <button
                          type="button"
                          className="action-button light"
                          onClick={() => markAchieved(issue.key)}
                          disabled={leavingActiveIssueKeys.includes(issue.key)}
                        >
                          達成した
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </section>
          </section>
        )}

        {screen === "done" && (
          <section className="screen-panel full-panel">
            <section className="list-card">
              <div className="section-head">
                <div>
                  <p className="section-label">達成済み</p>
                  <h2>解消できた項目</h2>
                </div>
                <span>{achievedIssues.length}件</span>
              </div>

              {achievedIssues.length === 0 ? (
                <div className="empty-card">
                  <strong>まだありません</strong>
                  <p>意識中タブで達成した項目がここに移ります。</p>
                </div>
              ) : (
                <div className="memo-list achieved-grid">
                  {achievedIssues.map((issue) => (
                    <article
                      key={issue.key}
                      className={`memo-card achieved-card ${leavingDoneIssueKeys.includes(issue.key) ? "leaving" : ""}`}
                    >
                      <div className="memo-meta">
                        <span className="status-pill yes">達成</span>
                        <span>{issue.lastSeenDate}</span>
                      </div>
                      <h3 className="issue-title dark">{issue.title}</h3>
                      {uniqueMentionTexts(issue)[0] && uniqueMentionTexts(issue)[0] !== issue.title ? (
                        <p className="memo-text">{uniqueMentionTexts(issue)[0]}</p>
                      ) : (
                        <p className="memo-empty">代表メッセージなし</p>
                      )}
                      <div className="memo-actions">
                        <button
                          type="button"
                          className="action-button subtle"
                          onClick={() => reopenIssue(issue.key)}
                          disabled={leavingDoneIssueKeys.includes(issue.key)}
                        >
                          意識中に戻す
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </section>
          </section>
        )}

        {screen === "calendar" && (
          <section className="screen-panel calendar-panel">
            <section className="list-card">
              <div className="section-head">
                <div>
                  <p className="section-label">いつ行ったかを見る</p>
                  <h2>カレンダー</h2>
                </div>
                <div className="month-nav">
                  <button
                    type="button"
                    className="month-arrow"
                    aria-label="前月"
                    onClick={() => setCalendarMonth((current) => shiftMonth(current, -1))}
                  >
                    ←
                  </button>
                  <span>{formatMonthLabel(calendarMonth.toISOString().slice(0, 10))}</span>
                  <button
                    type="button"
                    className="month-arrow"
                    aria-label="次月"
                    onClick={() => setCalendarMonth((current) => shiftMonth(current, 1))}
                  >
                    →
                  </button>
                </div>
              </div>

              <div className="calendar-weekdays">
                {["月", "火", "水", "木", "金", "土", "日"].map((day) => (
                  <span key={day}>{day}</span>
                ))}
              </div>

              <div className="calendar-grid">
                {monthCells.map((cell) => {
                  const entry = cell.dayNumber ? entryByDate.get(cell.key) : undefined;
                  const active = selectedCalendarDate === cell.key;
                  return (
                    <button
                      key={cell.key}
                      type="button"
                      className={`calendar-cell ${entry?.attended ? "went" : ""} ${active ? "active" : ""}`}
                      onClick={() => {
                        if (!cell.dayNumber) {
                          return;
                        }
                        setSelectedCalendarDate(cell.key);
                      }}
                      disabled={!cell.dayNumber}
                    >
                      <span className="calendar-day-number">{cell.dayNumber ?? ""}</span>
                    </button>
                  );
                })}
              </div>
            </section>

            <section className="list-card">
              <div className="section-head">
                <div>
                  <p className="section-label">選んだ日の記録</p>
                  <h2>{selectedCalendarDate ? formatDay(selectedCalendarDate) : "日付を選択"}</h2>
                </div>
                {selectedCalendarDate && (
                  <button type="button" className="text-button" onClick={() => setSelectedCalendarDate(null)}>
                    解除
                  </button>
                )}
              </div>

              <div className="memo-list">
                {!selectedCalendarDate ? (
                  <div className="empty-card">
                    <strong>日付を選んでください</strong>
                    <p>カレンダーから日付を押すと、その日の記録が出ます。</p>
                  </div>
                ) : filteredEntries.length === 0 ? (
                  <div className="empty-card">
                    <strong>記録がありません</strong>
                    <p>この日はまだ何も記録していません。</p>
                  </div>
                ) : (
                  filteredEntries.map((entry) => (
                    <article key={entry.id} className="memo-card">
                      <div className="memo-meta">
                        <span>{entry.date}</span>
                      </div>
                      {entry.note ? <p className="memo-text">{entry.note}</p> : <p className="memo-empty">メモなし</p>}
                      <div className="memo-actions">
                        <button type="button" className="text-button" onClick={() => startEdit(entry)}>
                          編集
                        </button>
                      </div>
                    </article>
                  ))
                )}
              </div>
            </section>
          </section>
        )}

        {screen === "settings" && (
          <section className="screen-panel full-panel">
            <section className="list-card settings-card">
              <div className="section-head">
                <div>
                  <p className="section-label">アカウント管理</p>
                  <h2>設定</h2>
                </div>
              </div>

              <div className="settings-grid">
                <article className="settings-block">
                  <h3>ログイン情報</h3>
                  <p className="settings-current">{authUserId}</p>
                </article>

                <article className="settings-block">
                  <h3>メールアドレス変更</h3>
                  <form onSubmit={updateEmail} className="settings-form">
                    <input
                      className="auth-input"
                      type="email"
                      placeholder="新しいメールアドレス"
                      value={nextEmail}
                      onChange={(event) => setNextEmail(event.target.value)}
                      required
                    />
                    <button type="submit" className="primary-button" disabled={profilePending}>
                      変更メールを送る
                    </button>
                  </form>
                </article>

                <article className="settings-block">
                  <h3>パスワード変更</h3>
                  <form onSubmit={updatePassword} className="settings-form">
                    <input
                      className="auth-input"
                      type="password"
                      placeholder="新しいパスワード"
                      value={nextPassword}
                      onChange={(event) => setNextPassword(event.target.value)}
                      required
                      minLength={8}
                    />
                    <button type="submit" className="primary-button" disabled={profilePending}>
                      パスワードを更新
                    </button>
                  </form>
                </article>

                <article className="settings-block">
                  <h3>セッション</h3>
                  <button type="button" className="action-button subtle" onClick={logout}>
                    ログアウト
                  </button>
                </article>
              </div>

              {profileMessage && <p className="success-copy">{profileMessage}</p>}
              {profileError && <p className="inline-error">{profileError}</p>}
            </section>
          </section>
        )}
      </main>

      {isDatePickerOpen && (
        <div className="modal-backdrop" onClick={() => setIsDatePickerOpen(false)}>
          <div
            className="date-modal"
            role="dialog"
            aria-modal="true"
            aria-label="日付を選ぶ"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="date-modal-head">
              <div>
                <p className="section-label">日付を選ぶ</p>
                <h2>{formatMonthLabel(pickerMonth.toISOString().slice(0, 10))}</h2>
              </div>
              <button type="button" className="text-button" onClick={() => setIsDatePickerOpen(false)}>
                閉じる
              </button>
            </div>

            <div className="month-nav modal-month-nav">
              <button
                type="button"
                className="month-arrow"
                aria-label="前月"
                onClick={() => setPickerMonth((current) => shiftMonth(current, -1))}
              >
                ←
              </button>
              <button type="button" className="date-today-button" onClick={() => chooseDate(todayDate())}>
                今日
              </button>
              <button
                type="button"
                className="month-arrow"
                aria-label="次月"
                onClick={() => setPickerMonth((current) => shiftMonth(current, 1))}
              >
                →
              </button>
            </div>

            <div className="calendar-weekdays compact">
              {["月", "火", "水", "木", "金", "土", "日"].map((day) => (
                <span key={day}>{day}</span>
              ))}
            </div>

            <div className="calendar-grid compact">
              {pickerMonthCells.map((cell) => (
                <button
                  key={cell.key}
                  type="button"
                  className={`calendar-cell picker-cell ${selectedDate === cell.key ? "active" : ""}`}
                  onClick={() => {
                    if (!cell.dayNumber) {
                      return;
                    }
                    chooseDate(cell.key);
                  }}
                  disabled={!cell.dayNumber}
                >
                  <span className="calendar-day-number">{cell.dayNumber ?? ""}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
