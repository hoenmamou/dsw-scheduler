"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";

const LS_KEY = "dsw_scheduler_mvp_v51";

/* ------------------ helpers ------------------ */
function uid(prefix = "id") {
  return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
}
function pad2(n) { return String(n).padStart(2, "0"); }
function toISODate(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function parseISODate(iso) {
  const [y, m, d] = String(iso || "").split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}
function addDaysISO(dateISO, days) {
  const d = parseISODate(dateISO) || new Date();
  const nd = new Date(d);
  nd.setDate(d.getDate() + days);
  return toISODate(nd);
}
function startOfWeekISO(dateISO, weekStartsOn = 1) {
  const d = parseISODate(dateISO) || new Date();
  const day = d.getDay();
  const diff = (day - weekStartsOn + 7) % 7;
  const start = new Date(d);
  start.setDate(d.getDate() - diff);
  return toISODate(start);
}
function parseTimeToMinutes(t) {
  if (!t || typeof t !== "string" || !t.includes(":")) return NaN;
  const [hh, mm] = t.split(":").map(Number);
  if (Number.isNaN(hh) || Number.isNaN(mm)) return NaN;
  return hh * 60 + mm;
}
function minutesToTime(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${pad2(h)}:${pad2(m)}`;
}
function minutesToHours(mins) { return mins / 60; }
function fmtHours(h) { return `${Math.round(h * 10) / 10}`; }
function dtFrom(dateISO, timeHHMM) {
  const d = parseISODate(dateISO);
  if (!d) return null;
  const mins = parseTimeToMinutes(timeHHMM);
  if (Number.isNaN(mins)) return null;
  const out = new Date(d);
  out.setHours(Math.floor(mins / 60), mins % 60, 0, 0);
  return out;
}
function overlapsDT(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}
function sliceShiftByDay(startDT, endDT) {
  const slices = [];
  const cur = new Date(startDT);
  cur.setSeconds(0, 0);

  while (cur < endDT) {
    const dayStart = new Date(cur);
    dayStart.setHours(0, 0, 0, 0);

    const nextDayStart = new Date(dayStart);
    nextDayStart.setDate(dayStart.getDate() + 1);

    const sliceStart = cur;
    const sliceEnd = endDT < nextDayStart ? endDT : nextDayStart;

    const dateISO = toISODate(dayStart);
    const startMin = sliceStart.getHours() * 60 + sliceStart.getMinutes();
    const endMin = sliceEnd.getHours() * 60 + sliceEnd.getMinutes();

    slices.push([dateISO, startMin, endMin]);
    cur.setTime(sliceEnd.getTime());
  }
  return slices;
}
function computeGaps(windowStart, windowEnd, intervals) {
  if (Number.isNaN(windowStart) || Number.isNaN(windowEnd) || windowEnd <= windowStart) return [];
  const clipped = intervals
    .map(([s, e]) => [Math.max(windowStart, s), Math.min(windowEnd, e)])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);

  if (!clipped.length) return [[windowStart, windowEnd]];

  const merged = [];
  for (const [s, e] of clipped) {
    if (!merged.length) merged.push([s, e]);
    else {
      const last = merged[merged.length - 1];
      if (s <= last[1]) last[1] = Math.max(last[1], e);
      else merged.push([s, e]);
    }
  }

  const gaps = [];
  let cur = windowStart;
  for (const [s, e] of merged) {
    if (s > cur) gaps.push([cur, s]);
    cur = Math.max(cur, e);
  }
  if (cur < windowEnd) gaps.push([cur, windowEnd]);
  return gaps;
}
async function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ""));
    r.onerror = reject;
    r.readAsText(file);
  });
}
function downloadJSON(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* ------------------ defaults ------------------ */
const DEFAULT_STATE = {
  settings: {
    weekStartsOn: 1,
    overtimeThresholdHours: 40,
    blockOvertime: true,
    requireLogin: true,
  },
  users: [], // {id, username, pin, role, displayName}
  staff: [],
  clients: [], // {id,name,coverageStart,coverageEnd}
  shifts: [],  // {id,startDate,startTime,endDate,endTime,staffId,clientId,notes,createdBy}
};

function ensureDefaultAdmins(state) {
  if (Array.isArray(state.users) && state.users.length > 0) return state;

  // FIXED IDs (no randomness) to avoid hydration issues
  const users = [
    { id: "u_admin1", username: "admin1", pin: "1234", role: "admin", displayName: "Admin 1" },
    { id: "u_admin2", username: "admin2", pin: "2345", role: "admin", displayName: "Admin 2" },
    { id: "u_admin3", username: "admin3", pin: "3456", role: "admin", displayName: "Admin 3" },
  ];
  return { ...state, users };
}

/* ------------------ styles ------------------ */
const styles = {
  page: { minHeight: "100vh", background: "#0b0c10", color: "#e8e8e8", padding: 16 },
  wrap: { maxWidth: 1200, margin: "0 auto", display: "flex", flexDirection: "column", gap: 12 },
  header: { display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 12, flexWrap: "wrap" },
  h1: { margin: 0, fontSize: 28, fontWeight: 900 },
  sub: { margin: "6px 0 0", fontSize: 13, opacity: 0.85, maxWidth: 900 },
  row: { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" },
  card: { background: "#12141a", border: "1px solid rgba(255,255,255,0.10)", borderRadius: 16, padding: 12 },
  btn: { background: "#1f6feb", border: "1px solid rgba(255,255,255,0.18)", color: "white", padding: "8px 10px", borderRadius: 10, cursor: "pointer", fontWeight: 900, fontSize: 13 },
  btn2: { background: "transparent", border: "1px solid rgba(255,255,255,0.18)", color: "#e8e8e8", padding: "8px 10px", borderRadius: 10, cursor: "pointer", fontWeight: 900, fontSize: 13 },
  btnDanger: { background: "#e11d48", border: "1px solid rgba(255,255,255,0.18)", color: "white", padding: "8px 10px", borderRadius: 10, cursor: "pointer", fontWeight: 950, fontSize: 13 },
  input: { background: "#0f1117", color: "#e8e8e8", border: "1px solid rgba(255,255,255,0.14)", borderRadius: 10, padding: "8px 10px", outline: "none", fontSize: 13 },
  select: { background: "#0f1117", color: "#e8e8e8", border: "1px solid rgba(255,255,255,0.14)", borderRadius: 10, padding: "8px 10px", outline: "none", fontSize: 13 },
  label: { fontSize: 12, opacity: 0.8, marginBottom: 6 },
  badge: (kind) => ({
    display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 10px", borderRadius: 999, fontSize: 12,
    border: "1px solid rgba(255,255,255,0.16)",
    background: kind === "ot" ? "rgba(225,29,72,0.20)" : kind === "near" ? "rgba(245,158,11,0.20)" : "rgba(34,197,94,0.15)",
  }),
  grid7: { display: "grid", gridTemplateColumns: "repeat(7, minmax(160px, 1fr))", gap: 10, overflowX: "auto", paddingBottom: 4 },
  dayHead: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 },
  tiny: { fontSize: 12, opacity: 0.8 },
  shift: { border: "1px solid rgba(255,255,255,0.12)", borderRadius: 14, padding: 10, background: "rgba(255,255,255,0.03)" },
  shiftTop: { display: "flex", justifyContent: "space-between", gap: 8, alignItems: "flex-start" },
  shiftTitle: { fontWeight: 950, fontSize: 13, marginBottom: 4 },
  shiftMeta: { fontSize: 12, opacity: 0.86, lineHeight: 1.35 },
  hr: { height: 1, background: "rgba(255,255,255,0.10)", margin: "10px 0" },
  modalOverlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 },
  modal: { width: "min(860px, 100%)", background: "#12141a", borderRadius: 16, border: "1px solid rgba(255,255,255,0.12)", padding: 14 },
  modalTitle: { fontSize: 18, fontWeight: 980, margin: 0 },
  twoCol: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 },
  fourCol: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 10 },
  warn: { color: "#f59e0b", fontSize: 13, marginTop: 6 },
  err: { color: "#fb7185", fontSize: 13, marginTop: 6 },
};

if (!Array.isArray(tabs)) return null;
if (tabs.some((x) => typeof x === "object" && x && !("label" in x))) {
  console.log("BAD tabs:", tabs);
}return (
    <div className="no-print" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {tabs.map((t) => (
        <button
          key={t.value}
          onClick={() => onChange(t.value)}
          style={{
            ...styles.btn2,
            background: value === t.value ? "rgba(31,111,235,0.18)" : "transparent",
            borderColor: value === t.value ? "rgba(31,111,235,0.55)" : "rgba(255,255,255,0.18)",
          }}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/* ------------------ Page (only login decisions here) ------------------ */
export default function Page() {
  const [mounted, setMounted] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  const [state, setState] = useState(() => ensureDefaultAdmins(DEFAULT_STATE));
  const [sessionUserId, setSessionUserId] = useState(null);

  // Mount gate
  useEffect(() => {
    setMounted(true);
  }, []);

  // Load from storage AFTER mount
  useEffect(() => {
    if (!mounted) return;

    // session user
    try {
      setSessionUserId(sessionStorage.getItem("dsw_user_id"));
    } catch {}

    // app state
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);

        const clients = Array.isArray(parsed.clients) ? parsed.clients : [];
        const shifts = Array.isArray(parsed.shifts) ? parsed.shifts : [];

        const next = ensureDefaultAdmins({
          settings: { ...DEFAULT_STATE.settings, ...(parsed.settings || {}) },
          users: Array.isArray(parsed.users) ? parsed.users : [],
          staff: Array.isArray(parsed.staff) ? parsed.staff : [],
          clients: clients.map((c) => ({ coverageStart: "08:00", coverageEnd: "16:00", ...c })),
          shifts: shifts.map((sh) => ({ ...sh, createdBy: sh.createdBy || "unknown" })),
        });

        setState(next);
      }
    } catch {
      // ignore parse errors; keep defaults
    } finally {
      setHydrated(true);
    }
  }, [mounted]);

  // Save to storage ONLY after hydration
  useEffect(() => {
    if (!mounted || !hydrated) return;
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(state));
    } catch {}
  }, [state, mounted, hydrated]);

  const currentUser = useMemo(
    () => state.users.find((u) => u.id === sessionUserId) || null,
    [state.users, sessionUserId]
  );

  function loginAs(userId) {
    try {
      sessionStorage.setItem("dsw_user_id", userId);
    } catch {}
    setSessionUserId(userId);
  }

  function logout() {
    try {
      sessionStorage.removeItem("dsw_user_id");
    } catch {}
    setSessionUserId(null);
  }

  // If you want a visible loading screen:
  if (!mounted || !hydrated) return null;

  if (state.settings.requireLogin && !currentUser) {
    return <LoginScreen users={state.users} onLogin={loginAs} />;
  }

  return (
    <SchedulerApp
      state={state}
      setState={setState}
      currentUser={currentUser || state.users[0]}
      onLogout={logout}
    />
  );
}
/* ------------------ Login Screen (separate component) ------------------ */
function LoginScreen({ users, onLogin }) {
  const [username, setUsername] = useState(users[0]?.username || "admin1");
  const [pin, setPin] = useState("");

  function submit() {
    const u = users.find((x) => x.username === username);
    if (!u) return alert("User not found.");
    if (String(pin) !== String(u.pin)) return alert("Incorrect PIN.");
    onLogin(u.id);
  }

  return (
    <div style={styles.page}>
      <div style={{ ...styles.wrap, maxWidth: 520 }}>
        <div style={styles.card}>
          <h1 style={styles.h1}>DSW Scheduler</h1>
          <p style={styles.sub}>Login required. Choose your account and enter your PIN.</p>

          <div style={{ height: 12 }} />

          <div style={styles.label}>Account</div>
          <select style={{ ...styles.select, width: "100%" }} value={username} onChange={(e) => setUsername(e.target.value)}>
            {users.map((u) => (
              <option key={u.id} value={u.username}>
                {u.displayName || u.username} ({u.role})
              </option>
            ))}
          </select>

          <div style={{ height: 10 }} />

          <div style={styles.label}>PIN</div>
          <input
            style={{ ...styles.input, width: "100%" }}
            type="password"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
            placeholder="Enter PIN"
          />

          <div style={{ height: 12 }} />
          <button style={styles.btn} onClick={submit}>Login</button>

          <div style={{ marginTop: 12, fontSize: 12, opacity: 0.85 }}>
            Default admins (change ASAP): admin1/1234, admin2/2345, admin3/3456.
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------ Main Scheduler App (all hooks live here) ------------------ */
function SchedulerApp({ state, setState, currentUser, onLogout }) {
  const isAdmin = currentUser?.role === "admin";

  const [tab, setTab] = useState("schedule");
  const [weekAnchorISO, setWeekAnchorISO] = useState(() => toISODate(new Date()));
  const weekStartISO = useMemo(() => startOfWeekISO(weekAnchorISO, state.settings.weekStartsOn), [weekAnchorISO, state.settings.weekStartsOn]);
  const weekDays = useMemo(() => Array.from({ length: 7 }, (_, i) => addDaysISO(weekStartISO, i)), [weekStartISO]);

  const staffById = useMemo(() => new Map(state.staff.map((s) => [s.id, s])), [state.staff]);
  const clientById = useMemo(() => new Map(state.clients.map((c) => [c.id, c])), [state.clients]);

  const weekRange = useMemo(() => {
    const start = dtFrom(weekStartISO, "00:00");
    const end = dtFrom(addDaysISO(weekStartISO, 7), "00:00");
    return { start, end };
  }, [weekStartISO]);

  const weekShifts = useMemo(() => {
    if (!weekRange.start || !weekRange.end) return [];
    return state.shifts.filter((sh) => {
      const sdt = dtFrom(sh.startDate, sh.startTime);
      const edt = dtFrom(sh.endDate, sh.endTime);
      if (!sdt || !edt || edt <= sdt) return false;
      return overlapsDT(sdt, edt, weekRange.start, weekRange.end);
    });
  }, [state.shifts, weekRange]);

  const weekShiftsMine = useMemo(() => weekShifts.filter((sh) => sh.createdBy === currentUser.id), [weekShifts, currentUser.id]);

  function computeStaffWeekHours(shifts) {
    const mapMins = new Map();
    for (const s of state.staff) mapMins.set(s.id, 0);

    for (const sh of shifts) {
      const sdt = dtFrom(sh.startDate, sh.startTime);
      const edt = dtFrom(sh.endDate, sh.endTime);
      if (!sdt || !edt || edt <= sdt) continue;

      const clipStart = new Date(Math.max(sdt.getTime(), weekRange.start.getTime()));
      const clipEnd = new Date(Math.min(edt.getTime(), weekRange.end.getTime()));
      if (clipEnd <= clipStart) continue;

      const mins = Math.round((clipEnd.getTime() - clipStart.getTime()) / 60000);
      mapMins.set(sh.staffId, (mapMins.get(sh.staffId) || 0) + mins);
    }

    const out = new Map();
    for (const [k, mins] of mapMins.entries()) out.set(k, minutesToHours(mins));
    return out;
  }

  const staffWeekHoursAll = useMemo(() => computeStaffWeekHours(weekShifts), [weekShifts]); // eslint-disable-line react-hooks/exhaustive-deps
  const staffWeekHoursMine = useMemo(() => computeStaffWeekHours(weekShiftsMine), [weekShiftsMine]); // eslint-disable-line react-hooks/exhaustive-deps

  const myTotalOvertimeHours = useMemo(() => {
    const threshold = state.settings.overtimeThresholdHours;
    let total = 0;
    for (const s of state.staff) {
      const h = staffWeekHoursMine.get(s.id) || 0;
      total += Math.max(0, h - threshold);
    }
    return total;
  }, [staffWeekHoursMine, state.staff, state.settings.overtimeThresholdHours]);

  const shiftsByDay = useMemo(() => {
    const map = new Map();
    for (const d of weekDays) map.set(d, []);
    for (const sh of weekShifts) {
      const sdt = dtFrom(sh.startDate, sh.startTime);
      const edt = dtFrom(sh.endDate, sh.endTime);
      if (!sdt || !edt || edt <= sdt) continue;
      const slices = sliceShiftByDay(sdt, edt);
      for (const [dateISO, startMin, endMin] of slices) {
        if (!map.has(dateISO)) continue;
        map.get(dateISO).push({ ...sh, _sliceStartMin: startMin, _sliceEndMin: endMin });
      }
    }
    for (const [d, arr] of map.entries()) {
      arr.sort((a, b) => (a._sliceStartMin ?? 0) - (b._sliceStartMin ?? 0));
      map.set(d, arr);
    }
    return map;
  }, [weekDays, weekShifts]);

  const coverageGaps = useMemo(() => {
    const results = [];
    for (const c of state.clients) {
      const ws = parseTimeToMinutes(c.coverageStart || "08:00");
      const we = parseTimeToMinutes(c.coverageEnd || "16:00");
      if (Number.isNaN(ws) || Number.isNaN(we) || we <= ws) continue;

      for (const dateISO of weekDays) {
        const dayArr = shiftsByDay.get(dateISO) || [];
        const daySlices = dayArr
          .filter((sh) => sh.clientId === c.id)
          .map((sh) => [sh._sliceStartMin, sh._sliceEndMin]);

        const gaps = computeGaps(ws, we, daySlices);
        if (gaps.length) results.push({ clientId: c.id, dateISO, gaps });
      }
    }
    return results;
  }, [state.clients, weekDays, shiftsByDay]);

  const weekSummaryAll = useMemo(() => {
    const threshold = state.settings.overtimeThresholdHours;
    return state.staff
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((s) => {
        const h = staffWeekHoursAll.get(s.id) || 0;
        return { staff: s, hours: h, status: h >= threshold ? "ot" : h >= threshold - 4 ? "near" : "ok" };
      });
  }, [state.staff, staffWeekHoursAll, state.settings.overtimeThresholdHours]);

  /* -------- Shift modal + auto end-date behavior -------- */
  const [modalOpen, setModalOpen] = useState(false);
  const [editingShiftId, setEditingShiftId] = useState(null);
  const [endDateTouched, setEndDateTouched] = useState(false);

  const defaultShiftForm = useMemo(() => ({
    startDate: weekStartISO,
    startTime: "08:00",
    endDate: weekStartISO,
    endTime: "16:00",
    staffId: state.staff[0]?.id || "",
    clientId: state.clients[0]?.id || "",
    notes: "",
  }), [weekStartISO, state.staff, state.clients]);

  const [shiftForm, setShiftForm] = useState(defaultShiftForm);

  function openNewShift(dateISO) {
    setEditingShiftId(null);
    setEndDateTouched(false);
    setShiftForm({ ...defaultShiftForm, startDate: dateISO, endDate: dateISO });
    setModalOpen(true);
  }
  function openEditShift(id) {
    const sh = state.shifts.find((x) => x.id === id);
    if (!sh) return;
    setEditingShiftId(id);
    setEndDateTouched(true);
    setShiftForm({
      startDate: sh.startDate,
      startTime: sh.startTime,
      endDate: sh.endDate,
      endTime: sh.endTime,
      staffId: sh.staffId,
      clientId: sh.clientId,
      notes: sh.notes || "",
    });
    setModalOpen(true);
  }
  function deleteShift(id) {
    if (!confirm("Delete this shift?")) return;
    setState((p) => ({ ...p, shifts: p.shifts.filter((x) => x.id !== id) }));
  }

  // ✅ Auto end date logic
  useEffect(() => {
    if (endDateTouched) return;

    const sMin = parseTimeToMinutes(shiftForm.startTime);
    const eMin = parseTimeToMinutes(shiftForm.endTime);
    if (Number.isNaN(sMin) || Number.isNaN(eMin)) return;

    let desired = shiftForm.startDate;
    if (eMin < sMin) desired = addDaysISO(shiftForm.startDate, 1);

    if (desired !== shiftForm.endDate) {
      setShiftForm((p) => ({ ...p, endDate: desired }));
    }
  }, [shiftForm.startDate, shiftForm.startTime, shiftForm.endTime, shiftForm.endDate, endDateTouched]);

  const shiftValidation = useMemo(() => {
    const issues = [];
    const warnings = [];
    const { startDate, startTime, endDate, endTime, staffId, clientId } = shiftForm;

    if (!startDate) issues.push("Start date is required.");
    if (!endDate) issues.push("End date is required.");
    if (!staffId) issues.push("Staff is required.");
    if (!clientId) issues.push("Client is required.");

    const sdt = dtFrom(startDate, startTime);
    const edt = dtFrom(endDate, endTime);
    if (!sdt || !edt) issues.push("Start/End date & time must be valid.");
    else if (edt <= sdt) issues.push("End must be after Start.");

    // ✅ Conflict check against ALL shifts (so supervisors can't double-book staff)
    if (!issues.length && staffId && sdt && edt) {
      const others = state.shifts.filter((sh) => sh.staffId === staffId && sh.id !== editingShiftId);
      for (const sh of others) {
        const s2 = dtFrom(sh.startDate, sh.startTime);
        const e2 = dtFrom(sh.endDate, sh.endTime);
        if (!s2 || !e2 || e2 <= s2) continue;
        if (overlapsDT(sdt, edt, s2, e2)) {
          issues.push("This shift overlaps another shift for the same staff (already scheduled by someone).");
          break;
        }
      }
    }

    // OT guard (selected week, ALL shifts)
    if (!issues.length && staffId && sdt && edt && weekRange.start && weekRange.end) {
      const currentMins = weekShifts
        .filter((sh) => sh.staffId === staffId && sh.id !== editingShiftId)
        .reduce((acc, sh) => {
          const a = dtFrom(sh.startDate, sh.startTime);
          const b = dtFrom(sh.endDate, sh.endTime);
          if (!a || !b || b <= a) return acc;
          const clipStart = new Date(Math.max(a.getTime(), weekRange.start.getTime()));
          const clipEnd = new Date(Math.min(b.getTime(), weekRange.end.getTime()));
          if (clipEnd <= clipStart) return acc;
          return acc + Math.round((clipEnd.getTime() - clipStart.getTime()) / 60000);
        }, 0);

      const clipStart = new Date(Math.max(sdt.getTime(), weekRange.start.getTime()));
      const clipEnd = new Date(Math.min(edt.getTime(), weekRange.end.getTime()));
      const thisMins = clipEnd > clipStart ? Math.round((clipEnd.getTime() - clipStart.getTime()) / 60000) : 0;

      const newTotalHrs = minutesToHours(currentMins + thisMins);
      const threshold = state.settings.overtimeThresholdHours;

      if (newTotalHrs > threshold) {
        const msg = `This would put the staff at ${fmtHours(newTotalHrs)} hrs for the selected week (>${threshold}).`;
        if (state.settings.blockOvertime) issues.push(msg);
        else warnings.push(msg);
      }
    }

    return { issues, warnings };
  }, [shiftForm, state.shifts, editingShiftId, weekRange, weekShifts, state.settings]);

  function saveShift() {
    if (shiftValidation.issues.length) return;

    const existing = editingShiftId ? state.shifts.find((x) => x.id === editingShiftId) : null;

    const payload = {
      id: editingShiftId || uid("shift"),
      startDate: shiftForm.startDate,
      startTime: shiftForm.startTime,
      endDate: shiftForm.endDate,
      endTime: shiftForm.endTime,
      staffId: shiftForm.staffId,
      clientId: shiftForm.clientId,
      notes: shiftForm.notes || "",
      createdBy: existing?.createdBy || currentUser.id,
    };

    setState((p) => ({
      ...p,
      shifts: editingShiftId ? p.shifts.map((x) => (x.id === editingShiftId ? payload : x)) : [payload, ...p.shifts],
    }));

    setModalOpen(false);
    setEditingShiftId(null);
  }

  /* -------- Staff/Clients CRUD -------- */
  const [staffName, setStaffName] = useState("");
  const [clientName, setClientName] = useState("");
  const [clientCoverageStart, setClientCoverageStart] = useState("08:00");
  const [clientCoverageEnd, setClientCoverageEnd] = useState("16:00");

  function addStaff() {
    const name = staffName.trim();
    if (!name) return;
    setState((p) => ({ ...p, staff: [{ id: uid("staff"), name }, ...p.staff] }));
    setStaffName("");
  }
  function addClient() {
    const name = clientName.trim();
    if (!name) return;
    setState((p) => ({
      ...p,
      clients: [{ id: uid("client"), name, coverageStart: clientCoverageStart, coverageEnd: clientCoverageEnd }, ...p.clients],
    }));
    setClientName("");
  }
  function updateClientCoverage(id, coverageStart, coverageEnd) {
    setState((p) => ({ ...p, clients: p.clients.map((c) => (c.id === id ? { ...c, coverageStart, coverageEnd } : c)) }));
  }
  function deleteStaff(id) {
    if (!confirm("Delete this staff? This will remove their shifts too.")) return;
    setState((p) => ({ ...p, staff: p.staff.filter((s) => s.id !== id), shifts: p.shifts.filter((sh) => sh.staffId !== id) }));
  }
  function deleteClient(id) {
    if (!confirm("Delete this client? This will remove related shifts too.")) return;
    setState((p) => ({ ...p, clients: p.clients.filter((c) => c.id !== id), shifts: p.shifts.filter((sh) => sh.clientId !== id) }));
  }

  /* -------- Users admin -------- */
  const [newUserUsername, setNewUserUsername] = useState("");
  const [newUserDisplayName, setNewUserDisplayName] = useState("");
  const [newUserPin, setNewUserPin] = useState("");
  const [newUserRole, setNewUserRole] = useState("supervisor");

  function addUser() {
    if (!isAdmin) return;
    const username = newUserUsername.trim();
    const displayName = newUserDisplayName.trim();
    const pin = String(newUserPin || "").trim();
    if (!username) return alert("Username is required.");
    if (!pin) return alert("PIN is required.");
    if (state.users.some((u) => u.username === username)) return alert("That username already exists.");

    const u = { id: uid("user"), username, pin, role: newUserRole, displayName: displayName || username };
    setState((p) => ({ ...p, users: [u, ...p.users] }));

    setNewUserUsername("");
    setNewUserDisplayName("");
    setNewUserPin("");
    setNewUserRole("supervisor");
  }
  function updateUser(id, patch) {
    if (!isAdmin) return;
    setState((p) => ({ ...p, users: p.users.map((u) => (u.id === id ? { ...u, ...patch } : u)) }));
  }
  function deleteUser(id) {
    if (!isAdmin) return;
    if (id === currentUser.id) return alert("You can’t delete the account you’re logged in with.");
    if (!confirm("Delete this user?")) return;
    setState((p) => ({ ...p, users: p.users.filter((u) => u.id !== id) }));
  }

  /* -------- Import/Export/Print -------- */
  const fileInputRef = useRef(null);

  async function importJSON(file) {
    try {
      const text = await readFileAsText(file);
      const parsed = JSON.parse(text);
      const clients = Array.isArray(parsed.clients) ? parsed.clients : [];
      const shifts = Array.isArray(parsed.shifts) ? parsed.shifts : [];
      const next = ensureDefaultAdmins({
        settings: { ...DEFAULT_STATE.settings, ...(parsed.settings || {}) },
        users: Array.isArray(parsed.users) ? parsed.users : [],
        staff: Array.isArray(parsed.staff) ? parsed.staff : [],
        clients: clients.map((c) => ({ coverageStart: "08:00", coverageEnd: "16:00", ...c })),
        shifts: shifts.map((sh) => ({ ...sh, createdBy: sh.createdBy || "unknown" })),
      });
      setState(next);
      alert("Import complete.");
    } catch {
      alert("Import failed. Please select a valid exported JSON file.");
    }
  }

  function resetAll() {
    if (!confirm("Reset all data? This cannot be undone.")) return;
    sessionStorage.removeItem("dsw_user_id");
    localStorage.removeItem(LS_KEY);
    location.reload();
  }

  function printWeek() { window.print(); }

  const printCss = `
    @media print {
      body { background: white !important; }
      .no-print { display: none !important; }
      .print-card { border: 1px solid #ddd !important; background: white !important; color: #111 !important; }
      .print-text { color: #111 !important; }
      .print-grid7 { grid-template-columns: repeat(2, 1fr) !important; }
      .print-shift { border: 1px solid #e5e5e5 !important; background: #fff !important; }
    }
  `;

  function weekDayLabel(iso) {
    const d = parseISODate(iso);
    return d ? d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }) : iso;
  }

  return (
    <div style={styles.page}>
      <style>{printCss}</style>

      <div style={styles.wrap}>
        <div style={styles.header} className="no-print">
          <div>
            <h1 style={styles.h1}>DSW Scheduler</h1>
            <p style={styles.sub}>
              Logged in as <b>{currentUser.displayName || currentUser.username}</b> ({currentUser.role}).{" "}
              Your supervisor OT total (selected week): <b>{fmtHours(myTotalOvertimeHours)}</b> hours (based on shifts you created).
            </p>
          </div>
          <div style={styles.row}>
            <button style={styles.btn2} onClick={printWeek}>Print / PDF</button>
            <button style={styles.btn2} onClick={() => downloadJSON(`dsw-scheduler_${weekStartISO}.json`, state)}>Export</button>
            <button style={styles.btn2} onClick={() => fileInputRef.current?.click()}>Import</button>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json"
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) importJSON(f);
                e.target.value = "";
              }}
            />
            <button style={styles.btn2} onClick={onLogout}>Logout</button>
            <button style={styles.btnDanger} onClick={resetAll}>Reset</button>
          </div>
        </div>

        <div style={styles.card} className="print-card">
          <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr 1fr", gap: 12 }}>
            <div className="print-text">
              <div style={styles.label}>Week</div>
              <div className="no-print" style={styles.row}>
                <input style={styles.input} type="date" value={weekAnchorISO} onChange={(e) => setWeekAnchorISO(e.target.value)} />
                <button style={styles.btn2} onClick={() => setWeekAnchorISO(toISODate(new Date()))}>Today</button>
                <button style={styles.btn2} onClick={() => setWeekAnchorISO(addDaysISO(weekAnchorISO, -7))}>Prev</button>
                <button style={styles.btn2} onClick={() => setWeekAnchorISO(addDaysISO(weekAnchorISO, 7))}>Next</button>
              </div>
              <div style={{ fontSize: 12, opacity: 0.85 }}>Week starting: <b>{weekStartISO}</b></div>
              <div className="no-print" style={{ marginTop: 8, fontSize: 12, opacity: 0.85 }}>
                Week starts:{" "}
                <select
                  style={styles.select}
                  value={String(state.settings.weekStartsOn)}
                  onChange={(e) => setState((p) => ({ ...p, settings: { ...p.settings, weekStartsOn: Number(e.target.value) } }))}
                >
                  <option value="1">Monday</option>
                  <option value="0">Sunday</option>
                </select>
              </div>
            </div>

            <div className="print-text">
              <div style={styles.label}>Overtime rules</div>
              <div className="no-print" style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={state.settings.blockOvertime}
                    onChange={(e) => setState((p) => ({ ...p, settings: { ...p.settings, blockOvertime: e.target.checked } }))}
                  />
                  Block shifts over threshold
                </label>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 12, opacity: 0.85 }}>OT threshold</span>
                  <input
                    style={{ ...styles.input, width: 90 }}
                    type="number"
                    min={1}
                    step={0.5}
                    value={state.settings.overtimeThresholdHours}
                    onChange={(e) =>
                      setState((p) => ({
                        ...p,
                        settings: { ...p.settings, overtimeThresholdHours: Math.max(1, Math.min(120, Number(e.target.value || 40))) },
                      }))
                    }
                  />
                </div>
              </div>
            </div>

            <div className="print-text">
              <div style={styles.label}>Stats</div>
              <div style={styles.row}>
                <span style={styles.badge("ok")}>Staff: {state.staff.length}</span>
                <span style={styles.badge("ok")}>Clients: {state.clients.length}</span>
                <span style={styles.badge(weekSummaryAll.some((x) => x.status === "ot") ? "ot" : "ok")}>
                  OT: {weekSummaryAll.filter((x) => x.status === "ot").length}
                </span>
                <span style={styles.badge(coverageGaps.length ? "near" : "ok")}>Gaps: {coverageGaps.length}</span>
                <span style={styles.badge(myTotalOvertimeHours > 0 ? "near" : "ok")}>My OT hrs: {fmtHours(myTotalOvertimeHours)}</span>
              </div>
            </div>
          </div>
        </div>

    <Tabs
  value={tab}
  onChange={setTab}
  tabs={[
    { value: "schedule", label: "Schedule" },
    { value: "gaps", label: "Coverage Gaps" },
    { value: "hours", label: "Hours & OT" },
    ...(isAdmin
      ? [
          { value: "staff", label: "Staff" },
          { value: "clients", label: "Clients" },
          { value: "settings", label: "Settings" },
        ]
      : []),
  ]}
/>

        {/* Schedule */}
        {tab === "schedule" && (
          <div style={styles.grid7} className="print-grid7">
            {weekDays.map((dateISO) => {
              const dayShifts = shiftsByDay.get(dateISO) || [];
              return (
                <div key={dateISO} style={styles.card} className="print-card">
                  <div style={styles.dayHead}>
                    <div className="print-text">
                      <div style={{ fontWeight: 980 }}>{weekDayLabel(dateISO)}</div>
                      <div style={styles.tiny}>{dateISO}</div>
                    </div>
                    <button className="no-print" style={styles.btn2} onClick={() => openNewShift(dateISO)}>+ Shift</button>
                  </div>

                  <div style={styles.hr} />

                  {dayShifts.length === 0 ? (
                    <div className="print-text" style={{ fontSize: 12, opacity: 0.85 }}>No shifts</div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      {dayShifts.map((sh) => {
                        const s = staffById.get(sh.staffId);
                        const c = clientById.get(sh.clientId);
                        const staffHours = staffWeekHoursAll.get(sh.staffId) || 0;
                        const threshold = state.settings.overtimeThresholdHours;
                        const status = staffHours >= threshold ? "ot" : staffHours >= threshold - 4 ? "near" : "ok";
                        const sliceHours = minutesToHours((sh._sliceEndMin ?? 0) - (sh._sliceStartMin ?? 0));
                        const creator = state.users.find((u) => u.id === sh.createdBy);

                        return (
                          <div key={`${sh.id}_${dateISO}_${sh._sliceStartMin}`} style={styles.shift} className="print-shift">
                            <div style={styles.shiftTop}>
                              <div style={{ minWidth: 0 }}>
                                <div style={styles.shiftTitle} className="print-text">
                                  {minutesToTime(sh._sliceStartMin)}–{minutesToTime(sh._sliceEndMin)}{" "}
                                  <span style={{ opacity: 0.8 }}>({fmtHours(sliceHours)}h)</span>
                                </div>
                                <div style={styles.shiftMeta} className="print-text">
                                  <div><b>{s?.name || "Staff missing"}</b></div>
                                  <div>{c?.name || "Client missing"}</div>
                                  <div style={{ marginTop: 6 }}>
                                    <span style={styles.badge(status)}>
                                      {status === "ot" ? "OT" : status === "near" ? "Near OT" : "OK"} · {fmtHours(staffHours)}h week
                                    </span>
                                  </div>
                                  <div style={{ marginTop: 6, fontSize: 12, opacity: 0.8 }}>
                                    Created by: <b>{creator?.displayName || creator?.username || "Unknown"}</b>
                                  </div>
                                </div>
                              </div>

                              <div className="no-print" style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
                                <button style={styles.btn2} onClick={() => openEditShift(sh.id)}>Edit</button>
                                <button style={styles.btnDanger} onClick={() => deleteShift(sh.id)}>Delete</button>
                              </div>
                            </div>

                            {sh.notes ? (
                              <div className="print-text" style={{ marginTop: 8, fontSize: 12, opacity: 0.85, whiteSpace: "pre-wrap" }}>
                                {sh.notes}
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Coverage gaps */}
        {tab === "gaps" && (
          <div style={styles.card} className="print-card">
            <div className="print-text" style={{ fontSize: 18, fontWeight: 990 }}>Coverage Gaps</div>
            <div className="print-text" style={{ fontSize: 12, opacity: 0.85 }}>
              Uncovered blocks inside each client’s coverage window.
            </div>
            <div style={styles.hr} />
            {state.clients.length === 0 ? (
              <div className="print-text" style={{ fontSize: 13, opacity: 0.85 }}>Add clients first.</div>
            ) : coverageGaps.length === 0 ? (
              <div className="print-text" style={{ fontSize: 13, opacity: 0.85 }}>No gaps detected for this week.</div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 10 }}>
                {coverageGaps.map((row, idx) => {
                  const c = clientById.get(row.clientId);
                  return (
                    <div key={`${row.clientId}_${row.dateISO}_${idx}`} style={{ border: "1px solid rgba(255,255,255,0.12)", borderRadius: 14, padding: 12 }}>
                      <div className="print-text" style={{ fontWeight: 990 }}>{c?.name || "Client missing"}</div>
                      <div className="print-text" style={{ fontSize: 12, opacity: 0.85 }}>{weekDayLabel(row.dateISO)} · {row.dateISO}</div>
                      <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
                        {row.gaps.map(([s, e], i) => (
                          <div key={i} className="print-text" style={{ fontSize: 13 }}>
                            <span style={styles.badge("near")}>Uncovered</span> <b>{minutesToTime(s)}</b>–<b>{minutesToTime(e)}</b>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Hours */}
        {tab === "hours" && (
          <div style={styles.card} className="print-card">
            <div className="print-text" style={{ fontSize: 18, fontWeight: 990 }}>Weekly hours</div>
            <div className="print-text" style={{ fontSize: 12, opacity: 0.85 }}>Week starting {weekStartISO}</div>
            <div style={styles.hr} />
            {weekSummaryAll.length === 0 ? (
              <div className="print-text" style={{ fontSize: 13, opacity: 0.85 }}>Add staff to start tracking hours.</div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 10 }}>
                {weekSummaryAll.map(({ staff, hours, status }) => (
                  <div key={staff.id} style={{ border: "1px solid rgba(255,255,255,0.12)", borderRadius: 14, padding: 12 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                      <div className="print-text" style={{ fontWeight: 990 }}>{staff.name}</div>
                      <span style={styles.badge(status)}>{status === "ot" ? "OT" : status === "near" ? "Near OT" : "OK"}</span>
                    </div>
                    <div style={{ marginTop: 10, display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
                      <div className="print-text">
                        <div style={{ fontSize: 34, fontWeight: 995, lineHeight: 1 }}>{fmtHours(hours)}</div>
                        <div style={{ fontSize: 12, opacity: 0.85 }}>hours this week</div>
                      </div>
                      <div className="print-text" style={{ fontSize: 12, opacity: 0.85 }}>
                        OT hours: {fmtHours(Math.max(0, hours - state.settings.overtimeThresholdHours))}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div style={{ marginTop: 12, fontSize: 13, opacity: 0.9 }} className="print-text">
              <b>Your OT total (shifts you created):</b> {fmtHours(myTotalOvertimeHours)} hours.
            </div>
          </div>
        )}

        {/* Staff */}
        {tab === "staff" && (
          <div className="no-print" style={{ display: "grid", gridTemplateColumns: "1fr 1.4fr", gap: 12 }}>
            <div style={styles.card}>
              <div style={{ fontSize: 16, fontWeight: 990, marginBottom: 8 }}>Add staff</div>
              <div style={styles.label}>Name</div>
              <input style={{ ...styles.input, width: "100%" }} value={staffName} onChange={(e) => setStaffName(e.target.value)} />
              <div style={{ marginTop: 10 }}>
                <button style={styles.btn} onClick={addStaff}>Add Staff</button>
              </div>
            </div>
            <div style={styles.card}>
              <div style={{ fontSize: 16, fontWeight: 990, marginBottom: 8 }}>Staff list</div>
              {state.staff.length === 0 ? (
                <div style={{ fontSize: 13, opacity: 0.85 }}>No staff yet.</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {state.staff.slice().sort((a, b) => a.name.localeCompare(b.name)).map((s) => (
                    <div key={s.id} style={{ border: "1px solid rgba(255,255,255,0.12)", borderRadius: 14, padding: 10 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
                        <div style={{ fontWeight: 990 }}>{s.name}</div>
                        <button style={styles.btnDanger} onClick={() => deleteStaff(s.id)}>Delete</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Clients */}
        {tab === "clients" && (
          <div className="no-print" style={{ display: "grid", gridTemplateColumns: "1fr 1.4fr", gap: 12 }}>
            <div style={styles.card}>
              <div style={{ fontSize: 16, fontWeight: 990, marginBottom: 8 }}>Add client</div>
              <div style={styles.label}>Name</div>
              <input style={{ ...styles.input, width: "100%" }} value={clientName} onChange={(e) => setClientName(e.target.value)} />
              <div style={{ height: 10 }} />
              <div style={styles.label}>Coverage window (used for gap detection)</div>
              <div style={styles.row}>
                <div>
                  <div style={styles.label}>Start</div>
                  <input style={styles.input} type="time" value={clientCoverageStart} onChange={(e) => setClientCoverageStart(e.target.value)} />
                </div>
                <div>
                  <div style={styles.label}>End</div>
                  <input style={styles.input} type="time" value={clientCoverageEnd} onChange={(e) => setClientCoverageEnd(e.target.value)} />
                </div>
              </div>
              <div style={{ marginTop: 10 }}>
                <button style={styles.btn} onClick={addClient}>Add Client</button>
              </div>
            </div>
            <div style={styles.card}>
              <div style={{ fontSize: 16, fontWeight: 990, marginBottom: 8 }}>Client list</div>
              {state.clients.length === 0 ? (
                <div style={{ fontSize: 13, opacity: 0.85 }}>No clients yet.</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {state.clients.slice().sort((a, b) => a.name.localeCompare(b.name)).map((c) => (
                    <div key={c.id} style={{ border: "1px solid rgba(255,255,255,0.12)", borderRadius: 14, padding: 10 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
                        <div style={{ fontWeight: 990 }}>{c.name}</div>
                        <button style={styles.btnDanger} onClick={() => deleteClient(c.id)}>Delete</button>
                      </div>
                      <div style={{ marginTop: 10 }}>
                        <div style={styles.label}>Coverage window</div>
                        <div style={styles.row}>
                          <input
                            style={styles.input}
                            type="time"
                            value={c.coverageStart || "08:00"}
                            onChange={(e) => updateClientCoverage(c.id, e.target.value, c.coverageEnd || "16:00")}
                          />
                          <span style={{ opacity: 0.8 }}>to</span>
                          <input
                            style={styles.input}
                            type="time"
                            value={c.coverageEnd || "16:00"}
                            onChange={(e) => updateClientCoverage(c.id, c.coverageStart || "08:00", e.target.value)}
                          />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Settings */}
        {tab === "settings" && (
          <div className="no-print" style={styles.card}>
            <div style={{ fontSize: 16, fontWeight: 990, marginBottom: 8 }}>Settings</div>
            <div style={styles.hr} />

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div style={{ border: "1px solid rgba(255,255,255,0.12)", borderRadius: 14, padding: 12 }}>
                <div style={{ fontWeight: 990 }}>Login requirement</div>
                <div style={{ marginTop: 8 }}>
                  <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
                    <input
                      type="checkbox"
                      checked={state.settings.requireLogin}
                      onChange={(e) => setState((p) => ({ ...p, settings: { ...p.settings, requireLogin: e.target.checked } }))}
                    />
                    Require login at startup
                  </label>
                </div>
              </div>

              <div style={{ border: "1px solid rgba(255,255,255,0.12)", borderRadius: 14, padding: 12 }}>
                <div style={{ fontWeight: 990 }}>Print / PDF</div>
                <div style={{ marginTop: 8 }}>
                  <button style={styles.btn} onClick={() => window.print()}>Print / Save as PDF</button>
                </div>
              </div>
            </div>

            <div style={styles.hr} />

            <div style={{ fontSize: 16, fontWeight: 990, marginBottom: 8 }}>
              Users {isAdmin ? "(Admin)" : "(View only)"}
            </div>

            {!isAdmin ? (
              <div style={{ fontSize: 13, opacity: 0.85 }}>Only admins can create/edit users.</div>
            ) : (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 10 }}>
                  <div>
                    <div style={styles.label}>Username</div>
                    <input style={{ ...styles.input, width: "100%" }} value={newUserUsername} onChange={(e) => setNewUserUsername(e.target.value)} />
                  </div>
                  <div>
                    <div style={styles.label}>Display name</div>
                    <input style={{ ...styles.input, width: "100%" }} value={newUserDisplayName} onChange={(e) => setNewUserDisplayName(e.target.value)} />
                  </div>
                  <div>
                    <div style={styles.label}>PIN</div>
                    <input style={{ ...styles.input, width: "100%" }} value={newUserPin} onChange={(e) => setNewUserPin(e.target.value)} />
                  </div>
                  <div>
                    <div style={styles.label}>Role</div>
                    <select style={{ ...styles.select, width: "100%" }} value={newUserRole} onChange={(e) => setNewUserRole(e.target.value)}>
                      <option value="supervisor">supervisor</option>
                      <option value="admin">admin</option>
                    </select>
                  </div>
                </div>

                <div style={{ marginTop: 10 }}>
                  <button style={styles.btn} onClick={addUser}>Add User</button>
                </div>

                <div style={styles.hr} />

                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {state.users.map((u) => (
                    <div key={u.id} style={{ border: "1px solid rgba(255,255,255,0.12)", borderRadius: 14, padding: 10 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                        <div>
                          <div style={{ fontWeight: 990 }}>{u.displayName || u.username}</div>
                          <div style={{ fontSize: 12, opacity: 0.85 }}>{u.username} · {u.role}</div>
                        </div>
                        <button style={styles.btnDanger} onClick={() => deleteUser(u.id)}>Delete</button>
                      </div>

                      <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
                        <div>
                          <div style={styles.label}>Display name</div>
                          <input style={{ ...styles.input, width: "100%" }} value={u.displayName || ""} onChange={(e) => updateUser(u.id, { displayName: e.target.value })} />
                        </div>
                        <div>
                          <div style={styles.label}>PIN</div>
                          <input style={{ ...styles.input, width: "100%" }} value={u.pin || ""} onChange={(e) => updateUser(u.id, { pin: e.target.value })} />
                        </div>
                        <div>
                          <div style={styles.label}>Role</div>
                          <select style={{ ...styles.select, width: "100%" }} value={u.role} onChange={(e) => updateUser(u.id, { role: e.target.value })}>
                            <option value="supervisor">supervisor</option>
                            <option value="admin">admin</option>
                          </select>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {/* Shift Modal */}
        {modalOpen && (
          <div
            style={styles.modalOverlay}
            onMouseDown={(e) => { if (e.target === e.currentTarget) setModalOpen(false); }}
          >
            <div style={styles.modal}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
                <h3 style={styles.modalTitle}>{editingShiftId ? "Edit shift" : "Add shift"}</h3>
                <button style={styles.btn2} onClick={() => setModalOpen(false)}>Close</button>
              </div>

              <div style={styles.hr} />

              {state.staff.length === 0 || state.clients.length === 0 ? (
                <div style={styles.err}>Add at least 1 staff and 1 client before scheduling shifts.</div>
              ) : (
                <>
                  <div style={styles.fourCol}>
                    <div>
                      <div style={styles.label}>Start Date</div>
                      <input
                        style={{ ...styles.input, width: "100%" }}
                        type="date"
                        value={shiftForm.startDate}
                        onChange={(e) => {
                          setEndDateTouched(false);
                          setShiftForm((p) => ({ ...p, startDate: e.target.value, endDate: e.target.value }));
                        }}
                      />
                    </div>
                    <div>
                      <div style={styles.label}>Start Time</div>
                      <input
                        style={{ ...styles.input, width: "100%" }}
                        type="time"
                        value={shiftForm.startTime}
                        onChange={(e) => { setEndDateTouched(false); setShiftForm((p) => ({ ...p, startTime: e.target.value })); }}
                      />
                    </div>
                    <div>
                      <div style={styles.label}>End Date</div>
                      <input
                        style={{ ...styles.input, width: "100%" }}
                        type="date"
                        value={shiftForm.endDate}
                        onChange={(e) => { setEndDateTouched(true); setShiftForm((p) => ({ ...p, endDate: e.target.value })); }}
                      />
                      <div style={{ marginTop: 6, fontSize: 12, opacity: 0.8 }}>Auto unless you change it.</div>
                    </div>
                    <div>
                      <div style={styles.label}>End Time</div>
                      <input
                        style={{ ...styles.input, width: "100%" }}
                        type="time"
                        value={shiftForm.endTime}
                        onChange={(e) => { setEndDateTouched(false); setShiftForm((p) => ({ ...p, endTime: e.target.value })); }}
                      />
                      <div style={{ marginTop: 6, fontSize: 12, opacity: 0.8 }}>If earlier than Start → bumps next day.</div>
                    </div>
                  </div>

                  <div style={{ height: 10 }} />

                  <div style={styles.twoCol}>
                    <div>
                      <div style={styles.label}>Staff</div>
                      <select style={{ ...styles.select, width: "100%" }} value={shiftForm.staffId} onChange={(e) => setShiftForm((p) => ({ ...p, staffId: e.target.value }))}>
                        <option value="" disabled>Select staff</option>
                        {state.staff.slice().sort((a, b) => a.name.localeCompare(b.name)).map((s) => (
                          <option key={s.id} value={s.id}>{s.name}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <div style={styles.label}>Client</div>
                      <select style={{ ...styles.select, width: "100%" }} value={shiftForm.clientId} onChange={(e) => setShiftForm((p) => ({ ...p, clientId: e.target.value }))}>
                        <option value="" disabled>Select client</option>
                        {state.clients.slice().sort((a, b) => a.name.localeCompare(b.name)).map((c) => (
                          <option key={c.id} value={c.id}>{c.name}</option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div style={{ height: 10 }} />
                  <div>
                    <div style={styles.label}>Notes (optional)</div>
                    <textarea
                      style={{ ...styles.input, width: "100%", minHeight: 80, resize: "vertical" }}
                      value={shiftForm.notes}
                      onChange={(e) => setShiftForm((p) => ({ ...p, notes: e.target.value }))}
                    />
                  </div>

                  {shiftValidation.issues.map((x, i) => <div key={i} style={styles.err}>• {x}</div>)}
                  {shiftValidation.warnings.map((x, i) => <div key={i} style={styles.warn}>• {x}</div>)}

                  <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
                    <button style={styles.btn2} onClick={() => setModalOpen(false)}>Cancel</button>
                    <button style={styles.btn} onClick={saveShift} disabled={shiftValidation.issues.length > 0}>Save Shift</button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        <div style={{ ...styles.card, fontSize: 13, opacity: 0.9 }} className="print-card">
          ✅ Supervisors can see each other’s shifts, and double-booking is blocked across ALL schedules.
        </div>
      </div>
    </div>
  );
}
