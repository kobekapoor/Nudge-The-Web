import { useState, useEffect, useRef } from "react";

const BASE_SCHEDULE: Record<number, number> = { 1: 7, 3: 7, 4: 3, 5: 7, 6: 3 };
const TARGET = 100;
const REDUCED_HOURS = 2;
const HOLIDAY_REDUCTION = 4;

const MONTHS_LIST = [
  { year: 2026, month: 7 },
  { year: 2026, month: 8 }, { year: 2026, month: 9 }, { year: 2026, month: 10 }, { year: 2026, month: 11 },
  { year: 2027, month: 0 }, { year: 2027, month: 1 }, { year: 2027, month: 2 }, { year: 2027, month: 3 },
  { year: 2027, month: 4 }, { year: 2027, month: 5 }, { year: 2027, month: 6 }, { year: 2027, month: 7 },
];

const MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const DAY_NAMES = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const DAY_SHORT = ["S","M","T","W","T","F","S"];

function dayKey(year: number, month: number, day: number) { return `${year}-${month}-${day}`; }

function getBaseHoursForDay(year: number, month: number, day: number) {
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const dow = new Date(year, month, day).getDay();
  const normal = BASE_SCHEDULE[dow] || 0;
  if (normal === 0) return 0;
  return day > daysInMonth - 7 ? REDUCED_HOURS : normal;
}

function getMonthData(year: number, month: number, overrides: Record<string, number> = {}, holidays: Set<string> = new Set()) {
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  let holidayCount = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    if (holidays.has(dayKey(year, month, d))) holidayCount++;
  }
  const effectiveTarget = Math.max(0, TARGET - holidayCount * HOLIDAY_REDUCTION);

  let hours = 0;
  let hitTarget = false;
  const days: any[] = [];

  for (let d = 1; d <= daysInMonth; d++) {
    const dow = new Date(year, month, d).getDay();
    const key = dayKey(year, month, d);
    const baseHours = getBaseHoursForDay(year, month, d);
    const normalHours = BASE_SCHEDULE[dow] || 0;
    const isLastSeven = d > daysInMonth - 7;
    const isHoliday = holidays.has(key);

    let schedHours: number, status: string;

    if (isHoliday) {
      schedHours = 0;
      status = "holiday";
    } else {
      schedHours = key in overrides ? overrides[key] : baseHours;
      status = "off";
      if (schedHours > 0) {
        if (!hitTarget) {
          hours += schedHours;
          if (hours >= effectiveTarget) { hitTarget = true; status = "complete"; }
          else status = "working";
        } else {
          status = "bonus";
        }
      }
    }

    days.push({
      day: d, dow, schedHours, baseHours, normalHours, status,
      cum: (status === "working" || status === "complete") ? hours : null,
      isOverridden: key in overrides,
      isHoliday, isLastSeven,
    });
  }

  const totalHours = days.reduce((sum, d) => sum + d.schedHours, 0);
  return { firstDay, daysInMonth, days, bonusDays: days.filter(d => d.status === "bonus"), totalHours, effectiveTarget, holidayCount };
}

function getPopoverAlign(dow: number) {
  if (dow <= 1) return { left: 0 as const, right: "auto", transform: "none" };
  if (dow >= 5) return { right: 0 as const, left: "auto", transform: "none" };
  return { left: "50%", right: "auto", transform: "translateX(-50%)" };
}

function Popover({ d, year, month, onClose, onSave, onReset, onToggleHoliday, anchorRef }: any) {
  const [val, setVal] = useState(String(d.schedHours));
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node) && anchorRef.current && !anchorRef.current.contains(e.target as Node)) onClose();
    }
    setTimeout(() => document.addEventListener("mousedown", handler), 0);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  const align = getPopoverAlign(d.dow);

  return (
    <div ref={ref} style={{
      position: "absolute", zIndex: 300,
      top: "calc(100% + 8px)",
      ...align,
      background: "#fff", borderRadius: 10, padding: 13,
      boxShadow: "0 8px 32px rgba(0,0,0,0.16), 0 2px 8px rgba(0,0,0,0.10)",
      border: "1px solid #e4e2da", width: 158, boxSizing: "border-box",
    }}>
      <div style={{ fontSize: 9.5, color: "#aaa", letterSpacing: "0.07em", textTransform: "uppercase", marginBottom: 10 }}>
        {DAY_NAMES[d.dow]} {MONTH_NAMES[month].slice(0,3)} {d.day}
      </div>

      {d.isHoliday ? (
        <>
          <div style={{ background: "#fff8f0", border: "1px solid #f5c48a", borderRadius: 7, padding: "8px 10px", marginBottom: 10, textAlign: "center" }}>
            <div style={{ fontSize: 15 }}>🎉</div>
            <div style={{ fontSize: 10, color: "#b06020", fontWeight: 500, marginTop: 2 }}>Holiday</div>
            <div style={{ fontSize: 8.5, color: "#c08040", marginTop: 2 }}>−{HOLIDAY_REDUCTION}h from goal</div>
          </div>
          <button onClick={() => { onToggleHoliday(); onClose(); }} style={{
            width: "100%", padding: "7px 0", fontSize: 10.5, fontFamily: "inherit",
            background: "#fff0f0", color: "#c04040", border: "1px solid #f0c0c0",
            borderRadius: 5, cursor: "pointer", fontWeight: 500,
          }}>Remove holiday</button>
        </>
      ) : (
        <>
          <div style={{ fontSize: 9.5, color: "#bbb", marginBottom: 4 }}>Quick set</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 3, marginBottom: 9 }}>
            {[0, 3, 5, 7].map(v => (
              <button key={v} onClick={() => setVal(String(v))} style={{
                padding: "5px 0", fontSize: 10.5, fontFamily: "inherit",
                background: val === String(v) ? "#1a1a2e" : "#f5f5f0",
                color: val === String(v) ? "#fff" : "#666",
                border: "1px solid", borderColor: val === String(v) ? "#1a1a2e" : "#e0dcd0",
                borderRadius: 5, cursor: "pointer", fontWeight: 500,
              }}>{v === 0 ? "Off" : `${v}h`}</button>
            ))}
          </div>

          <div style={{ fontSize: 9.5, color: "#bbb", marginBottom: 4 }}>Custom</div>
          <div style={{ display: "flex", gap: 5, alignItems: "center", marginBottom: 9 }}>
            <input
              type="number" min={0} max={24} value={val}
              onChange={e => setVal(e.target.value)}
              style={{
                flex: 1, padding: "5px 7px", fontSize: 12, fontFamily: "inherit",
                border: "1px solid #d8d4cc", borderRadius: 5, background: "#fafaf8",
                outline: "none", color: "#1a1a2e", minWidth: 0, boxSizing: "border-box",
              }}
            />
            <span style={{ fontSize: 10, color: "#bbb", whiteSpace: "nowrap" }}>hrs</span>
          </div>

          <div style={{ display: "flex", gap: 5, marginBottom: 8 }}>
            <button onClick={() => { onSave(Math.max(0, parseInt(val) || 0)); onClose(); }} style={{
              flex: 1, padding: "6px 0", fontSize: 10.5, fontFamily: "inherit",
              background: "#1a1a2e", color: "#fff", border: "none",
              borderRadius: 5, cursor: "pointer", fontWeight: 500,
            }}>Save</button>
            {d.isOverridden && (
              <button onClick={() => { onReset(); onClose(); }} title="Reset to default" style={{
                padding: "6px 9px", fontSize: 12, fontFamily: "inherit",
                background: "#f5f0e8", color: "#888", border: "1px solid #e0d8cc",
                borderRadius: 5, cursor: "pointer",
              }}>↺</button>
            )}
          </div>

          <button onClick={() => { onToggleHoliday(); onClose(); }} style={{
            width: "100%", padding: "6px 0", fontSize: 10, fontFamily: "inherit",
            background: "#fff8f0", color: "#c07030", border: "1px solid #f0d8b0",
            borderRadius: 5, cursor: "pointer",
          }}>🎉 Mark as holiday</button>

          {(d.isOverridden || d.isLastSeven) && (
            <div style={{ fontSize: 8.5, color: "#bbb", marginTop: 7, textAlign: "center" }}>
              {d.isOverridden
                ? `Default: ${d.baseHours}h${d.isLastSeven ? " (reduced)" : ""}`
                : `Normal: ${d.normalHours}h · Reduced: ${d.baseHours}h`}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function DayCell({ d, year, month, onSave, onReset, onToggleHoliday }: any) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const { day, dow, schedHours, status, cum, isOverridden, isLastSeven, isHoliday } = d;

  const colorMap: Record<string, { bg: string; border: string; num: string; accent: string; sub: string; subText: string }> = {
    complete: { bg: "#eaf7f0", border: "#4ec486", num: "#1a4a30", accent: "#2baa65", sub: "#2baa65", subText: "#6dd4a0" },
    bonus:    { bg: "#f2fbf5", border: "#bbe0cc", num: "#1a6040", accent: "#2baa65", sub: "#4ec486", subText: "#9ed8b8" },
    working:  { bg: "#f0f3fd", border: "#bec9f0", num: "#2a3870", accent: "#4560cc", sub: "#6a80d8", subText: "#9aaae8" },
    off:      { bg: "#fafaf7", border: "#eae8e0", num: "#ccc8c0", accent: "#ddd8d0", sub: "#ddd",    subText: "#ddd" },
    holiday:  { bg: "#fff8f0", border: "#f5c48a", num: "#8a4010", accent: "#e08030", sub: "#e08030", subText: "#d09060" },
  };
  const colors = colorMap[status];

  const reducedDot = isLastSeven && !isOverridden && !isHoliday && schedHours > 0 && status !== "complete";

  return (
    <div ref={anchorRef} style={{ position: "relative" }}>
      <div
        onClick={() => setOpen(!open)}
        style={{
          background: colors.bg,
          border: `1.5px solid ${open ? colors.accent : isOverridden && !isHoliday ? colors.sub : colors.border}`,
          borderRadius: 6, padding: "5px 3px 5px", minHeight: 54,
          display: "flex", flexDirection: "column", alignItems: "center",
          justifyContent: "space-between", cursor: "pointer",
          transition: "border-color 0.1s, box-shadow 0.1s",
          boxShadow: open ? `0 0 0 3px ${colors.accent}22` : "none",
          outline: isOverridden && !isHoliday ? `2px dashed ${colors.sub}88` : "none",
          outlineOffset: -3, boxSizing: "border-box",
        }}
      >
        {reducedDot && (
          <div style={{ position: "absolute", top: 3, right: 3, width: 4, height: 4, borderRadius: "50%", background: "#f0a060" }} />
        )}

        <span style={{ fontSize: 11, fontWeight: status === "complete" ? 700 : 400, color: colors.num, lineHeight: 1 }}>
          {day}
        </span>

        {status === "complete" && (
          <div style={{ textAlign: "center", lineHeight: 1.4 }}>
            <div style={{ fontSize: 12, color: colors.accent }}>✓</div>
            <div style={{ fontSize: 7, color: colors.subText, letterSpacing: "0.03em" }}>done</div>
          </div>
        )}
        {status === "bonus" && (
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 7.5, color: colors.sub, fontWeight: 600, letterSpacing: "0.04em" }}>FREE</div>
            <div style={{ fontSize: 7, color: colors.subText }}>{schedHours}h</div>
          </div>
        )}
        {status === "working" && (
          <div style={{ textAlign: "center", lineHeight: 1.5 }}>
            <div style={{ fontSize: 8, color: colors.sub, fontWeight: 500 }}>{schedHours}h</div>
            <div style={{ fontSize: 7, color: colors.subText }}>{cum}h</div>
          </div>
        )}
        {status === "holiday" && (
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 12 }}>🎉</div>
          </div>
        )}
        {(status === "off") && <div />}
      </div>

      {open && (
        <Popover
          d={d} year={year} month={month}
          onClose={() => setOpen(false)}
          onSave={(h: number) => onSave(dayKey(year, month, day), h)}
          onReset={() => onReset(dayKey(year, month, day))}
          onToggleHoliday={() => onToggleHoliday(dayKey(year, month, day))}
          anchorRef={anchorRef}
        />
      )}
    </div>
  );
}

export default function SchedulePlanner() {
  const [sel, setSel] = useState(0);
  const [overrides, setOverrides] = useState<Record<string, number>>({});
  const [holidays, setHolidays] = useState<Set<string>>(new Set());

  const [isLoaded, setIsLoaded] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [showPwPrompt, setShowPwPrompt] = useState(false);
  const [pwInput, setPwInput] = useState("");
  const isDirtyRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingPayloadRef = useRef<{ overrides: Record<string, number>; holidays: string[] } | null>(null);

  useEffect(() => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=Syne:wght@700;800&family=DM+Mono:wght@300;400;500&display=swap";
    document.head.appendChild(link);
    return () => { document.head.removeChild(link); };
  }, []);

  // Load saved state from API on mount
  useEffect(() => {
    fetch("/api/schedule")
      .then(r => r.json())
      .then((data: { overrides: Record<string, number>; holidays: string[] }) => {
        if (data.overrides) setOverrides(data.overrides);
        if (data.holidays) setHolidays(new Set(data.holidays));
      })
      .catch(() => {})
      .finally(() => setIsLoaded(true));
  }, []);

  // Debounced auto-save — only fires after load and on user edits
  useEffect(() => {
    if (!isLoaded || !isDirtyRef.current) return;
    clearTimeout(saveTimerRef.current);
    const payload = { overrides, holidays: Array.from(holidays) };
    saveTimerRef.current = setTimeout(() => doSave(payload), 600);
    return () => clearTimeout(saveTimerRef.current);
  }, [overrides, holidays, isLoaded]);

  async function doSave(
    payload: { overrides: Record<string, number>; holidays: string[] },
    pw?: string,
  ) {
    setSaveStatus("saving");
    pendingPayloadRef.current = payload;
    const storedPw = pw ?? (typeof localStorage !== "undefined" ? localStorage.getItem("sp-password") ?? "" : "");
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (storedPw) headers["x-schedule-password"] = storedPw;
    try {
      const res = await fetch("/api/schedule", { method: "POST", headers, body: JSON.stringify(payload) });
      if (res.status === 401) {
        setSaveStatus("error");
        setShowPwPrompt(true);
        return;
      }
      if (res.ok) {
        isDirtyRef.current = false;
        setSaveStatus("saved");
        setTimeout(() => setSaveStatus("idle"), 2000);
      } else {
        setSaveStatus("error");
      }
    } catch {
      setSaveStatus("error");
    }
  }

  function handlePwSubmit() {
    localStorage.setItem("sp-password", pwInput);
    setShowPwPrompt(false);
    if (pendingPayloadRef.current) doSave(pendingPayloadRef.current, pwInput);
    setPwInput("");
  }

  const { year, month } = MONTHS_LIST[sel];
  const { firstDay, days, bonusDays, totalHours, effectiveTarget, holidayCount } = getMonthData(year, month, overrides, holidays);
  const allBonus = MONTHS_LIST.map(m => getMonthData(m.year, m.month, overrides, holidays).bonusDays.length);
  const maxBonus = Math.max(...allBonus, 1);
  const hasOverridesThisMonth = days.some(d => d.isOverridden);

  const handleSave = (key: string, h: number) => { isDirtyRef.current = true; setOverrides(o => ({ ...o, [key]: h })); };
  const handleReset = (key: string) => { isDirtyRef.current = true; setOverrides(o => { const n = { ...o }; delete n[key]; return n; }); };
  const handleToggleHoliday = (key: string) => {
    isDirtyRef.current = true;
    setHolidays(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };
  const resetMonth = () => {
    isDirtyRef.current = true;
    const keys = days.filter(d => d.isOverridden).map(d => dayKey(year, month, d.day));
    setOverrides(o => { const n = { ...o }; keys.forEach(k => delete n[k]); return n; });
  };

  const overGoal = totalHours - effectiveTarget;

  return (
    <div style={{
      fontFamily: "'DM Mono', monospace",
      background: "#f6f5f1",
      minHeight: "100vh",
      color: "#1a1a2e",
      padding: "20px 16px",
      boxSizing: "border-box",
      maxWidth: 640,
      margin: "0 auto",
    }}>

      {/* Password prompt overlay */}
      {showPwPrompt && (
        <div style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", zIndex: 1000,
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <div style={{
            background: "#fff", borderRadius: 12, padding: 24, width: 280,
            boxShadow: "0 12px 40px rgba(0,0,0,0.2)", fontFamily: "'DM Mono', monospace",
          }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#1a1a2e", marginBottom: 6 }}>Password required</div>
            <div style={{ fontSize: 10, color: "#aaa", marginBottom: 14 }}>Enter the password to save changes.</div>
            <input
              autoFocus
              type="password"
              value={pwInput}
              onChange={e => setPwInput(e.target.value)}
              onKeyDown={e => e.key === "Enter" && handlePwSubmit()}
              placeholder="Password"
              style={{
                width: "100%", padding: "8px 10px", fontSize: 12, fontFamily: "inherit",
                border: "1px solid #d8d4cc", borderRadius: 6, outline: "none",
                color: "#1a1a2e", boxSizing: "border-box", marginBottom: 12,
              }}
            />
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={handlePwSubmit} style={{
                flex: 1, padding: "8px 0", fontSize: 11, fontFamily: "inherit",
                background: "#1a1a2e", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontWeight: 600,
              }}>Save</button>
              <button onClick={() => { setShowPwPrompt(false); setPwInput(""); setSaveStatus("idle"); }} style={{
                padding: "8px 14px", fontSize: 11, fontFamily: "inherit",
                background: "#f5f0e8", color: "#888", border: "1px solid #e0d8cc", borderRadius: 6, cursor: "pointer",
              }}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 16, borderBottom: "1px solid #e4e0d8", paddingBottom: 14, flexWrap: "wrap" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <h1 style={{ fontFamily: "'Syne', sans-serif", fontSize: 19, fontWeight: 800, margin: 0, color: "#1a1a2e", letterSpacing: "-0.02em" }}>Volunteer Hours</h1>
            {saveStatus === "saving" && <span style={{ fontSize: 8.5, color: "#bbb", letterSpacing: "0.05em" }}>saving…</span>}
            {saveStatus === "saved"  && <span style={{ fontSize: 8.5, color: "#2baa65", letterSpacing: "0.05em" }}>saved ✓</span>}
            {saveStatus === "error" && !showPwPrompt && <span style={{ fontSize: 8.5, color: "#c04040", letterSpacing: "0.05em" }}>error saving</span>}
          </div>
          <p style={{ fontSize: 9, color: "#bbb", margin: "3px 0 0", letterSpacing: "0.08em", textTransform: "uppercase" }}>Aug 2026 – Aug 2027 · tap any day to edit</p>
        </div>
        <div style={{ display: "flex", gap: 10, flexShrink: 0 }}>
          {[{ l: "Mon", h: 7 }, { l: "Wed", h: 7 }, { l: "Thu", h: 3 }, { l: "Fri", h: 7 }, { l: "Sat", h: 3 }].map(s => (
            <div key={s.l} style={{ textAlign: "center" }}>
              <div style={{ color: "#4560cc", fontWeight: 500, fontSize: 11 }}>{s.h}h</div>
              <div style={{ color: "#bbb", letterSpacing: "0.05em", fontSize: 8.5 }}>{s.l}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Monthly overview bars */}
      <div style={{ background: "#fff", borderRadius: 10, padding: "10px 8px", marginBottom: 18, boxShadow: "0 1px 3px rgba(0,0,0,0.05)", border: "1px solid #eae8e0" }}>
        <div style={{ display: "flex", gap: 2, alignItems: "flex-end" }}>
          {MONTHS_LIST.map((m, i) => {
            const bonus = allBonus[i];
            const isSel = i === sel;
            const barH = Math.max(4, (bonus / maxBonus) * 32);
            return (
              <button key={i} onClick={() => setSel(i)} style={{
                flex: 1, minWidth: 0, display: "flex", flexDirection: "column", alignItems: "center",
                gap: 2, background: "none", border: "none", cursor: "pointer", padding: "2px 0",
              }}>
                <span style={{ fontSize: 8, color: isSel ? "#1a1a2e" : bonus > 0 ? "#2baa65" : "#ccc", fontFamily: "'DM Mono', monospace", fontWeight: 500, lineHeight: 1 }}>
                  {bonus > 0 ? `+${bonus}` : "—"}
                </span>
                <div style={{
                  width: "100%", height: barH, borderRadius: 2,
                  background: isSel ? "#1a1a2e" : bonus >= 4 ? "#2baa65" : bonus >= 3 ? "#5ecb8a" : bonus >= 2 ? "#9adcb8" : bonus === 1 ? "#c4eed6" : "#eeebe0",
                  border: isSel ? "1.5px solid #1a1a2e" : "1px solid transparent",
                  transition: "all 0.15s ease", boxSizing: "border-box",
                }} />
                <span style={{ fontSize: 7, color: isSel ? "#1a1a2e" : "#bbb", letterSpacing: "0.02em", lineHeight: 1 }}>
                  {MONTH_NAMES[m.month].slice(0, 3).toUpperCase()}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Month heading */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, gap: 8, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 7, flexWrap: "wrap", minWidth: 0 }}>
          <h2 style={{ fontFamily: "'Syne', sans-serif", fontSize: 26, fontWeight: 800, margin: 0, color: "#1a1a2e", letterSpacing: "-0.03em", lineHeight: 1 }}>
            {MONTH_NAMES[month]}
          </h2>
          <span style={{ fontSize: 12, color: "#bbb" }}>{year}</span>
          {hasOverridesThisMonth && (
            <button onClick={resetMonth} style={{ fontSize: 8.5, color: "#aaa", background: "#f0ece4", border: "1px solid #e0d8cc", borderRadius: 4, padding: "3px 7px", cursor: "pointer", fontFamily: "inherit", letterSpacing: "0.04em", whiteSpace: "nowrap" }}>
              ↺ reset month
            </button>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "flex-end", gap: 14, flexShrink: 0 }}>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 8.5, color: "#bbb", letterSpacing: "0.08em", textTransform: "uppercase" }}>Total hours</div>
            <div style={{ fontFamily: "'Syne', sans-serif", fontSize: 34, fontWeight: 800, lineHeight: 1, color: totalHours >= effectiveTarget ? "#4560cc" : "#1a1a2e" }}>
              {totalHours}
            </div>
            <div style={{ fontSize: 8.5, letterSpacing: "0.03em", color: "#bbb" }}>
              {holidayCount > 0
                ? <span>goal: <span style={{ color: "#c07030" }}>{effectiveTarget}h</span></span>
                : <span style={{ color: totalHours >= effectiveTarget ? "#7090e0" : "#bbb" }}>
                    {overGoal >= 0 ? `+${overGoal} over` : `${-overGoal} to go`}
                  </span>
              }
            </div>
            {holidayCount > 0 && (
              <div style={{ fontSize: 8, color: overGoal >= 0 ? "#7090e0" : "#bbb", letterSpacing: "0.03em" }}>
                {overGoal >= 0 ? `+${overGoal} over` : `${-overGoal} to go`}
              </div>
            )}
          </div>

          <div style={{ width: 1, background: "#e4e0d8", alignSelf: "stretch", minHeight: 40 }} />

          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 8.5, color: "#bbb", letterSpacing: "0.08em", textTransform: "uppercase" }}>Bonus days off</div>
            <div style={{ fontFamily: "'Syne', sans-serif", fontSize: 34, fontWeight: 800, lineHeight: 1, color: bonusDays.length >= 4 ? "#2baa65" : bonusDays.length >= 2 ? "#5ecb8a" : bonusDays.length === 1 ? "#9adcb8" : "#ddd" }}>
              +{bonusDays.length}
            </div>
            {bonusDays.length > 0 && (
              <div style={{ fontSize: 8.5, color: "#4ec486", letterSpacing: "0.03em" }}>
                {bonusDays.map(d => `${DAY_NAMES[d.dow].slice(0,3)} ${d.day}`).join(" · ")}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Calendar */}
      <div style={{ background: "#fff", borderRadius: 12, padding: "12px 10px", marginBottom: 12, boxShadow: "0 1px 4px rgba(0,0,0,0.06)", border: "1px solid #eae8e0" }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2, marginBottom: 7 }}>
          {DAY_SHORT.map((d, i) => (
            <div key={i} style={{ textAlign: "center", fontSize: 8.5, color: "#bbb", letterSpacing: "0.04em", paddingBottom: 5, borderBottom: "1px solid #f0ece4" }}>{d}</div>
          ))}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2 }}>
          {Array.from({ length: firstDay }).map((_, i) => <div key={`e${i}`} />)}
          {days.map(d => (
            <DayCell key={d.day} d={d} year={year} month={month}
              onSave={handleSave} onReset={handleReset} onToggleHoliday={handleToggleHoliday} />
          ))}
        </div>
      </div>

      {/* Legend */}
      <div style={{ background: "#fff", borderRadius: 8, padding: "10px 12px", border: "1px solid #eae8e0", display: "flex", gap: 10, flexWrap: "wrap" }}>
        {[
          { bg: "#f0f3fd", border: "#bec9f0", label: "Volunteering" },
          { bg: "#eaf7f0", border: "#4ec486",  label: "Hits goal" },
          { bg: "#f2fbf5", border: "#bbe0cc",  label: "Bonus day off" },
          { bg: "#fafaf7", border: "#eae8e0",  label: "Day off" },
          { bg: "#fff8f0", border: "#f5c48a",  label: "Holiday (−4h goal)" },
        ].map(({ bg, border, label }) => (
          <div key={label} style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <div style={{ width: 11, height: 11, background: bg, border: `1.5px solid ${border}`, borderRadius: 2, flexShrink: 0 }} />
            <span style={{ fontSize: 8.5, color: "#666" }}>{label}</span>
          </div>
        ))}
        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <div style={{ width: 11, height: 11, background: "#fafaf7", border: "2px dashed #9aaedc", borderRadius: 2, flexShrink: 0 }} />
          <span style={{ fontSize: 8.5, color: "#666" }}>Edited</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <div style={{ width: 7, height: 7, borderRadius: "50%", background: "#f0a060", flexShrink: 0 }} />
          <span style={{ fontSize: 8.5, color: "#666" }}>Reduced (last 7 days)</span>
        </div>
      </div>
    </div>
  );
}
