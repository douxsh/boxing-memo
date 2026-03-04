import { useEffect, useMemo, useRef, useState } from "react";
import { extractIssuesLocally, extractIssuesWithAI, issueCatalog, type IssueMention } from "./issueExtraction";

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

type Screen = "record" | "focus" | "done" | "calendar";

const ENTRIES_KEY = "boxing-memo-entries";
const ACHIEVED_KEY = "boxing-memo-achieved-issues";

const SAMPLE_ENTRIES: EntryItem[] = [
  {
    id: "sample-1",
    date: "2026-03-04",
    attended: true,
    note: "前のめりになりすぎている。ジャブの後に頭が前へ出る。",
  },
  {
    id: "sample-2",
    date: "2026-03-03",
    attended: true,
    note: "重心が前にある。右を打つ時に肩が開く。",
  },
  {
    id: "sample-3",
    date: "2026-03-02",
    attended: true,
    note: "打った後にガードを戻す。",
  },
];

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

function shiftMonth(date: Date, offset: number) {
  return new Date(date.getFullYear(), date.getMonth() + offset, 1);
}

function loadEntries() {
  const stored = localStorage.getItem(ENTRIES_KEY);
  if (!stored) {
    return SAMPLE_ENTRIES;
  }
  try {
    return JSON.parse(stored) as EntryItem[];
  } catch {
    return SAMPLE_ENTRIES;
  }
}

function loadAchieved() {
  const stored = localStorage.getItem(ACHIEVED_KEY);
  if (!stored) {
    return [];
  }
  try {
    return JSON.parse(stored) as string[];
  } catch {
    return [];
  }
}

function createId() {
  return Math.random().toString(36).slice(2, 10);
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

function App() {
  const [screen, setScreen] = useState<Screen>("record");
  const [entries, setEntries] = useState<EntryItem[]>(() => loadEntries());
  const [achievedIssueKeys, setAchievedIssueKeys] = useState<string[]>(() => loadAchieved());
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
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const tabOrder: Screen[] = ["record", "focus", "done", "calendar"];
  const activeTabIndex = tabOrder.indexOf(screen);

  useEffect(() => {
    localStorage.setItem(ENTRIES_KEY, JSON.stringify(entries));
  }, [entries]);

  useEffect(() => {
    localStorage.setItem(ACHIEVED_KEY, JSON.stringify(achievedIssueKeys));
  }, [achievedIssueKeys]);

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
    setIsSaving(true);
    setSaveError(null);
    if (editingId) {
      const issues = issuesTouched
        ? buildIssuesFromSelection(note.trim(), selectedIssueKeys)
        : await buildIssuesForNote(note.trim(), selectedDate);
      setEntries((current) =>
        current.map((entry) =>
          entry.id === editingId
            ? {
                ...entry,
                date: selectedDate,
                attended: true,
                note: note.trim(),
                issues,
              }
            : entry,
        ),
      );
      resetForm();
      setIsSaving(false);
      return;
    }

    const existing = entries.find((entry) => entry.date === selectedDate);
    if (existing) {
      const issues = issuesTouched
        ? buildIssuesFromSelection(note.trim(), selectedIssueKeys)
        : await buildIssuesForNote(note.trim(), selectedDate);
      setEntries((current) =>
        current.map((entry) =>
          entry.date === selectedDate
            ? {
                ...entry,
                attended: true,
                note: note.trim(),
                issues,
              }
            : entry,
        ),
      );
      resetForm();
      setIsSaving(false);
      return;
    }

    const issues = issuesTouched
      ? buildIssuesFromSelection(note.trim(), selectedIssueKeys)
      : await buildIssuesForNote(note.trim(), selectedDate);
    const nextEntry: EntryItem = {
      id: createId(),
      date: selectedDate,
      attended: true,
      note: note.trim(),
      issues,
    };

    setEntries((current) => [nextEntry, ...current]);
    resetForm();
    setIsSaving(false);
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
      setAchievedIssueKeys((current) => (current.includes(issueKey) ? current : [...current, issueKey]));
      setLeavingActiveIssueKeys((current) => current.filter((key) => key !== issueKey));
    }, 280);
  }

  function reopenIssue(issueKey: string) {
    if (leavingDoneIssueKeys.includes(issueKey)) {
      return;
    }
    setLeavingDoneIssueKeys((current) => [...current, issueKey]);
    window.setTimeout(() => {
      setAchievedIssueKeys((current) => current.filter((key) => key !== issueKey));
      setLeavingDoneIssueKeys((current) => current.filter((key) => key !== issueKey));
    }, 280);
  }

  function deleteEntry(id: string) {
    const shouldDelete = window.confirm("この記録を削除しますか？");
    if (!shouldDelete) {
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

  return (
    <div className="app-shell simple">
      <header className="simple-header">
        <div>
          <p className="eyebrow">BOXING MEMO</p>
          <h1>練習記録</h1>
          <p className="header-copy">書いたメモは自動でまとめて、意識中に集約されます。達成したら外します。</p>
        </div>
        <button
          type="button"
          className="ghost-button"
          onClick={() => {
            setEntries(SAMPLE_ENTRIES);
            setAchievedIssueKeys([]);
          }}
        >
          サンプルに戻す
        </button>
      </header>

      <nav className="main-tabs four">
        <span
          className="tab-indicator"
          style={{ transform: `translateX(${activeTabIndex * 100}%)` }}
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
      </nav>

      <main className="single-screen">
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
                  <span className="date-trigger-sub">{selectedDate}</span>
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
