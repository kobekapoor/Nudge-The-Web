import { useState, useEffect, useRef } from "react";

interface CustomType { id: string; name: string; credit: number; color: string; }
interface DayInfo {
  day: number; dow: number; schedHours: number; baseHours: number; normalHours: number;
  status: string; cum: number | null; isOverridden: boolean; isHoliday: boolean;
  isLastSeven: boolean; customTypeId: string | null; customType: CustomType | null;
}
type Segment = { kind: "blank" } | { kind: "single"; cell: DayInfo } | { kind: "merged"; cells: DayInfo[]; typeId: string; span: number };

const TYPE_COLORS = ["#6a80d8","#e06060","#2baa65","#d04090","#20a090","#e07020","#3498db","#9b59b6"];
const BASE_SCHEDULE: Record<number, number> = { 1: 7, 3: 7, 4: 3, 5: 7, 6: 3 };
const TARGET = 100;
const REDUCED_HOURS = 2;
const HOLIDAY_REDUCTION = 4;

const MONTHS_LIST: { year: number; month: number }[] = [];
for (let y = 2026; y <= 2029; y++)
  for (let m = y === 2026 ? 7 : 0; m <= 11; m++)
    MONTHS_LIST.push({ year: y, month: m });

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

function getMonthData(
  year: number, month: number,
  overrides: Record<string, number>,
  holidays: Set<string>,
  customTypes: CustomType[],
  dayCustomTypes: Record<string, string>
) {
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  let totalCredit = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const key = dayKey(year, month, d);
    if (holidays.has(key)) totalCredit += HOLIDAY_REDUCTION;
    else if (key in dayCustomTypes) {
      const ct = customTypes.find(t => t.id === dayCustomTypes[key]);
      if (ct) totalCredit += ct.credit;
    }
  }
  const effectiveTarget = Math.max(0, TARGET - totalCredit);
  let hours = 0, hitTarget = false;
  const days: DayInfo[] = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const dow = new Date(year, month, d).getDay();
    const key = dayKey(year, month, d);
    const baseHours = getBaseHoursForDay(year, month, d);
    const normalHours = BASE_SCHEDULE[dow] || 0;
    const isLastSeven = d > daysInMonth - 7;
    const isHoliday = holidays.has(key);
    const customTypeId = (!isHoliday && key in dayCustomTypes) ? dayCustomTypes[key] : null;
    const customType = customTypeId ? (customTypes.find(t => t.id === customTypeId) ?? null) : null;
    let schedHours: number, status: string;
    if (isHoliday) { schedHours = 0; status = "holiday"; }
    else if (customType) { schedHours = 0; status = "custom"; }
    else {
      schedHours = key in overrides ? overrides[key] : baseHours;
      status = "off";
      if (schedHours > 0) {
        if (!hitTarget) {
          hours += schedHours;
          if (hours >= effectiveTarget) { hitTarget = true; status = "complete"; }
          else status = "working";
        } else status = "bonus";
      }
    }
    days.push({ day: d, dow, schedHours, baseHours, normalHours, status,
      cum: (status === "working" || status === "complete") ? hours : null,
      isOverridden: key in overrides, isHoliday, isLastSeven, customTypeId, customType });
  }
  const totalHours = days.reduce((sum, d) => sum + d.schedHours, 0);
  return { firstDay, daysInMonth, days, bonusDays: days.filter(d => d.status === "bonus"), totalHours, effectiveTarget, totalCredit };
}

function getPopoverAlign(dow: number) {
  if (dow <= 1) return { left: 0 as const, right: "auto", transform: "none" };
  if (dow >= 5) return { right: 0 as const, left: "auto", transform: "none" };
  return { left: "50%", right: "auto", transform: "translateX(-50%)" };
}

function buildWeekSegments(
  week: (DayInfo | null)[],
  dayCustomTypes: Record<string, string>,
  year: number, month: number
): Segment[] {
  const segments: Segment[] = [];
  let i = 0;
  while (i < week.length) {
    const cell = week[i];
    if (cell === null) { segments.push({ kind: "blank" }); i++; continue; }
    const key = dayKey(year, month, cell.day);
    const typeId = cell.isHoliday ? "__holiday__" : (dayCustomTypes[key] ?? null);
    if (typeId !== null) {
      let span = 1;
      while (i + span < week.length) {
        const next = week[i + span];
        if (!next) break;
        const nk = dayKey(year, month, next.day);
        const nType = next.isHoliday ? "__holiday__" : (dayCustomTypes[nk] ?? null);
        if (nType === typeId) span++; else break;
      }
      if (span > 1) { segments.push({ kind: "merged", cells: week.slice(i, i + span) as DayInfo[], typeId, span }); i += span; continue; }
    }
    segments.push({ kind: "single", cell }); i++;
  }
  return segments;
}

function Popover({ d, year, month, onClose, onSave, onReset, onToggleHoliday, customTypes, onSetCustomType, onCreateCustomType, anchorRef }: {
  d: DayInfo; year: number; month: number; onClose: () => void; onSave: (h: number) => void;
  onReset: () => void; onToggleHoliday: () => void; customTypes: CustomType[];
  onSetCustomType: (id: string | null) => void; onCreateCustomType: (name: string, credit: number) => string;
  anchorRef: React.RefObject<HTMLDivElement | null>;
}) {
  const [val, setVal] = useState(String(d.schedHours));
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [newCredit, setNewCredit] = useState("4");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node) && anchorRef.current && !anchorRef.current.contains(e.target as Node)) onClose();
    }
    setTimeout(() => document.addEventListener("mousedown", handler), 0);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);
  function handleCreate() {
    const name = newName.trim(); if (!name) return;
    const id = onCreateCustomType(name, Math.max(0, parseInt(newCredit) || 0));
    onSetCustomType(id); onClose();
  }
  const align = getPopoverAlign(d.dow);
  return (
    <div ref={ref} style={{ position: "absolute", zIndex: 300, top: "calc(100% + 8px)", ...align, background: "#fff", borderRadius: 10, padding: 13, boxShadow: "0 8px 32px rgba(0,0,0,0.16), 0 2px 8px rgba(0,0,0,0.10)", border: "1px solid #e4e2da", width: 170, boxSizing: "border-box" }}>
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
          <button onClick={() => { onToggleHoliday(); onClose(); }} style={{ width: "100%", padding: "7px 0", fontSize: 10.5, fontFamily: "inherit", background: "#fff0f0", color: "#c04040", border: "1px solid #f0c0c0", borderRadius: 5, cursor: "pointer", fontWeight: 500 }}>Remove holiday</button>
        </>
      ) : d.customType ? (
        <>
          <div style={{ background: d.customType.color + "18", border: `1px solid ${d.customType.color}`, borderRadius: 7, padding: "8px 10px", marginBottom: 10, textAlign: "center" }}>
            <div style={{ fontSize: 12, color: d.customType.color, fontWeight: 600 }}>{d.customType.name}</div>
            <div style={{ fontSize: 8.5, color: d.customType.color + "aa", marginTop: 2 }}>−{d.customType.credit}h from goal</div>
          </div>
          <button onClick={() => { onSetCustomType(null); onClose(); }} style={{ width: "100%", padding: "7px 0", fontSize: 10.5, fontFamily: "inherit", background: "#fff0f0", color: "#c04040", border: "1px solid #f0c0c0", borderRadius: 5, cursor: "pointer", fontWeight: 500, marginBottom: 6 }}>Remove</button>
          {customTypes.filter(t => t.id !== d.customType!.id).length > 0 && (
            <div>
              <div style={{ fontSize: 9, color: "#bbb", marginBottom: 4 }}>Change to</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
                {customTypes.filter(t => t.id !== d.customType!.id).map(ct => (
                  <button key={ct.id} onClick={() => { onSetCustomType(ct.id); onClose(); }} style={{ padding: "4px 7px", fontSize: 9, fontFamily: "inherit", background: ct.color + "18", color: ct.color, border: `1px solid ${ct.color}88`, borderRadius: 4, cursor: "pointer" }}>{ct.name}</button>
                ))}
              </div>
            </div>
          )}
        </>
      ) : (
        <>
          <div style={{ fontSize: 9.5, color: "#bbb", marginBottom: 4 }}>Quick set</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 3, marginBottom: 9 }}>
            {[0, 3, 5, 7].map(v => (
              <button key={v} onClick={() => setVal(String(v))} style={{ padding: "5px 0", fontSize: 10.5, fontFamily: "inherit", background: val === String(v) ? "#1a1a2e" : "#f5f5f0", color: val === String(v) ? "#fff" : "#666", border: "1px solid", borderColor: val === String(v) ? "#1a1a2e" : "#e0dcd0", borderRadius: 5, cursor: "pointer", fontWeight: 500 }}>{v === 0 ? "Off" : `${v}h`}</button>
            ))}
          </div>
          <div style={{ fontSize: 9.5, color: "#bbb", marginBottom: 4 }}>Custom</div>
          <div style={{ display: "flex", gap: 5, alignItems: "center", marginBottom: 9 }}>
            <input type="number" min={0} max={24} value={val} onChange={e => setVal(e.target.value)} style={{ flex: 1, padding: "5px 7px", fontSize: 12, fontFamily: "inherit", border: "1px solid #d8d4cc", borderRadius: 5, background: "#fafaf8", outline: "none", color: "#1a1a2e", minWidth: 0, boxSizing: "border-box" }} />
            <span style={{ fontSize: 10, color: "#bbb", whiteSpace: "nowrap" }}>hrs</span>
          </div>
          <div style={{ display: "flex", gap: 5, marginBottom: 8 }}>
            <button onClick={() => { onSave(Math.max(0, parseInt(val) || 0)); onClose(); }} style={{ flex: 1, padding: "6px 0", fontSize: 10.5, fontFamily: "inherit", background: "#1a1a2e", color: "#fff", border: "none", borderRadius: 5, cursor: "pointer", fontWeight: 500 }}>Save</button>
            {d.isOverridden && (
              <button onClick={() => { onReset(); onClose(); }} title="Reset to default" style={{ padding: "6px 9px", fontSize: 12, fontFamily: "inherit", background: "#f5f0e8", color: "#888", border: "1px solid #e0d8cc", borderRadius: 5, cursor: "pointer" }}>↺</button>
            )}
          </div>
          <div style={{ borderTop: "1px solid #f0ece4", paddingTop: 8 }}>
            <div style={{ fontSize: 9, color: "#bbb", marginBottom: 5, letterSpacing: "0.04em" }}>Special day</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginBottom: showNew ? 8 : 0 }}>
              <button onClick={() => { onToggleHoliday(); onClose(); }} style={{ padding: "4px 7px", fontSize: 9, fontFamily: "inherit", background: "#fff8f0", color: "#c07030", border: "1px solid #f0d8b0", borderRadius: 4, cursor: "pointer" }}>🎉 Holiday</button>
              {customTypes.map(ct => (
                <button key={ct.id} onClick={() => { onSetCustomType(ct.id); onClose(); }} style={{ padding: "4px 7px", fontSize: 9, fontFamily: "inherit", background: ct.color + "18", color: ct.color, border: `1px solid ${ct.color}88`, borderRadius: 4, cursor: "pointer" }}>{ct.name}</button>
              ))}
              <button onClick={() => setShowNew(true)} style={{ padding: "4px 7px", fontSize: 9, fontFamily: "inherit", background: "#f5f5f0", color: "#888", border: "1px solid #e0dcd0", borderRadius: 4, cursor: "pointer" }}>+ New</button>
            </div>
            {showNew && (
              <div style={{ background: "#f8f7f4", borderRadius: 6, padding: 8 }}>
                <input autoFocus placeholder="Type name" value={newName} onChange={e => setNewName(e.target.value)} onKeyDown={e => e.key === "Enter" && handleCreate()} style={{ width: "100%", padding: "4px 6px", fontSize: 10, fontFamily: "inherit", border: "1px solid #d8d4cc", borderRadius: 4, outline: "none", color: "#1a1a2e", marginBottom: 5, boxSizing: "border-box" }} />
                <div style={{ display: "flex", gap: 4, alignItems: "center", marginBottom: 6 }}>
                  <input type="number" min={0} max={24} placeholder="hrs credit" value={newCredit} onChange={e => setNewCredit(e.target.value)} style={{ flex: 1, padding: "4px 6px", fontSize: 10, fontFamily: "inherit", border: "1px solid #d8d4cc", borderRadius: 4, outline: "none", color: "#1a1a2e", minWidth: 0, boxSizing: "border-box" }} />
                  <span style={{ fontSize: 9, color: "#bbb" }}>h credit</span>
                </div>
                <div style={{ display: "flex", gap: 4 }}>
                  <button onClick={handleCreate} style={{ flex: 1, padding: "5px 0", fontSize: 10, fontFamily: "inherit", background: "#1a1a2e", color: "#fff", border: "none", borderRadius: 4, cursor: "pointer", fontWeight: 500 }}>Create & apply</button>
                  <button onClick={() => { setShowNew(false); setNewName(""); setNewCredit("4"); }} style={{ padding: "5px 8px", fontSize: 10, fontFamily: "inherit", background: "#f0ece4", color: "#888", border: "1px solid #e0d8cc", borderRadius: 4, cursor: "pointer" }}>✕</button>
                </div>
              </div>
            )}
          </div>
          {(d.isOverridden || d.isLastSeven) && (
            <div style={{ fontSize: 8.5, color: "#bbb", marginTop: 7, textAlign: "center" }}>
              {d.isOverridden ? `Default: ${d.baseHours}h${d.isLastSeven ? " (reduced)" : ""}` : `Normal: ${d.normalHours}h · Reduced: ${d.baseHours}h`}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function MergedCell({ days, typeId, typeLabel, typeColor, creditPerDay, span, onRemoveAll }: {
  days: DayInfo[]; typeId: string; typeLabel: string; typeColor: string;
  creditPerDay: number; span: number; onRemoveAll: () => void;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const isHol = typeId === "__holiday__";
  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (popRef.current && !popRef.current.contains(e.target as Node) && anchorRef.current && !anchorRef.current.contains(e.target as Node)) setOpen(false);
    }
    setTimeout(() => document.addEventListener("mousedown", handler), 0);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);
  const first = days[0], last = days[days.length - 1];
  const bgColor = isHol ? "#fff8f0" : typeColor + "18";
  const borderColor = isHol ? "#f5c48a" : typeColor;
  const textColor = isHol ? "#e08030" : typeColor;
  return (
    <div ref={anchorRef} style={{ gridColumn: `span ${span}`, position: "relative" }}>
      <div onClick={() => setOpen(!open)} style={{ background: bgColor, border: `1.5px solid ${open ? textColor : borderColor}`, borderRadius: 6, minHeight: 54, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", cursor: "pointer", padding: "4px 6px", boxSizing: "border-box", boxShadow: open ? `0 0 0 3px ${textColor}22` : "none" }}>
        {isHol && <div style={{ fontSize: 11, lineHeight: 1 }}>🎉</div>}
        <div style={{ fontSize: span > 2 ? 9.5 : 8, color: textColor, fontWeight: 600, textAlign: "center", lineHeight: 1.2, marginTop: isHol ? 2 : 0 }}>{typeLabel}</div>
        <div style={{ fontSize: 7, color: textColor + "99", marginTop: 2 }}>{first.day}{days.length > 1 ? `–${last.day}` : ""}</div>
      </div>
      {open && (
        <div ref={popRef} style={{ position: "absolute", zIndex: 300, top: "calc(100% + 8px)", left: "50%", transform: "translateX(-50%)", background: "#fff", borderRadius: 10, padding: 13, boxShadow: "0 8px 32px rgba(0,0,0,0.16)", border: "1px solid #e4e2da", width: 160, boxSizing: "border-box" }}>
          <div style={{ fontSize: 9.5, color: "#aaa", marginBottom: 8 }}>{DAY_NAMES[first.dow].slice(0,3)} {first.day} – {DAY_NAMES[last.dow].slice(0,3)} {last.day}</div>
          <div style={{ background: bgColor, border: `1px solid ${borderColor}`, borderRadius: 7, padding: "8px 10px", marginBottom: 10, textAlign: "center" }}>
            {isHol && <div style={{ fontSize: 14 }}>🎉</div>}
            <div style={{ fontSize: 11, color: textColor, fontWeight: 600 }}>{typeLabel}</div>
            <div style={{ fontSize: 8.5, color: textColor + "aa", marginTop: 2 }}>{days.length} day{days.length > 1 ? "s" : ""} · −{days.length * creditPerDay}h from goal</div>
          </div>
          <button onClick={() => { onRemoveAll(); setOpen(false); }} style={{ width: "100%", padding: "7px 0", fontSize: 10.5, fontFamily: "inherit", background: "#fff0f0", color: "#c04040", border: "1px solid #f0c0c0", borderRadius: 5, cursor: "pointer", fontWeight: 500 }}>Remove all</button>
        </div>
      )}
    </div>
  );
}

function DayCell({ d, year, month, onSave, onReset, onToggleHoliday, customTypes, onSetCustomType, onCreateCustomType }: {
  d: DayInfo; year: number; month: number; onSave: (key: string, h: number) => void;
  onReset: (key: string) => void; onToggleHoliday: (key: string) => void;
  customTypes: CustomType[]; onSetCustomType: (id: string | null) => void;
  onCreateCustomType: (name: string, credit: number) => string;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const { day, dow, schedHours, status, cum, isOverridden, isLastSeven, isHoliday, customType } = d;
  const colorMap: Record<string, { bg: string; border: string; num: string; accent: string; sub: string; subText: string }> = {
    complete: { bg: "#eaf7f0", border: "#4ec486", num: "#1a4a30", accent: "#2baa65", sub: "#2baa65", subText: "#6dd4a0" },
    bonus:    { bg: "#f2fbf5", border: "#bbe0cc", num: "#1a6040", accent: "#2baa65", sub: "#4ec486", subText: "#9ed8b8" },
    working:  { bg: "#f0f3fd", border: "#bec9f0", num: "#2a3870", accent: "#4560cc", sub: "#6a80d8", subText: "#9aaae8" },
    off:      { bg: "#fafaf7", border: "#eae8e0", num: "#ccc8c0", accent: "#ddd8d0", sub: "#ddd",    subText: "#ddd" },
    holiday:  { bg: "#fff8f0", border: "#f5c48a", num: "#8a4010", accent: "#e08030", sub: "#e08030", subText: "#d09060" },
    custom:   { bg: customType ? customType.color + "18" : "#f8f7f4", border: customType ? customType.color + "88" : "#ddd", num: customType ? customType.color : "#888", accent: customType ? customType.color : "#888", sub: customType ? customType.color : "#888", subText: customType ? customType.color + "88" : "#bbb" },
  };
  const colors = colorMap[status] ?? colorMap.off;
  const reducedDot = isLastSeven && !isOverridden && !isHoliday && !customType && schedHours > 0 && status !== "complete";
  return (
    <div ref={anchorRef} style={{ position: "relative" }}>
      <div onClick={() => setOpen(!open)} style={{ background: colors.bg, border: `1.5px solid ${open ? colors.accent : isOverridden && !isHoliday && !customType ? colors.sub : colors.border}`, borderRadius: 6, padding: "5px 3px 5px", minHeight: 54, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "space-between", cursor: "pointer", transition: "border-color 0.1s, box-shadow 0.1s", boxShadow: open ? `0 0 0 3px ${colors.accent}22` : "none", outline: isOverridden && !isHoliday && !customType ? `2px dashed ${colors.sub}88` : "none", outlineOffset: -3, boxSizing: "border-box" }}>
        {reducedDot && <div style={{ position: "absolute", top: 3, right: 3, width: 4, height: 4, borderRadius: "50%", background: "#f0a060" }} />}
        <span style={{ fontSize: 11, fontWeight: status === "complete" ? 700 : 400, color: colors.num, lineHeight: 1 }}>{day}</span>
        {status === "complete" && (<div style={{ textAlign: "center", lineHeight: 1.4 }}><div style={{ fontSize: 12, color: colors.accent }}>✓</div><div style={{ fontSize: 7, color: colors.subText, letterSpacing: "0.03em" }}>{schedHours}h</div></div>)}
        {status === "bonus" && (<div style={{ textAlign: "center" }}><div style={{ fontSize: 7.5, color: colors.sub, fontWeight: 600, letterSpacing: "0.04em" }}>FREE</div><div style={{ fontSize: 7, color: colors.subText }}>{schedHours}h</div></div>)}
        {status === "working" && (<div style={{ textAlign: "center", lineHeight: 1.5 }}><div style={{ fontSize: 8, color: colors.sub, fontWeight: 500 }}>{schedHours}h</div><div style={{ fontSize: 7, color: colors.subText }}>{cum}h</div></div>)}
        {status === "holiday" && (<div style={{ textAlign: "center" }}><div style={{ fontSize: 12 }}>🎉</div></div>)}
        {status === "custom" && customType && (<div style={{ textAlign: "center" }}><div style={{ fontSize: 8, color: customType.color, fontWeight: 600, lineHeight: 1.2 }}>{customType.name.slice(0, 6)}</div></div>)}
        {status === "off" && <div />}
      </div>
      {open && (
        <Popover d={d} year={year} month={month} onClose={() => setOpen(false)}
          onSave={(h) => onSave(dayKey(year, month, day), h)}
          onReset={() => onReset(dayKey(year, month, day))}
          onToggleHoliday={() => onToggleHoliday(dayKey(year, month, day))}
          customTypes={customTypes} onSetCustomType={onSetCustomType}
          onCreateCustomType={onCreateCustomType} anchorRef={anchorRef} />
      )}
    </div>
  );
}

export default function SchedulePlanner() {
  const [sel, setSel] = useState(0);
  const [overrides, setOverrides] = useState<Record<string, number>>({});
  const [holidays, setHolidays] = useState<Set<string>>(new Set());
  const [customTypes, setCustomTypes] = useState<CustomType[]>([]);
  const [dayCustomTypes, setDayCustomTypes] = useState<Record<string, string>>({});
  const [isLoaded, setIsLoaded] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const isDirtyRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const selectedMonthRef = useRef<HTMLButtonElement>(null);
  const hasMountedRef = useRef(false);

  useEffect(() => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=Syne:wght@700;800&family=DM+Mono:wght@300;400;500&display=swap";
    document.head.appendChild(link);
    return () => { document.head.removeChild(link); };
  }, []);

  useEffect(() => {
    fetch("/api/schedule").then(r => r.json()).then((data: any) => {
      if (data.overrides) setOverrides(data.overrides);
      if (data.holidays) setHolidays(new Set(data.holidays));
      if (data.customTypes) setCustomTypes(data.customTypes);
      if (data.dayCustomTypes) setDayCustomTypes(data.dayCustomTypes);
    }).catch(() => {}).finally(() => setIsLoaded(true));
  }, []);

  useEffect(() => {
    if (!isLoaded || !isDirtyRef.current) return;
    clearTimeout(saveTimerRef.current);
    const payload = { overrides, holidays: Array.from(holidays), customTypes, dayCustomTypes };
    saveTimerRef.current = setTimeout(() => doSave(payload), 600);
    return () => clearTimeout(saveTimerRef.current);
  }, [overrides, holidays, isLoaded, customTypes, dayCustomTypes]);

  useEffect(() => {
    if (selectedMonthRef.current) {
      selectedMonthRef.current.scrollIntoView({ inline: "center", behavior: hasMountedRef.current ? "smooth" : "instant", block: "nearest" });
    }
    hasMountedRef.current = true;
  }, [sel]);

  async function doSave(payload: object) {
    setSaveStatus("saving");
    try {
      const res = await fetch("/api/schedule", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (res.ok) { isDirtyRef.current = false; setSaveStatus("saved"); setTimeout(() => setSaveStatus("idle"), 2000); }
      else setSaveStatus("error");
    } catch { setSaveStatus("error"); }
  }

  const { year, month } = MONTHS_LIST[sel];
  const { firstDay, days, bonusDays, totalHours, effectiveTarget, totalCredit } = getMonthData(year, month, overrides, holidays, customTypes, dayCustomTypes);
  const hasOverridesThisMonth = days.some(d => d.isOverridden);
  const overGoal = totalHours - effectiveTarget;

  const handleSave = (key: string, h: number) => { isDirtyRef.current = true; setOverrides(o => ({ ...o, [key]: h })); };
  const handleReset = (key: string) => { isDirtyRef.current = true; setOverrides(o => { const n = { ...o }; delete n[key]; return n; }); };
  const handleToggleHoliday = (key: string) => {
    isDirtyRef.current = true;
    setHolidays(prev => { const n = new Set(prev); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  };
  const handleSetCustomType = (key: string, typeId: string | null) => {
    isDirtyRef.current = true;
    setDayCustomTypes(prev => { const n = { ...prev }; if (typeId === null) delete n[key]; else n[key] = typeId; return n; });
  };
  const handleCreateCustomType = (name: string, credit: number): string => {
    const id = `ct_${Date.now()}`;
    const color = TYPE_COLORS[customTypes.length % TYPE_COLORS.length];
    isDirtyRef.current = true;
    setCustomTypes(prev => [...prev, { id, name, credit, color }]);
    return id;
  };
  const handleRemoveMerged = (cells: DayInfo[], typeId: string) => {
    isDirtyRef.current = true;
    if (typeId === "__holiday__") {
      setHolidays(prev => { const n = new Set(prev); cells.forEach(d => n.delete(dayKey(year, month, d.day))); return n; });
    } else {
      setDayCustomTypes(prev => { const n = { ...prev }; cells.forEach(d => delete n[dayKey(year, month, d.day)]); return n; });
    }
  };
  const resetMonth = () => {
    isDirtyRef.current = true;
    const keys = days.filter(d => d.isOverridden).map(d => dayKey(year, month, d.day));
    setOverrides(o => { const n = { ...o }; keys.forEach(k => delete n[k]); return n; });
  };

  const allCells: (DayInfo | null)[] = [...Array(firstDay).fill(null), ...days];
  const weeks: (DayInfo | null)[][] = [];
  for (let i = 0; i < allCells.length; i += 7) weeks.push(allCells.slice(i, Math.min(i + 7, allCells.length)));

  return (
    <div style={{ fontFamily: "'DM Mono', monospace", background: "#f6f5f1", minHeight: "100vh", color: "#1a1a2e", padding: "20px 16px", boxSizing: "border-box", maxWidth: 640, margin: "0 auto" }}>
      <style>{`.sp-ms::-webkit-scrollbar{display:none}`}</style>

      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 16, borderBottom: "1px solid #e4e0d8", paddingBottom: 14, flexWrap: "wrap" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <h1 style={{ fontFamily: "'Syne', sans-serif", fontSize: 19, fontWeight: 800, margin: 0, color: "#1a1a2e", letterSpacing: "-0.02em" }}>Volunteer Hours</h1>
            {saveStatus === "saving" && <span style={{ fontSize: 8.5, color: "#bbb", letterSpacing: "0.05em" }}>saving…</span>}
            {saveStatus === "saved"  && <span style={{ fontSize: 8.5, color: "#2baa65", letterSpacing: "0.05em" }}>saved ✓</span>}
            {saveStatus === "error"  && <span style={{ fontSize: 8.5, color: "#c04040", letterSpacing: "0.05em" }}>error saving</span>}
          </div>
          <p style={{ fontSize: 9, color: "#bbb", margin: "3px 0 0", letterSpacing: "0.08em", textTransform: "uppercase" }}>Aug 2026 – Dec 2029 · tap any day to edit</p>
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

      {/* Month selector */}
      <div className="sp-ms" style={{ overflowX: "auto", scrollbarWidth: "none", marginBottom: 18, background: "#fff", borderRadius: 10, padding: "10px 10px", border: "1px solid #eae8e0", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          {MONTHS_LIST.map((m, i) => {
            const isSel = i === sel;
            const showYear = m.month === 0 || i === 0;
            return (
              <button key={i} ref={isSel ? selectedMonthRef : undefined} onClick={() => setSel(i)} style={{ padding: "5px 10px", fontSize: 10, fontFamily: "'DM Mono', monospace", background: isSel ? "#1a1a2e" : "transparent", color: isSel ? "#fff" : showYear ? "#888" : "#aaa", border: `1px solid ${isSel ? "#1a1a2e" : "transparent"}`, borderRadius: 20, cursor: "pointer", whiteSpace: "nowrap", fontWeight: isSel ? 600 : showYear ? 500 : 400, flexShrink: 0 }}>
                {MONTH_NAMES[m.month].slice(0, 3)}{showYear ? ` '${String(m.year).slice(2)}` : ""}
              </button>
            );
          })}
        </div>
      </div>

      {/* Month heading */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, gap: 8, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 7, flexWrap: "wrap", minWidth: 0 }}>
          <h2 style={{ fontFamily: "'Syne', sans-serif", fontSize: 26, fontWeight: 800, margin: 0, color: "#1a1a2e", letterSpacing: "-0.03em", lineHeight: 1 }}>{MONTH_NAMES[month]}</h2>
          <span style={{ fontSize: 12, color: "#bbb" }}>{year}</span>
          {hasOverridesThisMonth && (
            <button onClick={resetMonth} style={{ fontSize: 8.5, color: "#aaa", background: "#f0ece4", border: "1px solid #e0d8cc", borderRadius: 4, padding: "3px 7px", cursor: "pointer", fontFamily: "inherit", letterSpacing: "0.04em", whiteSpace: "nowrap" }}>↺ reset month</button>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 14, flexShrink: 0 }}>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 8.5, color: "#bbb", letterSpacing: "0.08em", textTransform: "uppercase" }}>Total hours</div>
            <div style={{ fontFamily: "'Syne', sans-serif", fontSize: 34, fontWeight: 800, lineHeight: 1, color: totalHours >= effectiveTarget ? "#4560cc" : "#1a1a2e" }}>{totalHours}</div>
            <div style={{ fontSize: 8.5, letterSpacing: "0.03em", color: "#bbb" }}>
              {totalCredit > 0
                ? <span>goal: <span style={{ color: "#c07030" }}>{effectiveTarget}h</span></span>
                : <span style={{ color: totalHours >= effectiveTarget ? "#7090e0" : "#bbb" }}>{overGoal >= 0 ? `+${overGoal} over` : `${-overGoal} to go`}</span>
              }
            </div>
            {totalCredit > 0 && <div style={{ fontSize: 8, color: overGoal >= 0 ? "#7090e0" : "#bbb", letterSpacing: "0.03em" }}>{overGoal >= 0 ? `+${overGoal} over` : `${-overGoal} to go`}</div>}
          </div>
          <div style={{ width: 1, background: "#e4e0d8", alignSelf: "stretch", minHeight: 40 }} />
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 8.5, color: "#bbb", letterSpacing: "0.08em", textTransform: "uppercase" }}>Bonus days off</div>
            <div style={{ fontFamily: "'Syne', sans-serif", fontSize: 34, fontWeight: 800, lineHeight: 1, color: bonusDays.length >= 4 ? "#2baa65" : bonusDays.length >= 2 ? "#5ecb8a" : bonusDays.length === 1 ? "#9adcb8" : "#ddd" }}>+{bonusDays.length}</div>
            {bonusDays.length > 0 && <div style={{ fontSize: 8.5, color: "#4ec486", letterSpacing: "0.03em" }}>{bonusDays.map(d => `${DAY_NAMES[d.dow].slice(0,3)} ${d.day}`).join(" · ")}</div>}
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
        {weeks.map((week, wi) => {
          const segments = buildWeekSegments(week, dayCustomTypes, year, month);
          return (
            <div key={wi} style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2, marginBottom: 2 }}>
              {segments.map((seg, si) => {
                if (seg.kind === "blank") return <div key={`b${si}`} />;
                if (seg.kind === "merged") {
                  const isHol = seg.typeId === "__holiday__";
                  const ct = isHol ? null : customTypes.find(t => t.id === seg.typeId);
                  return (
                    <MergedCell key={`m${seg.cells[0].day}`}
                      days={seg.cells} typeId={seg.typeId}
                      typeLabel={isHol ? "Holiday" : (ct?.name ?? "")}
                      typeColor={isHol ? "#e08030" : (ct?.color ?? "#888")}
                      creditPerDay={isHol ? HOLIDAY_REDUCTION : (ct?.credit ?? 0)}
                      span={seg.span}
                      onRemoveAll={() => handleRemoveMerged(seg.cells, seg.typeId)}
                    />
                  );
                }
                return (
                  <DayCell key={seg.cell.day} d={seg.cell} year={year} month={month}
                    onSave={handleSave} onReset={handleReset} onToggleHoliday={handleToggleHoliday}
                    customTypes={customTypes}
                    onSetCustomType={(id) => handleSetCustomType(dayKey(year, month, seg.cell.day), id)}
                    onCreateCustomType={handleCreateCustomType}
                  />
                );
              })}
            </div>
          );
        })}
      </div>

      {/* Legend */}
      <div style={{ background: "#fff", borderRadius: 8, padding: "10px 12px", border: "1px solid #eae8e0", display: "flex", gap: 10, flexWrap: "wrap" }}>
        {[
          { bg: "#f0f3fd", border: "#bec9f0", label: "Volunteering" },
          { bg: "#eaf7f0", border: "#4ec486", label: "Hits goal" },
          { bg: "#f2fbf5", border: "#bbe0cc", label: "Bonus day off" },
          { bg: "#fafaf7", border: "#eae8e0", label: "Day off" },
          { bg: "#fff8f0", border: "#f5c48a", label: "Holiday (−4h goal)" },
        ].map(({ bg, border, label }) => (
          <div key={label} style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <div style={{ width: 11, height: 11, background: bg, border: `1.5px solid ${border}`, borderRadius: 2, flexShrink: 0 }} />
            <span style={{ fontSize: 8.5, color: "#666" }}>{label}</span>
          </div>
        ))}
        {customTypes.map(ct => (
          <div key={ct.id} style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <div style={{ width: 11, height: 11, background: ct.color + "18", border: `1.5px solid ${ct.color}`, borderRadius: 2, flexShrink: 0 }} />
            <span style={{ fontSize: 8.5, color: "#666" }}>{ct.name} (−{ct.credit}h goal)</span>
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
