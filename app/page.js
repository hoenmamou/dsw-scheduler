"use client";

import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabaseClient";

const SUPABASE_CONFIGURED = !!(
  process.env.NEXT_PUBLIC_SUPABASE_URL &&
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

let supabaseErrorHandler = null;
let forceLocalFallback = false;

function setSupabaseErrorHandler(fn) {
  supabaseErrorHandler = fn;
}

function reportSupabaseError(error) {
  forceLocalFallback = true;
  console.warn("Supabase request failed; falling back to local storage.", error);
  if (typeof supabaseErrorHandler === "function") supabaseErrorHandler(error);
}

function canUseSupabase() {
  return SUPABASE_CONFIGURED && supabase && !forceLocalFallback;
}

const DAY_START_MIN = 7 * 60;
const DAY_END_MIN = 23 * 60;
const OT_THRESHOLD_MIN = 40 * 60;
const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const CLIENT_SCHEDULE_STORAGE_KEY = "dsw_client_schedules";

function uid(prefix = "id") {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}
function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}
function isoLocal(date) {
  const d = new Date(date);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}:00`;
}
function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}
function toISO(dateStr, timeStr) {
  return `${dateStr}T${timeStr}:00`;
}
function minutesBetweenISO(aISO, bISO) {
  const a = new Date(aISO);
  const b = new Date(bISO);
  if (isNaN(a) || isNaN(b) || b <= a) return 0;
  return Math.round((b - a) / 60000);
}
function overlaps(aStart, aEnd, bStart, bEnd) {
  return new Date(aStart) < new Date(bEnd) && new Date(bStart) < new Date(aEnd);
}
function fmtHoursFromMin(min) {
  const sign = min < 0 ? "-" : "";
  const abs = Math.abs(min);
  return `${sign}${(abs / 60).toFixed(2)}h`;
}
function formatDateHuman(dateLike) {
  const d = new Date(dateLike);
  if (isNaN(d)) return "";
  return d.toLocaleDateString();
}
function startOfWeekMonday(inputDate = new Date()) {
  const d = new Date(inputDate);
  const day = d.getDay();
  const diffToMon = (day === 0 ? -6 : 1) - day;
  d.setDate(d.getDate() + diffToMon);
  d.setHours(0, 0, 0, 0);
  return d;
}
function parseShiftPattern(input) {
  const lines = (input || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .flatMap((l) => l.split(",").map((p) => p.trim()).filter(Boolean));

  const out = [];
  for (const line of lines) {
    const m = line.match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
    if (!m) throw new Error(`Invalid shift format: "${line}" (expected HH:MM-HH:MM)`);
    const [, sh, sm, eh, em] = m;
    out.push({
      start: `${String(sh).padStart(2, "0")}:${sm}`,
      end: `${String(eh).padStart(2, "0")}:${em}`,
    });
  }
  return out;
}
function loadClientSchedule(clientId) {
  try {
    const raw = localStorage.getItem(CLIENT_SCHEDULE_STORAGE_KEY);
    const map = raw ? JSON.parse(raw) : {};
    return map[clientId] || null;
  } catch {
    return null;
  }
}
function saveClientSchedule(clientId, shifts) {
  try {
    const raw = localStorage.getItem(CLIENT_SCHEDULE_STORAGE_KEY);
    const map = raw ? JSON.parse(raw) : {};
    map[clientId] = { shifts };
    localStorage.setItem(CLIENT_SCHEDULE_STORAGE_KEY, JSON.stringify(map));
  } catch {}
}
function splitDayNightMinutes(startISO, endISO) {
  const start = new Date(startISO);
  const end = new Date(endISO);
  if (isNaN(start) || isNaN(end) || end <= start) {
    return { totalMin: 0, dayMin: 0, nightMin: 0 };
  }

  let totalMin = 0;
  let dayMin = 0;
  let nightMin = 0;
  let cursor = new Date(start);

  while (cursor < end) {
    const dayStart = new Date(cursor);
    dayStart.setHours(0, 0, 0, 0);
    const nextDay = new Date(dayStart);
    nextDay.setDate(nextDay.getDate() + 1);

    const segStart = cursor;
    const segEnd = end < nextDay ? end : nextDay;
    const segMin = Math.round((segEnd - segStart) / 60000);
    totalMin += segMin;

    const segStartMin = segStart.getHours() * 60 + segStart.getMinutes();
    let segEndMin = segEnd.getHours() * 60 + segEnd.getMinutes();
    if (segEnd <= nextDay && segEndMin === 0 && segEnd.getHours() === 0) {
      segEndMin = 1440;
    }

    const dayOverlapStart = clamp(segStartMin, DAY_START_MIN, DAY_END_MIN);
    const dayOverlapEnd = clamp(segEndMin, DAY_START_MIN, DAY_END_MIN);
    const dayOverlap = Math.max(0, dayOverlapEnd - dayOverlapStart);

    dayMin += dayOverlap;
    nightMin += segMin - dayOverlap;
    cursor = segEnd;
  }

  return { totalMin, dayMin, nightMin };
}
function makeDefaultAvailability() {
  return {
    days: [1, 2, 3, 4, 5],
    start: "07:00",
    end: "23:00",
  };
}
function parseJsonSafe(value, fallback) {
  if (!value) return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
function normalizeDateInput(value) {
  if (!value) return "";
  if (typeof value !== "string") return "";
  return value.length >= 10 ? value.slice(0, 10) : value;
}
function readStaffDate(row, ...keys) {
  for (const key of keys) {
    const value = row?.[key];
    if (value) return normalizeDateInput(value);
  }
  return "";
}
function todayYMD() {
  return isoLocal(new Date()).slice(0, 10);
}
function isExpired(dateStr) {
  if (!dateStr) return false;
  const d = new Date(`${dateStr}T23:59:59`);
  if (isNaN(d)) return false;
  return d < new Date();
}
function daysUntil(dateStr) {
  if (!dateStr) return null;
  const d = new Date(`${dateStr}T23:59:59`);
  if (isNaN(d)) return null;
  return Math.ceil((d - new Date()) / 86400000);
}
function getTrainingStatus(staff) {
  const items = [
    { key: "cprExp", label: "CPR", value: staff.cprExp },
    { key: "firstAidExp", label: "First Aid", value: staff.firstAidExp },
    { key: "medExp", label: "Med Training", value: staff.medExp },
  ];
  const expired = items.filter((x) => isExpired(x.value));
  const dueSoon = items.filter((x) => {
    const days = daysUntil(x.value);
    return days !== null && days >= 0 && days <= 30;
  });
  return { expired, dueSoon, items };
}
function isStaffAvailableForShift(staff, startISO, endISO) {
  const availability = staff.availability || makeDefaultAvailability();
  const start = new Date(startISO);
  const end = new Date(endISO);
  if (isNaN(start) || isNaN(end)) return false;

  const day = start.getDay();
  const allowedDays = Array.isArray(availability.days) ? availability.days : [];
  if (allowedDays.length && !allowedDays.includes(day)) return false;

  const shiftStart = start.getHours() * 60 + start.getMinutes();
  const shiftEnd = end.getHours() * 60 + end.getMinutes();

  const [ah, am] = String(availability.start || "00:00").split(":").map(Number);
  const [bh, bm] = String(availability.end || "23:59").split(":").map(Number);
  const availStart = ah * 60 + am;
  const availEnd = bh * 60 + bm;

  if (endISO.slice(0, 10) !== startISO.slice(0, 10)) {
    return false;
  }
  return shiftStart >= availStart && shiftEnd <= availEnd;
}
function staffShiftUniqueKey(sh) {
  if (sh.isShared && sh.sharedGroupId) {
    return `SS|${sh.staffId}|${sh.startISO}|${sh.endISO}|${sh.sharedGroupId}`;
  }
  return `N|${sh.id}`;
}
function staffWeekMinutesDedup(shifts, staffId) {
  const seen = new Set();
  let total = 0;
  for (const sh of shifts) {
    if (sh.staffId !== staffId) continue;
    const key = staffShiftUniqueKey(sh);
    if (seen.has(key)) continue;
    seen.add(key);
    total += minutesBetweenISO(sh.startISO, sh.endISO);
  }
  return total;
}
function Tabs({ value, onChange, tabs }) {
  return (
    <div className="no-print" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {tabs.map((t) => (
        <button
          key={t.value}
          onClick={() => onChange(t.value)}
          style={{
            ...styles.btn2,
            background: value === t.value ? "rgba(31,111,235,0.18)" : "transparent",
            borderColor:
              value === t.value ? "rgba(31,111,235,0.55)" : "rgba(255,255,255,0.18)",
          }}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/* =========================
   DB helpers
========================= */

async function sbSelect(table) {
  if (canUseSupabase()) {
    const { data, error } = await supabase.from(table).select("*");
    if (!error) return data || [];
    reportSupabaseError(error);
  }

  try {
    const raw = localStorage.getItem("dsw_local_db");
    const db = raw ? JSON.parse(raw) : DEFAULT_DB;
    return db[table] || [];
  } catch {
    return [];
  }
}
async function sbUpsert(table, rows) {
  if (canUseSupabase()) {
    const { error } = await supabase.from(table).upsert(rows, { onConflict: "id" });
    if (!error) return;
    reportSupabaseError(error);
  }

  try {
    const raw = localStorage.getItem("dsw_local_db");
    const db = raw ? JSON.parse(raw) : { ...DEFAULT_DB };
    db[table] = db[table] || [];
    for (const r of rows) {
      const idx = db[table].findIndex((x) => x.id === r.id);
      if (idx >= 0) db[table][idx] = { ...db[table][idx], ...r };
      else db[table].push(r);
    }
    localStorage.setItem("dsw_local_db", JSON.stringify(db));
  } catch (e) {
    console.error(e);
  }
}
async function sbDelete(table, id) {
  if (canUseSupabase()) {
    const { error } = await supabase.from(table).delete().eq("id", id);
    if (!error) return;
    reportSupabaseError(error);
  }
  try {
    const raw = localStorage.getItem("dsw_local_db");
    const db = raw ? JSON.parse(raw) : { ...DEFAULT_DB };
    db[table] = (db[table] || []).filter((x) => x.id !== id);
    localStorage.setItem("dsw_local_db", JSON.stringify(db));
  } catch (e) {
    console.error(e);
  }
}

const DEFAULT_DB = {
  users: [
    { id: "admin", name: "Admin", role: "admin", pin: "1234" },
    { id: "sup1", name: "Supervisor One", role: "supervisor", pin: "1111" },
  ],
  staff: [
    {
      id: "st1",
      name: "Natasha",
      active: true,
      availability: JSON.stringify(makeDefaultAvailability()),
      cpr_exp: "",
      first_aid_exp: "",
      med_exp: "",
      can_overtime: false,
    },
    {
      id: "st2",
      name: "Jordan",
      active: true,
      availability: JSON.stringify(makeDefaultAvailability()),
      cpr_exp: "",
      first_aid_exp: "",
      med_exp: "",
      can_overtime: false,
    },
  ],
  clients: [
    {
      id: "cl1",
      name: "Client A",
      supervisor_id: "sup1",
      coverage_start: "07:00",
      coverage_end: "23:00",
      is_24_hour: false,
      active: true,
      weekly_hours: 40,
    },
  ],
  shifts: [],
};

function normalizeFromDB({ users, staff, clients, shifts }) {
  return {
    settings: {
      includeUnassignedForSupervisors: true,
      hardStopConflicts: true,
      hardStopOT: true,
      blockExpiredTraining: true,
      allowOvertimeOverride: true,
    },
    users: (users || []).map((u) => ({
      id: u.id,
      name: u.name,
      role: u.role,
      pin: u.pin,
    })),
    staff: (staff || []).map((s) => ({
      id: s.id,
      name: s.name || "",
      active: s.active !== false,
      availability: parseJsonSafe(s.availability, makeDefaultAvailability()),
      cprExp: readStaffDate(s, "cpr_exp", "cprExp", "cpr_expiration"),
      firstAidExp: readStaffDate(s, "first_aid_exp", "firstAidExp", "first_aid_expiration"),
      medExp: readStaffDate(s, "med_exp", "medExp", "med_expiration"),
      canOvertime: !!(s.can_overtime ?? s.canOvertime),
    })),
    clients: (clients || []).map((c) => ({
      id: c.id,
      name: c.name,
      supervisorId: c.supervisor_id || "",
      coverageStart: c.coverage_start || "07:00",
      coverageEnd: c.coverage_end || "23:00",
      is24Hour: !!c.is_24_hour,
      weeklyHours:
        typeof c.weekly_hours === "number"
          ? c.weekly_hours
          : Number(c.weekly_hours) || 40,
      active: c.active !== false,
    })),
    shifts: (shifts || []).map((sh) => ({
      id: sh.id,
      clientId: sh.client_id || sh.clientId,
      staffId: sh.staff_id || sh.staffId,
      startISO: new Date(sh.start_iso || sh.startISO).toISOString(),
      endISO: new Date(sh.end_iso || sh.endISO).toISOString(),
      createdBy: sh.created_by || sh.createdBy || "",
      isShared: !!(sh.is_shared ?? sh.isShared),
      sharedGroupId: sh.shared_group_id || sh.sharedGroupId || "",
      overtimeApproved: !!(sh.overtime_approved ?? sh.overtimeApproved),
    })),
  };
}
async function refreshState(setStateLocal) {
  try {
    const [users, staff, clients, shifts] = await Promise.all([
      sbSelect("users"),
      sbSelect("staff"),
      sbSelect("clients"),
      sbSelect("shifts"),
    ]);
    const normalized = normalizeFromDB({ users, staff, clients, shifts });
    if (typeof setStateLocal === "function") {
      setStateLocal((p) => ({
        ...p,
        ...normalized,
        settings: { ...p.settings, ...normalized.settings },
      }));
    }
    return normalized;
  } catch (e) {
    console.error(e);
    return null;
  }
}

/* =========================
   Login
========================= */

function LoginScreen({ users, onLogin, onCreateAdmin }) {
  const [picked, setPicked] = useState(users?.[0]?.id || "");
  const [pin, setPin] = useState("");
  const [newId, setNewId] = useState("admin");
  const [newName, setNewName] = useState("Admin");
  const [newPin, setNewPin] = useState("1234");

  const user = users.find((u) => u.id === picked);

  if (!users || users.length === 0) {
    return (
      <div style={{ minHeight: "100vh", background: "#0b0c10", color: "white", padding: 20 }}>
        <div style={{ maxWidth: 520, margin: "40px auto", ...styles.card }}>
          <h2 style={{ marginTop: 0 }}>DSW Scheduler — Create Admin</h2>
          <div style={{ ...styles.twoCol, marginTop: 10 }}>
            <div>
              <div style={styles.tiny}>ID</div>
              <input style={styles.input} value={newId} onChange={(e) => setNewId(e.target.value)} />
            </div>
            <div>
              <div style={styles.tiny}>Name</div>
              <input style={styles.input} value={newName} onChange={(e) => setNewName(e.target.value)} />
            </div>
            <div>
              <div style={styles.tiny}>PIN</div>
              <input
                style={styles.input}
                type="password"
                value={newPin}
                onChange={(e) => setNewPin(e.target.value)}
              />
            </div>
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
            <button
              style={styles.btn}
              onClick={() => {
                if (!newId.trim() || !newName.trim() || !newPin.trim()) {
                  return alert("All fields are required.");
                }
                onCreateAdmin({
                  id: newId.trim(),
                  name: newName.trim(),
                  pin: newPin.trim(),
                });
              }}
            >
              Create Admin
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: "#0b0c10", color: "white", padding: 20 }}>
      <div style={{ maxWidth: 520, margin: "40px auto", ...styles.card }}>
        <h2 style={{ marginTop: 0 }}>DSW Scheduler Login</h2>
        <div style={{ ...styles.twoCol, marginTop: 10 }}>
          <div>
            <div style={styles.tiny}>User</div>
            <select style={styles.select} value={picked} onChange={(e) => setPicked(e.target.value)}>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} ({u.role})
                </option>
              ))}
            </select>
          </div>
          <div>
            <div style={styles.tiny}>PIN</div>
            <input
              style={styles.input}
              type="password"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
            />
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
          <button
            style={styles.btn}
            onClick={() => {
              if (!user) return alert("Pick a user.");
              const pinMatches = !user.pin || String(pin || "") === String(user.pin || "");
              if (!pinMatches) return alert("Incorrect PIN.");
              onLogin(user.id);
            }}
          >
            Login
          </button>
        </div>
      </div>
    </div>
  );
}

/* =========================
   Calendar
========================= */

function CalendarWeek({
  state,
  weekStartDate,
  visibleClients,
  canSeeAllShifts,
  setTab,
  setShiftDraft,
  deleteShift,
}) {
  const shifts = state.shifts || [];
  const clients = state.clients || [];
  const staff = state.staff || [];
  const clientName = (id) => clients.find((c) => c.id === id)?.name || "Unknown";
  const staffName = (id) => staff.find((s) => s.id === id)?.name || "Unknown";

  const start = new Date(weekStartDate);
  start.setHours(0, 0, 0, 0);

  const days = [...Array(7)].map((_, i) => {
    const d = addDays(start, i);
    return { d, dateStr: isoLocal(d).slice(0, 10) };
  });

  const visibleClientIds = new Set((visibleClients || []).map((c) => c.id));

  function dayShifts(dateStr) {
    const dayStart = new Date(`${dateStr}T00:00:00`).toISOString();
    const dayEnd = new Date(`${dateStr}T23:59:59`).toISOString();

    return shifts
      .filter((sh) => {
        if (!canSeeAllShifts && !visibleClientIds.has(sh.clientId)) return false;
        return overlaps(sh.startISO, sh.endISO, dayStart, dayEnd);
      })
      .sort((a, b) => new Date(a.startISO) - new Date(b.startISO));
  }

  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ ...styles.card, marginBottom: 12 }}>
        <div style={styles.rowBetween}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 980 }}>Weekly Calendar</div>
            <div style={styles.tiny}>Week of {start.toLocaleDateString()}</div>
          </div>
          <button className="no-print" style={styles.btn2} onClick={() => window.print()}>
            Print / Save PDF
          </button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(180px, 1fr))", gap: 10, overflowX: "auto" }}>
        {days.map(({ d, dateStr }) => (
          <div key={dateStr} style={styles.card}>
            <div style={{ fontWeight: 950 }}>
              {d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}
            </div>
            <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
              {dayShifts(dateStr).length === 0 ? (
                <div style={{ opacity: 0.75, fontSize: 12 }}>No shifts</div>
              ) : (
                dayShifts(dateStr).map((sh) => (
                  <div key={sh.id} style={styles.shift}>
                    <div style={styles.shiftTitle}>{clientName(sh.clientId)}</div>
                    <div style={styles.shiftMeta}>
                      {sh.startISO.slice(11, 16)} → {sh.endISO.slice(11, 16)}
                      <br />
                      Staff: <b>{staffName(sh.staffId)}</b>
                      {sh.isShared ? (
                        <>
                          <br />
                          Shared: <b>{sh.sharedGroupId || "Yes"}</b>
                        </>
                      ) : null}
                      {sh.overtimeApproved ? (
                        <>
                          <br />
                          OT Override: <b>Approved</b>
                        </>
                      ) : null}
                    </div>
                    <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                      <button
                        style={{ ...styles.btn2, padding: "2px 8px", fontSize: 12 }}
                        onClick={() => {
                          setTab("schedule");
                          setShiftDraft({
                            clientId: sh.clientId,
                            clientId2: sh.isShared
                              ? state.shifts.find(
                                  (s) => s.sharedGroupId === sh.sharedGroupId && s.id !== sh.id
                                )?.clientId || ""
                              : "",
                            staffId: sh.staffId,
                            startDate: sh.startISO.slice(0, 10),
                            startTime: sh.startISO.slice(11, 16),
                            endDate: sh.endISO.slice(0, 10),
                            endTime: sh.endISO.slice(11, 16),
                            isShared: !!sh.isShared,
                            sharedGroupId: sh.sharedGroupId || "",
                            overtimeApproved: !!sh.overtimeApproved,
                          });
                        }}
                      >
                        Edit
                      </button>
                      <button
                        style={{ ...styles.btn2, padding: "2px 8px", fontSize: 12, color: "#ff8b8b" }}
                        onClick={() => deleteShift(sh.id)}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* =========================
   Main App
========================= */

export default function Page() {
  const [mounted, setMounted] = useState(false);
  const [state, setState] = useState({
    settings: {
      includeUnassignedForSupervisors: true,
      hardStopConflicts: true,
      hardStopOT: true,
      blockExpiredTraining: true,
      allowOvertimeOverride: true,
    },
    users: [],
    staff: [],
    clients: [],
    shifts: [],
  });
  const [sessionUserId, setSessionUserId] = useState(null);
  const [supabaseError, setSupabaseError] = useState(null);

  const [tab, setTab] = useState("schedule");

  const [weekStart, setWeekStart] = useState(() => isoLocal(startOfWeekMonday()).slice(0, 10));
  const weekStartDate = useMemo(() => new Date(`${weekStart}T00:00:00`), [weekStart]);
  const weekEndDate = useMemo(() => addDays(weekStartDate, 7), [weekStartDate]);

  const [dailyPrintDate, setDailyPrintDate] = useState(() => weekStart);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [builderClientId, setBuilderClientId] = useState("");
  const [builderTemplate, setBuilderTemplate] = useState("2x12");
  const [builderScheduleSource, setBuilderScheduleSource] = useState("template");
  const [builderCustomTemplate, setBuilderCustomTemplate] = useState("07:00-15:00\n15:00-23:00");
  const [builderWeeklyAssignments, setBuilderWeeklyAssignments] = useState({});
  const [builderWeeks, setBuilderWeeks] = useState(1);

  const currentUser = useMemo(
    () => state.users.find((u) => u.id === sessionUserId) || null,
    [state.users, sessionUserId]
  );
  const normalizedRole = (currentUser?.role || "").toLowerCase();
  const isAdmin = normalizedRole.includes("admin");
  const canSeeAdminUI = isAdmin || normalizedRole.includes("super");

  const [shiftDraft, setShiftDraft] = useState({
    clientId: "",
    clientId2: "",
    staffId: "",
    startDate: weekStart,
    startTime: "07:00",
    endDate: weekStart,
    endTime: "15:00",
    isShared: false,
    sharedGroupId: "",
    overtimeApproved: false,
  });

  const [staffDraft, setStaffDraft] = useState({
    id: "",
    name: "",
    active: true,
    availabilityDays: [1, 2, 3, 4, 5],
    availabilityStart: "07:00",
    availabilityEnd: "23:00",
    cprExp: "",
    firstAidExp: "",
    medExp: "",
    canOvertime: false,
  });

  const [clientDraft, setClientDraft] = useState({
    id: "",
    name: "",
    supervisorId: "",
    coverageStart: "07:00",
    coverageEnd: "23:00",
    weeklyHours: 40,
    is24Hour: false,
    active: true,
  });

  const [userDraft, setUserDraft] = useState({
    id: "",
    name: "",
    role: "supervisor",
    pin: "",
  });

  const [emergencyFillDraft, setEmergencyFillDraft] = useState({
    clientId: "",
    date: weekStart,
    startTime: "07:00",
    endTime: "15:00",
    isShared: false,
  });

  useEffect(() => setMounted(true), []);
  useEffect(() => {
    setSupabaseErrorHandler(setSupabaseError);
    return () => setSupabaseErrorHandler(null);
  }, []);
  useEffect(() => {
    if (!mounted) return;
    try {
      setSessionUserId(sessionStorage.getItem("dsw_user_id"));
    } catch {}
  }, [mounted]);

  useEffect(() => {
    if (!mounted) return;
    let alive = true;

    async function loadAll() {
      let [users, staff, clients, shifts] = await Promise.all([
        sbSelect("users"),
        sbSelect("staff"),
        sbSelect("clients"),
        sbSelect("shifts"),
      ]);

      if (!users || users.length === 0) {
        users = DEFAULT_DB.users;
        await sbUpsert("users", users);
      }

      if (!alive) return;
      const normalized = normalizeFromDB({ users, staff, clients, shifts });
      setState((prev) => ({
        ...prev,
        ...normalized,
        settings: { ...prev.settings, ...normalized.settings },
      }));
    }

    loadAll().catch(console.error);

    if (SUPABASE_CONFIGURED && supabase) {
      const ch1 = supabase.channel("rt_users").on("postgres_changes", { event: "*", schema: "public", table: "users" }, loadAll).subscribe();
      const ch2 = supabase.channel("rt_staff").on("postgres_changes", { event: "*", schema: "public", table: "staff" }, loadAll).subscribe();
      const ch3 = supabase.channel("rt_clients").on("postgres_changes", { event: "*", schema: "public", table: "clients" }, loadAll).subscribe();
      const ch4 = supabase.channel("rt_shifts").on("postgres_changes", { event: "*", schema: "public", table: "shifts" }, loadAll).subscribe();

      return () => {
        alive = false;
        try {
          supabase.removeChannel(ch1);
          supabase.removeChannel(ch2);
          supabase.removeChannel(ch3);
          supabase.removeChannel(ch4);
        } catch {}
      };
    }

    return () => {
      alive = false;
    };
  }, [mounted]);

  useEffect(() => {
    setShiftDraft((p) => ({ ...p, startDate: weekStart, endDate: weekStart }));
    setEmergencyFillDraft((p) => ({ ...p, date: weekStart }));
    setDailyPrintDate(weekStart);
  }, [weekStart]);

  useEffect(() => {
    const sd = shiftDraft.startDate;
    const st = shiftDraft.startTime;
    const et = shiftDraft.endTime;
    if (!sd || !st || !et) return;

    const [sh, sm] = st.split(":").map(Number);
    const [eh, em] = et.split(":").map(Number);
    const startMin = sh * 60 + sm;
    const endMin = eh * 60 + em;

    let endDate = sd;
    if (endMin < startMin) {
      const d = new Date(`${sd}T00:00:00`);
      d.setDate(d.getDate() + 1);
      endDate = isoLocal(d).slice(0, 10);
    }
    if (shiftDraft.endDate !== endDate) setShiftDraft((p) => ({ ...p, endDate }));
  }, [shiftDraft.startDate, shiftDraft.startTime, shiftDraft.endTime, shiftDraft.endDate]);

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
  async function createAdminUser({ id, name, pin }) {
    await sbUpsert("users", [{ id, name, role: "admin", pin }]);
    await refreshState(setState);
    loginAs(id);
  }

  const visibleClients = useMemo(() => {
    const all = (state.clients || []).filter((c) => c.active !== false);
    if (isAdmin) return all;
    const me = currentUser?.id || "";
    const includeUnassigned = !!state.settings?.includeUnassignedForSupervisors;
    return all.filter((c) => {
      if ((c.supervisorId || "") === me) return true;
      if (includeUnassigned && (c.supervisorId || "") === "") return true;
      return false;
    });
  }, [state.clients, isAdmin, currentUser?.id, state.settings?.includeUnassignedForSupervisors]);

  const visibleClientIds = useMemo(() => new Set(visibleClients.map((c) => c.id)), [visibleClients]);

  const shiftsInSelectedWeek = useMemo(() => {
    return (state.shifts || []).filter((sh) => {
      const s = new Date(sh.startISO);
      return s >= weekStartDate && s < weekEndDate;
    });
  }, [state.shifts, weekStartDate, weekEndDate]);

  const visibleShiftsInWeek = useMemo(() => {
    return shiftsInSelectedWeek.filter((sh) => (isAdmin ? true : visibleClientIds.has(sh.clientId)));
  }, [shiftsInSelectedWeek, isAdmin, visibleClientIds]);

  const staffWeekMinutesMap = useMemo(() => {
    const out = {};
    for (const st of state.staff || []) {
      out[st.id] = staffWeekMinutesDedup(shiftsInSelectedWeek, st.id);
    }
    return out;
  }, [state.staff, shiftsInSelectedWeek]);

  const weekClientHours = useMemo(() => {
    const byClient = {};
    for (const sh of shiftsInSelectedWeek) {
      const id = sh.clientId;
      if (!id) continue;
      if (!byClient[id]) byClient[id] = { totalMin: 0, dayMin: 0, nightMin: 0 };
      const { totalMin, dayMin, nightMin } = splitDayNightMinutes(sh.startISO, sh.endISO);
      byClient[id].totalMin += totalMin;
      byClient[id].dayMin += dayMin;
      byClient[id].nightMin += nightMin;
    }
    return byClient;
  }, [shiftsInSelectedWeek]);

  async function findStaffConflictsDB({ staffId, startISO, endISO }) {
    const rows = await sbSelect("shifts");
    const all = (rows || []).map((sh) => ({
      id: sh.id,
      staffId: sh.staff_id || sh.staffId,
      clientId: sh.client_id || sh.clientId,
      startISO: new Date(sh.start_iso || sh.startISO).toISOString(),
      endISO: new Date(sh.end_iso || sh.endISO).toISOString(),
      isShared: !!(sh.is_shared || sh.isShared),
      sharedGroupId: sh.shared_group_id || sh.sharedGroupId || "",
    }));
    return all.filter((sh) => sh.staffId === staffId && overlaps(sh.startISO, sh.endISO, startISO, endISO));
  }

  function getAllowedVisibleStaff() {
    return (state.staff || []).filter((s) => s.active !== false);
  }

  function getTrainingBlockReason(staff) {
    if (!state.settings?.blockExpiredTraining) return "";
    const status = getTrainingStatus(staff);
    if (status.expired.length) {
      return `Expired training: ${status.expired.map((x) => x.label).join(", ")}`;
    }
    return "";
  }

  const suggestedStaff = useMemo(() => {
    const { clientId, startDate, startTime, endDate, endTime } = shiftDraft;
    if (!clientId || !startDate || !startTime || !endDate || !endTime) return null;

    const startISO = toISO(startDate, startTime);
    const endISO = toISO(endDate, endTime);
    const client = state.clients.find((c) => c.id === clientId);
    const candidates = getAllowedVisibleStaff();

    let best = null;
    let bestScore = Infinity;

    for (const st of candidates) {
      const trainingBlock = getTrainingBlockReason(st);
      if (trainingBlock) continue;
      if (!isStaffAvailableForShift(st, startISO, endISO)) continue;

      const hasConflict = (state.shifts || []).some((sh) => {
        if (sh.staffId !== st.id) return false;
        if (!overlaps(sh.startISO, sh.endISO, startISO, endISO)) return false;
        if (shiftDraft.isShared && sh.isShared && sh.sharedGroupId === shiftDraft.sharedGroupId) return false;
        return true;
      });
      if (hasConflict) continue;

      const currentMin = staffWeekMinutesMap[st.id] || 0;
      const addMin = minutesBetweenISO(startISO, endISO);
      const afterMin = currentMin + addMin;
      const otMin = Math.max(0, afterMin - OT_THRESHOLD_MIN);
      const score = otMin * 10000 + afterMin + (client ? 0 : 10);
      if (score < bestScore) {
        best = st;
        bestScore = score;
      }
    }

    return best;
  }, [shiftDraft, state.staff, state.shifts, staffWeekMinutesMap, state.settings, state.clients]);

  const coverageGaps = useMemo(() => {
    const gaps = [];
    const start = new Date(weekStartDate);

    for (const c of visibleClients) {
      const covStart = c.coverageStart || "07:00";
      const covEnd = c.coverageEnd || "23:00";

      for (let d = 0; d < 7; d++) {
        const day0 = addDays(start, d);
        day0.setHours(0, 0, 0, 0);
        const dateStr = isoLocal(day0).slice(0, 10);

        let covStartISO = `${dateStr}T${covStart}:00`;
        let covEndISO = `${dateStr}T${covEnd}:00`;

        if (c.is24Hour) {
          covStartISO = `${dateStr}T00:00:00`;
          const nd = addDays(new Date(`${dateStr}T00:00:00`), 1);
          covEndISO = `${isoLocal(nd).slice(0, 10)}T00:00:00`;
        } else if (new Date(covEndISO) <= new Date(covStartISO)) {
          const nd = new Date(`${dateStr}T00:00:00`);
          nd.setDate(nd.getDate() + 1);
          covEndISO = `${isoLocal(nd).slice(0, 10)}T${covEnd}:00`;
        }

        const clientShifts = shiftsInSelectedWeek
          .filter((sh) => sh.clientId === c.id)
          .map((sh) => ({ start: sh.startISO, end: sh.endISO }))
          .sort((a, b) => new Date(a.start) - new Date(b.start));

        const merged = [];
        for (const s of clientShifts) {
          if (!merged.length) merged.push({ ...s });
          else {
            const last = merged[merged.length - 1];
            if (new Date(s.start) <= new Date(last.end)) {
              if (new Date(s.end) > new Date(last.end)) last.end = s.end;
            } else {
              merged.push({ ...s });
            }
          }
        }

        let cursor = covStartISO;
        for (const seg of merged) {
          if (overlaps(cursor, covEndISO, seg.start, seg.end)) {
            const segStart = new Date(seg.start) > new Date(cursor) ? seg.start : cursor;
            if (new Date(segStart) > new Date(cursor)) {
              gaps.push({ clientId: c.id, dateStr, startISO: cursor, endISO: segStart });
            }
            cursor = new Date(seg.end) > new Date(cursor) ? seg.end : cursor;
          }
        }
        if (new Date(cursor) < new Date(covEndISO)) {
          gaps.push({ clientId: c.id, dateStr, startISO: cursor, endISO: covEndISO });
        }
      }
    }

    return gaps.filter((g) => minutesBetweenISO(g.startISO, g.endISO) >= 5);
  }, [visibleClients, shiftsInSelectedWeek, weekStartDate]);

  const emergencyFillSuggestions = useMemo(() => {
    const { clientId, date, startTime, endTime } = emergencyFillDraft;
    if (!clientId || !date || !startTime || !endTime) return [];
    const startISO = toISO(date, startTime);
    let endISO = toISO(date, endTime);
    if (new Date(endISO) <= new Date(startISO)) {
      const nd = addDays(new Date(`${date}T00:00:00`), 1);
      endISO = `${isoLocal(nd).slice(0, 10)}T${endTime}:00`;
    }

    return (state.staff || [])
      .filter((st) => st.active !== false)
      .map((st) => {
        const conflict = (state.shifts || []).find(
          (sh) => sh.staffId === st.id && overlaps(sh.startISO, sh.endISO, startISO, endISO)
        );
        const available = isStaffAvailableForShift(st, startISO, endISO);
        const trainingBlock = getTrainingBlockReason(st);
        const currentMin = staffWeekMinutesMap[st.id] || 0;
        const addMin = minutesBetweenISO(startISO, endISO);
        const afterMin = currentMin + addMin;
        const otMin = Math.max(0, afterMin - OT_THRESHOLD_MIN);

        let score = 0;
        if (conflict) score += 10000;
        if (!available) score += 5000;
        if (trainingBlock) score += 7000;
        score += otMin * 20;
        score += afterMin;

        return {
          staff: st,
          conflict,
          available,
          trainingBlock,
          currentMin,
          afterMin,
          otMin,
          score,
        };
      })
      .sort((a, b) => a.score - b.score);
  }, [emergencyFillDraft, state.staff, state.shifts, staffWeekMinutesMap, state.settings]);

  const supervisorDashboard = useMemo(() => {
    const supervisors = (state.users || []).filter(
      (u) => u.role === "supervisor" || u.role === "admin"
    );

    return supervisors.map((u) => {
      const clients = (state.clients || []).filter((c) => c.active !== false && c.supervisorId === u.id);
      const clientIds = new Set(clients.map((c) => c.id));
      const clientShifts = shiftsInSelectedWeek.filter((sh) => clientIds.has(sh.clientId));
      const clientGaps = coverageGaps.filter((g) => clientIds.has(g.clientId));

      const clientCoverageWindows = clients.reduce((sum, c) => {
        if (c.is24Hour) return sum + 24 * 60 * 7;
        const start = c.coverageStart || "07:00";
        const end = c.coverageEnd || "23:00";
        const s = Number(start.slice(0, 2)) * 60 + Number(start.slice(3, 5));
        const e = Number(end.slice(0, 2)) * 60 + Number(end.slice(3, 5));
        const mins = e > s ? e - s : 1440 - s + e;
        return sum + mins * 7;
      }, 0);

      const gapMin = clientGaps.reduce((sum, g) => sum + minutesBetweenISO(g.startISO, g.endISO), 0);
      const coveragePct =
        clientCoverageWindows > 0
          ? Math.max(0, Math.round(((clientCoverageWindows - gapMin) / clientCoverageWindows) * 100))
          : 100;

      return {
        supervisor: u,
        clientsCount: clients.length,
        shiftsCount: clientShifts.length,
        gapsCount: clientGaps.length,
        coveragePct,
      };
    });
  }, [state.users, state.clients, shiftsInSelectedWeek, coverageGaps]);

  const weeklyHealthScore = useMemo(() => {
    const overtimeStaff = (state.staff || []).filter((st) => (staffWeekMinutesMap[st.id] || 0) > OT_THRESHOLD_MIN).length;
    const expTrainingCount = (state.staff || []).filter((st) => getTrainingStatus(st).expired.length > 0).length;
    const openGapCount = coverageGaps.length;
    const totalVisibleClients = visibleClients.length || 1;

    let score = 100;
    score -= overtimeStaff * 8;
    score -= expTrainingCount * 6;
    score -= Math.min(30, openGapCount);
    score = Math.max(0, score);

    let label = "Strong";
    if (score < 85) label = "Watch";
    if (score < 70) label = "Risk";
    if (score < 50) label = "Critical";

    return {
      score,
      label,
      overtimeStaff,
      expTrainingCount,
      openGapCount,
      totalVisibleClients,
    };
  }, [state.staff, staffWeekMinutesMap, coverageGaps, visibleClients]);

  const dailyPrintRows = useMemo(() => {
    const dayStart = new Date(`${dailyPrintDate}T00:00:00`).toISOString();
    const dayEnd = new Date(`${dailyPrintDate}T23:59:59`).toISOString();

    return (state.shifts || [])
      .filter((sh) => (isAdmin ? true : visibleClientIds.has(sh.clientId)))
      .filter((sh) => overlaps(sh.startISO, sh.endISO, dayStart, dayEnd))
      .sort((a, b) => new Date(a.startISO) - new Date(b.startISO));
  }, [state.shifts, dailyPrintDate, isAdmin, visibleClientIds]);

  const tabs = [
    { value: "schedule", label: "Schedule" },
    { value: "calendar", label: "Weekly Calendar" },
    { value: "dailyPrint", label: "Daily Printout" },
    { value: "gaps", label: "Coverage Gaps" },
    { value: "hours", label: "Hours & OT" },
    { value: "emergencyFill", label: "Emergency Fill" },
    { value: "dashboard", label: "Dashboard" },
    ...(canSeeAdminUI
      ? [
          { value: "staff", label: "Staff" },
          { value: "clients", label: "Clients" },
          { value: "users", label: "Users" },
          { value: "settings", label: "Settings" },
        ]
      : []),
  ];

  async function addShift() {
    const {
      clientId,
      clientId2,
      staffId,
      startDate,
      startTime,
      endDate,
      endTime,
      isShared,
      overtimeApproved,
    } = shiftDraft;

    if (!clientId || !staffId) return alert("Pick a client and staff.");
    if (isShared && !clientId2) return alert("Pick the 2nd client for shared support.");
    if (isShared && clientId2 === clientId) return alert("Client 1 and Client 2 cannot be the same.");

    const staff = state.staff.find((s) => s.id === staffId);
    if (!staff) return alert("Staff not found.");

    const startISO = toISO(startDate, startTime);
    const endISO = toISO(endDate, endTime);
    if (new Date(endISO) <= new Date(startISO)) return alert("End must be after start.");

    const trainingBlock = getTrainingBlockReason(staff);
    if (trainingBlock) return alert(trainingBlock);

    if (!isStaffAvailableForShift(staff, startISO, endISO)) {
      return alert(`${staff.name} is outside availability for this shift.`);
    }

    const sharedGroupId = isShared
      ? shiftDraft.sharedGroupId.trim() || `SS-${Date.now().toString().slice(-6)}`
      : "";

    const conflicts = await findStaffConflictsDB({ staffId, startISO, endISO });
    const illegalConflicts = conflicts.filter((c) => {
      if (!isShared) return true;
      return !(
        c.isShared &&
        c.sharedGroupId === sharedGroupId &&
        c.startISO === new Date(startISO).toISOString() &&
        c.endISO === new Date(endISO).toISOString()
      );
    });

    if (illegalConflicts.length) {
      const first = illegalConflicts[0];
      const client = (state.clients || []).find((x) => x.id === first.clientId);
      const sup = (state.users || []).find((u) => u.id === (client?.supervisorId || ""));
      const msg =
        `Conflict: staff already scheduled.\n\n` +
        `Client: ${client?.name || "Unknown"}\n` +
        `Supervisor: ${sup ? sup.name : "Unassigned"}\n` +
        `Time: ${first.startISO.slice(0, 16).replace("T", " ")} → ${first.endISO
          .slice(0, 16)
          .replace("T", " ")}`;

      if (state.settings?.hardStopConflicts) return alert(msg);
      if (!confirm(msg + "\n\nContinue anyway?")) return;
    }

    const addMin = minutesBetweenISO(startISO, endISO);
    const currentMin = staffWeekMinutesMap[staffId] || 0;
    const afterMin = currentMin + addMin;
    const otMin = Math.max(0, afterMin - OT_THRESHOLD_MIN);

    if (otMin > 0) {
      const canOverride =
        state.settings?.allowOvertimeOverride && (overtimeApproved || staff.canOvertime);

      if (state.settings?.hardStopOT && !canOverride) {
        return alert(
          `${staff.name} would exceed 40 hours.\nWeek total after shift: ${fmtHoursFromMin(afterMin)}.\nApprove overtime or choose different staff.`
        );
      }

      if (!canOverride) {
        if (!confirm(`This creates overtime (${fmtHoursFromMin(otMin)}). Continue?`)) return;
      }
    }

    const createdBy = currentUser?.id || "unknown";
    const rows = [
      {
        id: uid("sh"),
        client_id: clientId,
        staff_id: staffId,
        start_iso: startISO,
        end_iso: endISO,
        created_by: createdBy,
        is_shared: !!isShared,
        shared_group_id: sharedGroupId,
        overtime_approved: !!overtimeApproved,
      },
    ];

    if (isShared) {
      rows.push({
        id: uid("sh"),
        client_id: clientId2,
        staff_id: staffId,
        start_iso: startISO,
        end_iso: endISO,
        created_by: createdBy,
        is_shared: true,
        shared_group_id: sharedGroupId,
        overtime_approved: !!overtimeApproved,
      });
    }

    await sbUpsert("shifts", rows);
    await refreshState(setState);
    setShiftDraft((p) => ({
      ...p,
      clientId2: "",
      isShared: false,
      sharedGroupId: "",
      overtimeApproved: false,
    }));
  }

  async function deleteShift(id) {
    if (!confirm("Delete this shift?")) return;
    await sbDelete("shifts", id);
    await refreshState(setState);
  }

  async function runBuilder() {
    if (!builderClientId) return alert("Pick a client for the builder.");
    const start = new Date(weekStartDate);
    const rows = [];
    let shiftsDef = [];

    try {
      if (builderScheduleSource === "client") {
        const schedule = loadClientSchedule(builderClientId);
        if (!schedule?.shifts?.length) return alert("No saved schedule for this client.");
        shiftsDef = schedule.shifts;
      } else if (builderScheduleSource === "custom") {
        shiftsDef = parseShiftPattern(builderCustomTemplate);
      } else {
        shiftsDef =
          builderTemplate === "2x12"
            ? [
                { start: "07:00", end: "19:00" },
                { start: "19:00", end: "07:00" },
              ]
            : [
                { start: "07:00", end: "15:00" },
                { start: "15:00", end: "23:00" },
              ];
      }
    } catch (e) {
      return alert(e.message || "Invalid schedule format.");
    }

    const minutesByStaff = { ...staffWeekMinutesMap };
    const pool = (state.staff || []).filter((s) => s.active !== false);
    let rotIndex = 0;

    const pickStaffForShift = (startISO, endISO) => {
      const weekday = new Date(startISO).getDay();
      const forcedStaffId = builderWeeklyAssignments[weekday];
      const addMin = minutesBetweenISO(startISO, endISO);

      const checkCandidate = (st) => {
        if (getTrainingBlockReason(st)) return false;
        if (!isStaffAvailableForShift(st, startISO, endISO)) return false;

        const hasConflict = (state.shifts || []).some(
          (sh) => sh.staffId === st.id && overlaps(sh.startISO, sh.endISO, startISO, endISO)
        );
        if (hasConflict) return false;

        const currentMin = minutesByStaff[st.id] || 0;
        const afterMin = currentMin + addMin;
        const otMin = Math.max(0, afterMin - OT_THRESHOLD_MIN);
        if (state.settings?.hardStopOT && otMin > 0 && !st.canOvertime) return false;

        minutesByStaff[st.id] = afterMin;
        return true;
      };

      if (forcedStaffId) {
        const forced = pool.find((s) => s.id === forcedStaffId);
        if (forced && checkCandidate(forced)) return forced;
      }

      for (let i = 0; i < pool.length; i++) {
        const idx = (rotIndex + i) % pool.length;
        const st = pool[idx];
        if (checkCandidate(st)) {
          rotIndex = idx + 1;
          return st;
        }
      }
      return null;
    };

    for (let w = 0; w < builderWeeks; w++) {
      const weekStartForRun = addDays(start, w * 7);
      for (let d = 0; d < 7; d++) {
        const day = addDays(weekStartForRun, d);
        const dateStr = isoLocal(day).slice(0, 10);

        for (const { start: sTime, end: eTime } of shiftsDef) {
          const sISO = toISO(dateStr, sTime);
          let eISO = toISO(dateStr, eTime);
          if (new Date(eISO) <= new Date(sISO)) {
            const nd = addDays(new Date(`${dateStr}T00:00:00`), 1);
            eISO = `${isoLocal(nd).slice(0, 10)}T${eTime}:00`;
          }

          const chosen = pickStaffForShift(sISO, eISO);
          if (chosen) {
            rows.push({
              id: uid("sh"),
              client_id: builderClientId,
              staff_id: chosen.id,
              start_iso: sISO,
              end_iso: eISO,
              created_by: currentUser?.id || "builder",
              is_shared: false,
              shared_group_id: "",
              overtime_approved: false,
            });
          }
        }
      }
    }

    if (!rows.length) return alert("Builder did not create any shifts.");
    await sbUpsert("shifts", rows);
    await refreshState(setState);
    setBuilderOpen(false);
    alert(`Builder created ${rows.length} shift rows.`);
  }

  async function saveStaff() {
    if (!staffDraft.name.trim()) return alert("Staff name is required.");

    const row = {
      id: staffDraft.id || uid("st"),
      name: staffDraft.name.trim(),
      active: staffDraft.active !== false,
      availability: JSON.stringify({
        days: Array.isArray(staffDraft.availabilityDays)
          ? [...staffDraft.availabilityDays].sort((a, b) => a - b)
          : [1, 2, 3, 4, 5],
        start: staffDraft.availabilityStart || "07:00",
        end: staffDraft.availabilityEnd || "23:00",
      }),
      cpr_exp: normalizeDateInput(staffDraft.cprExp) || null,
      first_aid_exp: normalizeDateInput(staffDraft.firstAidExp) || null,
      med_exp: normalizeDateInput(staffDraft.medExp) || null,
      can_overtime: !!staffDraft.canOvertime,
    };

    await sbUpsert("staff", [row]);
    await refreshState(setState);

    setStaffDraft({
      id: "",
      name: "",
      active: true,
      availabilityDays: [1, 2, 3, 4, 5],
      availabilityStart: "07:00",
      availabilityEnd: "23:00",
      cprExp: "",
      firstAidExp: "",
      medExp: "",
      canOvertime: false,
    });
  }

  async function removeStaff(id) {
    if (!confirm("Remove staff?")) return;
    await sbDelete("staff", id);
    await refreshState(setState);
  }

  async function saveClient() {
    if (!clientDraft.name.trim()) return alert("Client name required.");
    const row = {
      id: clientDraft.id || uid("cl"),
      name: clientDraft.name.trim(),
      supervisor_id: clientDraft.supervisorId || null,
      coverage_start: clientDraft.coverageStart || "07:00",
      coverage_end: clientDraft.coverageEnd || "23:00",
      weekly_hours: Number(clientDraft.weeklyHours) || 40,
      is_24_hour: !!clientDraft.is24Hour,
      active: clientDraft.active !== false,
    };
    await sbUpsert("clients", [row]);
    await refreshState(setState);
    setClientDraft({
      id: "",
      name: "",
      supervisorId: "",
      coverageStart: "07:00",
      coverageEnd: "23:00",
      weeklyHours: 40,
      is24Hour: false,
      active: true,
    });
  }

  async function deleteClient(id) {
    if (!confirm("Delete this client?")) return;
    const shifts = await sbSelect("shifts");
    const toRemove = (shifts || [])
      .filter((s) => (s.client_id || s.clientId) === id)
      .map((s) => s.id);
    for (const sid of toRemove) await sbDelete("shifts", sid);
    await sbDelete("clients", id);
    await refreshState(setState);
  }

  async function saveUser() {
    if (!userDraft.id.trim() || !userDraft.name.trim() || !userDraft.pin.trim()) {
      return alert("User id, name, and PIN required.");
    }
    await sbUpsert("users", [
      {
        id: userDraft.id.trim(),
        name: userDraft.name.trim(),
        role: userDraft.role,
        pin: userDraft.pin.trim(),
      },
    ]);
    await refreshState(setState);
    setUserDraft({ id: "", name: "", role: "supervisor", pin: "" });
  }

  async function deleteUser(id) {
    if (!confirm("Delete this user?")) return;
    await sbDelete("users", id);
    await refreshState(setState);
  }

  function saveAllNow() {
    alert("Saved / Synced.");
  }

  if (!mounted) return null;
  if (!currentUser) {
    return <LoginScreen users={state.users} onLogin={loginAs} onCreateAdmin={createAdminUser} />;
  }

  return (
    <div style={{ minHeight: "100vh", background: "#0b0c10", color: "white", padding: 16 }}>
      <div style={{ maxWidth: 1280, margin: "0 auto" }}>
        {!SUPABASE_CONFIGURED ? (
          <div style={{ ...styles.card, marginBottom: 12 }} className="no-print">
            <strong>Warning:</strong> Supabase is not configured. Using localStorage fallback.
          </div>
        ) : supabaseError ? (
          <div style={{ ...styles.card, marginBottom: 12 }} className="no-print">
            <strong>Warning:</strong> Supabase requests are failing. Using localStorage fallback.
            <div style={{ marginTop: 6, opacity: 0.85, fontSize: 12 }}>
              {supabaseError.message || supabaseError.code || "Unknown error"}
            </div>
          </div>
        ) : null}

        <div style={styles.rowBetween}>
          <div>
            <div style={{ fontSize: 24, fontWeight: 980 }}>DSW Scheduler</div>
            <div style={styles.tiny}>
              Logged in as <b>{currentUser.name}</b> ({currentUser.role})
            </div>
          </div>
          <div className="no-print" style={{ display: "flex", gap: 8 }}>
            <button style={styles.btn2} onClick={saveAllNow}>Save</button>
            <button style={styles.btn2} onClick={logout}>Logout</button>
          </div>
        </div>

        <div style={{ ...styles.card, marginTop: 12 }}>
          <div style={styles.rowBetween}>
            <div>
              <div style={{ fontWeight: 900, fontSize: 18 }}>Weekly Staffing Health Score</div>
              <div style={styles.tiny}>Week of {weekStart}</div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 28, fontWeight: 980 }}>{weeklyHealthScore.score}</div>
              <div style={styles.tiny}>{weeklyHealthScore.label}</div>
            </div>
          </div>

          <div style={{ ...styles.grid4, marginTop: 12 }}>
            <div style={styles.statCard}>
              <div style={styles.tiny}>Open Gaps</div>
              <div style={styles.statValue}>{weeklyHealthScore.openGapCount}</div>
            </div>
            <div style={styles.statCard}>
              <div style={styles.tiny}>Staff in OT</div>
              <div style={styles.statValue}>{weeklyHealthScore.overtimeStaff}</div>
            </div>
            <div style={styles.statCard}>
              <div style={styles.tiny}>Expired Training</div>
              <div style={styles.statValue}>{weeklyHealthScore.expTrainingCount}</div>
            </div>
            <div style={styles.statCard}>
              <div style={styles.tiny}>Visible Clients</div>
              <div style={styles.statValue}>{weeklyHealthScore.totalVisibleClients}</div>
            </div>
          </div>
        </div>

        <div className="no-print" style={{ marginTop: 10, display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
          <Tabs value={tab} onChange={setTab} tabs={tabs} />
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <div style={styles.tiny}>Week start</div>
            <input style={styles.input} type="date" value={weekStart} onChange={(e) => setWeekStart(e.target.value)} />
          </div>
        </div>

        {tab === "schedule" && (
          <div style={{ marginTop: 12, ...styles.card }}>
            <div style={styles.rowBetween}>
              <h3 style={{ margin: 0 }}>Add Shift</h3>
              <button style={styles.btn2} onClick={() => setBuilderOpen(true)}>
                24-Hour Builder
              </button>
            </div>

            <div style={{ marginTop: 10, ...styles.grid4 }}>
              <div>
                <div style={styles.tiny}>Client</div>
                <select
                  style={styles.select}
                  value={shiftDraft.clientId}
                  onChange={(e) => setShiftDraft((p) => ({ ...p, clientId: e.target.value }))}
                >
                  <option value="">Select…</option>
                  {visibleClients.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <div style={styles.tiny}>Staff</div>
                <div style={{ display: "flex", gap: 8 }}>
                  <select
                    style={styles.select}
                    value={shiftDraft.staffId}
                    onChange={(e) => setShiftDraft((p) => ({ ...p, staffId: e.target.value }))}
                  >
                    <option value="">Select…</option>
                    {suggestedStaff ? (
                      <option value={suggestedStaff.id}>⭐ Suggested: {suggestedStaff.name}</option>
                    ) : null}
                    {getAllowedVisibleStaff()
                      .filter((s) => !suggestedStaff || s.id !== suggestedStaff.id)
                      .map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                  </select>
                  {suggestedStaff && (
                    <button
                      style={{ ...styles.btn2, padding: "2px 8px", fontSize: 13 }}
                      onClick={() => setShiftDraft((p) => ({ ...p, staffId: suggestedStaff.id }))}
                    >
                      Suggest
                    </button>
                  )}
                </div>
              </div>

              <div>
                <div style={styles.tiny}>Start</div>
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    style={styles.input}
                    type="date"
                    value={shiftDraft.startDate}
                    onChange={(e) => setShiftDraft((p) => ({ ...p, startDate: e.target.value }))}
                  />
                  <input
                    style={styles.input}
                    type="time"
                    value={shiftDraft.startTime}
                    onChange={(e) => setShiftDraft((p) => ({ ...p, startTime: e.target.value }))}
                  />
                </div>
              </div>

              <div>
                <div style={styles.tiny}>End</div>
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    style={styles.input}
                    type="date"
                    value={shiftDraft.endDate}
                    onChange={(e) => setShiftDraft((p) => ({ ...p, endDate: e.target.value }))}
                  />
                  <input
                    style={styles.input}
                    type="time"
                    value={shiftDraft.endTime}
                    onChange={(e) => setShiftDraft((p) => ({ ...p, endTime: e.target.value }))}
                  />
                </div>
              </div>
            </div>

            <div style={{ ...styles.grid4, marginTop: 10 }}>
              <label style={styles.checkboxRow}>
                <input
                  type="checkbox"
                  checked={!!shiftDraft.isShared}
                  onChange={(e) => setShiftDraft((p) => ({ ...p, isShared: e.target.checked }))}
                />
                Shared support
              </label>

              {shiftDraft.isShared ? (
                <div>
                  <div style={styles.tiny}>Shared Client 2</div>
                  <select
                    style={styles.select}
                    value={shiftDraft.clientId2}
                    onChange={(e) => setShiftDraft((p) => ({ ...p, clientId2: e.target.value }))}
                  >
                    <option value="">Select…</option>
                    {visibleClients
                      .filter((c) => c.id !== shiftDraft.clientId)
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                  </select>
                </div>
              ) : (
                <div />
              )}

              <div>
                <div style={styles.tiny}>Shared Group ID</div>
                <input
                  style={styles.input}
                  value={shiftDraft.sharedGroupId}
                  onChange={(e) => setShiftDraft((p) => ({ ...p, sharedGroupId: e.target.value }))}
                  placeholder="Optional"
                />
              </div>

              <label style={styles.checkboxRow}>
                <input
                  type="checkbox"
                  checked={!!shiftDraft.overtimeApproved}
                  onChange={(e) => setShiftDraft((p) => ({ ...p, overtimeApproved: e.target.checked }))}
                  disabled={!state.settings.allowOvertimeOverride}
                />
                Overtime approval for this shift
              </label>
            </div>

            {shiftDraft.staffId ? (() => {
              const st = state.staff.find((s) => s.id === shiftDraft.staffId);
              if (!st) return null;
              const training = getTrainingStatus(st);
              const currentMin = staffWeekMinutesMap[st.id] || 0;
              const proposedMin =
                currentMin +
                minutesBetweenISO(
                  toISO(shiftDraft.startDate, shiftDraft.startTime),
                  toISO(shiftDraft.endDate, shiftDraft.endTime)
                );
              return (
                <div style={{ marginTop: 12, ...styles.card }}>
                  <div style={{ fontWeight: 900 }}>{st.name} Weekly Summary</div>
                  <div style={styles.tiny}>
                    Current week hours: <b>{fmtHoursFromMin(currentMin)}</b> • After this shift:{" "}
                    <b>{fmtHoursFromMin(proposedMin)}</b>
                  </div>
                  <div style={styles.tiny}>
                    Availability:{" "}
                    <b>
                      {(st.availability?.days || []).map((d) => WEEKDAY_NAMES[d]).join(", ") || "All days"} |{" "}
                      {st.availability?.start || "00:00"} - {st.availability?.end || "23:59"}
                    </b>
                  </div>
                  {training.expired.length > 0 ? (
                    <div style={styles.warn}>Expired: {training.expired.map((x) => x.label).join(", ")}</div>
                  ) : null}
                  {training.dueSoon.length > 0 ? (
                    <div style={{ ...styles.tiny, color: "#f59e0b", marginTop: 4 }}>
                      Due soon: {training.dueSoon.map((x) => `${x.label} (${x.value})`).join(", ")}
                    </div>
                  ) : null}
                </div>
              );
            })() : null}

            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
              <button style={styles.btn} onClick={addShift}>
                Add Shift
              </button>
            </div>

            {builderOpen ? (
              <div style={styles.modalWrap} className="no-print">
                <div style={{ width: 720, maxWidth: "95%", ...styles.card }}>
                  <h3 style={{ marginTop: 0 }}>24-Hour Builder</h3>
                  <div style={{ display: "grid", gap: 10 }}>
                    <div>
                      <div style={styles.tiny}>Client</div>
                      <select
                        style={styles.select}
                        value={builderClientId}
                        onChange={(e) => setBuilderClientId(e.target.value)}
                      >
                        <option value="">Select…</option>
                        {state.clients.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <div style={styles.tiny}>Schedule source</div>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <label style={styles.checkboxRow}>
                          <input
                            type="radio"
                            name="builderSource"
                            value="template"
                            checked={builderScheduleSource === "template"}
                            onChange={() => setBuilderScheduleSource("template")}
                          />
                          Template
                        </label>
                        <label style={styles.checkboxRow}>
                          <input
                            type="radio"
                            name="builderSource"
                            value="client"
                            checked={builderScheduleSource === "client"}
                            onChange={() => setBuilderScheduleSource("client")}
                          />
                          Client saved
                        </label>
                        <label style={styles.checkboxRow}>
                          <input
                            type="radio"
                            name="builderSource"
                            value="custom"
                            checked={builderScheduleSource === "custom"}
                            onChange={() => setBuilderScheduleSource("custom")}
                          />
                          Custom
                        </label>
                      </div>
                    </div>

                    {builderScheduleSource === "template" ? (
                      <div>
                        <div style={styles.tiny}>Template</div>
                        <select
                          style={styles.select}
                          value={builderTemplate}
                          onChange={(e) => setBuilderTemplate(e.target.value)}
                        >
                          <option value="2x12">2 × 12-hour</option>
                          <option value="2x8">2 × 8-hour</option>
                        </select>
                      </div>
                    ) : null}

                    {builderScheduleSource === "custom" ? (
                      <div>
                        <div style={styles.tiny}>Custom schedule</div>
                        <textarea
                          style={{ ...styles.input, height: 120, resize: "vertical" }}
                          value={builderCustomTemplate}
                          onChange={(e) => setBuilderCustomTemplate(e.target.value)}
                        />
                      </div>
                    ) : null}

                    <div>
                      <div style={styles.tiny}>Generate weeks</div>
                      <select
                        style={styles.select}
                        value={builderWeeks}
                        onChange={(e) => setBuilderWeeks(Number(e.target.value))}
                      >
                        <option value={1}>1 week</option>
                        <option value={2}>2 weeks</option>
                        <option value={4}>4 weeks</option>
                      </select>
                    </div>

                    <div>
                      <div style={styles.tiny}>Weekly staff assignment (optional)</div>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 6 }}>
                        {WEEKDAY_NAMES.map((day, idx) => (
                          <div key={day}>
                            <div style={{ fontSize: 11, opacity: 0.7 }}>{day}</div>
                            <select
                              style={styles.select}
                              value={builderWeeklyAssignments[idx] || ""}
                              onChange={(e) =>
                                setBuilderWeeklyAssignments((p) => ({
                                  ...p,
                                  [idx]: e.target.value,
                                }))
                              }
                            >
                              <option value="">—</option>
                              {state.staff.map((s) => (
                                <option key={s.id} value={s.id}>
                                  {s.name}
                                </option>
                              ))}
                            </select>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                      <button style={styles.btn2} onClick={() => setBuilderOpen(false)}>
                        Cancel
                      </button>
                      <button
                        style={styles.btn2}
                        onClick={() => {
                          if (!builderClientId) return alert("Choose a client first.");
                          try {
                            let shifts = [];
                            if (builderScheduleSource === "template") {
                              shifts =
                                builderTemplate === "2x12"
                                  ? [
                                      { start: "07:00", end: "19:00" },
                                      { start: "19:00", end: "07:00" },
                                    ]
                                  : [
                                      { start: "07:00", end: "15:00" },
                                      { start: "15:00", end: "23:00" },
                                    ];
                            } else if (builderScheduleSource === "custom") {
                              shifts = parseShiftPattern(builderCustomTemplate);
                            } else {
                              shifts = loadClientSchedule(builderClientId)?.shifts || [];
                            }
                            if (!shifts.length) return alert("No shifts to save.");
                            saveClientSchedule(builderClientId, shifts);
                            alert("Saved schedule template.");
                          } catch (e) {
                            alert(e.message || "Invalid schedule format.");
                          }
                        }}
                      >
                        Save Template
                      </button>
                      <button style={styles.btn} onClick={runBuilder}>
                        Generate
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        )}

        {tab === "calendar" && (
          <CalendarWeek
            state={state}
            weekStartDate={weekStartDate}
            visibleClients={visibleClients}
            canSeeAllShifts={isAdmin}
            setTab={setTab}
            setShiftDraft={setShiftDraft}
            deleteShift={deleteShift}
          />
        )}

        {tab === "dailyPrint" && (
          <div style={{ marginTop: 12, ...styles.card }}>
            <div style={styles.rowBetween}>
              <div>
                <h3 style={{ margin: 0 }}>Daily Schedule Printout</h3>
                <div style={styles.tiny}>Print-friendly daily staffing list</div>
              </div>
              <button style={styles.btn2} onClick={() => window.print()}>
                Print / Save PDF
              </button>
            </div>

            <div className="no-print" style={{ marginTop: 12, maxWidth: 220 }}>
              <div style={styles.tiny}>Date</div>
              <input
                style={styles.input}
                type="date"
                value={dailyPrintDate}
                onChange={(e) => setDailyPrintDate(e.target.value)}
              />
            </div>

            <div style={{ marginTop: 14, overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={styles.th}>Client</th>
                    <th style={styles.th}>Staff</th>
                    <th style={styles.th}>Start</th>
                    <th style={styles.th}>End</th>
                    <th style={styles.th}>Shared</th>
                    <th style={styles.th}>OT Override</th>
                  </tr>
                </thead>
                <tbody>
                  {dailyPrintRows.length === 0 ? (
                    <tr>
                      <td style={styles.td} colSpan={6}>
                        No shifts for {dailyPrintDate}
                      </td>
                    </tr>
                  ) : (
                    dailyPrintRows.map((sh) => {
                      const client = state.clients.find((c) => c.id === sh.clientId);
                      const staff = state.staff.find((s) => s.id === sh.staffId);
                      return (
                        <tr key={sh.id}>
                          <td style={styles.td}>{client?.name || "Unknown"}</td>
                          <td style={styles.td}>{staff?.name || "Unknown"}</td>
                          <td style={styles.td}>{sh.startISO.slice(11, 16)}</td>
                          <td style={styles.td}>{sh.endISO.slice(11, 16)}</td>
                          <td style={styles.td}>{sh.isShared ? "Yes" : "No"}</td>
                          <td style={styles.td}>{sh.overtimeApproved ? "Approved" : ""}</td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {tab === "gaps" && (
          <div style={{ marginTop: 12, ...styles.card }}>
            <h3 style={{ marginTop: 0 }}>Coverage Gaps</h3>
            {coverageGaps.length === 0 ? (
              <div style={styles.tiny}>No gaps detected for this week.</div>
            ) : (
              <div style={{ display: "grid", gap: 10 }}>
                {coverageGaps.map((g, idx) => {
                  const c = state.clients.find((x) => x.id === g.clientId);
                  return (
                    <div key={`${g.clientId}_${idx}`} style={styles.shift}>
                      <div style={styles.shiftTitle}>{c?.name || "Unknown Client"}</div>
                      <div style={styles.shiftMeta}>
                        {g.startISO.slice(0, 16).replace("T", " ")} → {g.endISO.slice(0, 16).replace("T", " ")}
                      </div>
                      <div style={{ marginTop: 8 }}>
                        <button
                          style={styles.btn2}
                          onClick={() => {
                            setEmergencyFillDraft({
                              clientId: g.clientId,
                              date: g.startISO.slice(0, 10),
                              startTime: g.startISO.slice(11, 16),
                              endTime: g.endISO.slice(11, 16),
                              isShared: false,
                            });
                            setTab("emergencyFill");
                          }}
                        >
                          Find Replacement Staff
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {tab === "hours" && (
          <div style={{ marginTop: 12, ...styles.card }}>
            <h3 style={{ marginTop: 0 }}>Hours & Overtime</h3>

            <div style={{ ...styles.card, marginBottom: 12 }}>
              <div style={{ fontWeight: 900 }}>Weekly Summary</div>
              <div style={styles.tiny}>
                Staff over 40 hours:{" "}
                <b>{(state.staff || []).filter((st) => (staffWeekMinutesMap[st.id] || 0) > OT_THRESHOLD_MIN).length}</b>
                {" "}• Coverage gaps: <b>{coverageGaps.length}</b>
              </div>
            </div>

            <div style={{ marginTop: 10, overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={styles.th}>Staff</th>
                    <th style={styles.th}>Week Hours</th>
                    <th style={styles.th}>OT Hours</th>
                    <th style={styles.th}>OT Allowed</th>
                    <th style={styles.th}>Training Status</th>
                  </tr>
                </thead>
                <tbody>
                  {state.staff.map((st) => {
                    const min = staffWeekMinutesMap[st.id] || 0;
                    const otMin = Math.max(0, min - OT_THRESHOLD_MIN);
                    const training = getTrainingStatus(st);
                    return (
                      <tr key={st.id}>
                        <td style={styles.td}><b>{st.name}</b></td>
                        <td style={styles.td}>{fmtHoursFromMin(min)}</td>
                        <td style={{ ...styles.td, color: otMin > 0 ? "#ff8b8b" : "inherit" }}>
                          {fmtHoursFromMin(otMin)}
                        </td>
                        <td style={styles.td}>{st.canOvertime ? "Yes" : "No"}</td>
                        <td style={styles.td}>
                          {training.expired.length
                            ? `Expired: ${training.expired.map((x) => x.label).join(", ")}`
                            : training.dueSoon.length
                            ? `Due soon: ${training.dueSoon.map((x) => x.label).join(", ")}`
                            : "OK"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div style={{ marginTop: 16, ...styles.card }}>
              <h3 style={{ marginTop: 0 }}>Client Weekly Hours</h3>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr>
                      <th style={styles.th}>Client</th>
                      <th style={styles.th}>Allotted</th>
                      <th style={styles.th}>Weekly Total</th>
                      <th style={styles.th}>Remaining</th>
                      <th style={styles.th}>Day Hours</th>
                      <th style={styles.th}>Night Hours</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleClients.map((c) => {
                      const h = weekClientHours[c.id] || { totalMin: 0, dayMin: 0, nightMin: 0 };
                      const allottedMin = (Number(c.weeklyHours) || 0) * 60;
                      const remainingMin = allottedMin - h.totalMin;
                      return (
                        <tr key={c.id}>
                          <td style={styles.td}><b>{c.name}</b></td>
                          <td style={styles.td}>{fmtHoursFromMin(allottedMin)}</td>
                          <td style={styles.td}>{fmtHoursFromMin(h.totalMin)}</td>
                          <td style={{ ...styles.td, color: remainingMin < 0 ? "#ff8b8b" : "inherit" }}>
                            {fmtHoursFromMin(remainingMin)}
                          </td>
                          <td style={styles.td}>{fmtHoursFromMin(h.dayMin)}</td>
                          <td style={styles.td}>{fmtHoursFromMin(h.nightMin)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {tab === "emergencyFill" && (
          <div style={{ marginTop: 12, ...styles.card }}>
            <h3 style={{ marginTop: 0 }}>Call-In / Emergency Fill System</h3>

            <div style={{ ...styles.grid4, marginTop: 10 }}>
              <div>
                <div style={styles.tiny}>Client</div>
                <select
                  style={styles.select}
                  value={emergencyFillDraft.clientId}
                  onChange={(e) => setEmergencyFillDraft((p) => ({ ...p, clientId: e.target.value }))}
                >
                  <option value="">Select…</option>
                  {visibleClients.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <div style={styles.tiny}>Date</div>
                <input
                  style={styles.input}
                  type="date"
                  value={emergencyFillDraft.date}
                  onChange={(e) => setEmergencyFillDraft((p) => ({ ...p, date: e.target.value }))}
                />
              </div>

              <div>
                <div style={styles.tiny}>Start</div>
                <input
                  style={styles.input}
                  type="time"
                  value={emergencyFillDraft.startTime}
                  onChange={(e) => setEmergencyFillDraft((p) => ({ ...p, startTime: e.target.value }))}
                />
              </div>

              <div>
                <div style={styles.tiny}>End</div>
                <input
                  style={styles.input}
                  type="time"
                  value={emergencyFillDraft.endTime}
                  onChange={(e) => setEmergencyFillDraft((p) => ({ ...p, endTime: e.target.value }))}
                />
              </div>
            </div>

            <div style={{ marginTop: 14, overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={styles.th}>Staff</th>
                    <th style={styles.th}>Status</th>
                    <th style={styles.th}>Week Hours</th>
                    <th style={styles.th}>After Fill</th>
                    <th style={styles.th}>Notes</th>
                    <th style={styles.th}>Use</th>
                  </tr>
                </thead>
                <tbody>
                  {emergencyFillSuggestions.map((row) => (
                    <tr key={row.staff.id}>
                      <td style={styles.td}><b>{row.staff.name}</b></td>
                      <td style={styles.td}>
                        {row.conflict
                          ? "Conflict"
                          : !row.available
                          ? "Unavailable"
                          : row.trainingBlock
                          ? "Training Block"
                          : row.otMin > 0
                          ? "OT Risk"
                          : "Best Fit"}
                      </td>
                      <td style={styles.td}>{fmtHoursFromMin(row.currentMin)}</td>
                      <td style={styles.td}>{fmtHoursFromMin(row.afterMin)}</td>
                      <td style={styles.td}>
                        {row.conflict
                          ? "Already scheduled"
                          : !row.available
                          ? "Outside availability"
                          : row.trainingBlock
                          ? row.trainingBlock
                          : row.otMin > 0
                          ? `Would add ${fmtHoursFromMin(row.otMin)} OT`
                          : "No conflict, in availability"}
                      </td>
                      <td style={styles.td}>
                        <button
                          style={styles.btn2}
                          onClick={() => {
                            setTab("schedule");
                            setShiftDraft((p) => ({
                              ...p,
                              clientId: emergencyFillDraft.clientId,
                              staffId: row.staff.id,
                              startDate: emergencyFillDraft.date,
                              startTime: emergencyFillDraft.startTime,
                              endDate: emergencyFillDraft.date,
                              endTime: emergencyFillDraft.endTime,
                              overtimeApproved: row.otMin > 0,
                            }));
                          }}
                        >
                          Use
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {tab === "dashboard" && (
          <div style={{ marginTop: 12, ...styles.card }}>
            <h3 style={{ marginTop: 0 }}>Supervisor Dashboard</h3>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={styles.th}>Supervisor</th>
                    <th style={styles.th}>Clients</th>
                    <th style={styles.th}>Shifts</th>
                    <th style={styles.th}>Gaps</th>
                    <th style={styles.th}>Coverage %</th>
                  </tr>
                </thead>
                <tbody>
                  {supervisorDashboard.map((row) => (
                    <tr key={row.supervisor.id}>
                      <td style={styles.td}><b>{row.supervisor.name}</b></td>
                      <td style={styles.td}>{row.clientsCount}</td>
                      <td style={styles.td}>{row.shiftsCount}</td>
                      <td style={styles.td}>{row.gapsCount}</td>
                      <td style={styles.td}>{row.coveragePct}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {tab === "staff" && canSeeAdminUI && (
          <div style={{ marginTop: 12, ...styles.card }}>
            <h3 style={{ marginTop: 0 }}>Staff Availability Profiles</h3>

            <div style={{ ...styles.grid4, marginTop: 10 }}>
              <div>
                <div style={styles.tiny}>Name</div>
                <input
                  style={styles.input}
                  value={staffDraft.name}
                  onChange={(e) => setStaffDraft((p) => ({ ...p, name: e.target.value }))}
                />
              </div>

              <div>
                <div style={styles.tiny}>Availability Start</div>
                <input
                  style={styles.input}
                  type="time"
                  value={staffDraft.availabilityStart}
                  onChange={(e) => setStaffDraft((p) => ({ ...p, availabilityStart: e.target.value }))}
                />
              </div>

              <div>
                <div style={styles.tiny}>Availability End</div>
                <input
                  style={styles.input}
                  type="time"
                  value={staffDraft.availabilityEnd}
                  onChange={(e) => setStaffDraft((p) => ({ ...p, availabilityEnd: e.target.value }))}
                />
              </div>

              <label style={styles.checkboxRow}>
                <input
                  type="checkbox"
                  checked={!!staffDraft.canOvertime}
                  onChange={(e) => setStaffDraft((p) => ({ ...p, canOvertime: e.target.checked }))}
                />
                Can work overtime
              </label>
            </div>

            <div style={{ marginTop: 10 }}>
              <div style={styles.tiny}>Available Days</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 6 }}>
                {WEEKDAY_NAMES.map((day, idx) => (
                  <label key={day} style={styles.checkboxRow}>
                    <input
                      type="checkbox"
                      checked={staffDraft.availabilityDays.includes(idx)}
                      onChange={() =>
                        setStaffDraft((p) => ({
                          ...p,
                          availabilityDays: p.availabilityDays.includes(idx)
                            ? p.availabilityDays.filter((x) => x !== idx)
                            : [...p.availabilityDays, idx].sort((a, b) => a - b),
                        }))
                      }
                    />
                    {day}
                  </label>
                ))}
              </div>
            </div>

            <div style={{ ...styles.grid4, marginTop: 10 }}>
              <div>
                <div style={styles.tiny}>CPR Expiration</div>
                <input
                  style={styles.input}
                  type="date"
                  value={staffDraft.cprExp}
                  onChange={(e) => setStaffDraft((p) => ({ ...p, cprExp: e.target.value }))}
                />
              </div>
              <div>
                <div style={styles.tiny}>First Aid Expiration</div>
                <input
                  style={styles.input}
                  type="date"
                  value={staffDraft.firstAidExp}
                  onChange={(e) => setStaffDraft((p) => ({ ...p, firstAidExp: e.target.value }))}
                />
              </div>
              <div>
                <div style={styles.tiny}>Med Training Expiration</div>
                <input
                  style={styles.input}
                  type="date"
                  value={staffDraft.medExp}
                  onChange={(e) => setStaffDraft((p) => ({ ...p, medExp: e.target.value }))}
                />
              </div>
              <div style={{ display: "flex", alignItems: "end", justifyContent: "flex-end" }}>
                <button style={styles.btn} onClick={saveStaff}>Save Staff</button>
              </div>
            </div>

            <div style={styles.hr} />

            <div style={{ display: "grid", gap: 10 }}>
              {state.staff.map((s) => {
                const training = getTrainingStatus(s);
                return (
                  <div key={s.id} style={styles.shift}>
                    <div style={styles.shiftTop}>
                      <div>
                        <div style={styles.shiftTitle}>{s.name}</div>
                        <div style={styles.shiftMeta}>
                          Status: <b>{s.active !== false ? "Active" : "Inactive"}</b>
                          <br />
                          Availability: {(s.availability?.days || []).map((d) => WEEKDAY_NAMES[d]).join(", ")} •{" "}
                          {s.availability?.start || "00:00"} - {s.availability?.end || "23:59"}
                          <br />
                          CPR: {s.cprExp || "—"} • First Aid: {s.firstAidExp || "—"} • Med: {s.medExp || "—"}
                          <br />
                          OT Permission: <b>{s.canOvertime ? "Yes" : "No"}</b>
                        </div>
                        {training.expired.length ? (
                          <div style={styles.warn}>
                            Training expired: {training.expired.map((x) => x.label).join(", ")}
                          </div>
                        ) : null}
                      </div>
                      <div style={{ display: "flex", gap: 8 }}>
                        <button
                          style={styles.btn2}
                          onClick={() =>
                            setStaffDraft({
                              id: s.id,
                              name: s.name || "",
                              active: s.active !== false,
                              availabilityDays: Array.isArray(s.availability?.days)
                                ? s.availability.days
                                : [1, 2, 3, 4, 5],
                              availabilityStart: s.availability?.start || "07:00",
                              availabilityEnd: s.availability?.end || "23:00",
                              cprExp: normalizeDateInput(s.cprExp),
                              firstAidExp: normalizeDateInput(s.firstAidExp),
                              medExp: normalizeDateInput(s.medExp),
                              canOvertime: !!s.canOvertime,
                            })
                          }
                        >
                          Edit
                        </button>
                        <button style={styles.btn2} onClick={() => removeStaff(s.id)}>Remove</button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {tab === "clients" && canSeeAdminUI && (
          <div style={{ marginTop: 12, ...styles.card }}>
            <h3 style={{ marginTop: 0 }}>Clients</h3>

            <div style={{ ...styles.grid4, marginTop: 10 }}>
              <div>
                <div style={styles.tiny}>Client name</div>
                <input
                  style={styles.input}
                  value={clientDraft.name}
                  onChange={(e) => setClientDraft((p) => ({ ...p, name: e.target.value }))}
                />
              </div>
              <div>
                <div style={styles.tiny}>Supervisor</div>
                <select
                  style={styles.select}
                  value={clientDraft.supervisorId}
                  onChange={(e) => setClientDraft((p) => ({ ...p, supervisorId: e.target.value }))}
                >
                  <option value="">Unassigned</option>
                  {state.users
                    .filter((u) => u.role === "supervisor" || u.role === "admin")
                    .map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name} ({u.role})
                      </option>
                    ))}
                </select>
              </div>
              <div>
                <div style={styles.tiny}>Coverage Start</div>
                <input
                  style={styles.input}
                  type="time"
                  value={clientDraft.coverageStart}
                  onChange={(e) => setClientDraft((p) => ({ ...p, coverageStart: e.target.value }))}
                />
              </div>
              <div>
                <div style={styles.tiny}>Coverage End</div>
                <input
                  style={styles.input}
                  type="time"
                  value={clientDraft.coverageEnd}
                  onChange={(e) => setClientDraft((p) => ({ ...p, coverageEnd: e.target.value }))}
                />
              </div>
            </div>

            <div style={{ ...styles.grid4, marginTop: 10 }}>
              <div>
                <div style={styles.tiny}>Weekly Hours</div>
                <input
                  style={styles.input}
                  type="number"
                  min={0}
                  value={clientDraft.weeklyHours}
                  onChange={(e) => setClientDraft((p) => ({ ...p, weeklyHours: Number(e.target.value) }))}
                />
              </div>
              <label style={styles.checkboxRow}>
                <input
                  type="checkbox"
                  checked={!!clientDraft.is24Hour}
                  onChange={(e) => setClientDraft((p) => ({ ...p, is24Hour: e.target.checked }))}
                />
                24-hour client
              </label>
              <div />
              <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "end" }}>
                <button style={styles.btn} onClick={saveClient}>Save Client</button>
              </div>
            </div>

            <div style={styles.hr} />

            <div style={{ display: "grid", gap: 10 }}>
              {state.clients.map((c) => {
                const sup = state.users.find((u) => u.id === c.supervisorId);
                return (
                  <div key={c.id} style={styles.shift}>
                    <div style={styles.shiftTop}>
                      <div>
                        <div style={styles.shiftTitle}>{c.name}</div>
                        <div style={styles.shiftMeta}>
                          Supervisor: <b>{sup ? sup.name : "Unassigned"}</b>
                          <br />
                          Coverage: {c.coverageStart} → {c.coverageEnd}
                          <br />
                          Weekly Hours: <b>{c.weeklyHours}</b> {c.is24Hour ? "• 24h" : ""}
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: 8 }}>
                        <button
                          style={styles.btn2}
                          onClick={() =>
                            setClientDraft({
                              id: c.id,
                              name: c.name,
                              supervisorId: c.supervisorId || "",
                              coverageStart: c.coverageStart || "07:00",
                              coverageEnd: c.coverageEnd || "23:00",
                              weeklyHours: Number(c.weeklyHours) || 40,
                              is24Hour: !!c.is24Hour,
                              active: c.active !== false,
                            })
                          }
                        >
                          Edit
                        </button>
                        <button
                          style={styles.btn2}
                          onClick={() => {
                            setBuilderClientId(c.id);
                            setBuilderOpen(true);
                            setTab("schedule");
                          }}
                        >
                          Schedule
                        </button>
                        <button style={styles.btn2} onClick={() => deleteClient(c.id)}>Delete</button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {tab === "users" && canSeeAdminUI && (
          <div style={{ marginTop: 12, ...styles.card }}>
            <h3 style={{ marginTop: 0 }}>Users</h3>

            <div style={{ ...styles.grid4, marginTop: 10 }}>
              <div>
                <div style={styles.tiny}>User ID</div>
                <input
                  style={styles.input}
                  value={userDraft.id}
                  onChange={(e) => setUserDraft((p) => ({ ...p, id: e.target.value }))}
                />
              </div>
              <div>
                <div style={styles.tiny}>Name</div>
                <input
                  style={styles.input}
                  value={userDraft.name}
                  onChange={(e) => setUserDraft((p) => ({ ...p, name: e.target.value }))}
                />
              </div>
              <div>
                <div style={styles.tiny}>Role</div>
                <select
                  style={styles.select}
                  value={userDraft.role}
                  onChange={(e) => setUserDraft((p) => ({ ...p, role: e.target.value }))}
                >
                  <option value="supervisor">supervisor</option>
                  <option value="admin">admin</option>
                </select>
              </div>
              <div>
                <div style={styles.tiny}>PIN</div>
                <input
                  style={styles.input}
                  value={userDraft.pin}
                  onChange={(e) => setUserDraft((p) => ({ ...p, pin: e.target.value }))}
                />
              </div>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
              <button style={styles.btn} onClick={saveUser}>Save User</button>
            </div>

            <div style={styles.hr} />

            <div style={{ display: "grid", gap: 10 }}>
              {state.users.map((u) => (
                <div key={u.id} style={styles.shift}>
                  <div style={styles.shiftTop}>
                    <div>
                      <div style={styles.shiftTitle}>{u.name}</div>
                      <div style={styles.shiftMeta}>ID: {u.id} • Role: {u.role}</div>
                    </div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button style={styles.btn2} onClick={() => setUserDraft({ ...u })}>Edit</button>
                      <button style={styles.btn2} onClick={() => deleteUser(u.id)}>Delete</button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === "settings" && canSeeAdminUI && (
          <div style={{ marginTop: 12, ...styles.card }}>
            <h3 style={{ marginTop: 0 }}>Settings</h3>

            <label style={styles.checkboxRow}>
              <input
                type="checkbox"
                checked={!!state.settings.includeUnassignedForSupervisors}
                onChange={(e) =>
                  setState((p) => ({
                    ...p,
                    settings: { ...p.settings, includeUnassignedForSupervisors: e.target.checked },
                  }))
                }
              />
              Supervisors can see unassigned clients
            </label>

            <label style={styles.checkboxRow}>
              <input
                type="checkbox"
                checked={!!state.settings.hardStopConflicts}
                onChange={(e) =>
                  setState((p) => ({
                    ...p,
                    settings: { ...p.settings, hardStopConflicts: e.target.checked },
                  }))
                }
              />
              Hard-stop shift conflicts
            </label>

            <label style={styles.checkboxRow}>
              <input
                type="checkbox"
                checked={!!state.settings.hardStopOT}
                onChange={(e) =>
                  setState((p) => ({
                    ...p,
                    settings: { ...p.settings, hardStopOT: e.target.checked },
                  }))
                }
              />
              Hard-stop over 40 hours
            </label>

            <label style={styles.checkboxRow}>
              <input
                type="checkbox"
                checked={!!state.settings.allowOvertimeOverride}
                onChange={(e) =>
                  setState((p) => ({
                    ...p,
                    settings: { ...p.settings, allowOvertimeOverride: e.target.checked },
                  }))
                }
              />
              Allow overtime approval override
            </label>

            <label style={styles.checkboxRow}>
              <input
                type="checkbox"
                checked={!!state.settings.blockExpiredTraining}
                onChange={(e) =>
                  setState((p) => ({
                    ...p,
                    settings: { ...p.settings, blockExpiredTraining: e.target.checked },
                  }))
                }
              />
              Block scheduling when training expired
            </label>
          </div>
        )}
      </div>
    </div>
  );
}

/* =========================
   Styles
========================= */

const styles = {
  card: {
    border: "1px solid rgba(255,255,255,0.12)",
    borderRadius: 16,
    padding: 14,
    background: "rgba(255,255,255,0.04)",
  },
  statCard: {
    border: "1px solid rgba(255,255,255,0.12)",
    borderRadius: 14,
    padding: 12,
    background: "rgba(255,255,255,0.03)",
  },
  statValue: {
    fontSize: 24,
    fontWeight: 980,
    marginTop: 4,
  },
  btn: {
    padding: "10px 12px",
    borderRadius: 12,
    border: "1px solid rgba(31,111,235,0.7)",
    background: "#1f6feb",
    color: "white",
    fontWeight: 900,
    cursor: "pointer",
  },
  btn2: {
    padding: "9px 12px",
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.18)",
    background: "transparent",
    color: "white",
    fontWeight: 850,
    cursor: "pointer",
  },
  input: {
    width: "100%",
    padding: "10px 10px",
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.18)",
    background: "rgba(255,255,255,0.03)",
    color: "white",
    outline: "none",
  },
  select: {
    width: "100%",
    padding: "10px 10px",
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.18)",
    background: "rgba(15,15,20,0.9)",
    color: "white",
    outline: "none",
  },
  grid4: {
    display: "grid",
    gridTemplateColumns: "repeat(4, minmax(220px, 1fr))",
    gap: 10,
  },
  twoCol: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 10,
  },
  tiny: {
    fontSize: 12,
    opacity: 0.8,
  },
  shift: {
    border: "1px solid rgba(255,255,255,0.12)",
    borderRadius: 14,
    padding: 10,
    background: "rgba(255,255,255,0.03)",
  },
  shiftTop: {
    display: "flex",
    justifyContent: "space-between",
    gap: 8,
    alignItems: "flex-start",
  },
  shiftTitle: {
    fontWeight: 950,
    fontSize: 13,
    marginBottom: 4,
  },
  shiftMeta: {
    fontSize: 12,
    opacity: 0.86,
    lineHeight: 1.35,
  },
  hr: {
    height: 1,
    background: "rgba(255,255,255,0.10)",
    margin: "12px 0",
  },
  warn: {
    color: "#f59e0b",
    fontSize: 13,
    marginTop: 6,
  },
  th: {
    textAlign: "left",
    fontSize: 12,
    opacity: 0.85,
    padding: "8px 6px",
    borderBottom: "1px solid rgba(255,255,255,0.10)",
  },
  td: {
    padding: "8px 6px",
    borderBottom: "1px solid rgba(255,255,255,0.06)",
    fontSize: 13,
  },
  rowBetween: {
    display: "flex",
    justifyContent: "space-between",
    gap: 12,
    alignItems: "center",
    flexWrap: "wrap",
  },
  checkboxRow: {
    display: "flex",
    gap: 8,
    alignItems: "center",
  },
  modalWrap: {
    position: "fixed",
    inset: 0,
    display: "grid",
    placeItems: "center",
    background: "rgba(0,0,0,0.6)",
    zIndex: 50,
  },
};
