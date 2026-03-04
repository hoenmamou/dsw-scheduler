"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";

/* ------------------ Storage Key ------------------ */
const LS_KEY = "dsw_scheduler_mvp_v60";

/* ------------------ Day/Night definition ------------------ */
/** Day: 07:00–23:00, Night: 23:00–07:00 */
const DAY_START_MIN = 7 * 60;
const DAY_END_MIN = 23 * 60;

/* ------------------ Defaults ------------------ */
const DEFAULT_STATE = {
  settings: {
    requireLogin: true,
    includeUnassignedForSupervisors: true, // supervisors can also see unassigned clients
    hardStopConflicts: true,               // block save when staff has overlap
  },
  users: [
    // 3 admin logins (edit PINs as you like)
    { id: "admin1", name: "Admin 1", role: "admin", pin: "1111" },
    { id: "admin2", name: "Admin 2", role: "admin", pin: "2222" },
    { id: "admin3", name: "Admin 3", role: "admin", pin: "3333" },
    // sample supervisor (add more in Settings > Users)
    { id: "sup1", name: "Supervisor 1", role: "supervisor", pin: "1234" },
  ],
  staff: [
    // sample staff
    { id: "st1", name: "DSW 1" },
    { id: "st2", name: "DSW 2" },
  ],
  clients: [
    // sample client
    { id: "cl1", name: "Natasha", supervisorId: "sup1", coverageStart: "07:00", coverageEnd: "23:00" },
  ],
  shifts: [
    // { id, clientId, staffId, startISO, endISO, createdBy }
  ],
};

/* ------------------ Utils ------------------ */
function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function isoLocal(date) {
  const d = new Date(date);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
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

function splitDayNightMinutes(startISO, endISO) {
  const start = new Date(startISO);
  const end = new Date(endISO);

  if (isNaN(start) || isNaN(end) || end <= start) {
    return { totalMin: 0, dayMin: 0, nightMin: 0 };
  }

  let totalMin = 0;
  let dayMin = 0;
  let nightMin = 0;

  // Walk day-by-day (local time)
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

    // If segment ends exactly at midnight, treat end minute as 1440
    if (segEnd <= nextDay && segEndMin === 0 && segEnd.getHours() === 0 && segEnd.getMinutes() === 0) {
      segEndMin = 1440;
    }

    const dayOverlapStart = clamp(segStartMin, DAY_START_MIN, DAY_END_MIN);
    const dayOverlapEnd = clamp(segEndMin, DAY_START_MIN, DAY_END_MIN);
    const dayOverlap = Math.max(0, dayOverlapEnd - dayOverlapStart);

    dayMin += dayOverlap;
    nightMin += (segMin - dayOverlap);

    cursor = segEnd;
  }

  return { totalMin, dayMin, nightMin };
}

function fmtHoursFromMin(min) {
  return `${(min / 60).toFixed(2)}h`;
}

function uid(prefix = "id") {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

/* ------------------ Ensure defaults ------------------ */
function ensureDefaultAdmins(st) {
  const next = { ...DEFAULT_STATE, ...(st || {}) };
  next.settings = { ...DEFAULT_STATE.settings, ...(st?.settings || {}) };

  next.users = Array.isArray(st?.users) ? st.users : DEFAULT_STATE.users;
  next.staff = Array.isArray(st?.staff) ? st.staff : DEFAULT_STATE.staff;
  next.clients = Array.isArray(st?.clients) ? st.clients : DEFAULT_STATE.clients;
  next.shifts = Array.isArray(st?.shifts) ? st.shifts : DEFAULT_STATE.shifts;

  // Normalize clients/shifts
  next.clients = next.clients.map((c) => ({
    coverageStart: "07:00",
    coverageEnd: "23:00",
    supervisorId: "",
    ...c,
  }));
  next.shifts = next.shifts.map((sh) => ({ createdBy: sh.createdBy || "unknown", ...sh }));

  return next;
}

/* ------------------ Tabs ------------------ */
function Tabs({ value, onChange, tabs }) {
  const safeTabs = Array.isArray(tabs) ? tabs : [];
  return (
    <div className="no-print" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {safeTabs.map((t) => (
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

/* ------------------ Login ------------------ */
function LoginScreen({ users, onLogin }) {
  const [picked, setPicked] = useState(users?.[0]?.id || "");
  const [pin, setPin] = useState("");

  const user = users.find((u) => u.id === picked);

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
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              placeholder="Enter PIN"
              type="password"
            />
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
          <button
            style={styles.btn}
            onClick={() => {
              if (!user) return;
              if (String(pin || "") !== String(user.pin || "")) {
                alert("Incorrect PIN.");
                return;
              }
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

/* ------------------ 24 Hour Builder Modal ------------------ */
function Builder24Modal({
  open,
  onClose,
  state,
  weekStartISO,
  setWeekStartISO,
  targetClientId,
  setTargetClientId,
  template,
  setTemplate,
  hardStopOT,
  setHardStopOT,
  staffPoolIds,
  setStaffPoolIds,
  onApplyShifts,
  computeStaffWeekMinutes,
  weekShifts,
}) {
  if (!open) return null;

  const templates = [
    {
      id: "2x12",
      label: "2×12 (7a–7p, 7p–7a)",
      blocks: [
        { start: "07:00", end: "19:00" },
        { start: "19:00", end: "07:00", nextDay: true },
      ],
    },
    {
      id: "3x8",
      label: "3×8 (7a–3p, 3p–11p, 11p–7a)",
      blocks: [
        { start: "07:00", end: "15:00" },
        { start: "15:00", end: "23:00" },
        { start: "23:00", end: "07:00", nextDay: true },
      ],
    },
  ];

  const tpl = templates.find((t) => t.id === template) || templates[1];

  const allStaff = state.staff || [];
  const pool = staffPoolIds?.length ? allStaff.filter((s) => staffPoolIds.includes(s.id)) : allStaff;

  function makeDayBlocks(dayDate) {
    return tpl.blocks.map((b) => {
      const [sh, sm] = b.start.split(":").map(Number);
      const [eh, em] = b.end.split(":").map(Number);

      const start = new Date(dayDate);
      start.setHours(sh, sm, 0, 0);

      const end = new Date(dayDate);
      end.setHours(eh, em, 0, 0);

      if (b.nextDay || end <= start) end.setDate(end.getDate() + 1);

      return { startISO: isoLocal(start), endISO: isoLocal(end) };
    });
  }

  function autoBuildWeek() {
    if (!targetClientId) {
      alert("Pick a client first.");
      return;
    }
    const wkStart = new Date(weekStartISO);
    if (isNaN(wkStart)) {
      alert("Week start date is invalid.");
      return;
    }

    const proposed = [];
    const staffMin = {};
    for (const s of allStaff) staffMin[s.id] = computeStaffWeekMinutes(s.id);

    for (let d = 0; d < 7; d++) {
      const day0 = addDays(wkStart, d);
      day0.setHours(0, 0, 0, 0);

      const blocks = makeDayBlocks(day0);

      for (const blk of blocks) {
        const blkMin = minutesBetweenISO(blk.startISO, blk.endISO);

        const candidates = pool
          .map((s) => {
            const current = staffMin[s.id] || 0;
            const after = current + blkMin;
            const overtimeMin = Math.max(0, after - 40 * 60);
            return { s, after, overtimeMin };
          })
          .sort((a, b) => {
            if (a.overtimeMin !== b.overtimeMin) return a.overtimeMin - b.overtimeMin;
            return a.after - b.after;
          })
          .filter(({ s }) => {
            const existing = weekShifts.filter((x) => x.staffId === s.id);
            for (const ex of existing) {
              if (overlaps(ex.startISO, ex.endISO, blk.startISO, blk.endISO)) return false;
            }
            const already = proposed.filter((x) => x.staffId === s.id);
            for (const ex of already) {
              if (overlaps(ex.startISO, ex.endISO, blk.startISO, blk.endISO)) return false;
            }
            return true;
          })
          .filter(({ overtimeMin }) => (hardStopOT ? overtimeMin === 0 : true));

        if (!candidates.length) {
          alert(
            `No staff available for a block on ${day0.toDateString()} (${blk.startISO.slice(11, 16)}–${blk.endISO
              .slice(11, 16)
              .replace("T", " ")}).\n` + (hardStopOT ? "Hard-stop OT is ON." : "")
          );
          return;
        }

        const pick = candidates[0];
        staffMin[pick.s.id] = pick.after;

        proposed.push({
          id: uid("sh"),
          clientId: targetClientId,
          staffId: pick.s.id,
          startISO: blk.startISO,
          endISO: blk.endISO,
          createdBy: "builder",
        });
      }
    }

    onApplyShifts(proposed);
    onClose();
  }

  return (
    <div style={styles.modalOverlay}>
      <div style={styles.modal}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
          <h3 style={styles.modalTitle}>24-Hour Builder (Avoid OT)</h3>
          <button style={styles.btn2} onClick={onClose}>
            Close
          </button>
        </div>

        <div style={{ marginTop: 10, ...styles.twoCol }}>
          <div>
            <div style={styles.tiny}>Week start</div>
            <input
              style={styles.input}
              value={weekStartISO.slice(0, 10)}
              onChange={(e) => setWeekStartISO(`${e.target.value}T00:00:00`)}
              type="date"
            />
          </div>

          <div>
            <div style={styles.tiny}>Client</div>
            <select style={styles.select} value={targetClientId} onChange={(e) => setTargetClientId(e.target.value)}>
              <option value="">Select client…</option>
              {(state.clients || []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <div style={styles.tiny}>Template</div>
            <select style={styles.select} value={template} onChange={(e) => setTemplate(e.target.value)}>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <div style={styles.tiny}>Hard-stop overtime</div>
            <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
              <input type="checkbox" checked={hardStopOT} onChange={(e) => setHardStopOT(e.target.checked)} />
              Do not build shifts that push any staff over 40 hours
            </label>
          </div>

          <div style={{ gridColumn: "1 / -1" }}>
            <div style={styles.tiny}>Optional: limit to specific staff (leave blank = everyone)</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
              {(state.staff || []).map((s) => {
                const checked = staffPoolIds.includes(s.id);
                return (
                  <label key={s.id} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => {
                        const next = e.target.checked
                          ? Array.from(new Set([...staffPoolIds, s.id]))
                          : staffPoolIds.filter((id) => id !== s.id);
                        setStaffPoolIds(next);
                      }}
                    />
                    <span>{s.name}</span>
                  </label>
                );
              })}
            </div>
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
          <button style={styles.btn2} onClick={onClose}>
            Cancel
          </button>
          <button style={styles.btn} onClick={autoBuildWeek}>
            Build Week
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------ Main App ------------------ */
function SchedulerApp({ state, setState, currentUser, onLogout, onSave }) {
  const isAdmin = currentUser?.role === "admin";

  const [tab, setTab] = useState("schedule");

  // Week selection (Monday start)
  const [weekStart, setWeekStart] = useState(() => {
    const d = new Date();
    const day = d.getDay(); // 0 Sun
    const diffToMon = (day === 0 ? -6 : 1) - day;
    d.setDate(d.getDate() + diffToMon);
    d.setHours(0, 0, 0, 0);
    return isoLocal(d).slice(0, 10);
  });

  const weekStartDate = useMemo(() => new Date(`${weekStart}T00:00:00`), [weekStart]);

  const weekEndDate = useMemo(() => {
    const d = new Date(weekStartDate);
    d.setDate(d.getDate() + 7);
    return d;
  }, [weekStartDate]);

  const shiftsInSelectedWeek = useMemo(() => {
    const a = weekStartDate;
    const b = weekEndDate;
    return (state.shifts || []).filter((sh) => {
      const s = new Date(sh.startISO);
      return s >= a && s < b;
    });
  }, [state.shifts, weekStartDate, weekEndDate]);

  // Supervisor case assignment filtering
  const visibleClients = useMemo(() => {
    if (isAdmin) return state.clients || [];
    const me = currentUser?.id || "";
    const includeUnassigned = !!state.settings?.includeUnassignedForSupervisors;
    return (state.clients || []).filter((c) => {
      if ((c.supervisorId || "") === me) return true;
      if (includeUnassigned && (c.supervisorId || "") === "") return true;
      return false;
    });
  }, [state.clients, state.settings?.includeUnassignedForSupervisors, isAdmin, currentUser?.id]);

  // Client weekly hours (total/day/night)
  const weekClientHours = useMemo(() => {
    const byClient = {};
    for (const sh of shiftsInSelectedWeek) {
      if (!sh.clientId) continue;
      const id = sh.clientId;
      if (!byClient[id]) byClient[id] = { totalMin: 0, dayMin: 0, nightMin: 0 };
      const { totalMin, dayMin, nightMin } = splitDayNightMinutes(sh.startISO, sh.endISO);
      byClient[id].totalMin += totalMin;
      byClient[id].dayMin += dayMin;
      byClient[id].nightMin += nightMin;
    }
    return byClient;
  }, [shiftsInSelectedWeek]);

  // Staff weekly minutes + overtime
  const staffWeekMinutes = useMemo(() => {
    const m = {};
    for (const s of state.staff || []) m[s.id] = 0;
    for (const sh of shiftsInSelectedWeek) {
      if (!sh.staffId) continue;
      m[sh.staffId] = (m[sh.staffId] || 0) + minutesBetweenISO(sh.startISO, sh.endISO);
    }
    return m;
  }, [state.staff, shiftsInSelectedWeek]);

  const computeStaffWeekMinutes = useCallback(
    (staffId) => staffWeekMinutes[staffId] || 0,
    [staffWeekMinutes]
  );

  // Draft shift form
  const [shiftDraft, setShiftDraft] = useState({
    clientId: "",
    staffId: "",
    startDate: weekStart,
    startTime: "07:00",
    endDate: weekStart,
    endTime: "15:00",
  });

  // Auto endDate + bump to next day if endTime earlier than startTime
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
    if (shiftDraft.endDate !== endDate) {
      setShiftDraft((p) => ({ ...p, endDate }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shiftDraft.startDate, shiftDraft.startTime, shiftDraft.endTime]);

  function toISO(dateStr, timeStr) {
    return `${dateStr}T${timeStr}:00`;
  }

  // Global conflict check across ALL clients (Natasha, etc.)
  function findStaffConflicts({ staffId, startISO, endISO, ignoreShiftId }) {
    return (state.shifts || []).filter((sh) => {
      if (ignoreShiftId && sh.id === ignoreShiftId) return false;
      if (sh.staffId !== staffId) return false;
      return overlaps(sh.startISO, sh.endISO, startISO, endISO);
    });
  }

  function addShift() {
    const { clientId, staffId, startDate, startTime, endDate, endTime } = shiftDraft;
    if (!clientId || !staffId) {
      alert("Pick a client and staff.");
      return;
    }

    const startISO = toISO(startDate, startTime);
    const endISO = toISO(endDate, endTime);

    if (new Date(endISO) <= new Date(startISO)) {
      alert("End must be after start.");
      return;
    }

    // Conflict check (global)
    const conflicts = findStaffConflicts({ staffId, startISO, endISO });
    if (conflicts.length) {
      const first = conflicts[0];
      const c = (state.clients || []).find((x) => x.id === first.clientId);
      const sup = (state.users || []).find((u) => u.id === (c?.supervisorId || ""));
      const supName = sup ? sup.name : "Unassigned";
      const msg =
        `Conflict: This staff is already scheduled.\n\n` +
        `Client: ${c?.name || "Unknown"}\n` +
        `Supervisor: ${supName}\n` +
        `Time: ${first.startISO.slice(0, 16).replace("T", " ")} → ${first.endISO
          .slice(0, 16)
          .replace("T", " ")}`;

      if (state.settings?.hardStopConflicts) {
        alert(msg);
        return;
      } else {
        if (!confirm(msg + "\n\nContinue anyway?")) return;
      }
    }

    // OT warning
    const newMin = minutesBetweenISO(startISO, endISO);
    const afterMin = (staffWeekMinutes[staffId] || 0) + newMin;
    const otMin = Math.max(0, afterMin - 40 * 60);
    if (otMin > 0) {
      if (!confirm(`This will create overtime: ${fmtHoursFromMin(otMin)}.\n\nContinue?`)) return;
    }

    const sh = {
      id: uid("sh"),
      clientId,
      staffId,
      startISO,
      endISO,
      createdBy: currentUser?.id || "unknown",
    };

    setState((prev) => ({ ...prev, shifts: [...(prev.shifts || []), sh] }));
  }

  // Coverage gaps (simple): based on client coverage window each day
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

        const covStartISO = `${dateStr}T${covStart}:00`;
        let covEndISO = `${dateStr}T${covEnd}:00`;
        // if coverage wraps past midnight
        if (new Date(covEndISO) <= new Date(covStartISO)) {
          const nd = new Date(`${dateStr}T00:00:00`);
          nd.setDate(nd.getDate() + 1);
          covEndISO = `${isoLocal(nd).slice(0, 10)}T${covEnd}:00`;
        }

        const clientShifts = shiftsInSelectedWeek
          .filter((sh) => sh.clientId === c.id)
          .map((sh) => ({ start: sh.startISO, end: sh.endISO }))
          .sort((a, b) => new Date(a.start) - new Date(b.start));

        // Merge overlaps
        const merged = [];
        for (const s of clientShifts) {
          if (!merged.length) merged.push({ ...s });
          else {
            const last = merged[merged.length - 1];
            if (new Date(s.start) <= new Date(last.end)) {
              if (new Date(s.end) > new Date(last.end)) last.end = s.end;
            } else merged.push({ ...s });
          }
        }

        // Find gaps inside coverage window
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

    // Filter out tiny gaps (< 5 min)
    return gaps.filter((g) => minutesBetweenISO(g.startISO, g.endISO) >= 5);
  }, [visibleClients, shiftsInSelectedWeek, weekStartDate]);

  // 24-hour builder state
  const [builderOpen, setBuilderOpen] = useState(false);
  const [builderWeekStartISO, setBuilderWeekStartISO] = useState(() => `${weekStart}T00:00:00`);
  const [builderClientId, setBuilderClientId] = useState("");
  const [builderTemplate, setBuilderTemplate] = useState("3x8");
  const [builderHardStopOT, setBuilderHardStopOT] = useState(true);
  const [builderStaffPoolIds, setBuilderStaffPoolIds] = useState([]);

  useEffect(() => {
    setBuilderWeekStartISO(`${weekStart}T00:00:00`);
  }, [weekStart]);

  function applyBuiltShifts(newShifts) {
    // Final safety: block any global conflicts if hardStopConflicts is on
    if (state.settings?.hardStopConflicts) {
      for (const sh of newShifts) {
        const conf = findStaffConflicts({ staffId: sh.staffId, startISO: sh.startISO, endISO: sh.endISO });
        if (conf.length) {
          alert("Builder found a conflict with an existing shift. Nothing was added.");
          return;
        }
      }
    }
    setState((prev) => ({ ...prev, shifts: [...(prev.shifts || []), ...newShifts] }));
  }

  // Client edit (admin only)
  const [clientDraft, setClientDraft] = useState({ id: "", name: "", supervisorId: "", coverageStart: "07:00", coverageEnd: "23:00" });

  function saveClient() {
    if (!isAdmin) return;
    if (!clientDraft.name.trim()) {
      alert("Client name required.");
      return;
    }
    const draft = {
      ...clientDraft,
      id: clientDraft.id || uid("cl"),
      supervisorId: clientDraft.supervisorId || "",
      coverageStart: clientDraft.coverageStart || "07:00",
      coverageEnd: clientDraft.coverageEnd || "23:00",
    };
    setState((prev) => {
      const exists = (prev.clients || []).some((c) => c.id === draft.id);
      const clients = exists
        ? (prev.clients || []).map((c) => (c.id === draft.id ? draft : c))
        : [...(prev.clients || []), draft];
      return { ...prev, clients };
    });
    setClientDraft({ id: "", name: "", supervisorId: "", coverageStart: "07:00", coverageEnd: "23:00" });
  }

  function deleteClient(id) {
    if (!isAdmin) return;
    if (!confirm("Delete this client?")) return;
    setState((prev) => ({
      ...prev,
      clients: (prev.clients || []).filter((c) => c.id !== id),
      shifts: (prev.shifts || []).filter((s) => s.clientId !== id),
    }));
  }

  // Users edit (admin only)
  const [userDraft, setUserDraft] = useState({ id: "", name: "", role: "supervisor", pin: "" });

  function saveUser() {
    if (!isAdmin) return;
    if (!userDraft.id.trim() || !userDraft.name.trim() || !userDraft.pin.trim()) {
      alert("User id, name, and PIN required.");
      return;
    }
    const draft = { ...userDraft, id: userDraft.id.trim() };
    setState((prev) => {
      const exists = (prev.users || []).some((u) => u.id === draft.id);
      const users = exists ? (prev.users || []).map((u) => (u.id === draft.id ? draft : u)) : [...(prev.users || []), draft];
      return { ...prev, users };
    });
    setUserDraft({ id: "", name: "", role: "supervisor", pin: "" });
  }

  function deleteUser(id) {
    if (!isAdmin) return;
    if (!confirm("Delete this user?")) return;
    setState((prev) => ({
      ...prev,
      users: (prev.users || []).filter((u) => u.id !== id),
      clients: (prev.clients || []).map((c) => ((c.supervisorId || "") === id ? { ...c, supervisorId: "" } : c)),
    }));
  }

  const tabs = [
    { value: "schedule", label: "Schedule" },
    { value: "gaps", label: "Coverage Gaps" },
    { value: "hours", label: "Hours & OT" },
    ...(isAdmin ? [{ value: "clients", label: "Clients" }, { value: "users", label: "Users" }, { value: "settings", label: "Settings" }] : []),
  ];

  return (
    <div style={{ minHeight: "100vh", background: "#0b0c10", color: "white", padding: 16 }}>
      <div style={{ maxWidth: 1200, margin: "0 auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
          <div>
            <div style={{ fontSize: 22, fontWeight: 980 }}>DSW Scheduler</div>
            <div style={styles.tiny}>
              Logged in as <b>{currentUser?.name}</b> ({currentUser?.role})
            </div>
          </div>

          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button style={styles.btn2} onClick={onSave}>Save</button>
            <button style={styles.btn2} onClick={onLogout}>Logout</button>
          </div>
        </div>

        <div style={{ marginTop: 10, display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
          <Tabs value={tab} onChange={setTab} tabs={tabs} />
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <div style={styles.tiny}>Week start</div>
            <input style={styles.input} type="date" value={weekStart} onChange={(e) => setWeekStart(e.target.value)} />
          </div>
        </div>

        {/* ---------------- Schedule Tab ---------------- */}
        {tab === "schedule" && (
          <div style={{ marginTop: 12, ...styles.card }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <h3 style={{ margin: 0 }}>Add Shift</h3>
              <button style={styles.btn2} onClick={() => setBuilderOpen(true)}>24-Hour Builder</button>
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
                <select
                  style={styles.select}
                  value={shiftDraft.staffId}
                  onChange={(e) => setShiftDraft((p) => ({ ...p, staffId: e.target.value }))}
                >
                  <option value="">Select…</option>
                  {(state.staff || []).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
                {!!shiftDraft.staffId && (
                  <div style={styles.tiny}>
                    Week hours: <b>{fmtHoursFromMin(staffWeekMinutes[shiftDraft.staffId] || 0)}</b>
                  </div>
                )}
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
                <div style={styles.tiny}>Auto bump end date if end time is earlier than start.</div>
              </div>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
              <button style={styles.btn} onClick={addShift}>Add Shift</button>
            </div>

            <div style={{ marginTop: 14 }}>
              <h3 style={{ margin: "8px 0" }}>This Week’s Shifts</h3>
              <div style={styles.hr} />
              <div style={{ display: "grid", gap: 10 }}>
                {shiftsInSelectedWeek
                  .filter((sh) => {
                    // Supervisors: show shifts for visible clients (their cases)
                    if (isAdmin) return true;
                    return visibleClients.some((c) => c.id === sh.clientId);
                  })
                  .sort((a, b) => new Date(a.startISO) - new Date(b.startISO))
                  .map((sh) => {
                    const c = (state.clients || []).find((x) => x.id === sh.clientId);
                    const s = (state.staff || []).find((x) => x.id === sh.staffId);
                    const sup = (state.users || []).find((u) => u.id === (c?.supervisorId || ""));
                    return (
                      <div key={sh.id} style={styles.shift}>
                        <div style={styles.shiftTop}>
                          <div>
                            <div style={styles.shiftTitle}>{c?.name || "Unknown Client"}</div>
                            <div style={styles.shiftMeta}>
                              Staff: <b>{s?.name || "Unknown"}</b>
                              <br />
                              Supervisor: <b>{sup ? sup.name : "Unassigned"}</b>
                              <br />
                              {sh.startISO.slice(0, 16).replace("T", " ")} → {sh.endISO.slice(0, 16).replace("T", " ")}
                            </div>
                          </div>
                          <button
                            style={styles.btn2}
                            onClick={() => {
                              if (!confirm("Delete this shift?")) return;
                              setState((prev) => ({ ...prev, shifts: (prev.shifts || []).filter((x) => x.id !== sh.id) }));
                            }}
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    );
                  })}
              </div>
            </div>
          </div>
        )}

        {/* ---------------- Coverage Gaps Tab ---------------- */}
        {tab === "gaps" && (
          <div style={{ marginTop: 12, ...styles.card }}>
            <h3 style={{ marginTop: 0 }}>Coverage Gaps (for visible clients)</h3>
            <div style={styles.tiny}>Based on each client’s coverage window (default 7:00a–11:00p).</div>
            <div style={styles.hr} />

            {coverageGaps.length === 0 ? (
              <div style={styles.tiny}>No gaps detected for the selected week.</div>
            ) : (
              <div style={{ display: "grid", gap: 10 }}>
                {coverageGaps.slice(0, 300).map((g, idx) => {
                  const c = (state.clients || []).find((x) => x.id === g.clientId);
                  return (
                    <div key={`${g.clientId}_${idx}`} style={styles.shift}>
                      <div style={styles.shiftTitle}>{c?.name || "Unknown Client"}</div>
                      <div style={styles.shiftMeta}>
                        {g.startISO.slice(0, 16).replace("T", " ")} → {g.endISO.slice(0, 16).replace("T", " ")}
                      </div>
                    </div>
                  );
                })}
                {coverageGaps.length > 300 && <div style={styles.warn}>Showing first 300 gaps.</div>}
              </div>
            )}
          </div>
        )}

        {/* ---------------- Hours & OT Tab ---------------- */}
        {tab === "hours" && (
          <div style={{ marginTop: 12, ...styles.card }}>
            <h3 style={{ marginTop: 0 }}>Hours & Overtime</h3>

            <div style={{ marginTop: 10, overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={styles.th}>Staff</th>
                    <th style={styles.th}>Week Hours</th>
                    <th style={styles.th}>OT Hours</th>
                  </tr>
                </thead>
                <tbody>
                  {(state.staff || []).map((st) => {
                    const min = staffWeekMinutes[st.id] || 0;
                    const otMin = Math.max(0, min - 40 * 60);
                    return (
                      <tr key={st.id}>
                        <td style={styles.td}><b>{st.name}</b></td>
                        <td style={styles.td}>{fmtHoursFromMin(min)}</td>
                        <td style={styles.td}>{fmtHoursFromMin(otMin)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div style={{ marginTop: 16, ...styles.card }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
                <h3 style={{ margin: 0 }}>Client Weekly Hours</h3>
                <div style={styles.tiny}>Day: 7:00a–11:00p • Night: 11:00p–7:00a</div>
              </div>

              <div style={{ marginTop: 10, overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr>
                      <th style={styles.th}>Client</th>
                      <th style={styles.th}>Weekly Total</th>
                      <th style={styles.th}>Day Hours</th>
                      <th style={styles.th}>Night Hours</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(visibleClients || []).map((c) => {
                      const h = weekClientHours[c.id] || { totalMin: 0, dayMin: 0, nightMin: 0 };
                      return (
                        <tr key={c.id}>
                          <td style={styles.td}><b>{c.name}</b></td>
                          <td style={styles.td}>{fmtHoursFromMin(h.totalMin)}</td>
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

        {/* ---------------- Clients Tab (Admin) ---------------- */}
        {tab === "clients" && isAdmin && (
          <div style={{ marginTop: 12, ...styles.card }}>
            <h3 style={{ marginTop: 0 }}>Clients (Assign supervisor over case)</h3>

            <div style={{ marginTop: 10, ...styles.grid4 }}>
              <div>
                <div style={styles.tiny}>Client name</div>
                <input
                  style={styles.input}
                  value={clientDraft.name}
                  onChange={(e) => setClientDraft((p) => ({ ...p, name: e.target.value }))}
                  placeholder="Client name"
                />
              </div>

              <div>
                <div style={styles.tiny}>Supervisor over case</div>
                <select
                  style={styles.select}
                  value={clientDraft.supervisorId || ""}
                  onChange={(e) => setClientDraft((p) => ({ ...p, supervisorId: e.target.value }))}
                >
                  <option value="">Unassigned</option>
                  {(state.users || [])
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
                  value={clientDraft.coverageStart || "07:00"}
                  onChange={(e) => setClientDraft((p) => ({ ...p, coverageStart: e.target.value }))}
                />
              </div>

              <div>
                <div style={styles.tiny}>Coverage End</div>
                <input
                  style={styles.input}
                  type="time"
                  value={clientDraft.coverageEnd || "23:00"}
                  onChange={(e) => setClientDraft((p) => ({ ...p, coverageEnd: e.target.value }))}
                />
              </div>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
              <button style={styles.btn} onClick={saveClient}>Save Client</button>
            </div>

            <div style={styles.hr} />

            <div style={{ display: "grid", gap: 10 }}>
              {(state.clients || []).map((c) => {
                const sup = (state.users || []).find((u) => u.id === (c.supervisorId || ""));
                return (
                  <div key={c.id} style={styles.shift}>
                    <div style={styles.shiftTop}>
                      <div>
                        <div style={styles.shiftTitle}>{c.name}</div>
                        <div style={styles.shiftMeta}>
                          Supervisor: <b>{sup ? sup.name : "Unassigned"}</b>
                          <br />
                          Coverage: {c.coverageStart || "07:00"} → {c.coverageEnd || "23:00"}
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
                            })
                          }
                        >
                          Edit
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

        {/* ---------------- Users Tab (Admin) ---------------- */}
        {tab === "users" && isAdmin && (
          <div style={{ marginTop: 12, ...styles.card }}>
            <h3 style={{ marginTop: 0 }}>Users</h3>

            <div style={{ marginTop: 10, ...styles.grid4 }}>
              <div>
                <div style={styles.tiny}>User ID (unique)</div>
                <input style={styles.input} value={userDraft.id} onChange={(e) => setUserDraft((p) => ({ ...p, id: e.target.value }))} />
              </div>
              <div>
                <div style={styles.tiny}>Name</div>
                <input style={styles.input} value={userDraft.name} onChange={(e) => setUserDraft((p) => ({ ...p, name: e.target.value }))} />
              </div>
              <div>
                <div style={styles.tiny}>Role</div>
                <select style={styles.select} value={userDraft.role} onChange={(e) => setUserDraft((p) => ({ ...p, role: e.target.value }))}>
                  <option value="supervisor">supervisor</option>
                  <option value="admin">admin</option>
                </select>
              </div>
              <div>
                <div style={styles.tiny}>PIN</div>
                <input style={styles.input} value={userDraft.pin} onChange={(e) => setUserDraft((p) => ({ ...p, pin: e.target.value }))} />
              </div>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
              <button style={styles.btn} onClick={saveUser}>Save User</button>
            </div>

            <div style={styles.hr} />

            <div style={{ display: "grid", gap: 10 }}>
              {(state.users || []).map((u) => (
                <div key={u.id} style={styles.shift}>
                  <div style={styles.shiftTop}>
                    <div>
                      <div style={styles.shiftTitle}>{u.name}</div>
                      <div style={styles.shiftMeta}>
                        ID: <b>{u.id}</b> • Role: <b>{u.role}</b>
                      </div>
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

        {/* ---------------- Settings Tab (Admin) ---------------- */}
        {tab === "settings" && isAdmin && (
          <div style={{ marginTop: 12, ...styles.card }}>
            <h3 style={{ marginTop: 0 }}>Settings</h3>

            <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10 }}>
              <input
                type="checkbox"
                checked={!!state.settings?.includeUnassignedForSupervisors}
                onChange={(e) =>
                  setState((p) => ({
                    ...p,
                    settings: { ...p.settings, includeUnassignedForSupervisors: e.target.checked },
                  }))
                }
              />
              Supervisors can see unassigned clients
            </label>

            <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10 }}>
              <input
                type="checkbox"
                checked={!!state.settings?.hardStopConflicts}
                onChange={(e) =>
                  setState((p) => ({
                    ...p,
                    settings: { ...p.settings, hardStopConflicts: e.target.checked },
                  }))
                }
              />
              Hard-stop conflicts (block saving overlaps)
            </label>
          </div>
        )}

        {/* 24 Hour Builder Modal */}
        <Builder24Modal
          open={builderOpen}
          onClose={() => setBuilderOpen(false)}
          state={state}
          weekStartISO={builderWeekStartISO}
          setWeekStartISO={setBuilderWeekStartISO}
          targetClientId={builderClientId}
          setTargetClientId={setBuilderClientId}
          template={builderTemplate}
          setTemplate={setBuilderTemplate}
          hardStopOT={builderHardStopOT}
          setHardStopOT={setBuilderHardStopOT}
          staffPoolIds={builderStaffPoolIds}
          setStaffPoolIds={setBuilderStaffPoolIds}
          onApplyShifts={applyBuiltShifts}
          computeStaffWeekMinutes={computeStaffWeekMinutes}
          weekShifts={shiftsInSelectedWeek}
        />
      </div>
    </div>
  );
}

/* ------------------ Page ------------------ */
export default function Page() {
  const [mounted, setMounted] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  const [state, setState] = useState(() => ensureDefaultAdmins(DEFAULT_STATE));
  const [sessionUserId, setSessionUserId] = useState(null);

  useEffect(() => setMounted(true), []);

  // Load AFTER mount
  useEffect(() => {
    if (!mounted) return;

    try {
      setSessionUserId(sessionStorage.getItem("dsw_user_id"));
    } catch {}

    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);

        const next = ensureDefaultAdmins({
          settings: { ...DEFAULT_STATE.settings, ...(parsed.settings || {}) },
          users: Array.isArray(parsed.users) ? parsed.users : [],
          staff: Array.isArray(parsed.staff) ? parsed.staff : [],
          clients: Array.isArray(parsed.clients) ? parsed.clients : [],
          shifts: Array.isArray(parsed.shifts) ? parsed.shifts : [],
        });

        setState(next);
      }
    } catch {
      // ignore parse errors
    } finally {
      setHydrated(true);
    }
  }, [mounted]);

  // Auto-save after hydration
  useEffect(() => {
    if (!mounted || !hydrated) return;
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(state));
    } catch {}
  }, [state, mounted, hydrated]);

  const currentUser = useMemo(() => state.users.find((u) => u.id === sessionUserId) || null, [state.users, sessionUserId]);

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

  function manualSave() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(state));
      alert("Saved.");
    } catch {
      alert("Save failed (storage blocked).");
    }
  }

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
      onSave={manualSave}
    />
  );
}

/* ------------------ Styles ------------------ */
const styles = {
  card: {
    border: "1px solid rgba(255,255,255,0.12)",
    borderRadius: 16,
    padding: 14,
    background: "rgba(255,255,255,0.04)",
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
  grid4: { display: "grid", gridTemplateColumns: "repeat(4, minmax(220px, 1fr))", gap: 10 },
  twoCol: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 },
  tiny: { fontSize: 12, opacity: 0.8 },
  shift: { border: "1px solid rgba(255,255,255,0.12)", borderRadius: 14, padding: 10, background: "rgba(255,255,255,0.03)" },
  shiftTop: { display: "flex", justifyContent: "space-between", gap: 8, alignItems: "flex-start" },
  shiftTitle: { fontWeight: 950, fontSize: 13, marginBottom: 4 },
  shiftMeta: { fontSize: 12, opacity: 0.86, lineHeight: 1.35 },
  hr: { height: 1, background: "rgba(255,255,255,0.10)", margin: "10px 0" },
  warn: { color: "#f59e0b", fontSize: 13, marginTop: 6 },
  err: { color: "#fb7185", fontSize: 13, marginTop: 6 },
  th: { textAlign: "left", fontSize: 12, opacity: 0.85, padding: "8px 6px", borderBottom: "1px solid rgba(255,255,255,0.10)" },
  td: { padding: "8px 6px", borderBottom: "1px solid rgba(255,255,255,0.06)", fontSize: 13 },

  modalOverlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 50 },
  modal: { width: "min(860px, 100%)", background: "#12141a", borderRadius: 16, border: "1px solid rgba(255,255,255,0.12)", padding: 14 },
  modalTitle: { fontSize: 18, fontWeight: 980, margin: 0 },
};
