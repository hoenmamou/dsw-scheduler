// lib/calculations.js
// Centralized calculation engine for hours, units, and overtime.
// All functions are pure — no side effects, no DB calls.

export const UNITS_PER_HOUR = 4;
export const OT_THRESHOLD_HOURS = 40;
export const OT_THRESHOLD_MIN = 40 * 60;
export const WEEKLY_DAYS = 7;
export const BIWEEKLY_DAYS = 14;

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function getShiftStartISO(shift) {
  return shift?.startISO || shift?.start_iso || "";
}

function getShiftEndISO(shift) {
  return shift?.endISO || shift?.end_iso || "";
}

function getShiftStaffId(shift) {
  return shift?.staffId || shift?.staff_id || "";
}

function getShiftClientId(shift) {
  return shift?.clientId || shift?.client_id || "";
}

function getShiftSharedGroupId(shift) {
  return shift?.sharedGroupId || shift?.shared_group_id || "";
}

function isSharedShift(shift) {
  return !!(shift?.isShared || shift?.is_shared);
}

function toValidDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function rangesOverlap(startA, endA, startB, endB) {
  const aStart = toValidDate(startA);
  const aEnd = toValidDate(endA);
  const bStart = toValidDate(startB);
  const bEnd = toValidDate(endB);
  if (!aStart || !aEnd || !bStart || !bEnd) return false;
  return aStart < bEnd && bStart < aEnd;
}

// Unit conversions

export function hoursToUnits(hours) {
  return toFiniteNumber(hours) * UNITS_PER_HOUR;
}

export function unitsToHours(units) {
  return toFiniteNumber(units) / UNITS_PER_HOUR;
}

export function minutesToHours(min) {
  return toFiniteNumber(min) / 60;
}

export function minutesToUnits(min) {
  return hoursToUnits(minutesToHours(min));
}

export function fmtHours(min) {
  return `${minutesToHours(min).toFixed(2)}h`;
}

export function fmtUnits(min) {
  return `${minutesToUnits(min).toFixed(1)}u`;
}

// Date window helpers

function toDateOnly(input) {
  const raw = String(input || "").trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const date = new Date(`${raw}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDate(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + toFiniteNumber(days));
  return result;
}

export function getWeekWindow(dateInput) {
  const date = toDateOnly(dateInput);
  if (!date) return null;
  const day = date.getDay();
  const start = addDays(date, -day);
  const end = addDays(start, WEEKLY_DAYS);
  return {
    startISO: `${formatDate(start)}T00:00:00`,
    endISO: `${formatDate(end)}T00:00:00`,
    startDate: formatDate(start),
    endDate: formatDate(addDays(start, WEEKLY_DAYS - 1)),
    label: `Week of ${formatDate(start)}`,
  };
}

export function getBiweeklyWindow(dateInput, anchorDate = "2026-03-08") {
  const date = toDateOnly(dateInput);
  const anchor = toDateOnly(anchorDate);
  if (!date || !anchor) return null;

  const diffMs = date.getTime() - anchor.getTime();
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

// Minutes calculation (clipped to window)

function shiftMinutesInWindow(shiftStartISO, shiftEndISO, windowStartISO, windowEndISO) {
  const shiftStart = toValidDate(shiftStartISO);
  const shiftEnd = toValidDate(shiftEndISO);
  const windowStart = toValidDate(windowStartISO);
  const windowEnd = toValidDate(windowEndISO);

  if (!shiftStart || !shiftEnd || !windowStart || !windowEnd) return 0;
  if (shiftEnd <= shiftStart || windowEnd <= windowStart) return 0;

  const start = shiftStart > windowStart ? shiftStart : windowStart;
  const end = shiftEnd < windowEnd ? shiftEnd : windowEnd;
  if (end <= start) return 0;

  return Math.round((end - start) / 60000);
}

export function shiftDedupKey(shift) {
  const shared = isSharedShift(shift);
  const groupId = getShiftSharedGroupId(shift);
  if (shared && groupId) {
    const staffId = getShiftStaffId(shift);
    const startISO = getShiftStartISO(shift);
    const endISO = getShiftEndISO(shift);
    return `SS|${staffId}|${startISO}|${endISO}|${groupId}`;
  }
  return `N|${shift?.id ?? ""}`;
}

// Staff hours

export function staffMinutesInWindow(shifts, staffId, windowStartISO, windowEndISO) {
  const seen = new Set();
  let total = 0;

  for (const shift of asArray(shifts)) {
    const normalizedStaffId = getShiftStaffId(shift);
    if (normalizedStaffId !== staffId) continue;

    const key = shiftDedupKey(shift);
    if (seen.has(key)) continue;
    seen.add(key);

    total += shiftMinutesInWindow(
      getShiftStartISO(shift),
      getShiftEndISO(shift),
      windowStartISO,
      windowEndISO
    );
  }

  return total;
}

export function staffWeeklyMinutes(shifts, staffId, weekDate) {
  const window = getWeekWindow(weekDate);
  if (!window) return 0;
  return staffMinutesInWindow(shifts, staffId, window.startISO, window.endISO);
}

export function staffBiweeklyMinutes(shifts, staffId, dateInPeriod, anchor) {
  const window = getBiweeklyWindow(dateInPeriod, anchor);
  if (!window) return 0;
  return staffMinutesInWindow(shifts, staffId, window.startISO, window.endISO);
}

// Client hours

export function clientMinutesInWindow(shifts, clientId, windowStartISO, windowEndISO) {
  let total = 0;

  for (const shift of asArray(shifts)) {
    const normalizedClientId = getShiftClientId(shift);
    if (normalizedClientId !== clientId) continue;

    total += shiftMinutesInWindow(
      getShiftStartISO(shift),
      getShiftEndISO(shift),
      windowStartISO,
      windowEndISO
    );
  }

  return total;
}

export function clientWeeklyMinutes(shifts, clientId, weekDate) {
  const window = getWeekWindow(weekDate);
  if (!window) return 0;
  return clientMinutesInWindow(shifts, clientId, window.startISO, window.endISO);
}

export function clientBiweeklyMinutes(shifts, clientId, dateInPeriod, anchor) {
  const window = getBiweeklyWindow(dateInPeriod, anchor);
  if (!window) return 0;
  return clientMinutesInWindow(shifts, clientId, window.startISO, window.endISO);
}

// Overtime analysis

export function staffOvertimeMinutes(totalMinutes) {
  return Math.max(0, toFiniteNumber(totalMinutes) - OT_THRESHOLD_MIN);
}

export function staffOvertimePercent(totalMinutes) {
  const overtimeMinutes = staffOvertimeMinutes(totalMinutes);
  if (overtimeMinutes <= 0) return 0;
  return (overtimeMinutes / OT_THRESHOLD_MIN) * 100;
}

export function isNearOT(totalMinutes) {
  const minutes = toFiniteNumber(totalMinutes);
  return minutes >= 36 * 60 && minutes < OT_THRESHOLD_MIN;
}

export function isInOT(totalMinutes) {
  return toFiniteNumber(totalMinutes) >= OT_THRESHOLD_MIN;
}

export function findShiftCausingOT(shifts, staffId, windowStartISO, windowEndISO) {
  const seen = new Set();
  let cumulative = 0;

  const staffShifts = asArray(shifts)
    .filter((shift) => getShiftStaffId(shift) === staffId)
    .sort((a, b) => {
      const aTime = toValidDate(getShiftStartISO(a))?.getTime() ?? 0;
      const bTime = toValidDate(getShiftStartISO(b))?.getTime() ?? 0;
      return aTime - bTime;
    });

  for (const shift of staffShifts) {
    const key = shiftDedupKey(shift);
    if (seen.has(key)) continue;
    seen.add(key);

    const minutes = shiftMinutesInWindow(
      getShiftStartISO(shift),
      getShiftEndISO(shift),
      windowStartISO,
      windowEndISO
    );
    if (minutes <= 0) continue;

    cumulative += minutes;
    if (cumulative > OT_THRESHOLD_MIN) return shift;
  }

  return null;
}

// All staff OT summary for a window

export function allStaffOTSummary(shifts, staffList, windowStartISO, windowEndISO) {
  const results = [];

  for (const staff of asArray(staffList)) {
    const totalMinutes = staffMinutesInWindow(shifts, staff?.id, windowStartISO, windowEndISO);
    const otMinutes = staffOvertimeMinutes(totalMinutes);
    const otPercent = staffOvertimePercent(totalMinutes);
    const near = isNearOT(totalMinutes);
    const over = isInOT(totalMinutes);

    results.push({
      staffId: staff?.id,
      name: staff?.name,
      totalMinutes,
      otMinutes,
      otPercent,
      isNearOT: near,
      isInOT: over,
      shiftCausingOT: over
        ? findShiftCausingOT(shifts, staff?.id, windowStartISO, windowEndISO)
        : null,
    });
  }

  return results;
}

// Client authorized vs scheduled

export function clientAuthorizedVsScheduled(
  shifts,
  client,
  windowStartISO,
  windowEndISO,
  windowDays = 7
) {
  const clientId = client?.id;
  if (!clientId) return null;

  const weeklyAuth =
    toFiniteNumber(client?.weeklyHours) ||
    toFiniteNumber(client?.hours_allotted) ||
    toFiniteNumber(client?.weekly_hours) ||
    40;
  const biweeklyAuth =
    toFiniteNumber(client?.biweeklyHours) ||
    toFiniteNumber(client?.biweekly_hours) ||
    weeklyAuth * 2;
  const safeWindowDays = toFiniteNumber(windowDays, 7) || 7;
  const authorizedMinutes = Math.round(weeklyAuth * 60 * (safeWindowDays / 7));
  const scheduledMinutes = clientMinutesInWindow(shifts, clientId, windowStartISO, windowEndISO);
  const remainingMinutes = authorizedMinutes - scheduledMinutes;

  return {
    clientId,
    clientName: client?.name,
    weeklyAuthorizedHours: weeklyAuth,
    biweeklyAuthorizedHours: biweeklyAuth,
    authorizedMinutes,
    scheduledMinutes,
    remainingMinutes,
    isOver: remainingMinutes < 0,
    isUnder: scheduledMinutes < authorizedMinutes * 0.8,
    usagePercent: authorizedMinutes > 0 ? (scheduledMinutes / authorizedMinutes) * 100 : 0,
  };
}

// Open shifts (unassigned staff)

export function findOpenShifts(shifts) {
  return asArray(shifts).filter((shift) => !getShiftStaffId(shift));
}

export function openShiftMinutes(shifts) {
  return findOpenShifts(shifts).reduce((sum, shift) => {
    const start = toValidDate(getShiftStartISO(shift));
    const end = toValidDate(getShiftEndISO(shift));
    if (!start || !end || end <= start) return sum;
    return sum + Math.round((end - start) / 60000);
  }, 0);
}

// Conflict detection

export function findAllConflicts(shifts) {
  const normalized = asArray(shifts)
    .map((shift) => ({
      id: shift?.id,
      staffId: getShiftStaffId(shift),
      clientId: getShiftClientId(shift),
      startISO: getShiftStartISO(shift),
      endISO: getShiftEndISO(shift),
      isShared: isSharedShift(shift),
      sharedGroupId: getShiftSharedGroupId(shift),
    }))
    .filter((shift) => shift.staffId && shift.startISO && shift.endISO);

  const conflicts = [];
  for (let index = 0; index < normalized.length; index += 1) {
    for (let compareIndex = index + 1; compareIndex < normalized.length; compareIndex += 1) {
      const shiftA = normalized[index];
      const shiftB = normalized[compareIndex];

      if (shiftA.staffId !== shiftB.staffId) continue;
      if (
        shiftA.isShared &&
        shiftB.isShared &&
        shiftA.sharedGroupId &&
        shiftA.sharedGroupId === shiftB.sharedGroupId
      ) {
        continue;
      }

      if (rangesOverlap(shiftA.startISO, shiftA.endISO, shiftB.startISO, shiftB.endISO)) {
        conflicts.push({ shiftA, shiftB, staffId: shiftA.staffId });
      }
    }
  }

  return conflicts;
}

// Shift save validation (pre-save warnings)

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
} = {}) {
  const warnings = [];
  const shiftMinutes = shiftMinutesInWindow(startISO, endISO, startISO, endISO);

  if (staffId && windowStartISO && windowEndISO) {
    const currentMinutes = staffMinutesInWindow(shifts, staffId, windowStartISO, windowEndISO);
    const projectedMinutes = currentMinutes + shiftMinutes;
    if (projectedMinutes > OT_THRESHOLD_MIN) {
      warnings.push({
        type: "weekly_ot",
        severity: "warn",
        message: `This shift puts staff at ${fmtHours(projectedMinutes)} this week (${fmtHours(staffOvertimeMinutes(projectedMinutes))} OT).`,
        projectedMinutes,
        otMinutes: staffOvertimeMinutes(projectedMinutes),
      });
    }
  }

  if (staffId && biweeklyWindowStartISO && biweeklyWindowEndISO) {
    const currentBiweeklyMinutes = staffMinutesInWindow(
      shifts,
      staffId,
      biweeklyWindowStartISO,
      biweeklyWindowEndISO
    );
    const projectedBiweeklyMinutes = currentBiweeklyMinutes + shiftMinutes;
    if (projectedBiweeklyMinutes > OT_THRESHOLD_MIN * 2) {
      warnings.push({
        type: "biweekly_ot",
        severity: "warn",
        message: `This shift puts staff at ${fmtHours(projectedBiweeklyMinutes)} this biweekly period (${fmtHours(projectedBiweeklyMinutes - OT_THRESHOLD_MIN * 2)} over 80h).`,
        projectedMinutes: projectedBiweeklyMinutes,
      });
    }
  }

  if (staffId) {
    const overlappingShifts = asArray(shifts).filter((shift) => {
      if (getShiftStaffId(shift) !== staffId) return false;
      return rangesOverlap(getShiftStartISO(shift), getShiftEndISO(shift), startISO, endISO);
    });

    if (overlappingShifts.length > 0) {
      warnings.push({
        type: "overlap",
        severity: "block",
        message: "This shift overlaps an existing shift for this staff.",
        overlappingShifts,
      });
    }
  }

  if (client && clientId && windowStartISO && windowEndISO) {
    const authCheck = clientAuthorizedVsScheduled(
      shifts,
      client,
      windowStartISO,
      windowEndISO,
      windowDays
    );
    if (authCheck) {
      const projectedClientMinutes = authCheck.scheduledMinutes + shiftMinutes;
      if (projectedClientMinutes > authCheck.authorizedMinutes) {
        warnings.push({
          type: "client_over_auth",
          severity: "warn",
          message: `This shift causes client scheduled hours (${fmtHours(projectedClientMinutes)}) to exceed authorized hours (${fmtHours(authCheck.authorizedMinutes)}).`,
          projectedMinutes: projectedClientMinutes,
          authorizedMinutes: authCheck.authorizedMinutes,
        });
      }
    }
  }

  return warnings;
}

// Replacement finder for call-outs

export function findReplacementCandidates({
  shifts,
  staffList,
  shiftStartISO,
  shiftEndISO,
  excludeStaffId,
  unavailableDates = {},
  windowStartISO,
  windowEndISO,
} = {}) {
  const shiftDate = String(shiftStartISO || "").slice(0, 10);
  const safeUnavailableDates = unavailableDates && typeof unavailableDates === "object" ? unavailableDates : {};

  return asArray(staffList)
    .filter((staff) => staff?.active !== false)
    .filter((staff) => staff?.id !== excludeStaffId)
    .map((staff) => {
      const staffUnavailableDates = Array.isArray(safeUnavailableDates[staff?.id])
        ? safeUnavailableDates[staff.id]
        : [];
      const isUnavailable = staffUnavailableDates.includes(shiftDate);

      const hasOverlap = asArray(shifts).some((shift) => {
        if (getShiftStaffId(shift) !== staff?.id) return false;
        return rangesOverlap(
          getShiftStartISO(shift),
          getShiftEndISO(shift),
          shiftStartISO,
          shiftEndISO
        );
      });

      const weeklyMinutes =
        windowStartISO && windowEndISO
          ? staffMinutesInWindow(shifts, staff?.id, windowStartISO, windowEndISO)
          : 0;
      const shiftMinutes = shiftMinutesInWindow(
        shiftStartISO,
        shiftEndISO,
        shiftStartISO,
        shiftEndISO
      );
      const projectedMinutes = weeklyMinutes + shiftMinutes;
      const wouldCauseOT = projectedMinutes > OT_THRESHOLD_MIN;

      return {
        staff,
        weeklyMinutes,
        projectedMinutes,
        wouldCauseOT,
        isUnavailable,
        hasOverlap,
        isAvailable: !isUnavailable && !hasOverlap,
        sortScore:
          (hasOverlap ? 100000 : 0) +
          (isUnavailable ? 50000 : 0) +
          (wouldCauseOT ? 10000 : 0) +
          weeklyMinutes,
      };
    })
    .sort((a, b) => a.sortScore - b.sortScore);
}

// Dashboard summary computation

export function computeDashboardSummary({
  shifts,
  staffList,
  clients,
  callOuts,
  windowStartISO,
  windowEndISO,
  windowDays = 7,
  todayISO,
} = {}) {
  const safeShifts = asArray(shifts);
  const safeStaffList = asArray(staffList);
  const safeClients = asArray(clients);
  const safeCallOuts = asArray(callOuts);
  const openShifts = findOpenShifts(safeShifts);
  const conflicts = findAllConflicts(safeShifts);

  const staffSummary = allStaffOTSummary(safeShifts, safeStaffList, windowStartISO, windowEndISO);
  const staffNear40 = staffSummary.filter((staff) => staff.isNearOT);
  const staffInOT = staffSummary.filter((staff) => staff.isInOT);

  const clientSummaries = safeClients
    .map((client) =>
      clientAuthorizedVsScheduled(safeShifts, client, windowStartISO, windowEndISO, windowDays)
    )
    .filter(Boolean);
  const clientsUnderAuth = clientSummaries.filter((client) => client.isUnder);
  const clientsOverAuth = clientSummaries.filter((client) => client.isOver);

  const today = todayISO || new Date().toISOString().slice(0, 10);
  const todayCallOuts = safeCallOuts.filter((callOut) => {
    const callOutDate = callOut?.date || String(callOut?.created_at || "").slice(0, 10);
    return callOutDate === today;
  });

  const unfilledByClient = safeClients
    .map((client) => {
      const auth = clientAuthorizedVsScheduled(
        safeShifts,
        client,
        windowStartISO,
        windowEndISO,
        windowDays
      );

      return {
        clientId: client?.id,
        clientName: client?.name,
        remainingMinutes: auth?.remainingMinutes || 0,
        scheduledMinutes: auth?.scheduledMinutes || 0,
        authorizedMinutes: auth?.authorizedMinutes || 0,
      };
    })
    .filter((client) => client.remainingMinutes > 0)
    .sort((a, b) => b.remainingMinutes - a.remainingMinutes);

  return {
    openShiftsCount: openShifts.length,
    openShiftsMinutes: openShiftMinutes(safeShifts),
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

// Payroll summary computation

export function computePayrollSummary({
  shifts,
  staffList,
  windowStartISO,
  windowEndISO,
  weekBuckets = [],
} = {}) {
  const staffRows = asArray(staffList)
    .map((staff) => {
      const totalMinutes = staffMinutesInWindow(shifts, staff?.id, windowStartISO, windowEndISO);
      const otMinutes = staffOvertimeMinutes(totalMinutes);
      const otPercent = staffOvertimePercent(totalMinutes);

      const weeklyBreakdown = asArray(weekBuckets).map((bucket) => {
        const minutes = staffMinutesInWindow(shifts, staff?.id, bucket?.startISO, bucket?.endISO);
        return {
          weekStart: bucket?.startDate,
          minutes,
          otMinutes: Math.max(0, minutes - OT_THRESHOLD_MIN),
        };
      });

      return {
        staffId: staff?.id,
        name: staff?.name,
        totalMinutes,
        otMinutes,
        otPercent,
        weeklyBreakdown,
      };
    })
    .filter((row) => row.totalMinutes > 0)
    .sort((a, b) => b.totalMinutes - a.totalMinutes);

  const totalScheduledMinutes = staffRows.reduce((sum, row) => sum + row.totalMinutes, 0);
  const totalOTMinutes = staffRows.reduce((sum, row) => sum + row.otMinutes, 0);

  return {
    staffRows,
    totalScheduledMinutes,
    totalOTMinutes,
    overallOTPercent:
      totalScheduledMinutes > 0 ? (totalOTMinutes / totalScheduledMinutes) * 100 : 0,
  };
}
