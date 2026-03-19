// lib/calculations.js
// Centralized calculation engine for hours, units, and overtime.
// All functions are pure — no side effects, no DB calls.

export const UNITS_PER_HOUR = 4;
export const OT_THRESHOLD_HOURS = 40;
export const OT_THRESHOLD_MIN = 40 * 60;
export const WEEKLY_DAYS = 7;
export const BIWEEKLY_DAYS = 14;

// ─── Unit conversions ───

export function hoursToUnits(hours) {
  return (Number(hours) || 0) * UNITS_PER_HOUR;
}

export function unitsToHours(units) {
  return (Number(units) || 0) / UNITS_PER_HOUR;
}

export function minutesToHours(min) {
  return (Number(min) || 0) / 60;
}

export function minutesToUnits(min) {
  return hoursToUnits(minutesToHours(min));
}

export function fmtHours(min) {
  return `${(min / 60).toFixed(2)}h`;
}

export function fmtUnits(min) {
  return `${minutesToUnits(min).toFixed(1)}u`;
}

// ─── Date window helpers ───

function toDateOnly(input) {
  const raw = String(input || "").trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const d = new Date(`${raw}T00:00:00`);
  return isNaN(d) ? null : d;
}

function formatDate(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function addDays(d, n) {
  const result = new Date(d);
  result.setDate(result.getDate() + n);
  return result;
}

export function getWeekWindow(dateInput) {
  const d = toDateOnly(dateInput);
  if (!d) return null;
  const day = d.getDay(); // 0=Sun
  const start = addDays(d, -day);
  const end = addDays(start, 7); // exclusive
  return {
    startISO: `${formatDate(start)}T00:00:00`,
    endISO: `${formatDate(end)}T00:00:00`,
    startDate: formatDate(start),
    endDate: formatDate(addDays(start, 6)),
    label: `Week of ${formatDate(start)}`,
  };
}

export function getBiweeklyWindow(dateInput, anchorDate = "2026-03-08") {
  const d = toDateOnly(dateInput);
  const anchor = toDateOnly(anchorDate);
  if (!d || !anchor) return null;
  const diffMs = d.getTime() - anchor.getTime();
  const diffDays = Math.floor(diffMs / 86400000);
  const cycleIndex = Math.floor(diffDays / BIWEEKLY_DAYS);
  const start = addDays(anchor, cycleIndex * BIWEEKLY_DAYS);
  const end = addDays(start, BIWEEKLY_DAYS);
  return {
    startISO: `${formatDate(start)}T00:00:00`,
    endISO: `${formatDate(end)}T00:00:00`,
    startDate: formatDate(start),
    endDate: formatDate(addDays(start, BIWEEKLY_DAYS - 1)),
    label: `Biweek ${formatDate(start)} – ${formatDate(addDays(start, BIWEEKLY_DAYS - 1))}`,
  };
}

// ─── Minutes calculation (clipped to window) ───

function shiftMinutesInWindow(shiftStartISO, shiftEndISO, windowStartISO, windowEndISO) {
  const ss = new Date(shiftStartISO);
  const se = new Date(shiftEndISO);
  const ws = new Date(windowStartISO);
  const we = new Date(windowEndISO);
  if (isNaN(ss) || isNaN(se) || isNaN(ws) || isNaN(we)) return 0;
  if (se <= ss || we <= ws) return 0;
  const start = ss > ws ? ss : ws;
  const end = se < we ? se : we;
  if (end <= start) return 0;
  return Math.round((end - start) / 60000);
}

// Shared-support dedup key
function shiftDedupKey(sh) {
  const isShared = !!(sh.isShared || sh.is_shared);
  const groupId = sh.sharedGroupId || sh.shared_group_id || "";
  if (isShared && groupId) {
    const staffId = sh.staffId || sh.staff_id || "";
    const startISO = sh.startISO || sh.start_iso || "";
    const endISO = sh.endISO || sh.end_iso || "";
    return `SS|${staffId}|${startISO}|${endISO}|${groupId}`;
  }
  return `N|${sh.id}`;
}

// ─── Staff hours ───

export function staffMinutesInWindow(shifts, staffId, windowStartISO, windowEndISO) {
  const seen = new Set();
  let total = 0;
  for (const sh of shifts || []) {
    const sid = sh.staffId || sh.staff_id;
    if (sid !== staffId) continue;
    const key = shiftDedupKey(sh);
    if (seen.has(key)) continue;
    seen.add(key);
    const startISO = sh.startISO || sh.start_iso;
    const endISO = sh.endISO || sh.end_iso;
    total += shiftMinutesInWindow(startISO, endISO, windowStartISO, windowEndISO);
  }
  return total;
}

export function staffWeeklyMinutes(shifts, staffId, weekDate) {
  const w = getWeekWindow(weekDate);
  if (!w) return 0;
  return staffMinutesInWindow(shifts, staffId, w.startISO, w.endISO);
}

export function staffBiweeklyMinutes(shifts, staffId, dateInPeriod, anchor) {
  const w = getBiweeklyWindow(dateInPeriod, anchor);
  if (!w) return 0;
  return staffMinutesInWindow(shifts, staffId, w.startISO, w.endISO);
}

// ─── Client hours ───

export function clientMinutesInWindow(shifts, clientId, windowStartISO, windowEndISO) {
  let total = 0;
  for (const sh of shifts || []) {
    const cid = sh.clientId || sh.client_id;
    if (cid !== clientId) continue;
    const startISO = sh.startISO || sh.start_iso;
    const endISO = sh.endISO || sh.end_iso;
    total += shiftMinutesInWindow(startISO, endISO, windowStartISO, windowEndISO);
  }
  return total;
}

export function clientWeeklyMinutes(shifts, clientId, weekDate) {
  const w = getWeekWindow(weekDate);
  if (!w) return 0;
  return clientMinutesInWindow(shifts, clientId, w.startISO, w.endISO);
}

export function clientBiweeklyMinutes(shifts, clientId, dateInPeriod, anchor) {
  const w = getBiweeklyWindow(dateInPeriod, anchor);
  if (!w) return 0;
  return clientMinutesInWindow(shifts, clientId, w.startISO, w.endISO);
}

// ─── Overtime analysis ───

export function staffOvertimeMinutes(totalMinutes) {
  return Math.max(0, (Number(totalMinutes) || 0) - OT_THRESHOLD_MIN);
}

export function staffOvertimePercent(totalMinutes) {
  const ot = staffOvertimeMinutes(totalMinutes);
  if (ot <= 0) return 0;
  return (ot / OT_THRESHOLD_MIN) * 100;
}

export function isNearOT(totalMinutes) {
  const m = Number(totalMinutes) || 0;
  return m >= 36 * 60 && m < OT_THRESHOLD_MIN;
}

export function isInOT(totalMinutes) {
  return (Number(totalMinutes) || 0) >= OT_THRESHOLD_MIN;
}

/** Find the shift that first pushes a staff member past 40h in a window */
export function findShiftCausingOT(shifts, staffId, windowStartISO, windowEndISO) {
  const seen = new Set();
  let cumulative = 0;
  const staffShifts = (shifts || [])
    .filter((sh) => (sh.staffId || sh.staff_id) === staffId)
    .sort((a, b) => new Date(a.startISO || a.start_iso) - new Date(b.startISO || b.start_iso));

  for (const sh of staffShifts) {
    const key = shiftDedupKey(sh);
    if (seen.has(key)) continue;
    seen.add(key);
    const startISO = sh.startISO || sh.start_iso;
    const endISO = sh.endISO || sh.end_iso;
    const min = shiftMinutesInWindow(startISO, endISO, windowStartISO, windowEndISO);
    if (min <= 0) continue;
    cumulative += min;
    if (cumulative > OT_THRESHOLD_MIN) return sh;
  }
  return null;
}

// ─── All staff OT summary for a window ───

export function allStaffOTSummary(shifts, staffList, windowStartISO, windowEndISO) {
  const results = [];
  for (const st of staffList || []) {
    const min = staffMinutesInWindow(shifts, st.id, windowStartISO, windowEndISO);
    const otMin = staffOvertimeMinutes(min);
    const otPct = staffOvertimePercent(min);
    const near = isNearOT(min);
    const over = isInOT(min);
    results.push({
      staffId: st.id,
      name: st.name,
      totalMinutes: min,
      otMinutes: otMin,
      otPercent: otPct,
      isNearOT: near,
      isInOT: over,
      shiftCausingOT: over ? findShiftCausingOT(shifts, st.id, windowStartISO, windowEndISO) : null,
    });
  }
  return results;
}

// ─── Client authorized vs scheduled ───

export function clientAuthorizedVsScheduled(shifts, client, windowStartISO, windowEndISO, windowDays = 7) {
  const clientId = client?.id;
  if (!clientId) return null;
  const weeklyAuth = Number(client.weeklyHours ?? client.hours_allotted ?? client.weekly_hours) || 40;
  const biweeklyAuth = Number(client.biweeklyHours ?? client.biweekly_hours) || weeklyAuth * 2;
  const authorizedMin = Math.round(weeklyAuth * 60 * (windowDays / 7));
  const scheduledMin = clientMinutesInWindow(shifts, clientId, windowStartISO, windowEndISO);
  const remainingMin = authorizedMin - scheduledMin;

  return {
    clientId,
    clientName: client.name,
    weeklyAuthorizedHours: weeklyAuth,
    biweeklyAuthorizedHours: biweeklyAuth,
    authorizedMinutes: authorizedMin,
    scheduledMinutes: scheduledMin,
    remainingMinutes: remainingMin,
    isOver: remainingMin < 0,
    isUnder: scheduledMin < authorizedMin * 0.8,
    usagePercent: authorizedMin > 0 ? (scheduledMin / authorizedMin) * 100 : 0,
  };
}

// ─── Open shifts (unassigned staff) ───

export function findOpenShifts(shifts) {
  return (shifts || []).filter((sh) => {
    const staffId = sh.staffId || sh.staff_id || "";
    return !staffId;
  });
}

export function openShiftMinutes(shifts) {
  return findOpenShifts(shifts).reduce((sum, sh) => {
    const s = new Date(sh.startISO || sh.start_iso);
    const e = new Date(sh.endISO || sh.end_iso);
    if (isNaN(s) || isNaN(e) || e <= s) return sum;
    return sum + Math.round((e - s) / 60000);
  }, 0);
}

// ─── Conflict detection ───

export function findAllConflicts(shifts) {
  const normalized = (shifts || [])
    .map((sh) => ({
      id: sh.id,
      staffId: sh.staffId || sh.staff_id || "",
      clientId: sh.clientId || sh.client_id || "",
      startISO: sh.startISO || sh.start_iso || "",
      endISO: sh.endISO || sh.end_iso || "",
      isShared: !!(sh.isShared || sh.is_shared),
      sharedGroupId: sh.sharedGroupId || sh.shared_group_id || "",
    }))
    .filter((sh) => sh.staffId && sh.startISO && sh.endISO);

  const conflicts = [];
  for (let i = 0; i < normalized.length; i++) {
    for (let j = i + 1; j < normalized.length; j++) {
      const a = normalized[i];
      const b = normalized[j];
      if (a.staffId !== b.staffId) continue;
      // Same shared group is not a conflict
      if (a.isShared && b.isShared && a.sharedGroupId && a.sharedGroupId === b.sharedGroupId) continue;
      const aS = new Date(a.startISO);
      const aE = new Date(a.endISO);
      const bS = new Date(b.startISO);
      const bE = new Date(b.endISO);
      if (aS < bE && bS < aE) {
        conflicts.push({ shiftA: a, shiftB: b, staffId: a.staffId });
      }
    }
  }
  return conflicts;
}

// ─── Shift save validation (pre-save warnings) ───

export function validateShiftSave({
  shifts,
  staffId,
  clientId,
  startISO,
  endISO,
  client,
  windowStartISO,
  windowEndISO,
  windowDays = 7,
  biweeklyWindowStartISO,
  biweeklyWindowEndISO,
}) {
  const warnings = [];
  const shiftMin = shiftMinutesInWindow(startISO, endISO, startISO, endISO);

  // Weekly OT check
  if (staffId && windowStartISO && windowEndISO) {
    const currentMin = staffMinutesInWindow(shifts, staffId, windowStartISO, windowEndISO);
    const projectedMin = currentMin + shiftMin;
    if (projectedMin > OT_THRESHOLD_MIN) {
      warnings.push({
        type: "weekly_ot",
        severity: "warn",
        message: `This shift puts staff at ${fmtHours(projectedMin)} this week (${fmtHours(staffOvertimeMinutes(projectedMin))} OT).`,
        projectedMinutes: projectedMin,
        otMinutes: staffOvertimeMinutes(projectedMin),
      });
    }
  }

  // Biweekly OT check
  if (staffId && biweeklyWindowStartISO && biweeklyWindowEndISO) {
    const currentBiMin = staffMinutesInWindow(shifts, staffId, biweeklyWindowStartISO, biweeklyWindowEndISO);
    const projectedBiMin = currentBiMin + shiftMin;
    if (projectedBiMin > OT_THRESHOLD_MIN * 2) {
      warnings.push({
        type: "biweekly_ot",
        severity: "warn",
        message: `This shift puts staff at ${fmtHours(projectedBiMin)} this biweekly period (${fmtHours(projectedBiMin - OT_THRESHOLD_MIN * 2)} over 80h).`,
        projectedMinutes: projectedBiMin,
      });
    }
  }

  // Overlap check
  if (staffId) {
    const overlapping = (shifts || []).filter((sh) => {
      const sid = sh.staffId || sh.staff_id;
      if (sid !== staffId) return false;
      const sS = new Date(sh.startISO || sh.start_iso);
      const sE = new Date(sh.endISO || sh.end_iso);
      const cS = new Date(startISO);
      const cE = new Date(endISO);
      return sS < cE && cS < sE;
    });
    if (overlapping.length > 0) {
      warnings.push({
        type: "overlap",
        severity: "block",
        message: "This shift overlaps an existing shift for this staff.",
        overlappingShifts: overlapping,
      });
    }
  }

  // Client authorized hours check
  if (client && clientId && windowStartISO && windowEndISO) {
    const authCheck = clientAuthorizedVsScheduled(shifts, client, windowStartISO, windowEndISO, windowDays);
    if (authCheck) {
      const projectedClientMin = authCheck.scheduledMinutes + shiftMin;
      if (projectedClientMin > authCheck.authorizedMinutes) {
        warnings.push({
          type: "client_over_auth",
          severity: "warn",
          message: `This shift causes client scheduled hours (${fmtHours(projectedClientMin)}) to exceed authorized hours (${fmtHours(authCheck.authorizedMinutes)}).`,
          projectedMinutes: projectedClientMin,
          authorizedMinutes: authCheck.authorizedMinutes,
        });
      }
    }
  }

  return warnings;
}

// ─── Replacement finder for call-outs ───

export function findReplacementCandidates({
  shifts,
  staffList,
  shiftStartISO,
  shiftEndISO,
  excludeStaffId,
  unavailableDates = {},
  windowStartISO,
  windowEndISO,
}) {
  const shiftDate = String(shiftStartISO || "").slice(0, 10);

  return (staffList || [])
    .filter((st) => st.active !== false)
    .filter((st) => st.id !== excludeStaffId)
    .map((st) => {
      // Check unavailable dates
      const staffUnavailDates = unavailableDates[st.id] || [];
      const isUnavailable = staffUnavailDates.includes(shiftDate);

      // Check overlaps
      const hasOverlap = (shifts || []).some((sh) => {
        const sid = sh.staffId || sh.staff_id;
        if (sid !== st.id) return false;
        const sS = new Date(sh.startISO || sh.start_iso);
        const sE = new Date(sh.endISO || sh.end_iso);
        const cS = new Date(shiftStartISO);
        const cE = new Date(shiftEndISO);
        return sS < cE && cS < sE;
      });

      // Weekly hours
      const weeklyMin = windowStartISO && windowEndISO
        ? staffMinutesInWindow(shifts, st.id, windowStartISO, windowEndISO)
        : 0;
      const shiftMin = shiftMinutesInWindow(shiftStartISO, shiftEndISO, shiftStartISO, shiftEndISO);
      const projectedMin = weeklyMin + shiftMin;
      const wouldCauseOT = projectedMin > OT_THRESHOLD_MIN;

      return {
        staff: st,
        weeklyMinutes: weeklyMin,
        projectedMinutes: projectedMin,
        wouldCauseOT,
        isUnavailable,
        hasOverlap,
        isAvailable: !isUnavailable && !hasOverlap,
        sortScore: (hasOverlap ? 100000 : 0) + (isUnavailable ? 50000 : 0) + (wouldCauseOT ? 10000 : 0) + weeklyMin,
      };
    })
    .sort((a, b) => a.sortScore - b.sortScore);
}

// ─── Dashboard summary computation ───

export function computeDashboardSummary({
  shifts,
  staffList,
  clients,
  callOuts,
  windowStartISO,
  windowEndISO,
  windowDays = 7,
  todayISO,
}) {
  const openShifts = findOpenShifts(shifts);
  const conflicts = findAllConflicts(shifts);

  // Staff near 40h and in OT
  const staffSummary = allStaffOTSummary(shifts, staffList, windowStartISO, windowEndISO);
  const staffNear40 = staffSummary.filter((s) => s.isNearOT);
  const staffInOT = staffSummary.filter((s) => s.isInOT);

  // Client authorized vs scheduled
  const clientSummaries = (clients || []).map((c) =>
    clientAuthorizedVsScheduled(shifts, c, windowStartISO, windowEndISO, windowDays)
  ).filter(Boolean);
  const clientsUnderAuth = clientSummaries.filter((c) => c.isUnder);
  const clientsOverAuth = clientSummaries.filter((c) => c.isOver);

  // Today's call-outs
  const today = todayISO || new Date().toISOString().slice(0, 10);
  const todayCallOuts = (callOuts || []).filter((co) => {
    const coDate = co.date || String(co.created_at || "").slice(0, 10);
    return coDate === today;
  });

  // Unfilled hours by client
  const unfilledByClient = (clients || []).map((c) => {
    const auth = clientAuthorizedVsScheduled(shifts, c, windowStartISO, windowEndISO, windowDays);
    return {
      clientId: c.id,
      clientName: c.name,
      remainingMinutes: auth?.remainingMinutes || 0,
      scheduledMinutes: auth?.scheduledMinutes || 0,
      authorizedMinutes: auth?.authorizedMinutes || 0,
    };
  }).filter((c) => c.remainingMinutes > 0)
    .sort((a, b) => b.remainingMinutes - a.remainingMinutes);

  return {
    openShiftsCount: openShifts.length,
    openShiftsMinutes: openShiftMinutes(shifts),
    conflictsCount: conflicts.length,
    conflicts,
    staffNear40Count: staffNear40.length,
    staffNear40,
    staffInOTCount: staffInOT.length,
    staffInOT,
    clientsUnderAuthCount: clientsUnderAuth.length,
    clientsUnderAuth,
    clientsOverAuthCount: clientsOverAuth.length,
    clientsOverAuth,
    todayCallOutsCount: todayCallOuts.length,
    todayCallOuts,
    unfilledByClient,
    clientSummaries,
    staffSummary,
  };
}

// ─── Payroll summary computation ───

export function computePayrollSummary({
  shifts,
  staffList,
  windowStartISO,
  windowEndISO,
  weekBuckets = [],
}) {
  const staffRows = (staffList || []).map((st) => {
    const totalMin = staffMinutesInWindow(shifts, st.id, windowStartISO, windowEndISO);
    const otMin = staffOvertimeMinutes(totalMin);
    const otPct = staffOvertimePercent(totalMin);

    // Weekly breakdown
    const weekly = weekBuckets.map((bucket) => {
      const min = staffMinutesInWindow(shifts, st.id, bucket.startISO, bucket.endISO);
      return { weekStart: bucket.startDate, minutes: min, otMinutes: Math.max(0, min - OT_THRESHOLD_MIN) };
    });

    return {
      staffId: st.id,
      name: st.name,
      totalMinutes: totalMin,
      otMinutes: otMin,
      otPercent: otPct,
      weeklyBreakdown: weekly,
    };
  }).filter((r) => r.totalMinutes > 0)
    .sort((a, b) => b.totalMinutes - a.totalMinutes);

  const totalScheduledMin = staffRows.reduce((sum, r) => sum + r.totalMinutes, 0);
  const totalOTMin = staffRows.reduce((sum, r) => sum + r.otMinutes, 0);

  return {
    staffRows,
    totalScheduledMinutes: totalScheduledMin,
    totalOTMinutes: totalOTMin,
    overallOTPercent: totalScheduledMin > 0 ? (totalOTMin / totalScheduledMin) * 100 : 0,
  };
}
