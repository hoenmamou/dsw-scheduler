"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabaseClient";

// On the client, Next.js replaces env vars at build time.
const SUPABASE_CONFIGURED = !!(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);

// Supabase errors (auth/RLS) should not break the app. When they happen we
// fall back to localStorage (and log a warning).
let supabaseErrorHandler = null;

// ====== Helper functions and constants ======
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
function overlaps(startA, endA, startB, endB) {
  return startA < endB && endA > startB;
}
function minutesBetweenISO(start, end) {
  return Math.max(0, (new Date(end) - new Date(start)) / 60000);
}
function splitDayNightMinutes(startISO, endISO) {
  const start = new Date(startISO);
  const end = new Date(endISO);
  let totalMin = 0, dayMin = 0, nightMin = 0;
  let t = new Date(start);
  while (t < end) {
    const hour = t.getHours();
    const next = new Date(t);
    next.setMinutes(next.getMinutes() + 1);
    totalMin++;
    if (hour >= DAY_START_MIN / 60 && hour < DAY_END_MIN / 60) dayMin++;
    else nightMin++;
    t = next;
  }
  return { totalMin, dayMin, nightMin };
}
function fmtHoursFromMin(min) {
  if (min == null) return "0h";
  const h = Math.floor(Math.abs(min) / 60);
  const m = Math.abs(min) % 60;
  return `${min < 0 ? "-" : ""}${h}h${m ? ` ${m}m` : ""}`;
}
function uid(prefix = "") {
  return prefix + Math.random().toString(36).slice(2, 10);
}
function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}
const DAY_START_MIN = 7 * 60;
const DAY_END_MIN = 23 * 60;
const OT_THRESHOLD_MIN = 40 * 60;
const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
// ====== End helpers ======

/* =========================
   Calendar (print/PDF)
========================= */

function CalendarWeek({ state, weekStartDate, visibleClients, canSeeAllShifts, setTab, setShiftDraft, deleteShift }) {
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
        <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 980 }}>Weekly Calendar</div>
            <div style={styles.tiny}>Week of {start.toLocaleDateString()}</div>
          </div>
          <button className="no-print" style={styles.btn2} onClick={() => window.print()}>
            Print / Save PDF
          </button>
    settings: { includeUnassignedForSupervisors: true, hardStopConflicts: true },
    users: [],
    staff: [],
    clients: [],
    shifts: [],
  });

  // session login (local session only)
  const [sessionUserId, setSessionUserId] = useState(null);

  // Supabase error state (used to show a warning banner when auth/RLS fails)
  const [supabaseError, setSupabaseError] = useState(null);

  // UI
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
  const weekEndDate = useMemo(() => addDays(weekStartDate, 7), [weekStartDate]);

  // --- Client Profiles state ---
  const [selectedClientId, setSelectedClientId] = useState("");
  const profileClients = useMemo(() => {
    return canSeeAdminUI ? (state.clients || []) : visibleClients;
  }, [canSeeAdminUI, state.clients, visibleClients]);
  const selectedClient = useMemo(() => (profileClients || []).find(c => c.id === selectedClientId) || null, [profileClients, selectedClientId]);
  const selectedClientShifts = useMemo(() => {
    if (!selectedClientId) return [];
    return (state.shifts || [])
      .filter(sh => sh.clientId === selectedClientId)
      .filter(sh => {
        // Only shifts in the selected week
        const shStart = new Date(sh.startISO);
        return shStart >= weekStartDate && shStart < weekEndDate;
      })
      .sort((a, b) => new Date(a.startISO) - new Date(b.startISO));
  }, [state.shifts, selectedClientId, weekStartDate, weekEndDate]);
  const selectedClientStaffSummary = useMemo(() => {
    if (!selectedClientShifts.length) return [];
    const staffMap = {};
    for (const sh of selectedClientShifts) {
      if (!sh.staffId) continue;
      if (!staffMap[sh.staffId]) staffMap[sh.staffId] = { staff: (state.staff || []).find(s => s.id === sh.staffId), min: 0 };
      staffMap[sh.staffId].min += minutesBetweenISO(sh.startISO, sh.endISO);
    }
    return Object.values(staffMap).sort((a, b) => (a.staff?.name || "").localeCompare(b.staff?.name || ""));
  }, [selectedClientShifts, state.staff]);
  const selectedClientWeekHours = useMemo(() => {
    let totalMin = 0, dayMin = 0, nightMin = 0;
    for (const sh of selectedClientShifts) {
      const { totalMin: t, dayMin: d, nightMin: n } = splitDayNightMinutes(sh.startISO, sh.endISO);
      totalMin += t; dayMin += d; nightMin += n;
    }
    const allottedMin = (Number(selectedClient?.weeklyHours) || 0) * 60;
    const remainingMin = allottedMin - totalMin;
    return { totalMin, dayMin, nightMin, allottedMin, remainingMin };
  }, [selectedClientShifts, selectedClient]);

  // keep startDate aligned with week when week changes
  useEffect(() => {
    setShiftDraft((p) => ({ ...p, startDate: weekStart, endDate: weekStart }));
  }, [weekStart]);

  // Load stored client schedule template into the builder when selecting a client
  useEffect(() => {
    if (!builderClientId) return;
    const schedule = loadClientSchedule(builderClientId);
    if (schedule?.shifts) {
      setBuilderCustomTemplate(schedule.shifts.map((s) => `${s.start}-${s.end}`).join("\n"));
      setBuilderScheduleSource((prev) => (prev === "custom" ? "custom" : "client"));
    }
  }, [builderClientId]);

  // Auto bump endDate if endTime earlier than startTime
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shiftDraft.startDate, shiftDraft.startTime, shiftDraft.endTime]);

  function toISO(dateStr, timeStr) {
    return `${dateStr}T${timeStr}:00`;
  }

  async function runBuilder() {
    if (!builderClientId) return alert("Pick a client for the builder.");
    const start = new Date(weekStartDate);
    const rows = [];

    // Determine shift definitions based on selected source
    let shiftsDef = [];
    try {
      if (builderScheduleSource === "client") {
        if (!clientSchedule?.shifts?.length) return alert("No saved schedule for this client.");
        shiftsDef = clientSchedule.shifts;
      } else if (builderScheduleSource === "custom") {
        shiftsDef = parseShiftPattern(builderCustomTemplate);
      } else {
        shiftsDef = builderTemplate === "2x12"
          ? [ { start: "07:00", end: "19:00" }, { start: "19:00", end: "07:00" } ]
          : [ { start: "07:00", end: "15:00" }, { start: "15:00", end: "23:00" }, { start: "23:00", end: "07:00" } ];
      }
    } catch (e) {
      return alert(e.message || "Invalid schedule format.");
    }

    // Track per-staff minutes while building to avoid over-assigning
    const minutesByStaff = { ...staffWeekMinutesMap };
    const pool = (state.staff || []).filter((s) => s.active !== false);
    let rotIndex = 0;

    const pickStaffForShift = async (startISO, endISO) => {
      const weekday = new Date(startISO).getDay();
      const forcedStaffId = builderWeeklyAssignments[weekday];
      const addMin = minutesBetweenISO(startISO, endISO);

      const checkCandidate = async (st) => {
        const conflicts = await findStaffConflictsDB({ staffId: st.id, startISO, endISO });
        if (conflicts.length) return false;
        const currentMin = minutesByStaff[st.id] || 0;
        if (state.settings?.hardStopConflicts && currentMin + addMin > OT_THRESHOLD_MIN) return false;
        minutesByStaff[st.id] = currentMin + addMin;
        return true;
      };

      if (forcedStaffId) {
        const forced = pool.find((s) => s.id === forcedStaffId);
        if (forced && (await checkCandidate(forced))) return forced;
      }

      for (let i = 0; i < pool.length; i++) {
        const idx = (rotIndex + i) % pool.length;
        const st = pool[idx];
        if (await checkCandidate(st)) {
          rotIndex = idx + 1;
          return st;
        }
      }
      return null;
    };

    // Build for N weeks (1=week, 4=month) using the repeat interval
    for (let w = 0; w < builderWeeks; w += builderRepeatInterval) {
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

          const chosen = await pickStaffForShift(sISO, eISO);
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
            });
          }
        }
      }
    }

    if (!rows.length) return alert("Builder did not create any shifts (no available staff).");
    await sbUpsert("shifts", rows);
    await refreshState(setState);
    setBuilderOpen(false);
    alert(`Builder created ${rows.length} shift rows.`);
  }

  // Cross-supervisor (global) staff conflict check
  async function findStaffConflictsDB({ staffId, startISO, endISO }) {
    // Use sbSelect which supports Supabase or local fallback
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

  async function addShift() {
    // Works with Supabase or localStorage fallback via sbUpsert

    const { clientId, clientId2, staffId, startDate, startTime, endDate, endTime, isShared } = shiftDraft;

    if (!clientId || !staffId) return alert("Pick a client and staff.");

    if (isShared) {
      if (!clientId2) return alert("Pick the 2nd client for Shared Support.");
      if (clientId2 === clientId) return alert("Client 1 and Client 2 cannot be the same.");
    }

    const startISO = toISO(startDate, startTime);
    const endISO = toISO(endDate, endTime);
    if (new Date(endISO) <= new Date(startISO)) return alert("End must be after start.");

    const sharedGroupId = isShared
      ? (shiftDraft.sharedGroupId.trim() || `SS-${Date.now().toString().slice(-6)}`)
      : "";

    // Check conflicts globally
    const conflicts = await findStaffConflictsDB({ staffId, startISO, endISO });

    // Allow overlap ONLY when it is the same shared-group/time block
    const illegalConflicts = conflicts.filter((c) => {
      if (!isShared) return true; // non-shared can never overlap
      // shared can overlap only if the conflict is also shared and matches group + exact time
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
        `Time: ${first.startISO.slice(0, 16).replace("T", " ")} → ${first.endISO.slice(0, 16).replace("T", " ")}`;

      if (state.settings?.hardStopConflicts) return alert(msg);
      if (!confirm(msg + "\n\nContinue anyway?")) return;
    }

    // OT warning (dedup shared support)
    const newMin = minutesBetweenISO(startISO, endISO);
    const currentMin = staffWeekMinutesMap[staffId] || 0;
    const afterMin = currentMin + newMin; // shared counts once per staff, so this is fine
    const otMin = Math.max(0, afterMin - OT_THRESHOLD_MIN);
    if (otMin > 0) {
      if (!confirm(`This will create overtime: ${fmtHoursFromMin(otMin)}.\n\nContinue?`)) return;
    }

    const createdBy = currentUser?.id || "unknown";
    const rows = [];

    // Always create row for primary client
    rows.push({
      id: uid("sh"),
      client_id: clientId,
      staff_id: staffId,
      start_iso: startISO,
      end_iso: endISO,
      created_by: createdBy,
      is_shared: !!isShared,
      shared_group_id: sharedGroupId,
    });

    // Shared support: also create row for client 2
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
      });
    }

    await sbUpsert("shifts", rows);
    // refresh UI and reset draft
    await refreshState(setState);
    setShiftDraft((p) => ({ ...p, isShared: false, clientId2: "", sharedGroupId: "" }));
  }

  async function deleteShift(id) {
    if (!confirm("Delete this shift?")) return;
    await sbDelete("shifts", id);
    await refreshState(setState);
  }

  // Coverage gaps (uses visible clients + their coverage windows; supports 24h clients)
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

        // 24h client overrides
        if (c.is24Hour) {
          covStartISO = `${dateStr}T00:00:00`;
          const nd = addDays(new Date(`${dateStr}T00:00:00`), 1);
          covEndISO = `${isoLocal(nd).slice(0, 10)}T00:00:00`;
        } else {
          // if coverage wraps past midnight
          if (new Date(covEndISO) <= new Date(covStartISO)) {
            const nd = new Date(`${dateStr}T00:00:00`);
            nd.setDate(nd.getDate() + 1);
            covEndISO = `${isoLocal(nd).slice(0, 10)}T${covEnd}:00`;
          }
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

        if (new Date(cursor) < new Date(covEndISO)) gaps.push({ clientId: c.id, dateStr, startISO: cursor, endISO: covEndISO });
      }
    }

    return gaps.filter((g) => minutesBetweenISO(g.startISO, g.endISO) >= 5);
  }, [visibleClients, shiftsInSelectedWeek, weekStartDate]);

  // Admin: drafts
  const [staffDraftName, setStaffDraftName] = useState("");
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
  const [userDraft, setUserDraft] = useState({ id: "", name: "", role: "supervisor", pin: "" });

  async function saveAllNow() {
    // Manual refresh is enough because we already upsert on actions. Works with local fallback.
    alert("Saved / Synced (Realtime will update all users when Supabase is configured).");
  }

  async function addStaff() {
    const name = staffDraftName.trim();
    console.debug("addStaff", { name, staffDraftName });
    if (!name) return alert("Staff name is required.");

    try {
      await sbUpsert("staff", [{ id: uid("st"), name, active: true }]);
      await refreshState(setState);
      setStaffDraftName("");
    } catch (err) {
      console.error("addStaff error", err);
      alert("Unable to add staff. See console for details.");
    }
  }

  async function toggleStaff(id, active) {
    await sbUpsert("staff", [{ id, active: !active }]);
    await refreshState(setState);
  }

  async function removeStaff(id) {
    if (!confirm("Remove staff? (This does not delete their shifts automatically.)")) return;
    await sbDelete("staff", id);
    await refreshState(setState);
  }

  async function saveClient() {
    const name = clientDraft.name.trim();
    if (!name) return alert("Client name required.");
    const row = {
      id: clientDraft.id || uid("cl"),
      name,
      supervisor_id: clientDraft.supervisorId || null,
      coverage_start: clientDraft.coverageStart || "07:00",
      coverage_end: clientDraft.coverageEnd || "23:00",
      weekly_hours: Number(clientDraft.weeklyHours) || 40,
      is_24_hour: !!clientDraft.is24Hour,
      active: clientDraft.active !== false,
    };
    await sbUpsert("clients", [row]);
    await refreshState(setState);
    setClientDraft({ id: "", name: "", supervisorId: "", coverageStart: "07:00", coverageEnd: "23:00", weeklyHours: 40, is24Hour: false, active: true });
  }

  async function deleteClient(id) {
    if (!confirm("Delete this client?")) return;
    // remove shifts for that client first
    const shifts = await sbSelect("shifts");
    const toRemove = (shifts || []).filter((s) => (s.client_id || s.clientId) === id).map((s) => s.id);
    for (const sid of toRemove) {
      await sbDelete("shifts", sid);
    }
    await sbDelete("clients", id);
    await refreshState(setState);
  }

  async function saveUser() {
    if (!userDraft.id.trim() || !userDraft.name.trim() || !userDraft.pin.trim()) {
      return alert("User id, name, and PIN required.");
    }
    const row = { id: userDraft.id.trim(), name: userDraft.name.trim(), role: userDraft.role, pin: userDraft.pin.trim() };
    await sbUpsert("users", [row]);
    await refreshState(setState);
    setUserDraft({ id: "", name: "", role: "supervisor", pin: "" });
  }

  async function deleteUser(id) {
    if (!confirm("Delete this user?")) return;
    await sbDelete("users", id);
    await refreshState(setState);
  }

  // Tabs
  const tabs = [
    { value: "schedule", label: "Schedule" },
    { value: "calendar", label: "Weekly Calendar" },
    { value: "month", label: "Monthly Calendar" },
    { value: "staffSchedule", label: "Staff Schedule" },
    { value: "gaps", label: "Coverage Gaps" },
    { value: "hours", label: "Hours & OT" },
    // --- Client Profiles tab for users who can see clients or admin ---
    ...((canSeeAdminUI || visibleClients.length > 0) ? [
      { value: "clientProfiles", label: "Client Profiles" },
    ] : []),
    ...(canSeeAdminUI
      ? [
          { value: "staff", label: "Staff" },
          { value: "clients", label: "Clients" },
          { value: "users", label: "Users" },
          { value: "settings", label: "Settings" },
        ]
      : []),
  ]);


  if (!mounted) return null;


  // If Supabase isn't configured we'll show a banner inside the UI and
  // fall back to localStorage for data persistence.

  if (!currentUser) {
    return <LoginScreen users={state.users} onLogin={loginAs} onCreateAdmin={createAdminUser} />;
  }

  const canSeeAllShifts = isAdmin; // supervisors see their clients + optional unassigned (via visibleClients)

  return (
    <div style={{ minHeight: "100vh", background: "#0b0c10", color: "white", padding: 16 }}>
      <div style={{ maxWidth: 1200, margin: "0 auto" }}>
        {!SUPABASE_CONFIGURED ? (
          <div style={{ ...styles.card, marginBottom: 12 }} className="no-print">
            <strong>Warning:</strong> Supabase is not configured. The app is using localStorage fallback. To enable cloud sync set <b>NEXT_PUBLIC_SUPABASE_URL</b> and <b>NEXT_PUBLIC_SUPABASE_ANON_KEY</b>.
          </div>
        ) : supabaseError ? (
          <div style={{ ...styles.card, marginBottom: 12 }} className="no-print">
            <strong>Warning:</strong> Supabase requests are failing. The app is using localStorage fallback.
            <div style={{ marginTop: 6, opacity: 0.85, fontSize: 12 }}>
              {supabaseError.message || supabaseError.code || "Unknown error"} (check your anon key & table policies)
            </div>
          </div>
        ) : null}
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 22, fontWeight: 980 }}>DSW Scheduler (Dynamic)</div>
            <div style={styles.tiny}>
              Logged in as <b>{currentUser.name}</b> ({currentUser.role})
            </div>
          </div>

          <div className="no-print" style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button style={styles.btn2} onClick={saveAllNow}>Save</button>
            <button style={styles.btn2} onClick={logout}>Logout</button>
          </div>
        </div>

        <div className="no-print" style={{ marginTop: 10, display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
          <Tabs value={tab} onChange={setTab} tabs={tabs} />
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <div style={styles.tiny}>Week start</div>
            <input style={styles.input} type="date" value={weekStart} onChange={(e) => setWeekStart(e.target.value)} />
          </div>
        </div>

              {/* ================= Schedule ================= */}
{tab === "schedule" && (
  <div style={{ marginTop: 12, ...styles.card }}>
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        gap: 10,
        flexWrap: "wrap",
        alignItems: "center",
      }}
    >
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
          onChange={(e) =>
            setShiftDraft((p) => ({ ...p, clientId: e.target.value }))
          }
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
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <select
            style={styles.select}
            value={shiftDraft.staffId}
            onChange={(e) =>
              setShiftDraft((p) => ({ ...p, staffId: e.target.value }))
            }
          >
            <option value="">Select…</option>
            {suggestedStaff ? (
              <option value={suggestedStaff.id}>
                ⭐ Suggested: {suggestedStaff.name}
              </option>
            ) : null}
            {(state.staff || []).filter((s) => !suggestedStaff || s.id !== suggestedStaff.id).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          {suggestedStaff && shiftDraft.staffId !== suggestedStaff.id ? (
            <button
              style={{ ...styles.btn2, padding: "2px 8px", fontSize: 13 }}
              type="button"
              onClick={() => setShiftDraft((p) => ({ ...p, staffId: suggestedStaff.id }))}
            >
              Suggest
            </button>
          ) : null}
        </div>
        {suggestedStaff ? (
          <div style={{ fontSize: 12, color: "#4cc9f0", marginTop: 2 }}>
            Best match: {suggestedStaff.name} (no conflict, lowest OT)
          </div>
        ) : null}
      </div>

      <div>
        <div style={styles.tiny}>Start</div>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            style={styles.input}
            type="date"
            value={shiftDraft.startDate}
            onChange={(e) =>
              setShiftDraft((p) => ({ ...p, startDate: e.target.value }))
            }
          />
          <input
            style={styles.input}
            type="time"
            value={shiftDraft.startTime}
            onChange={(e) =>
              setShiftDraft((p) => ({ ...p, startTime: e.target.value }))
            }
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
            onChange={(e) =>
              setShiftDraft((p) => ({ ...p, endDate: e.target.value }))
            }
          />
          <input
            style={styles.input}
            type="time"
            value={shiftDraft.endTime}
            onChange={(e) =>
              setShiftDraft((p) => ({ ...p, endTime: e.target.value }))
            }
          />
        </div>
        <div style={styles.tiny}>
          Auto bump end date if end time is earlier than start.
        </div>
      </div>
    </div>

    <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
      <button style={styles.btn} onClick={addShift}>
        Add Shift
      </button>
    </div>

    {builderOpen ? (
      <div style={{ position: "fixed", inset: 0, display: "grid", placeItems: "center", background: "rgba(0,0,0,0.6)" }} className="no-print">
        <div style={{ width: 720, maxWidth: "95%", ...styles.card }}>
          <h3 style={{ marginTop: 0 }}>24-Hour Builder</h3>
          <div style={{ display: "grid", gap: 8 }}>
            <div>
              <div style={styles.tiny}>Client</div>
              <select style={styles.select} value={builderClientId} onChange={(e) => setBuilderClientId(e.target.value)}>
                <option value="">Select…</option>
                {(state.clients || []).map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>

            <div>
              <div style={styles.tiny}>Schedule source</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <input
                    type="radio"
                    name="builderScheduleSource"
                    value="template"
                    checked={builderScheduleSource === "template"}
                    onChange={() => setBuilderScheduleSource("template")}
                  />
                  Template
                </label>
                <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <input
                    type="radio"
                    name="builderScheduleSource"
                    value="client"
                    checked={builderScheduleSource === "client"}
                    onChange={() => setBuilderScheduleSource("client")}
                    disabled={!builderClientId || !clientSchedule?.shifts?.length}
                  />
                  Client saved
                </label>
                <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <input
                    type="radio"
                    name="builderScheduleSource"
                    value="custom"
                    checked={builderScheduleSource === "custom"}
                    onChange={() => setBuilderScheduleSource("custom")}
                  />
                  Custom
                </label>
              </div>
              {builderScheduleSource === "client" ? (
                <div style={styles.tiny}>
                  {clientSchedule?.shifts?.length
                    ? `Loaded saved schedule (${clientSchedule.shifts.length} shifts).`
                    : "No saved schedule for this client yet."}
                </div>
              ) : null}
            </div>

            {builderScheduleSource === "template" ? (
              <div>
                <div style={styles.tiny}>Template</div>
                <select style={styles.select} value={builderTemplate} onChange={(e) => setBuilderTemplate(e.target.value)}>
                  <option value="2x12">2 × 12-hour</option>
                  <option value="3x8">3 × 8-hour</option>
                </select>
              </div>
            ) : null}

            {builderScheduleSource === "custom" ? (
              <div>
                <div style={styles.tiny}>Custom schedule (one per line, e.g. 07:00-15:00)</div>
                <textarea
                  style={{ ...styles.input, height: 120, fontFamily: "inherit", resize: "vertical" }}
                  value={builderCustomTemplate}
                  onChange={(e) => setBuilderCustomTemplate(e.target.value)}
                />
              </div>
            ) : null}

            <div>
              <div style={styles.tiny}>Generate horizon</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <input
                    type="radio"
                    name="builderWeeks"
                    value={1}
                    checked={builderWeeks === 1}
                    onChange={() => setBuilderWeeks(1)}
                  />
                  1 week
                </label>
                <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <input
                    type="radio"
                    name="builderWeeks"
                    value={4}
                    checked={builderWeeks === 4}
                    onChange={() => setBuilderWeeks(4)}
                  />
                  4 weeks
                </label>
              </div>
              <div style={{ marginTop: 8, ...styles.tiny }}>Repeat interval</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <input
                    type="radio"
                    name="builderRepeatInterval"
                    value={1}
                    checked={builderRepeatInterval === 1}
                    onChange={() => setBuilderRepeatInterval(1)}
                  />
                  Every week
                </label>
                <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <input
                    type="radio"
                    name="builderRepeatInterval"
                    value={2}
                    checked={builderRepeatInterval === 2}
                    onChange={() => setBuilderRepeatInterval(2)}
                  />
                  Every 2 weeks
                </label>
                <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <input
                    type="radio"
                    name="builderRepeatInterval"
                    value={4}
                    checked={builderRepeatInterval === 4}
                    onChange={() => setBuilderRepeatInterval(4)}
                  />
                  Every 4 weeks
                </label>
              </div>
              <div style={styles.tiny}>For example: select 4 weeks + every 2 weeks to schedule Week 1 + Week 3.</div>
            </div>

            <div>
              <div style={styles.tiny}>Weekly staff assignment</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(60px, 1fr))", gap: 6 }}>
                {WEEKDAY_NAMES.map((day, idx) => (
                  <div key={day} style={{ display: "flex", flexDirection: "column" }}>
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
                      {(state.staff || []).map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
              <div style={styles.tiny}>Optionally force a specific staff for each day (e.g., Cory on Fridays).</div>
            </div>

            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button
                style={styles.btn2}
                onClick={() => setBuilderOpen(false)}
              >
                Cancel
              </button>
              <button
                style={styles.btn2}
                onClick={() => {
                  if (!builderClientId) return;
                  try {
                    let shifts = [];
                    if (builderScheduleSource === "template") {
                      shifts = builderTemplate === "2x12"
                        ? [
                            { start: "07:00", end: "19:00" },
                            { start: "19:00", end: "07:00" },
                          ]
                        : [
                            { start: "07:00", end: "15:00" },
                            { start: "15:00", end: "23:00" },
                            { start: "23:00", end: "07:00" },
                          ];
                    } else if (builderScheduleSource === "custom") {
                      shifts = parseShiftPattern(builderCustomTemplate);
                    } else if (builderScheduleSource === "client") {
                      shifts = clientSchedule?.shifts || [];
                    }
                    if (!shifts.length) return alert("No shifts to save.");
                    saveClientSchedule(builderClientId, shifts);
                    alert("Saved schedule for this client.");
                  } catch (e) {
                    alert(e.message || "Invalid schedule format.");
                  }
                }}
              >
                Save template
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
        {/* ================= Calendar ================= */}
        {tab === "calendar" && (
          <CalendarWeek
            state={state}
            weekStartDate={weekStartDate}
            visibleClients={visibleClients}
            canSeeAllShifts={canSeeAllShifts}
            setTab={setTab}
            setShiftDraft={setShiftDraft}
            deleteShift={deleteShift}
          />
        )}

        {tab === "month" && (
          <CalendarMonth
            state={state}
            monthStartDate={monthStartDate}
            visibleClients={visibleClients}
            canSeeAllShifts={canSeeAllShifts}
          />
        )}

        {/* ================= Staff Schedule ================= */}
        {tab === "staffSchedule" && (
          <div style={{ marginTop: 12, ...styles.card }}>
            <h3 style={{ marginTop: 0 }}>Staff Schedule</h3>
            <div style={styles.tiny}>Shows upcoming shifts for each staff member in the selected week.</div>

            <div style={{ marginTop: 10, overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={styles.th}>Staff</th>
                    <th style={styles.th}>Shift</th>
                    <th style={styles.th}>Client</th>
                  </tr>
                </thead>
                <tbody>
                  {(state.staff || []).map((st) => {
                    const shifts = shiftsInSelectedWeek
                      .filter((sh) => sh.staffId === st.id)
                      .filter((sh) => (canSeeAllShifts ? true : visibleClients.some((c) => c.id === sh.clientId)))
                      .sort((a, b) => new Date(a.startISO) - new Date(b.startISO));

                    if (!shifts.length) {
                      return (
                        <tr key={st.id}>
                          <td style={styles.td}><b>{st.name}</b></td>
                          <td style={{ ...styles.td, opacity: 0.7 }} colSpan={2}>
                            No shifts this week
                          </td>
                        </tr>
                      );
                    }

                    return shifts.map((sh, idx) => {
                      const client = state.clients.find((c) => c.id === sh.clientId);
                      return (
                        <tr key={`${st.id}_${sh.id}`}>
                          {idx === 0 ? (
                            <td style={styles.td} rowSpan={shifts.length}>
                              <b>{st.name}</b>
                            </td>
                          ) : null}
                          <td style={styles.td}>
                            {sh.startISO.slice(0, 16).replace("T", " ")} → {sh.endISO.slice(0, 16).replace("T", " ")}
                          </td>
                          <td style={styles.td}>{client?.name || "(unknown)"}</td>
                        </tr>
                      );
                    });
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ================= Coverage Gaps ================= */}
        {tab === "gaps" && (
          <div style={{ marginTop: 12, ...styles.card }}>
            <h3 style={{ marginTop: 0 }}>Coverage Gaps (visible clients)</h3>
            <div style={styles.tiny}>
              Based on coverage window (default 7:00a–11:00p). 24-hour clients use 00:00–24:00.
            </div>
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

        {/* ================= Hours & OT ================= */}
        {tab === "hours" && (
          <div style={{ marginTop: 12, ...styles.card }}>
            <h3 style={{ marginTop: 0 }}>Hours & Overtime</h3>
            <div style={styles.tiny}>Shared Support counts once for staff OT, but counts for each client.</div>

            {(currentUser?.role === "supervisor" || isAdmin) &&
            (state.staff || []).some((st) => (staffWeekMinutesMap[st.id] || 0) >= OT_THRESHOLD_MIN) ? (
              <div style={styles.warn}>
                ⚠️ One or more staff have reached 40 hours this week. Review assignments or adjust shifts.
              </div>
            ) : null}

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
                    const min = staffWeekMinutesMap[st.id] || 0;
                    const otMin = Math.max(0, min - OT_THRESHOLD_MIN);
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
                      <th style={styles.th}>Allotted</th>
                      <th style={styles.th}>Weekly Total</th>
                      <th style={styles.th}>Remaining</th>
                      <th style={styles.th}>Day Hours</th>
                      <th style={styles.th}>Night Hours</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(visibleClients || []).map((c) => {
                      const h = weekClientHours[c.id] || { totalMin: 0, dayMin: 0, nightMin: 0 };
                      const allottedMin = (Number(c.weeklyHours) || 0) * 60;
                      const remainingMin = allottedMin - h.totalMin;
                      return (
                        <tr key={c.id}>
                          <td style={styles.td}><b>{c.name}</b></td>
                          <td style={styles.td}>
                            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                              <div style={{ fontSize: 12, opacity: 0.8 }}>{fmtHoursFromMin(allottedMin)}</div>
                              <div style={{ height: 8, width: 120, background: "rgba(255,255,255,0.12)", borderRadius: 4, overflow: "hidden" }}>
                                <div
                                  style={{
                                    height: "100%",
                                    width: `${Math.min(100, allottedMin ? Math.round((h.totalMin / allottedMin) * 100) : 0)}%`,
                                    background: remainingMin < 0 ? "#ff8b8b" : "#4cc9f0",
                                  }}
                                />
                              </div>
                            </div>
                          </td>
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

        {/* ================= Staff (Admin) ================= */}
        {tab === "staff" && canSeeAdminUI && (
          <div style={{ marginTop: 12, ...styles.card }}>
            <h3 style={{ marginTop: 0 }}>Staff</h3>

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <input style={{ ...styles.input, maxWidth: 360 }} value={staffDraftName} onChange={(e) => setStaffDraftName(e.target.value)} placeholder="Add staff name…" />
              <button style={styles.btn} onClick={addStaff}>Add Staff</button>
            </div>

            <div style={styles.hr} />

            <div style={{ display: "grid", gap: 10 }}>
              {(state.staff || []).map((s) => (
                <div key={s.id} style={styles.shift}>
                  <div style={styles.shiftTop}>
                    <div>
                      <div style={styles.shiftTitle}>{s.name}</div>
                      <div style={styles.shiftMeta}>Status: <b>{s.active !== false ? "Active" : "Inactive"}</b></div>
                    </div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button style={styles.btn2} onClick={() => toggleStaff(s.id, s.active !== false)}>
                        {s.active !== false ? "Deactivate" : "Activate"}
                      </button>
                      <button style={styles.btn2} onClick={() => removeStaff(s.id)}>Remove</button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ================= Clients (Admin) ================= */}
        {tab === "clients" && canSeeAdminUI && (
          <div style={{ marginTop: 12, ...styles.card }}>
            <h3 style={{ marginTop: 0 }}>Clients (Assign supervisor over case)</h3>

            <div style={{ marginTop: 10, ...styles.grid4 }}>
              <div>
                <div style={styles.tiny}>Client name</div>
                <input style={styles.input} value={clientDraft.name} onChange={(e) => setClientDraft((p) => ({ ...p, name: e.target.value }))} />
              </div>

              <div>
                <div style={styles.tiny}>Supervisor over case</div>
                <select style={styles.select} value={clientDraft.supervisorId || ""} onChange={(e) => setClientDraft((p) => ({ ...p, supervisorId: e.target.value }))}>
                  <option value="">Unassigned</option>
                  {(state.users || []).filter((u) => u.role === "supervisor" || u.role === "admin").map((u) => (
                    <option key={u.id} value={u.id}>{u.name} ({u.role})</option>
                  ))}
                </select>
              </div>

              <div>
                <div style={styles.tiny}>Weekly hours allotted</div>
                <input
                  style={styles.input}
                  type="number"
                  min={0}
                  value={clientDraft.weeklyHours}
                  onChange={(e) => setClientDraft((p) => ({ ...p, weeklyHours: Number(e.target.value) }))}
                />
              </div>

              <div>
                <div style={styles.tiny}>Coverage Start</div>
                <input style={styles.input} type="time" value={clientDraft.coverageStart || "07:00"} onChange={(e) => setClientDraft((p) => ({ ...p, coverageStart: e.target.value }))} />
                <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
                  <input type="checkbox" checked={!!clientDraft.is24Hour} onChange={(e) => setClientDraft((p) => ({ ...p, is24Hour: e.target.checked }))} />
                  24-hour client
                </label>
              </div>

              <div>
                <div style={styles.tiny}>Coverage End</div>
                <input style={styles.input} type="time" value={clientDraft.coverageEnd || "23:00"} onChange={(e) => setClientDraft((p) => ({ ...p, coverageEnd: e.target.value }))} />
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
                        <div style={styles.shiftTitle}>
                          {c.name} {c.is24Hour ? <span style={{ opacity: 0.8 }}>(24h)</span> : null}
                        </div>
                        <div style={styles.shiftMeta}>
                          Supervisor: <b>{sup ? sup.name : "Unassigned"}</b>
                          <br />
                          Coverage: {c.coverageStart || "07:00"} → {c.coverageEnd || "23:00"}
                          <br />
                          Weekly allotment: <b>{Number(c.weeklyHours) || 0}h</b>
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
                            setTab("schedule");
                            setBuilderClientId(c.id);
                            setBuilderScheduleSource("client");
                            setBuilderOpen(true);
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

        {/* ================= Users (Admin) ================= */}
        {tab === "users" && canSeeAdminUI && (
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
                      <div style={styles.shiftMeta}>ID: <b>{u.id}</b> • Role: <b>{u.role}</b></div>
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

        {/* ================= Settings (Admin) ================= */}
        {tab === "settings" && canSeeAdminUI && (
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
              Hard-stop conflicts (block overlaps unless same Shared Group block)
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
  th: { textAlign: "left", fontSize: 12, opacity: 0.85, padding: "8px 6px", borderBottom: "1px solid rgba(255,255,255,0.10)" },
  td: { padding: "8px 6px", borderBottom: "1px solid rgba(255,255,255,0.06)", fontSize: 13 },
};

