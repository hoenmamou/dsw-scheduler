"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * DSW Scheduler (Clients + Shifts + 40hr OT Guard) - Single-file MVP
 * Works in a plain Next.js app router project (no extra UI libraries).
 *
 * Features:
 * - Staff + Client lists
 * - Weekly schedule view (Mon/Sun week start toggle)
 * - Add/Edit/Delete shifts (staff + client + date + start/end)
 * - Prevent overlapping shifts for same staff (same day)
 * - Weekly hours calculation per staff
 * - Overtime marking at threshold (default 40)
 * - Optional guardrail: block saving shift that pushes staff > threshold
 * - LocalStorage save + Export/Import JSON
 */

const LS_KEY = "dsw_scheduler_mvp_v2";

function uid(prefix = "id") {
  return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function toISODate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

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
  // weekStartsOn: 0=Sun, 1=Mon
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

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd; // half-open intervals
}

function minutesToHours(mins) {
  return mins / 60;
}

function fmtHours(h) {
  return `${Math.round(h * 10) / 10}`;
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

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ""));
    r.onerror = reject;
    r.readAsText(file);
  });
}

const DEFAULT_STATE = {
  settings: {
    weekStartsOn: 1, // Monday
    overtimeThresholdHours: 40,
    blockOvertime: true,
  },
  staff: [],
  clients: [],
  shifts: [], // {id, dateISO, start, end, staffId, clientId, notes}
};

const styles = {
  page: { minHeight: "100vh", background: "#0b0c10", color: "#e8e8e8", padding: 16 },
  wrap: { maxWidth: 1200, margin: "0 auto", display: "flex", flexDirection: "column", gap: 12 },
  header: { display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 12, flexWrap: "wrap" },
  h1: { margin: 0, fontSize: 28, fontWeight: 700 },
  sub: { margin: "6px 0 0", fontSize: 13, opacity: 0.8, maxWidth: 760 },
  row: { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" },
  card: { background: "#12141a", border: "1px solid rgba(255,255,255,0.10)", borderRadius: 16, padding: 12 },
  btn: {
    background: "#1f6feb",
    border: "1px solid rgba(255,255,255,0.18)",
    color: "white",
    padding: "8px 10px",
    borderRadius: 10,
    cursor: "pointer",
    fontWeight: 600,
    fontSize: 13,
  },
  btn2: {
    background: "transparent",
    border: "1px solid rgba(255,255,255,0.18)",
    color: "#e8e8e8",
    padding: "8px 10px",
    borderRadius: 10,
    cursor: "pointer",
    fontWeight: 600,
    fontSize: 13,
  },
  btnDanger: {
    background: "#e11d48",
    border: "1px solid rgba(255,255,255,0.18)",
    color: "white",
    padding: "8px 10px",
    borderRadius: 10,
    cursor: "pointer",
    fontWeight: 700,
    fontSize: 13,
  },
  input: {
    background: "#0f1117",
    color: "#e8e8e8",
    border: "1px solid rgba(255,255,255,0.14)",
    borderRadius: 10,
    padding: "8px 10px",
    outline: "none",
    fontSize: 13,
  },
  select: {
    background: "#0f1117",
    color: "#e8e8e8",
    border: "1px solid rgba(255,255,255,0.14)",
    borderRadius: 10,
    padding: "8px 10px",
    outline: "none",
    fontSize: 13,
  },
  label: { fontSize: 12, opacity: 0.8, marginBottom: 6 },
  badge: (kind) => ({
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "3px 10px",
    borderRadius: 999,
    fontSize: 12,
    border: "1px solid rgba(255,255,255,0.16)",
    background:
      kind === "ot"
        ? "rgba(225,29,72,0.20)"
        : kind === "near"
          ? "rgba(245,158,11,0.20)"
          : "rgba(34,197,94,0.15)",
  }),
  grid7: { display: "grid", gridTemplateColumns: "repeat(7, minmax(160px, 1fr))", gap: 10, overflowX: "auto", paddingBottom: 4 },
  dayHead: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 },
  tiny: { fontSize: 12, opacity: 0.8 },
  shift: { border: "1px solid rgba(255,255,255,0.12)", borderRadius: 14, padding: 10, background: "rgba(255,255,255,0.03)" },
  shiftTop: { display: "flex", justifyContent: "space-between", gap: 8, alignItems: "flex-start" },
  shiftTitle: { fontWeight: 700, fontSize: 13, marginBottom: 4 },
  shiftMeta: { fontSize: 12, opacity: 0.85, lineHeight: 1.35 },
  hr: { height: 1, background: "rgba(255,255,255,0.10)", margin: "10px 0" },
  modalOverlay: {
    position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)",
    display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
  },
  modal: { width: "min(720px, 100%)", background: "#12141a", borderRadius: 16, border: "1px solid rgba(255,255,255,0.12)", padding: 14 },
  modalTitle: { fontSize: 18, fontWeight: 800, margin: 0 },
  twoCol: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 },
  threeCol: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 },
  warn: { color: "#f59e0b", fontSize: 13, marginTop: 6 },
  err: { color: "#fb7185", fontSize: 13, marginTop: 6 },
};

function Tabs({ value, onChange, tabs }) {
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
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

export default function Page() {
  const [state, setState] = useState(() => {
    const raw = typeof window !== "undefined" ? localStorage.getItem(LS_KEY) : null;
    if (!raw) return DEFAULT_STATE;
    try {
      const parsed = JSON.parse(raw);
      return {
        settings: { ...DEFAULT_STATE.settings, ...(parsed.settings || {}) },
        staff: Array.isArray(parsed.staff) ? parsed.staff : [],
        clients: Array.isArray(parsed.clients) ? parsed.clients : [],
        shifts: Array.isArray(parsed.shifts) ? parsed.shifts : [],
      };
    } catch {
      return DEFAULT_STATE;
    }
  });

  useEffect(() => {
    localStorage.setItem(LS_KEY, JSON.stringify(state));
  }, [state]);

  const [tab, setTab] = useState("schedule");
  const [weekAnchorISO, setWeekAnchorISO] = useState(() => toISODate(new Date()));
  const weekStartISO = useMemo(
    () => startOfWeekISO(weekAnchorISO, state.settings.weekStartsOn),
    [weekAnchorISO, state.settings.weekStartsOn]
  );
  const weekDays = useMemo(() => Array.from({ length: 7 }, (_, i) => addDaysISO(weekStartISO, i)), [weekStartISO]);

  const staffById = useMemo(() => new Map(state.staff.map((s) => [s.id, s])), [state.staff]);
  const clientById = useMemo(() => new Map(state.clients.map((c) => [c.id, c])), [state.clients]);

  const weekShifts = useMemo(() => {
    const set = new Set(weekDays);
    return state.shifts.filter((sh) => set.has(sh.dateISO));
  }, [state.shifts, weekDays]);

  const staffWeekHours = useMemo(() => {
    const map = new Map();
    for (const s of state.staff) map.set(s.id, 0);
    for (const sh of weekShifts) {
      const a = parseTimeToMinutes(sh.start);
      const b = parseTimeToMinutes(sh.end);
      if (Number.isNaN(a) || Number.isNaN(b) || b <= a) continue;
      const mins = b - a;
      map.set(sh.staffId, (map.get(sh.staffId) || 0) + mins);
    }
    const out = new Map();
    for (const [k, mins] of map.entries()) out.set(k, minutesToHours(mins));
    return out;
  }, [weekShifts, state.staff]);

  const shiftsByDay = useMemo(() => {
    const map = new Map();
    for (const d of weekDays) map.set(d, []);
    for (const sh of weekShifts) {
      if (!map.has(sh.dateISO)) map.set(sh.dateISO, []);
      map.get(sh.dateISO).push(sh);
    }
    for (const [d, arr] of map.entries()) {
      arr.sort((x, y) => parseTimeToMinutes(x.start) - parseTimeToMinutes(y.start));
      map.set(d, arr);
    }
    return map;
  }, [weekShifts, weekDays]);

  // --- Modal (Add/Edit Shift)
  const [modalOpen, setModalOpen] = useState(false);
  const [editingShiftId, setEditingShiftId] = useState(null);
  const fileInputRef = useRef(null);

  const defaultShiftForm = useMemo(
    () => ({
      dateISO: weekStartISO,
      start: "08:00",
      end: "16:00",
      staffId: state.staff[0]?.id || "",
      clientId: state.clients[0]?.id || "",
      notes: "",
    }),
    [weekStartISO, state.staff, state.clients]
  );

  const [shiftForm, setShiftForm] = useState(defaultShiftForm);

  function openNewShift(dateISO) {
    setEditingShiftId(null);
    setShiftForm({ ...defaultShiftForm, dateISO });
    setModalOpen(true);
  }

  function openEditShift(id) {
    const sh = state.shifts.find((x) => x.id === id);
    if (!sh) return;
    setEditingShiftId(id);
    setShiftForm({
      dateISO: sh.dateISO,
      start: sh.start,
      end: sh.end,
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

  const shiftValidation = useMemo(() => {
    const issues = [];
    const warnings = [];

    const { dateISO, start, end, staffId, clientId } = shiftForm;
    if (!dateISO) issues.push("Date is required.");
    if (!staffId) issues.push("Staff is required.");
    if (!clientId) issues.push("Client is required.");

    const a = parseTimeToMinutes(start);
    const b = parseTimeToMinutes(end);
    if (Number.isNaN(a) || Number.isNaN(b)) issues.push("Start/End times must be valid.");
    else if (b <= a) issues.push("End time must be after Start time.");

    // Overlap check for same staff/day
    if (!issues.length && staffId && dateISO) {
      const same = state.shifts.filter(
        (sh) => sh.staffId === staffId && sh.dateISO === dateISO && sh.id !== editingShiftId
      );
      for (const sh of same) {
        const s2 = parseTimeToMinutes(sh.start);
        const e2 = parseTimeToMinutes(sh.end);
        if (!Number.isNaN(s2) && !Number.isNaN(e2) && overlaps(a, b, s2, e2)) {
          issues.push("This shift overlaps another shift for the same staff.");
          break;
        }
      }
    }

    // Weekly OT guard (exclude editing shift)
    if (!issues.length && staffId && dateISO && !Number.isNaN(a) && !Number.isNaN(b) && b > a) {
      const set = new Set(weekDays);
      const current = state.shifts
        .filter((sh) => set.has(sh.dateISO) && sh.staffId === staffId && sh.id !== editingShiftId)
        .reduce((acc, sh) => {
          const x = parseTimeToMinutes(sh.start);
          const y = parseTimeToMinutes(sh.end);
          if (Number.isNaN(x) || Number.isNaN(y) || y <= x) return acc;
          return acc + minutesToHours(y - x);
        }, 0);

      const thisShift = minutesToHours(b - a);
      const newTotal = current + thisShift;
      const threshold = state.settings.overtimeThresholdHours;

      if (newTotal > threshold) {
        const msg = `This would put the staff at ${fmtHours(newTotal)} hrs for the week (>${threshold}).`;
        if (state.settings.blockOvertime) issues.push(msg);
        else warnings.push(msg);
      } else if (threshold - current <= 4) {
        warnings.push(`Heads up: only ${fmtHours(Math.max(0, threshold - current))} hrs remaining before OT.`);
      }
    }

    return { issues, warnings };
  }, [shiftForm, state.shifts, editingShiftId, weekDays, state.settings]);

  function saveShift() {
    if (shiftValidation.issues.length) return;

    const payload = {
      id: editingShiftId || uid("shift"),
      dateISO: shiftForm.dateISO,
      start: shiftForm.start,
      end: shiftForm.end,
      staffId: shiftForm.staffId,
      clientId: shiftForm.clientId,
      notes: shiftForm.notes || "",
    };

    setState((p) => ({
      ...p,
      shifts: editingShiftId ? p.shifts.map((x) => (x.id === editingShiftId ? payload : x)) : [payload, ...p.shifts],
    }));
    setModalOpen(false);
    setEditingShiftId(null);
  }

  // Staff/client CRUD
  const [staffName, setStaffName] = useState("");
  const [clientName, setClientName] = useState("");

  function addStaff() {
    const name = staffName.trim();
    if (!name) return;
    setState((p) => ({ ...p, staff: [{ id: uid("staff"), name }, ...p.staff] }));
    setStaffName("");
  }

  function addClient() {
    const name = clientName.trim();
    if (!name) return;
    setState((p) => ({ ...p, clients: [{ id: uid("client"), name }, ...p.clients] }));
    setClientName("");
  }

  function deleteStaff(id) {
    if (!confirm("Delete this staff? This will remove their shifts too.")) return;
    setState((p) => ({
      ...p,
      staff: p.staff.filter((s) => s.id !== id),
      shifts: p.shifts.filter((sh) => sh.staffId !== id),
    }));
  }

  function deleteClient(id) {
    if (!confirm("Delete this client? This will remove related shifts too.")) return;
    setState((p) => ({
      ...p,
      clients: p.clients.filter((c) => c.id !== id),
      shifts: p.shifts.filter((sh) => sh.clientId !== id),
    }));
  }

  async function importJSON(file) {
    try {
      const text = await readFileAsText(file);
      const parsed = JSON.parse(text);
      const next = {
        settings: { ...DEFAULT_STATE.settings, ...(parsed.settings || {}) },
        staff: Array.isArray(parsed.staff) ? parsed.staff : [],
        clients: Array.isArray(parsed.clients) ? parsed.clients : [],
        shifts: Array.isArray(parsed.shifts) ? parsed.shifts : [],
      };
      setState(next);
    } catch {
      alert("Import failed. Please select a valid exported JSON file.");
    }
  }

  function resetAll() {
    if (!confirm("Reset all data? This cannot be undone.")) return;
    setState(DEFAULT_STATE);
  }

  const weekSummary = useMemo(() => {
    const threshold = state.settings.overtimeThresholdHours;
    return state.staff
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((s) => {
        const h = staffWeekHours.get(s.id) || 0;
        return {
          staff: s,
          hours: h,
          status: h >= threshold ? "ot" : h >= threshold - 4 ? "near" : "ok",
        };
      });
  }, [state.staff, staffWeekHours, state.settings.overtimeThresholdHours]);

  return (
    <div style={styles.page}>
      <div style={styles.wrap}>
        <div style={styles.header}>
          <div>
            <h1 style={styles.h1}>DSW Scheduler</h1>
            <p style={styles.sub}>
              Schedule by client coverage and automatically track weekly hours. Staff are marked <b>OT</b> at{" "}
              {state.settings.overtimeThresholdHours} hours. Guardrail can block saving shifts that push over the limit.
            </p>
          </div>
          <div style={styles.row}>
            <button
              style={styles.btn2}
              onClick={() => downloadJSON(`dsw-scheduler_${weekStartISO}.json`, state)}
              title="Export JSON"
            >
              Export
            </button>
            <button style={styles.btn2} onClick={() => fileInputRef.current?.click()} title="Import JSON">
              Import
            </button>
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
            <button style={styles.btnDanger} onClick={resetAll} title="Reset all data">
              Reset
            </button>
          </div>
        </div>

        <div style={{ ...styles.card, display: "grid", gridTemplateColumns: "1.2fr 1fr 1fr", gap: 12 }}>
          <div>
            <div style={styles.label}>Week of</div>
            <div style={styles.row}>
              <input
                style={styles.input}
                type="date"
                value={weekAnchorISO}
                onChange={(e) => setWeekAnchorISO(e.target.value)}
              />
              <button style={styles.btn2} onClick={() => setWeekAnchorISO(toISODate(new Date()))}>
                Today
              </button>
              <button style={styles.btn2} onClick={() => setWeekAnchorISO(addDaysISO(weekAnchorISO, -7))}>
                Prev
              </button>
              <button style={styles.btn2} onClick={() => setWeekAnchorISO(addDaysISO(weekAnchorISO, 7))}>
                Next
              </button>
            </div>
            <div style={{ marginTop: 8, fontSize: 12, opacity: 0.8 }}>
              Week starts:{" "}
              <select
                style={styles.select}
                value={String(state.settings.weekStartsOn)}
                onChange={(e) =>
                  setState((p) => ({ ...p, settings: { ...p.settings, weekStartsOn: Number(e.target.value) } }))
                }
              >
                <option value="1">Monday</option>
                <option value="0">Sunday</option>
              </select>
            </div>
          </div>

          <div>
            <div style={styles.label}>Overtime guardrail</div>
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={state.settings.blockOvertime}
                  onChange={(e) =>
                    setState((p) => ({ ...p, settings: { ...p.settings, blockOvertime: e.target.checked } }))
                  }
                />
                Block saving shifts over threshold
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
                      settings: {
                        ...p.settings,
                        overtimeThresholdHours: Math.max(1, Math.min(120, Number(e.target.value || 40))),
                      },
                    }))
                  }
                />
              </div>
            </div>
            <div style={{ marginTop: 8, fontSize: 12, opacity: 0.8 }}>
              OT means <b>reached or exceeded</b> the threshold for the selected week.
            </div>
          </div>

          <div>
            <div style={styles.label}>Quick stats</div>
            <div style={styles.row}>
              <span style={styles.badge("ok")}>Staff: {state.staff.length}</span>
              <span style={styles.badge("ok")}>Clients: {state.clients.length}</span>
              <span style={styles.badge(weekSummary.some((x) => x.status === "ot") ? "ot" : "ok")}>
                OT this week: {weekSummary.filter((x) => x.status === "ot").length}
              </span>
            </div>
          </div>
        </div>

        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { value: "schedule", label: "Schedule" },
            { value: "hours", label: "Hours & OT" },
            { value: "staff", label: "Staff" },
            { value: "clients", label: "Clients" },
          ]}
        />

        {tab === "schedule" && (
          <div style={styles.grid7}>
            {weekDays.map((dateISO) => {
              const d = parseISODate(dateISO);
              const label = d
                ? d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })
                : dateISO;
              const dayShifts = shiftsByDay.get(dateISO) || [];

              return (
                <div key={dateISO} style={styles.card}>
                  <div style={styles.dayHead}>
                    <div>
                      <div style={{ fontWeight: 800 }}>{label}</div>
                      <div style={styles.tiny}>{dateISO}</div>
                    </div>
                    <button style={styles.btn2} onClick={() => openNewShift(dateISO)}>
                      + Shift
                    </button>
                  </div>

                  <div style={styles.hr} />

                  {dayShifts.length === 0 ? (
                    <div style={{ fontSize: 12, opacity: 0.75 }}>No shifts</div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      {dayShifts.map((sh) => {
                        const s = staffById.get(sh.staffId);
                        const c = clientById.get(sh.clientId);
                        const staffHours = staffWeekHours.get(sh.staffId) || 0;
                        const threshold = state.settings.overtimeThresholdHours;

                        const a = parseTimeToMinutes(sh.start);
                        const b = parseTimeToMinutes(sh.end);
                        const shiftHours =
                          !Number.isNaN(a) && !Number.isNaN(b) && b > a ? minutesToHours(b - a) : 0;

                        const status = staffHours >= threshold ? "ot" : staffHours >= threshold - 4 ? "near" : "ok";

                        return (
                          <div key={sh.id} style={styles.shift}>
                            <div style={styles.shiftTop}>
                              <div style={{ minWidth: 0 }}>
                                <div style={styles.shiftTitle}>
                                  {sh.start}–{sh.end} <span style={{ opacity: 0.8 }}>({fmtHours(shiftHours)}h)</span>
                                </div>
                                <div style={styles.shiftMeta}>
                                  <div><b>{s?.name || "Staff missing"}</b></div>
                                  <div>{c?.name || "Client missing"}</div>
                                  <div style={{ marginTop: 6 }}>
                                    <span style={styles.badge(status)}>
                                      {status === "ot" ? "OT" : status === "near" ? "Near OT" : "OK"} ·{" "}
                                      {fmtHours(staffHours)}h week
                                    </span>
                                  </div>
                                </div>
                              </div>

                              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
                                <button style={styles.btn2} onClick={() => openEditShift(sh.id)}>
                                  Edit
                                </button>
                                <button style={styles.btnDanger} onClick={() => deleteShift(sh.id)}>
                                  Delete
                                </button>
                              </div>
                            </div>

                            {sh.notes ? (
                              <div style={{ marginTop: 8, fontSize: 12, opacity: 0.8, whiteSpace: "pre-wrap" }}>
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

        {tab === "hours" && (
          <div style={styles.card}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
              <div>
                <div style={{ fontSize: 18, fontWeight: 900 }}>Weekly hours</div>
                <div style={{ fontSize: 12, opacity: 0.8 }}>Week starting {weekStartISO}</div>
              </div>
              <div style={styles.row}>
                <span style={styles.badge("ok")}>Threshold: {state.settings.overtimeThresholdHours}h</span>
                <span style={styles.badge(state.settings.blockOvertime ? "ok" : "near")}>
                  Guardrail: {state.settings.blockOvertime ? "Blocking OT" : "Warning only"}
                </span>
              </div>
            </div>

            <div style={styles.hr} />

            {weekSummary.length === 0 ? (
              <div style={{ fontSize: 13, opacity: 0.8 }}>Add staff to start tracking hours.</div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 10 }}>
                {weekSummary.map(({ staff, hours, status }) => (
                  <div key={staff.id} style={{ border: "1px solid rgba(255,255,255,0.12)", borderRadius: 14, padding: 12 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                      <div style={{ fontWeight: 900 }}>{staff.name}</div>
                      <span style={styles.badge(status)}>{status === "ot" ? "OT" : status === "near" ? "Near OT" : "OK"}</span>
                    </div>
                    <div style={{ marginTop: 10, display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
                      <div>
                        <div style={{ fontSize: 34, fontWeight: 950, lineHeight: 1 }}>{fmtHours(hours)}</div>
                        <div style={{ fontSize: 12, opacity: 0.8 }}>hours this week</div>
                      </div>
                      <div style={{ fontSize: 12, opacity: 0.8 }}>
                        Remaining: {fmtHours(Math.max(0, state.settings.overtimeThresholdHours - hours))}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === "staff" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1.4fr", gap: 12 }}>
            <div style={styles.card}>
              <div style={{ fontSize: 16, fontWeight: 900, marginBottom: 8 }}>Add staff</div>
              <div style={styles.label}>Name</div>
              <input style={{ ...styles.input, width: "100%" }} value={staffName} onChange={(e) => setStaffName(e.target.value)} />
              <div style={{ marginTop: 10 }}>
                <button style={styles.btn} onClick={addStaff}>Add Staff</button>
              </div>
              <div style={{ marginTop: 10, fontSize: 12, opacity: 0.8 }}>
                Tip: Add your DSW list first, then add clients, then schedule shifts.
              </div>
            </div>

            <div style={styles.card}>
              <div style={{ fontSize: 16, fontWeight: 900, marginBottom: 8 }}>Staff list</div>
              {state.staff.length === 0 ? (
                <div style={{ fontSize: 13, opacity: 0.8 }}>No staff yet.</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {state.staff.slice().sort((a, b) => a.name.localeCompare(b.name)).map((s) => (
                    <div key={s.id} style={{ border: "1px solid rgba(255,255,255,0.12)", borderRadius: 14, padding: 10 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
                        <div style={{ fontWeight: 800 }}>{s.name}</div>
                        <button style={styles.btnDanger} onClick={() => deleteStaff(s.id)}>Delete</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {tab === "clients" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1.4fr", gap: 12 }}>
            <div style={styles.card}>
              <div style={{ fontSize: 16, fontWeight: 900, marginBottom: 8 }}>Add client</div>
              <div style={styles.label}>Name</div>
              <input style={{ ...styles.input, width: "100%" }} value={clientName} onChange={(e) => setClientName(e.target.value)} />
              <div style={{ marginTop: 10 }}>
                <button style={styles.btn} onClick={addClient}>Add Client</button>
              </div>
            </div>

            <div style={styles.card}>
              <div style={{ fontSize: 16, fontWeight: 900, marginBottom: 8 }}>Client list</div>
              {state.clients.length === 0 ? (
                <div style={{ fontSize: 13, opacity: 0.8 }}>No clients yet.</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {state.clients.slice().sort((a, b) => a.name.localeCompare(b.name)).map((c) => (
                    <div key={c.id} style={{ border: "1px solid rgba(255,255,255,0.12)", borderRadius: 14, padding: 10 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
                        <div style={{ fontWeight: 800 }}>{c.name}</div>
                        <button style={styles.btnDanger} onClick={() => deleteClient(c.id)}>Delete</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Modal */}
        {modalOpen && (
          <div style={styles.modalOverlay} onMouseDown={(e) => { if (e.target === e.currentTarget) setModalOpen(false); }}>
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
                  <div style={styles.threeCol}>
                    <div>
                      <div style={styles.label}>Date</div>
                      <input
                        style={{ ...styles.input, width: "100%" }}
                        type="date"
                        value={shiftForm.dateISO}
                        onChange={(e) => setShiftForm((p) => ({ ...p, dateISO: e.target.value }))}
                      />
                    </div>
                    <div>
                      <div style={styles.label}>Start</div>
                      <input
                        style={{ ...styles.input, width: "100%" }}
                        type="time"
                        value={shiftForm.start}
                        onChange={(e) => setShiftForm((p) => ({ ...p, start: e.target.value }))}
                      />
                    </div>
                    <div>
                      <div style={styles.label}>End</div>
                      <input
                        style={{ ...styles.input, width: "100%" }}
                        type="time"
                        value={shiftForm.end}
                        onChange={(e) => setShiftForm((p) => ({ ...p, end: e.target.value }))}
                      />
                    </div>
                  </div>

                  <div style={{ height: 10 }} />

                  <div style={styles.twoCol}>
                    <div>
                      <div style={styles.label}>Staff</div>
                      <select
                        style={{ ...styles.select, width: "100%" }}
                        value={shiftForm.staffId}
                        onChange={(e) => setShiftForm((p) => ({ ...p, staffId: e.target.value }))}
                      >
                        <option value="" disabled>Select staff</option>
                        {state.staff.slice().sort((a, b) => a.name.localeCompare(b.name)).map((s) => {
                          const h = staffWeekHours.get(s.id) || 0;
                          const t = state.settings.overtimeThresholdHours;
                          const tag = h >= t ? " (OT)" : h >= t - 4 ? " (Near OT)" : "";
                          return (
                            <option key={s.id} value={s.id}>
                              {s.name}{tag}
                            </option>
                          );
                        })}
                      </select>
                      {shiftForm.staffId ? (
                        <div style={{ marginTop: 6, fontSize: 12, opacity: 0.85 }}>
                          Current week hours: <b>{fmtHours(staffWeekHours.get(shiftForm.staffId) || 0)}</b>
                        </div>
                      ) : null}
                    </div>

                    <div>
                      <div style={styles.label}>Client</div>
                      <select
                        style={{ ...styles.select, width: "100%" }}
                        value={shiftForm.clientId}
                        onChange={(e) => setShiftForm((p) => ({ ...p, clientId: e.target.value }))}
                      >
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
                      placeholder="Example: training, appointment, coverage notes"
                    />
                  </div>

                  {shiftValidation.issues.map((x, i) => (
                    <div key={i} style={styles.err}>• {x}</div>
                  ))}
                  {shiftValidation.warnings.map((x, i) => (
                    <div key={i} style={styles.warn}>• {x}</div>
                  ))}

                  <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
                    <button style={styles.btn2} onClick={() => setModalOpen(false)}>Cancel</button>
                    <button
                      style={styles.btn}
                      onClick={saveShift}
                      disabled={shiftValidation.issues.length > 0 || state.staff.length === 0 || state.clients.length === 0}
                      title={shiftValidation.issues.length ? "Fix errors first" : "Save shift"}
                    >
                      Save Shift
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        <div style={{ ...styles.card, fontSize: 13, opacity: 0.9 }}>
          <b>Note:</b> This MVP stores data in the browser (LocalStorage). Use <b>Export</b> to back up or move to another computer.
          Next upgrades (easy): shared support (2 clients on a shift), mileage, supervisor “coverage gaps” view, printable schedule, user logins.
        </div>
      </div>
    </div>
  );
}
