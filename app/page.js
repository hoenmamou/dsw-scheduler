"use client";

import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { SUPABASE_CONFIGURED, supabase } from "../lib/supabaseClient";
import {
  fmtHours as calcFmtHours,
  hoursToUnits, unitsToHours, minutesToHours, minutesToUnits,
  getWeekWindow, getBiweeklyWindow,
  staffMinutesInWindow as calcStaffMin, staffWeeklyMinutes, staffBiweeklyMinutes,
  clientMinutesInWindow as calcClientMin, clientWeeklyMinutes, clientBiweeklyMinutes,
  staffOvertimeMinutes, staffOvertimePercent, isNearOT, isInOT,
  findShiftCausingOT, allStaffOTSummary,
  clientAuthorizedVsScheduled, findOpenShifts, openShiftMinutes,
  findAllConflicts, validateShiftSave, findReplacementCandidates,
  shiftDedupKey, rangesOverlap,
  computeDashboardSummary, computePayrollSummary,
  OT_THRESHOLD_MIN as CALC_OT_THRESHOLD_MIN,
} from "../lib/calculations";
import {
  logShiftCreate, logShiftEdit, logShiftDelete, logCallOut, logReassignment,
  fetchAuditLogs,
} from "../lib/auditLog";

const LOCAL_DB_STORAGE_KEY = "dsw_local_db";
const DATA_TABLES = ["users", "staff", "clients", "shifts", "call_outs", "audit_logs"];

let supabaseErrorHandler = null;
function setSupabaseErrorHandler(fn) {
  supabaseErrorHandler = fn;
}
function reportSupabaseError(error) {
  console.warn("Supabase request failed.", error);
  if (typeof supabaseErrorHandler === "function") supabaseErrorHandler(error);
}

/* =========================
   Notes
   - This version is "dynamic": Supabase is the source of truth.
   - If Supabase env vars are missing, it will show an error banner.
  - SQL (run once):
    alter table public.clients add column if not exists assigned_staff_ids text;
========================= */

const DAY_START_MIN = 7 * 60;  // 07:00
const DAY_END_MIN = 23 * 60;   // 23:00
const OT_THRESHOLD_MIN = CALC_OT_THRESHOLD_MIN;
const MAX_HOURS_PER_24_MIN = 16 * 60;
const PAYROLL_CYCLE_DAYS = 14;
const PAYROLL_BUCKET_DAYS = 7;
const DEFAULT_PAYROLL_CYCLE_ANCHOR = "2026-03-08";

function normalizeRole(role) {
  return String(role || "").trim().toLowerCase();
}

function readUserNameParts(user) {
  const first = String(user?.first_name ?? user?.firstName ?? "").trim();
  const last = String(user?.last_name ?? user?.lastName ?? "").trim();
  return [first, last].filter(Boolean).join(" ").trim();
}

function readUserNameValue(user) {
  const name = String(user?.name || "").trim();
  if (name) return name;

  const username = String(user?.username ?? user?.user_name ?? "").trim();
  if (username) return username;

  const combinedName = readUserNameParts(user);
  if (combinedName) return combinedName;

  const email = String(user?.email || "").trim();
  if (email) return email;

  return "";
}

function getUserDisplayName(user, fallback = "Unknown User") {
  return readUserNameValue(user) || fallback;
}

function getUserRoleValue(user) {
  return normalizeRole(user?.role ?? user?.dashboard_role ?? user?.user_role) || "supervisor";
}

function getSupervisorNameById(users, supervisorId, { unassignedLabel = "Unassigned", unknownLabel = "Unknown Supervisor" } = {}) {
  const id = String(supervisorId || "").trim();
  if (!id) return unassignedLabel;
  const match = (users || []).find((user) => user.id === id);
  if (!match) return unknownLabel;
  return getUserDisplayName(match, unknownLabel);
}

function formatUserOptionLabel(user) {
  const label = getUserDisplayName(user, "Unknown User");
  const role = getUserRoleValue(user);
  return `${label} (${role})`;
}

function isSupervisorRole(role) {
  const normalized = normalizeRole(role);
  return normalized === "supervisor";
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function uid(prefix = "id") {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function isoLocal(date) {
  const d = new Date(date);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
}

function normalizeDateTimeISO(value) {
  if (value == null) return null;

  // Keep scheduler wall-clock times as local, timezone-free values.
  // This avoids UTC offset shifts like 07:00 -> 02:00.
  const raw = String(value).trim();
  const isoLike = raw.match(/^(\d{4}-\d{2}-\d{2})[T\s](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (isoLike) {
    const [, date, hhRaw, mmRaw, ssRaw] = isoLike;
    const hh = Number(hhRaw);
    const mm = Number(mmRaw);
    const ss = Number(ssRaw ?? 0);
    if (
      Number.isFinite(hh) && Number.isFinite(mm) && Number.isFinite(ss)
      && hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59 && ss >= 0 && ss <= 59
    ) {
      return `${date}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
    }
  }

  const d = new Date(raw);
  if (isNaN(d)) return null;
  return isoLocal(d);
}

function normalizeTimeValue(value, fallback) {
  const raw = String(value ?? "").trim();
  const match = raw.match(/^(\d{1,2}):(\d{2})(?:\s*([AaPp][Mm]))?$/);
  if (!match) return fallback;
  const hour = Number(match[1]);
  const min = Number(match[2]);
  const ampm = (match[3] || "").toUpperCase();
  if (!Number.isFinite(hour) || !Number.isFinite(min) || min < 0 || min > 59) return fallback;

  let hour24 = hour;
  if (ampm) {
    if (hour < 1 || hour > 12) return fallback;
    hour24 = (hour % 12) + (ampm === "PM" ? 12 : 0);
  }

  if (!ampm) {
    if (hour24 === 24 && min === 0) return "23:59";
    if (hour24 < 0 || hour24 > 23) return fallback;
  }

  return `${String(hour24).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

function formatTime12(value) {
  const normalized = normalizeTimeValue(value, null);
  if (!normalized) return String(value || "");
  const [hh, mm] = normalized.split(":").map(Number);
  const suffix = hh >= 12 ? "PM" : "AM";
  const hour12 = hh % 12 || 12;
  return `${hour12}:${String(mm).padStart(2, "0")} ${suffix}`;
}

function formatShiftTimeFromISO(iso) {
  const m = String(iso || "").match(/T(\d{2}:\d{2})/);
  return formatTime12(m?.[1] || "");
}

function formatShiftDateTimeFromISO(iso) {
  const date = String(iso || "").slice(0, 10);
  const time = formatShiftTimeFromISO(iso);
  return `${date} ${time}`.trim();
}

function formatTimeCompact(value) {
  const normalized = normalizeTimeValue(value, null);
  if (!normalized) return "";
  const [hh, mm] = normalized.split(":").map(Number);
  const suffix = hh >= 12 ? "p" : "a";
  const hour12 = hh % 12 || 12;
  if (mm === 0) return `${hour12}${suffix}`;
  return `${hour12}:${String(mm).padStart(2, "0")}${suffix}`;
}

function compactShiftRange(startISO, endISO) {
  const m1 = String(startISO || "").match(/T(\d{2}:\d{2})/);
  const m2 = String(endISO || "").match(/T(\d{2}:\d{2})/);
  return `${formatTimeCompact(m1?.[1] || "")}-${formatTimeCompact(m2?.[1] || "")}`;
}

function shortLabel(value, max = 12) {
  const text = String(value || "").trim();
  if (!text) return "Unknown";
  return text.length <= max ? text : `${text.slice(0, max - 1)}...`;
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function startOfWeekSunday(dateInput) {
  const d = new Date(dateInput);
  if (isNaN(d)) return null;
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay());
  return d;
}

function parseDateOnlyLocal(value) {
  const raw = String(value || "").trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const d = new Date(`${raw}T00:00:00`);
  return isNaN(d) ? null : d;
}

function formatDateOnlyLocal(dateInput) {
  const d = new Date(dateInput);
  if (isNaN(d)) return "";
  d.setHours(0, 0, 0, 0);
  return isoLocal(d).slice(0, 10);
}

function daysBetweenDateOnly(startInput, endInput) {
  const start = new Date(startInput);
  const end = new Date(endInput);
  if (isNaN(start) || isNaN(end)) return 0;
  start.setHours(0, 0, 0, 0);
  end.setHours(0, 0, 0, 0);
  return Math.round((end - start) / 86400000);
}

function getInclusiveDateRange(startInput, finishInput) {
  const start = parseDateOnlyLocal(startInput);
  const finish = parseDateOnlyLocal(finishInput);
  if (!start || !finish || finish < start) return [];

  const days = [];
  for (let cursor = new Date(start); cursor <= finish; cursor = addDays(cursor, 1)) {
    days.push(new Date(cursor));
  }
  return days;
}

function getPayrollCycleRangeForReferenceDate(referenceDateInput, anchorDateInput = DEFAULT_PAYROLL_CYCLE_ANCHOR, cycleDays = PAYROLL_CYCLE_DAYS) {
  const reference = parseDateOnlyLocal(referenceDateInput) || parseDateOnlyLocal(new Date()) || new Date();
  const anchor = parseDateOnlyLocal(anchorDateInput) || parseDateOnlyLocal(DEFAULT_PAYROLL_CYCLE_ANCHOR) || new Date();
  const diffDays = daysBetweenDateOnly(anchor, reference);
  const cycleIndex = Math.floor(diffDays / cycleDays);
  const startDate = addDays(anchor, cycleIndex * cycleDays);
  const finishDate = addDays(startDate, cycleDays - 1);
  return {
    startDate: formatDateOnlyLocal(startDate),
    finishDate: formatDateOnlyLocal(finishDate),
  };
}

function getPayrollBucketStartKey(dateInput, anchorDateInput, bucketDays = PAYROLL_BUCKET_DAYS) {
  const anchor = parseDateOnlyLocal(anchorDateInput);
  const date = parseDateOnlyLocal(String(dateInput || "").slice(0, 10)) || new Date(dateInput);
  if (!anchor || isNaN(date)) return null;
  date.setHours(0, 0, 0, 0);
  const diffDays = daysBetweenDateOnly(anchor, date);
  const bucketIndex = Math.floor(diffDays / bucketDays);
  const bucketStart = addDays(anchor, bucketIndex * bucketDays);
  return formatDateOnlyLocal(bucketStart);
}

function getMinutesForWeeklyHoursAcrossRange(weeklyHours, rangeDayCount) {
  return Math.round((Number(weeklyHours) || 0) * 60 * (Math.max(1, rangeDayCount) / 7));
}

function getDateRangeWindow(startDateValue, finishDateValue) {
  const start = parseDateOnlyLocal(startDateValue);
  const finish = parseDateOnlyLocal(finishDateValue);
  if (!start || !finish || finish < start) return null;
  const endExclusive = addDays(finish, 1);
  return {
    startDate: start,
    finishDate: finish,
    startISO: `${formatDateOnlyLocal(start)}T00:00:00`,
    endExclusiveISO: `${formatDateOnlyLocal(endExclusive)}T00:00:00`,
  };
}

function overlapsWindow(shiftStartISO, shiftEndISO, windowStartISO, windowEndISO) {
  return rangesOverlap(shiftStartISO, shiftEndISO, windowStartISO, windowEndISO);
}

function clipShiftToWindow(shiftStartISO, shiftEndISO, windowStartISO, windowEndISO) {
  const shiftStart = new Date(shiftStartISO);
  const shiftEnd = new Date(shiftEndISO);
  const windowStart = new Date(windowStartISO);
  const windowEnd = new Date(windowEndISO);
  if (
    isNaN(shiftStart) || isNaN(shiftEnd)
    || isNaN(windowStart) || isNaN(windowEnd)
    || shiftEnd <= shiftStart
    || windowEnd <= windowStart
  ) {
    return null;
  }

  const clippedStart = shiftStart > windowStart ? shiftStart : windowStart;
  const clippedEnd = shiftEnd < windowEnd ? shiftEnd : windowEnd;
  if (clippedEnd <= clippedStart) return null;
  return {
    startISO: isoLocal(clippedStart),
    endISO: isoLocal(clippedEnd),
  };
}

function splitDayNightMinutesInWindow(shiftStartISO, shiftEndISO, windowStartISO, windowEndISO) {
  const clipped = clipShiftToWindow(shiftStartISO, shiftEndISO, windowStartISO, windowEndISO);
  if (!clipped) return { totalMin: 0, dayMin: 0, nightMin: 0 };
  return splitDayNightMinutes(clipped.startISO, clipped.endISO);
}

function calculateShiftHoursInWindow(shifts, windowStartISO, windowEndISO) {
  return (shifts || []).reduce(
    (sum, sh) => sum + splitShiftIntoWindowMinutes(sh.startISO, sh.endISO, windowStartISO, windowEndISO),
    0
  );
}

function staffMinutesDedupInWindow(shifts, staffId, windowStartISO, windowEndISO, sharedOnly = false) {
  if (!sharedOnly) {
    return calcStaffMin(shifts, staffId, windowStartISO, windowEndISO);
  }
  const seen = new Set();
  let total = 0;
  for (const sh of shifts || []) {
    if (sh.staffId !== staffId) continue;
    if (sharedOnly && !(sh.isShared || sh.is_shared)) continue;
    const key = staffShiftUniqueKey(sh);
    if (seen.has(key)) continue;
    const overlapMinutes = splitShiftIntoWindowMinutes(sh.startISO, sh.endISO, windowStartISO, windowEndISO);
    if (overlapMinutes <= 0) continue;
    seen.add(key);
    total += overlapMinutes;
  }
  return total;
}

function getSharedSupportMinutesByStaffInWindow(shifts, staffList, windowStartISO, windowEndISO) {
  const out = {};
  for (const st of staffList || []) {
    out[st.id] = staffMinutesDedupInWindow(shifts, st.id, windowStartISO, windowEndISO, true);
  }
  return out;
}

function minutesBetweenISO(aISO, bISO) {
  const a = new Date(aISO);
  const b = new Date(bISO);
  if (isNaN(a) || isNaN(b) || b <= a) return 0;
  return Math.round((b - a) / 60000);
}

function addMinutes(date, minutes) {
  const d = new Date(date);
  d.setMinutes(d.getMinutes() + minutes);
  return d;
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return rangesOverlap(aStart, aEnd, bStart, bEnd);
}

function hasTrueTimeOverlap(aStartInput, aEndInput, bStartInput, bEndInput) {
  const aStartISO = normalizeDateTimeISO(aStartInput);
  const aEndISO = normalizeDateTimeISO(aEndInput);
  const bStartISO = normalizeDateTimeISO(bStartInput);
  const bEndISO = normalizeDateTimeISO(bEndInput);
  if (!aStartISO || !aEndISO || !bStartISO || !bEndISO) return false;

  const aStart = new Date(aStartISO);
  const aEnd = new Date(aEndISO);
  const bStart = new Date(bStartISO);
  const bEnd = new Date(bEndISO);
  if (isNaN(aStart) || isNaN(aEnd) || isNaN(bStart) || isNaN(bEnd)) return false;
  if (aEnd <= aStart || bEnd <= bStart) return false;
  return aStart < bEnd && bStart < aEnd;
}

/** Day: 07:00–23:00, Night: 23:00–07:00 */
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

    // if ends exactly at midnight treat as 1440
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

function normalizeShiftDraftDates(draft) {
  const next = { ...draft };
  const startDate = next.startDate;
  const startTime = next.startTime;
  const endTime = next.endTime;
  if (!startDate || !startTime || !endTime) return next;

  const [sh, sm] = String(startTime).split(":").map(Number);
  const [eh, em] = String(endTime).split(":").map(Number);
  if ([sh, sm, eh, em].some((n) => !Number.isFinite(n))) return next;

  const startMin = sh * 60 + sm;
  const endMin = eh * 60 + em;
  if (endMin < startMin) {
    const d = new Date(`${startDate}T00:00:00`);
    d.setDate(d.getDate() + 1);
    next.endDate = isoLocal(d).slice(0, 10);
  } else if (!next.endDate || new Date(`${next.endDate}T00:00:00`) < new Date(`${startDate}T00:00:00`)) {
    next.endDate = startDate;
  }

  return next;
}

function fmtHoursFromMin(min) {
  return `${(min / 60).toFixed(2)}h`;
}

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const CLIENT_SCHEDULE_STORAGE_KEY = "dsw_client_schedules";

function parseAssignedStaffIds(value) {
  if (Array.isArray(value)) {
    return Array.from(new Set(value.map((id) => String(id || "").trim()).filter(Boolean)));
  }

  if (typeof value === "string") {
    const raw = value.trim();
    if (!raw) return [];

    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return Array.from(new Set(parsed.map((id) => String(id || "").trim()).filter(Boolean)));
      }
    } catch {
      // Fallback for comma-separated values in legacy rows.
      return Array.from(new Set(raw.split(",").map((id) => id.trim()).filter(Boolean)));
    }
  }

  return [];
}

function serializeAssignedStaffIds(ids) {
  return JSON.stringify(parseAssignedStaffIds(ids));
}

function getClientAssignedStaff(client, allStaff) {
  const activeStaff = (allStaff || []).filter((s) => s?.active !== false);
  const assignedIds = parseAssignedStaffIds(client?.assignedStaffIds ?? client?.assigned_staff_ids);
  if (!assignedIds.length) return activeStaff;
  const assignedSet = new Set(assignedIds);
  return activeStaff.filter((s) => assignedSet.has(s.id));
}

function parseShiftPattern(input) {
  // Accept newline or comma separated entries like "07:00-15:00"
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
    const start = `${String(sh).padStart(2, "0")}:${sm}`;
    const end = `${String(eh).padStart(2, "0")}:${em}`;
    out.push({ start, end });
  }
  return out;
}

function shouldSplitIntoDailyShifts(startDate, endDate, startTime, endTime) {
  const start = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);
  if (isNaN(start) || isNaN(end)) return false;

  // If end is before start, invalid range
  if (end < start) return false;

  // If end equals start (same day), do NOT split—single day shift
  if (end.getTime() === start.getTime()) return false;

  const overnight = String(endTime || "") <= String(startTime || "");
  const dayDiff = Math.round((end - start) / (24 * 60 * 60 * 1000));

  // Keep true single overnight shifts as one row when the end date is next day.
  if (dayDiff === 1 && overnight) return false;

  // Multi-day range: always split
  return true;
}

function buildSeparateDailyShifts(startDate, endDate, startTime, endTime) {
  const start = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);
  if (isNaN(start) || isNaN(end) || end < start) return [];

  const overnight = String(endTime || "") <= String(startTime || "");
  const windows = [];

  // Loop through each day from start to end (inclusive)
  let cursor = new Date(start);
  while (cursor.getTime() <= end.getTime()) {
    const dateStr = isoLocal(cursor).slice(0, 10);
    const startISO = `${dateStr}T${startTime}:00`;
    
    let nextDayObj;
    if (overnight) {
      // Overnight shift spans to next day
      nextDayObj = addDays(new Date(`${dateStr}T00:00:00`), 1);
    } else {
      // Same-day shift
      nextDayObj = new Date(`${dateStr}T00:00:00`);
    }
    
    const endISO = `${isoLocal(nextDayObj).slice(0, 10)}T${endTime}:00`;
    
    // Only add if end is after start
    if (new Date(endISO) > new Date(startISO)) {
      windows.push({ startISO, endISO, dateStr });
    }
    
    // Move to next day
    cursor = addDays(cursor, 1);
  }

  return windows;
}

function normalizeShiftForSchedulingRule(sh, idx = 0) {
  const startISO = normalizeDateTimeISO(sh?.startISO ?? sh?.start_iso);
  const endISO = normalizeDateTimeISO(sh?.endISO ?? sh?.end_iso);
  const staffId = sh?.staffId ?? sh?.staff_id;
  if (!startISO || !endISO || !staffId) return null;
  return {
    id: sh?.id ?? `rule_${idx}_${staffId}`,
    staffId,
    startISO,
    endISO,
    isShared: !!(sh?.isShared ?? sh?.is_shared),
    sharedGroupId: sh?.sharedGroupId ?? sh?.shared_group_id ?? "",
  };
}

function getStaffShiftsInRange(allShifts, staffId, rangeStartISO, rangeEndISO) {
  const rangeStart = new Date(rangeStartISO);
  const rangeEnd = new Date(rangeEndISO);
  if (isNaN(rangeStart) || isNaN(rangeEnd) || rangeEnd <= rangeStart) return [];

  return (allShifts || [])
    .map((sh, idx) => normalizeShiftForSchedulingRule(sh, idx))
    .filter(Boolean)
    .filter((sh) => sh.staffId === staffId)
    .filter((sh) => overlaps(sh.startISO, sh.endISO, rangeStartISO, rangeEndISO));
}

function splitShiftIntoWindowMinutes(shiftStartISO, shiftEndISO, windowStartISO, windowEndISO) {
  const shiftStart = new Date(shiftStartISO);
  const shiftEnd = new Date(shiftEndISO);
  const windowStart = new Date(windowStartISO);
  const windowEnd = new Date(windowEndISO);
  if (
    isNaN(shiftStart) || isNaN(shiftEnd)
    || isNaN(windowStart) || isNaN(windowEnd)
    || shiftEnd <= shiftStart
    || windowEnd <= windowStart
  ) {
    return 0;
  }

  const start = shiftStart > windowStart ? shiftStart : windowStart;
  const end = shiftEnd < windowEnd ? shiftEnd : windowEnd;
  if (end <= start) return 0;
  return Math.round((end - start) / 60000);
}

function wouldExceed16HoursIn24(staffId, candidateStartISO, candidateEndISO, allShifts) {
  const candidateStart = new Date(candidateStartISO);
  const candidateEnd = new Date(candidateEndISO);
  if (isNaN(candidateStart) || isNaN(candidateEnd) || candidateEnd <= candidateStart) return false;

  const candidate = {
    id: "candidate_24h",
    staffId,
    startISO: candidateStartISO,
    endISO: candidateEndISO,
    isShared: false,
    sharedGroupId: "",
  };

  const scanStart = addMinutes(candidateStart, -24 * 60);
  const scanEnd = addMinutes(candidateEnd, 24 * 60);
  const scanStartISO = isoLocal(scanStart);
  const scanEndISO = isoLocal(scanEnd);

  const relevant = getStaffShiftsInRange(
    [...(allShifts || []), candidate],
    staffId,
    scanStartISO,
    scanEndISO
  );

  const anchors = [];
  for (const sh of relevant) {
    anchors.push(new Date(sh.startISO));
    anchors.push(new Date(sh.endISO));
  }
  anchors.push(candidateStart, candidateEnd);

  for (const anchor of anchors) {
    if (isNaN(anchor)) continue;

    const windows = [
      {
        start: addMinutes(anchor, -24 * 60),
        end: anchor,
      },
      {
        start: anchor,
        end: addMinutes(anchor, 24 * 60),
      },
    ];

    for (const win of windows) {
      const winStartISO = isoLocal(win.start);
      const winEndISO = isoLocal(win.end);
      let totalMin = 0;
      const seen = new Set();

      for (const sh of relevant) {
        const key = staffShiftUniqueKey(sh);
        if (seen.has(key)) continue;

        const overlapMin = splitShiftIntoWindowMinutes(
          sh.startISO,
          sh.endISO,
          winStartISO,
          winEndISO
        );

        if (overlapMin > 0) {
          seen.add(key);
          totalMin += overlapMin;
          if (totalMin > MAX_HOURS_PER_24_MIN) return true;
        }
      }
    }
  }

  return false;
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
  } catch {
    // ignore
  }
}

function Tabs({ value, onChange, tabs }) {
  return (
    <div className="no-print" style={{ display: "flex", gap: 6, flexWrap: "wrap", padding: 6, borderRadius: 12, background: UI.nav, border: `1px solid ${UI.border}` }}>
      {tabs.map((t) => (
        <button
          key={t.value}
          onClick={() => onChange(t.value)}
          style={{
            ...styles.btn2,
            padding: "7px 11px",
            fontSize: 12,
            lineHeight: 1.2,
            background: value === t.value ? "rgba(79,125,243,0.12)" : UI.nav,
            color: value === t.value ? UI.accent : UI.textSecondary,
            borderColor: value === t.value ? "rgba(79,125,243,0.42)" : UI.border,
            boxShadow: value === t.value ? "inset 0 0 0 1px rgba(79,125,243,0.08)" : "none",
          }}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

function summarizeAssignedStaffSelection(selectedIds, staffOptions) {
  const ids = parseAssignedStaffIds(selectedIds);
  if (!ids.length) return "None selected";

  const names = ids
    .map((id) => staffOptions.find((s) => s.id === id)?.name || id)
    .filter(Boolean);

  if (names.length <= 2) return names.join(", ");
  return `${names.slice(0, 2).join(", ")} +${names.length - 2} more`;
}

function AssignedStaffDropdown({ label = "Assigned Staff", selectedIds, staffOptions, onChange }) {
  const ids = parseAssignedStaffIds(selectedIds);

  return (
    <div style={{ position: "relative" }}>
      <div style={styles.tiny}>{label}</div>
      <details style={{ marginTop: 6 }}>
        <summary style={{ ...styles.select, cursor: "pointer", userSelect: "none" }}>
          {ids.length
            ? `${ids.length} staff selected (${summarizeAssignedStaffSelection(ids, staffOptions)})`
            : "Select staff..."}
        </summary>
        <div
          style={{
            position: "absolute",
            zIndex: 30,
            marginTop: 6,
            width: "100%",
            minWidth: 280,
            maxHeight: 240,
            overflowY: "auto",
            border: `1px solid ${UI.border}`,
            borderRadius: 12,
            background: UI.panel,
            padding: 8,
            boxShadow: UI.shadowLg,
          }}
        >
          {staffOptions.length === 0 ? (
            <div style={styles.tiny}>No active staff.</div>
          ) : (
            staffOptions.map((st) => {
              const checked = ids.includes(st.id);
              return (
                <label key={st.id} style={{ display: "flex", gap: 8, alignItems: "center", padding: "6px 4px", color: UI.text }}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => {
                      const next = e.target.checked
                        ? [...ids, st.id]
                        : ids.filter((id) => id !== st.id);
                      onChange(parseAssignedStaffIds(next));
                    }}
                  />
                  <span>{st.name}</span>
                </label>
              );
            })
          )}
        </div>
      </details>
    </div>
  );
}

/* =========================
   Supabase data helpers
========================= */

function createEmptyDb() {
  return {
    users: [],
    staff: [],
    clients: [],
    shifts: [],
    call_outs: [],
    audit_logs: [],
  };
}

function readLocalDb() {
  try {
    const raw = localStorage.getItem(LOCAL_DB_STORAGE_KEY);
    return raw ? JSON.parse(raw) : createEmptyDb();
  } catch {
    return createEmptyDb();
  }
}

function writeLocalDb(db) {
  localStorage.setItem(LOCAL_DB_STORAGE_KEY, JSON.stringify(db));
}

function getLocalDbSnapshot() {
  const db = readLocalDb();
  return {
    users: Array.isArray(db.users) ? db.users : [],
    staff: Array.isArray(db.staff) ? db.staff : [],
    clients: Array.isArray(db.clients) ? db.clients : [],
    shifts: Array.isArray(db.shifts) ? db.shifts : [],
    call_outs: Array.isArray(db.call_outs) ? db.call_outs : [],
    audit_logs: Array.isArray(db.audit_logs) ? db.audit_logs : [],
  };
}

function replaceLocalTable(table, rows) {
  const db = readLocalDb();
  db[table] = Array.isArray(rows) ? rows : [];
  writeLocalDb(db);
}

function mergeLocalTableRows(table, rows) {
  const db = readLocalDb();
  db[table] = db[table] || [];
  for (const row of rows || []) {
    const index = db[table].findIndex((item) => item.id === row.id);
    if (index >= 0) db[table][index] = { ...db[table][index], ...row };
    else db[table].push(row);
  }
  writeLocalDb(db);
}

function removeLocalTableRow(table, id) {
  const db = readLocalDb();
  db[table] = (db[table] || []).filter((row) => row.id !== id);
  writeLocalDb(db);
}

function createDataRequestError(operation, table, error) {
  const wrapped = new Error(
    `Supabase ${operation} failed for ${table}: ${error?.message || error?.code || "Unknown error"}`
  );
  wrapped.name = "DataRequestError";
  wrapped.operation = operation;
  wrapped.table = table;
  wrapped.code = error?.code;
  wrapped.details = error?.details;
  wrapped.hint = error?.hint;
  wrapped.cause = error;
  return wrapped;
}

function hasOnlyDefaultUsers(rows) {
  const users = Array.isArray(rows) ? rows : [];
  if (users.length !== DEFAULT_DB.users.length) return false;
  const ids = new Set(users.map((user) => user?.id));
  return DEFAULT_DB.users.every((user) => ids.has(user.id));
}

async function fetchAllDataSnapshot() {
  if (SUPABASE_CONFIGURED && supabase) {
    const localDb = readLocalDb();
    const snapshot = { ...getLocalDbSnapshot() };
    const tableSources = {};
    const results = await Promise.allSettled(
      DATA_TABLES.map(async (table) => {
        const { data, error } = await supabase.from(table).select("*");
        if (error) throw createDataRequestError("select", table, error);
        return { table, data: data || [] };
      })
    );

    for (const result of results) {
      if (result.status === "fulfilled") {
        const { table, data } = result.value;
        snapshot[table] = data;
        replaceLocalTable(table, data);
        tableSources[table] = "supabase";
        continue;
      }

      const error = result.reason;
      const table = error?.table || "unknown";
      reportSupabaseError(error);
      tableSources[table] = "local";
      snapshot[table] = getLocalDbSnapshot()[table] || [];
    }

    if (tableSources.users === "local" && hasOnlyDefaultUsers(snapshot.users)) {
      console.warn("Users query fell back to local placeholder users; suppressing demo users while Supabase is configured.");
      snapshot.users = [];
    }

    writeLocalDb({ ...localDb, ...snapshot });
    console.info(`Users loaded from ${tableSources.users === "supabase" ? "Supabase" : "local fallback"}.`, {
      count: snapshot.users?.length || 0,
      ids: (snapshot.users || []).map((user) => user.id),
      displayNames: (snapshot.users || []).map((user) => readUserNameValue(user) || "Unknown User"),
    });
    return { source: tableSources.users === "supabase" ? "supabase" : "local", snapshot, tableSources };
  }

  const snapshot = getLocalDbSnapshot();
  console.info("Users loaded from local fallback.", {
    count: snapshot.users?.length || 0,
    ids: (snapshot.users || []).map((user) => user.id),
    displayNames: (snapshot.users || []).map((user) => readUserNameValue(user) || "Unknown User"),
  });
  return { source: "local", snapshot };
}

function toClientSnakeCaseRow(row) {
  return {
    id: row.id,
    name: row.name,
    supervisor_id: row.supervisor_id ?? row.supervisorId ?? null,
    coverage_start: row.coverage_start ?? row.coverageStart ?? "07:00",
    coverage_end: row.coverage_end ?? row.coverageEnd ?? "23:00",
    // Canonical DB column for client weekly hours
    hours_allotted: row.hours_allotted ?? row.weekly_hours ?? row.weeklyHours ?? 40,
    assigned_staff_ids: row.assigned_staff_ids ?? serializeAssignedStaffIds(row.assignedStaffIds ?? []),
    is_24_hour: row.is_24_hour ?? row.is24Hour ?? false,
    active: row.active !== false,
  };
}

function toClientCamelCaseRow(row) {
  return {
    id: row.id,
    name: row.name,
    supervisorId: row.supervisorId ?? row.supervisor_id ?? null,
    coverageStart: row.coverageStart ?? row.coverage_start ?? "07:00",
    coverageEnd: row.coverageEnd ?? row.coverage_end ?? "23:00",
    weeklyHours: row.weeklyHours ?? row.hours_allotted ?? row.weekly_hours ?? 40,
    assignedStaffIds: parseAssignedStaffIds(row.assignedStaffIds ?? row.assigned_staff_ids),
    is24Hour: row.is24Hour ?? row.is_24_hour ?? false,
    active: row.active !== false,
  };
}

function toClientMinimalRow(row) {
  return {
    id: row.id,
    name: row.name,
    supervisor_id: row.supervisor_id ?? row.supervisorId ?? null,
    coverage_start: row.coverage_start ?? row.coverageStart ?? "07:00",
    coverage_end: row.coverage_end ?? row.coverageEnd ?? "23:00",
    hours_allotted: row.hours_allotted ?? row.weekly_hours ?? row.weeklyHours ?? 40,
    assigned_staff_ids: row.assigned_staff_ids ?? serializeAssignedStaffIds(row.assignedStaffIds ?? []),
    active: row.active !== false,
  };
}

function buildClientUpsertRow(inputRow, existingRow = null) {
  const merged = toClientCamelCaseRow({ ...(existingRow || {}), ...(inputRow || {}) });
  return toClientSnakeCaseRow(merged);
}

function collectDuplicateIdIssues(label, rows) {
  const counts = new Map();
  for (const row of rows || []) {
    const id = String(row?.id || "").trim();
    if (!id) continue;
    counts.set(id, (counts.get(id) || 0) + 1);
  }

  return Array.from(counts.entries())
    .filter(([, count]) => count > 1)
    .map(([id, count]) => `${label} contains duplicate id "${id}" (${count} rows).`);
}

function collectProfileDataIssues({ users, staff, clients, shifts }) {
  const issues = [
    ...collectDuplicateIdIssues("Users", users),
    ...collectDuplicateIdIssues("Staff", staff),
    ...collectDuplicateIdIssues("Clients", clients),
    ...collectDuplicateIdIssues("Shifts", shifts),
  ];

  const userIds = new Set((users || []).map((user) => user.id));
  const staffIds = new Set((staff || []).map((member) => member.id));
  const clientIds = new Set((clients || []).map((client) => client.id));

  for (const user of users || []) {
    const rawName = readUserNameValue(user);
    if (!rawName) {
      issues.push(`User "${user?.id || "unknown-user"}" is missing a display name; the UI will show Unknown User.`);
    }
  }

  for (const client of clients || []) {
    const clientId = client?.id || "unknown-client";
    const supervisorId = client?.supervisor_id ?? client?.supervisorId ?? "";
    if (supervisorId && !userIds.has(supervisorId)) {
      issues.push(`Client "${clientId}" points to missing supervisor "${supervisorId}".`);
    }

    const hasHoursField = [client?.hours_allotted, client?.weekly_hours, client?.weeklyHours].some((value) => value != null && value !== "");
    if (!hasHoursField) {
      issues.push(`Client "${clientId}" is missing weekly hours; the UI defaulted it to 40.`);
    }

    const hasCoverageStart = [client?.coverage_start, client?.coverageStart].some((value) => String(value || "").trim());
    const hasCoverageEnd = [client?.coverage_end, client?.coverageEnd].some((value) => String(value || "").trim());
    if (!hasCoverageStart || !hasCoverageEnd) {
      issues.push(`Client "${clientId}" is missing coverage hours; the UI defaulted the missing value.`);
    }

    const assignedIds = parseAssignedStaffIds(client?.assigned_staff_ids ?? client?.assignedStaffIds);
    const unknownAssignedIds = assignedIds.filter((staffId) => !staffIds.has(staffId));
    if (unknownAssignedIds.length) {
      issues.push(`Client "${clientId}" references missing assigned staff: ${unknownAssignedIds.join(", ")}.`);
    }
  }

  for (const shift of shifts || []) {
    const shiftId = shift?.id || "unknown-shift";
    const clientId = shift?.client_id ?? shift?.clientId ?? "";
    const staffId = shift?.staff_id ?? shift?.staffId ?? "";
    if (!clientId) issues.push(`Shift "${shiftId}" is missing client_id.`);
    else if (!clientIds.has(clientId)) issues.push(`Shift "${shiftId}" references missing client "${clientId}".`);
    if (staffId && !staffIds.has(staffId)) {
      issues.push(`Shift "${shiftId}" references missing staff "${staffId}".`);
    }
  }

  return Array.from(new Set(issues));
}

async function sbSelect(table) {
  if (SUPABASE_CONFIGURED && supabase) {
    const { data, error } = await supabase.from(table).select("*");
    if (!error) {
      replaceLocalTable(table, data || []);
      return data || [];
    }
    const wrappedError = createDataRequestError("select", table, error);
    reportSupabaseError(wrappedError);
    throw wrappedError;
  }

  return getLocalDbSnapshot()[table] || [];
}

async function sbUpsert(table, rows) {
  if (SUPABASE_CONFIGURED && supabase) {
    let { error } = await supabase.from(table).upsert(rows, { onConflict: "id" });
    if (error && table === "clients") {
      // Retry with progressively simpler payloads for schema variants.
      const clientAttempts = [
        rows.map((row) => toClientSnakeCaseRow(row)),
        rows.map((row) => toClientMinimalRow(row)),
      ];
      for (const attemptRows of clientAttempts) {
        ({ error } = await supabase.from(table).upsert(attemptRows, { onConflict: "id" }));
        if (!error) break;
      }
    }
    if (!error) {
      mergeLocalTableRows(table, rows);
      return;
    }
    const wrappedError = createDataRequestError("upsert", table, error);
    reportSupabaseError(wrappedError);
    throw wrappedError;
  }

  mergeLocalTableRows(table, rows);
}

async function sbDelete(table, id) {
  if (SUPABASE_CONFIGURED && supabase) {
    const { error } = await supabase.from(table).delete().eq("id", id);
    if (!error) {
      removeLocalTableRow(table, id);
      return;
    }
    const wrappedError = createDataRequestError("delete", table, error);
    reportSupabaseError(wrappedError);
    throw wrappedError;
  }

  removeLocalTableRow(table, id);
}

// Local data fallback default seed
const DEFAULT_DB = {
  users: [
    { id: "admin", name: "Admin", role: "admin", pin: "1234" },
    { id: "sup1", name: "Supervisor One", role: "supervisor", pin: "1111" },
  ],
  staff: [
    { id: "st1", name: "Natasha" },
    { id: "st2", name: "Jordan" },
  ],
  clients: [
    { id: "cl1", name: "Client A", supervisor_id: "sup1", coverage_start: "07:00", coverage_end: "23:00", is_24_hour: false, active: true, hours_allotted: 40 },
  ],
  shifts: [],
  call_outs: [],
  audit_logs: [],
};

function normalizeFromDB({ users, staff, clients, shifts, call_outs, audit_logs }) {
  return {
    settings: {
      includeUnassignedForSupervisors: true,
      hardStopConflicts: true,
      crossWeekConsecutiveProtection: false,
      maxConsecutiveDays: 6,
    },
    users: (users || []).map((u) => ({
      id: u.id,
      name: getUserDisplayName(u, "Unknown User"),
      role: getUserRoleValue(u),
      pin: u.pin ?? u.user_pin ?? u.passcode ?? "",
    })),
    staff: (staff || []).map((s) => ({
      id: s.id,
      name: s.name,
      active: s.active !== false,
      notes: s.notes || "",
      restrictions: s.restrictions || "",
      unavailableDates: (() => { try { return JSON.parse(s.unavailable_dates || "[]"); } catch { return []; } })(),
      trainingExpiration: s.training_expiration || null,
    })),
    clients: (clients || []).map((c) => ({
      id: c.id,
      name: c.name,
      supervisorId: c.supervisor_id ?? c.supervisorId ?? "",
      coverageStart: normalizeTimeValue(
        c.coverage_start ?? c.coverageStart,
        "07:00"
      ),
      coverageEnd: normalizeTimeValue(c.coverage_end ?? c.coverageEnd, "23:00"),
      is24Hour: !!(c.is_24_hour ?? c.is24Hour),
      weeklyHours:
        typeof c.hours_allotted === "number"
          ? c.hours_allotted
          : Number(c.hours_allotted ?? c.weekly_hours) || 40,
      biweeklyHours: c.biweekly_hours != null ? Number(c.biweekly_hours) : null,
      assignedStaffIds: parseAssignedStaffIds(c.assigned_staff_ids ?? c.assignedStaffIds),
      active: c.active !== false,
      serviceNotes: c.service_notes || "",
      criticalFlags: c.critical_flags || "",
    })),

    shifts: (shifts || [])
      .map((sh) => {
        const startISO = normalizeDateTimeISO(sh.start_iso || sh.startISO);
        const endISO = normalizeDateTimeISO(sh.end_iso || sh.endISO);
        if (!startISO || !endISO) return null;
        return {
          id: sh.id,
          clientId: sh.client_id || sh.clientId,
          staffId: sh.staff_id || sh.staffId,
          startISO,
          endISO,
          createdBy: sh.created_by || sh.createdBy,
          isShared: !!(sh.is_shared || sh.isShared),
          sharedGroupId: sh.shared_group_id || sh.sharedGroupId || "",
          isCallOut: !!(sh.is_call_out || sh.isCallOut),
          callOutReason: sh.call_out_reason || sh.callOutReason || "",
          replacementStaffId: sh.replacement_staff_id || sh.replacementStaffId || "",
        };
      })
      .filter(Boolean),

    callOuts: (call_outs || []).map((co) => ({
      id: co.id,
      shiftId: co.shift_id || co.shiftId || "",
      clientId: co.client_id || co.clientId || "",
      originalStaffId: co.original_staff_id || co.originalStaffId || "",
      replacementStaffId: co.replacement_staff_id || co.replacementStaffId || "",
      date: co.date || "",
      reason: co.reason || "",
      status: co.status || "open",
      createdBy: co.created_by || co.createdBy || "",
      createdAt: co.created_at || co.createdAt || "",
    })),
  };
}

function toDB(state) {
  return {
    users: (state.users || []).map((u) => ({
      id: u.id,
      name: getUserDisplayName(u, "Unknown User"),
      role: getUserRoleValue(u),
      pin: u.pin,
    })),
    staff: (state.staff || []).map((s) => ({
      id: s.id, name: s.name, active: s.active !== false,
      notes: s.notes || "",
      restrictions: s.restrictions || "",
      unavailable_dates: JSON.stringify(s.unavailableDates || []),
      training_expiration: s.trainingExpiration || "",
    })),
    clients: (state.clients || []).map((c) => ({
      id: c.id,
      name: c.name,
      supervisor_id: c.supervisorId || null,
      coverage_start: c.coverageStart || "07:00",
      coverage_end: c.coverageEnd || "23:00",
      is_24_hour: !!c.is24Hour,
      // Canonical DB column for client weekly hours
      hours_allotted: Number(c.weeklyHours) || 40,
      biweekly_hours: Number(c.biweeklyHours) || 0,
      service_notes: c.serviceNotes || "",
      critical_flags: c.criticalFlags || "",
      assigned_staff_ids: serializeAssignedStaffIds(c.assignedStaffIds ?? []),
      active: c.active !== false,
    })),

    shifts: (state.shifts || []).map((sh) => ({
      id: sh.id,
      client_id: sh.clientId,
      staff_id: sh.staffId,
      start_iso: sh.startISO,
      end_iso: sh.endISO,
      created_by: sh.createdBy || "unknown",
      is_shared: !!sh.isShared,
      shared_group_id: sh.sharedGroupId || "",
      is_call_out: !!sh.isCallOut,
      call_out_reason: sh.callOutReason || "",
      replacement_staff_id: sh.replacementStaffId || "",
    })),

    call_outs: (state.callOuts || []).map((co) => ({
      id: co.id,
      shift_id: co.shift_id,
      client_id: co.client_id,
      original_staff_id: co.original_staff_id,
      replacement_staff_id: co.replacement_staff_id || "",
      date: co.date,
      reason: co.reason || "",
      status: co.status || "open",
      created_by: co.created_by || "unknown",
      created_at: co.created_at || new Date().toISOString(),
    })),
  };
}

// Refresh in-memory state from DB or localStorage
async function refreshState(setStateLocal, setIssuesLocal) {
  try {
    let { source, snapshot, tableSources } = await fetchAllDataSnapshot();

    if (source === "supabase" && (!snapshot.users || snapshot.users.length === 0)) {
      console.warn("Users table returned zero rows from Supabase.", {
        source,
        supabaseConfigured: SUPABASE_CONFIGURED,
        tableSources,
      });
    }

    if (!SUPABASE_CONFIGURED && source === "local" && (!snapshot.users || snapshot.users.length === 0)) {
      console.warn("No users found in local mode; seeding default users.");
      snapshot = { ...snapshot, users: DEFAULT_DB.users };
      await sbUpsert("users", DEFAULT_DB.users);
    }

    const issues = collectProfileDataIssues(snapshot);
    if (issues.length) {
      console.warn("Profile data diagnostics", issues);
    }

    const normalized = normalizeFromDB(snapshot);
    if (typeof setStateLocal === "function") setStateLocal((p) => ({ ...p, ...normalized }));
    if (typeof setIssuesLocal === "function") setIssuesLocal(issues);
    return normalized;
  } catch (e) {
    console.error("refreshState failed", e);
    return null;
  }
}

/* =========================
   Shared support OT logic
========================= */

function staffShiftUniqueKey(sh) {
  return shiftDedupKey({
    id: sh?.id,
    staffId: sh?.staffId ?? sh?.staff_id,
    startISO: sh?.startISO ?? sh?.start_iso,
    endISO: sh?.endISO ?? sh?.end_iso,
    isShared: sh?.isShared ?? sh?.is_shared,
    sharedGroupId: sh?.sharedGroupId ?? sh?.shared_group_id,
  });
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

function normalizeDraftStaffingType(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "shared3") return "shared3";
  if (raw === "shared2" || raw === "shared") return "shared2";
  return "single";
}

function getSharedClientIdsForShift(shifts, shift) {
  if (!shift) return [];
  const isShared = !!(shift.isShared || shift.is_shared);
  const shiftClientId = shift.clientId || shift.client_id || "";
  if (!isShared) return shiftClientId ? [shiftClientId] : [];

  const groupId = shift.sharedGroupId || shift.shared_group_id || "";
  const staffId = shift.staffId || shift.staff_id || "";
  const startISO = shift.startISO || shift.start_iso || "";
  const endISO = shift.endISO || shift.end_iso || "";

  return Array.from(
    new Set(
      (shifts || [])
        .filter((row) => !!(row.isShared || row.is_shared))
        .filter((row) => {
          const rowGroupId = row.sharedGroupId || row.shared_group_id || "";
          const rowStaffId = row.staffId || row.staff_id || "";
          const rowStartISO = row.startISO || row.start_iso || "";
          const rowEndISO = row.endISO || row.end_iso || "";
          if (groupId) return rowGroupId === groupId;
          return rowStaffId === staffId && rowStartISO === startISO && rowEndISO === endISO;
        })
        .map((row) => row.clientId || row.client_id || "")
        .filter(Boolean)
    )
  );
}

function getShiftStaffingType(shifts, shift) {
  if (!shift || !(shift.isShared || shift.is_shared)) return "single";
  const sharedClientCount = getSharedClientIdsForShift(shifts, shift).length;
  if (sharedClientCount >= 3) return "shared3";
  return "shared2";
}

function getShiftStaffingLabel(shifts, shift) {
  const staffingType = getShiftStaffingType(shifts, shift);
  if (staffingType === "shared3") return "Shared 3:1";
  if (staffingType === "shared2") return "Shared 2:1";
  return "1:1";
}

function staffSharedSupportMinutesDedup(shifts, staffId) {
  const seen = new Set();
  let total = 0;
  for (const sh of shifts) {
    if (sh.staffId !== staffId) continue;
    if (!(sh.isShared || sh.is_shared)) continue;
    const key = staffShiftUniqueKey(sh);
    if (seen.has(key)) continue;
    seen.add(key);
    total += minutesBetweenISO(sh.startISO, sh.endISO);
  }
  return total;
}

function getSharedSupportMinutesByStaff(shifts, staffList) {
  const out = {};
  for (const st of staffList || []) {
    out[st.id] = staffSharedSupportMinutesDedup(shifts, st.id);
  }
  return out;
}

function localDateKeyFromISO(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function getShiftsForConsecutiveCheck(allShifts, staffId, weekStartDate, weekEndDate, crossWeekProtection) {
  const baseStart = new Date(weekStartDate);
  baseStart.setHours(0, 0, 0, 0);

  const baseEnd = new Date(weekEndDate);
  baseEnd.setHours(0, 0, 0, 0);

  const rangeStart = crossWeekProtection ? addDays(baseStart, -7) : baseStart;
  const rangeEnd = crossWeekProtection ? addDays(baseEnd, 7) : baseEnd;

  return (allShifts || []).filter((sh) => {
    if (sh.staffId !== staffId) return false;
    const start = new Date(sh.startISO);
    if (isNaN(start)) return false;
    return start >= rangeStart && start < rangeEnd;
  });
}

function getConsecutiveWorkedDaysFromShifts(shifts) {
  const uniqueDays = Array.from(
    new Set(
      (shifts || [])
        .map((sh) => localDateKeyFromISO(sh.startISO))
        .filter(Boolean)
    )
  )
    .map((dayKey) => {
      const d = new Date(`${dayKey}T00:00:00`);
      return isNaN(d) ? null : d;
    })
    .filter(Boolean)
    .sort((a, b) => a - b);

  let maxStreak = 0;
  let streak = 0;
  let prev = null;

  for (const day of uniqueDays) {
    if (!prev) {
      streak = 1;
    } else {
      const diffDays = Math.round((day - prev) / (24 * 60 * 60 * 1000));
      streak = diffDays === 1 ? streak + 1 : 1;
    }
    if (streak > maxStreak) maxStreak = streak;
    prev = day;
  }

  return { uniqueWorkedDays: uniqueDays.length, maxStreak };
}

function projectedConsecutiveStreak({
  allShifts,
  staffId,
  weekStartDate,
  weekEndDate,
  crossWeekProtection,
  candidateShift,
}) {
  const scoped = getShiftsForConsecutiveCheck(
    allShifts,
    staffId,
    weekStartDate,
    weekEndDate,
    crossWeekProtection
  );
  const includeCandidate = candidateShift
    && getShiftsForConsecutiveCheck(
      [candidateShift],
      staffId,
      weekStartDate,
      weekEndDate,
      crossWeekProtection
    ).length > 0;
  const projected = includeCandidate ? [...scoped, candidateShift] : scoped;
  return getConsecutiveWorkedDaysFromShifts(projected).maxStreak;
}

function getWeekStartKey(dateInput) {
  const start = startOfWeekSunday(dateInput);
  return start ? isoLocal(start).slice(0, 10) : null;
}

function getGeneratedShiftEndISO(dateStr, startTime, endTime) {
  const startISO = `${dateStr}T${startTime}:00`;
  let endISO = `${dateStr}T${endTime}:00`;
  if (new Date(endISO) <= new Date(startISO)) {
    const nextDay = addDays(new Date(`${dateStr}T00:00:00`), 1);
    endISO = `${isoLocal(nextDay).slice(0, 10)}T${endTime}:00`;
  }
  return { startISO, endISO };
}

function createShiftRowsFromTemplate({
  clientId,
  rangeStartDate,
  rangeFinishDate,
  shiftsDef,
  assignments,
  createdBy,
}) {
  const rows = [];
  const generatedShifts = [];
  const days = getInclusiveDateRange(rangeStartDate, rangeFinishDate);

  for (const day of days) {
    const dateStr = formatDateOnlyLocal(day);

    for (let blockIdx = 0; blockIdx < shiftsDef.length; blockIdx++) {
      const { start: startTime, end: endTime } = shiftsDef[blockIdx];
      const { startISO, endISO } = getGeneratedShiftEndISO(dateStr, startTime, endTime);
      const weekday = new Date(`${dateStr}T00:00:00`).getDay();
      const assignedStaffId = assignments[`${weekday}_${blockIdx}`] || null;

      const row = {
        id: uid("sh"),
        client_id: clientId,
        staff_id: assignedStaffId,
        start_iso: startISO,
        end_iso: endISO,
        created_by: createdBy,
        is_shared: false,
        shared_group_id: "",
      };

      rows.push(row);
      generatedShifts.push({
        id: row.id,
        clientId,
        staffId: assignedStaffId,
        startISO,
        endISO,
        createdBy,
        isShared: false,
        sharedGroupId: "",
      });
    }
  }

  return { rows, generatedShifts };
}

function getStaffWeeklyMinutes(staffId, staffMinutesMap) {
  if (!staffId) return 0;
  return Number(staffMinutesMap?.[staffId] || 0);
}

function isNearOvertime(totalMinutes) {
  return isNearOT(totalMinutes);
}

function isOvertime(totalMinutes) {
  return isInOT(totalMinutes);
}

function isSharedSupport(shift) {
  return !!(shift?.isShared || shift?.is_shared);
}

function getShiftStatus(shift, staffMinutesMap) {
  const totalMinutes = getStaffWeeklyMinutes(shift?.staffId, staffMinutesMap);
  const sharedSupport = isSharedSupport(shift);
  const overtime = isOvertime(totalMinutes);
  const nearOvertime = !overtime && isNearOvertime(totalMinutes);

  return {
    totalMinutes,
    sharedSupport,
    overtime,
    nearOvertime,
    tone: overtime ? "over" : nearOvertime ? "near" : "normal",
  };
}

function getShiftStatusColors(status) {
  const tone = status?.tone || "normal";
  const palette = tone === "over"
    ? {
        background: "#FCEDEE",
        border: "#E9C2C4",
        text: "#7F2F36",
      }
    : tone === "near"
      ? {
          background: "#FFF7E6",
          border: "#E8D49E",
          text: "#7A5A12",
        }
      : {
          background: "#EDF7EF",
          border: "#C8DFCF",
          text: "#2F6A3B",
        };

  return {
    ...palette,
    sharedRail: "#4F7DF3",
    sharedBadgeBg: "#EAF0FF",
    sharedBadgeText: "#365CC6",
  };
}

function getStaffHoursMapForBucket(shifts, staffList, bucketStartValue, bucketDays = PAYROLL_BUCKET_DAYS) {
  const bucketStartDate = parseDateOnlyLocal(bucketStartValue);
  if (!bucketStartDate) return {};
  const bucketEndDate = addDays(bucketStartDate, bucketDays);
  const bucketStartISO = `${formatDateOnlyLocal(bucketStartDate)}T00:00:00`;
  const bucketEndISO = `${formatDateOnlyLocal(bucketEndDate)}T00:00:00`;

  const out = {};
  for (const st of staffList || []) {
    out[st.id] = staffMinutesDedupInWindow(shifts, st.id, bucketStartISO, bucketEndISO);
  }
  return out;
}

function calculateUnassignedShiftHours(shifts) {
  return (shifts || []).reduce((sum, sh) => sum + minutesBetweenISO(sh.startISO, sh.endISO), 0);
}

function calculateMinimumStaffRequired(totalMinutes) {
  if (!totalMinutes || totalMinutes <= 0) return 0;
  return Math.ceil(totalMinutes / OT_THRESHOLD_MIN);
}

function calculateRemainingCapacityByStaff(weeklyHoursMap, staffIds, staffList) {
  const uniqueStaffIds = Array.from(new Set((staffIds || []).filter(Boolean)));
  const entries = uniqueStaffIds.map((staffId) => {
    const minutes = weeklyHoursMap[staffId] || 0;
    const remainingMinutes = Math.max(0, OT_THRESHOLD_MIN - minutes);
    const staff = (staffList || []).find((st) => st.id === staffId);
    return {
      id: staffId,
      name: staff?.name || staffId,
      assignedMinutes: minutes,
      remainingMinutes,
      isAt40: minutes === OT_THRESHOLD_MIN,
      isOver40: minutes > OT_THRESHOLD_MIN,
      isUsable: remainingMinutes > 0,
    };
  });

  return {
    entries,
    usableStaffCount: entries.filter((entry) => entry.isUsable).length,
    totalRemainingMinutes: entries.reduce((sum, entry) => sum + entry.remainingMinutes, 0),
  };
}

function calculateAdditionalStaffNeeded(totalMinutes, assignedMinutes, remainingCapacityMinutes, currentUsableStaff, minimumStaffRequired) {
  const uncoveredMinutes = Math.max(0, totalMinutes - assignedMinutes - remainingCapacityMinutes);
  const extraFromHours = Math.ceil(uncoveredMinutes / OT_THRESHOLD_MIN);
  const extraFromHeadcount = Math.max(0, minimumStaffRequired - currentUsableStaff);
  return Math.max(extraFromHours, extraFromHeadcount);
}

function analyzeWeeklyStaffingNeeds({ existingShifts, generatedShifts, staffList, payrollStartDate, payrollFinishDate }) {
  const generated = generatedShifts || [];
  const assignedGenerated = generated.filter((sh) => !!sh.staffId);
  const unassignedGenerated = generated.filter((sh) => !sh.staffId);
  const payrollWindow = getDateRangeWindow(payrollStartDate, payrollFinishDate);
  const totalScheduledMinutes = payrollWindow
    ? calculateShiftHoursInWindow(generated, payrollWindow.startISO, payrollWindow.endExclusiveISO)
    : 0;
  const assignedScheduledMinutes = payrollWindow
    ? calculateShiftHoursInWindow(assignedGenerated, payrollWindow.startISO, payrollWindow.endExclusiveISO)
    : 0;
  const weekKeys = [];
  if (payrollWindow) {
    for (let cursor = new Date(payrollWindow.startDate); cursor <= payrollWindow.finishDate; cursor = addDays(cursor, PAYROLL_BUCKET_DAYS)) {
      weekKeys.push(formatDateOnlyLocal(cursor));
    }
  }
  if (!weekKeys.length && payrollStartDate) weekKeys.push(payrollStartDate);

  const at40Set = new Set();
  const over40Set = new Set();
  const weeklyBreakdown = [];

  for (const weekKey of weekKeys) {
    const combinedShifts = [...(existingShifts || []), ...assignedGenerated];
    const weeklyHoursMap = getStaffHoursMapForBucket(combinedShifts, staffList, weekKey);
    const staffAt40 = (staffList || []).filter((st) => weeklyHoursMap[st.id] === OT_THRESHOLD_MIN);
    const staffOver40 = (staffList || []).filter((st) => weeklyHoursMap[st.id] > OT_THRESHOLD_MIN);
    const bucketWindow = getDateRangeWindow(weekKey, formatDateOnlyLocal(addDays(parseDateOnlyLocal(weekKey), PAYROLL_BUCKET_DAYS - 1)));
    const weekUnassigned = (unassignedGenerated || []).filter((sh) => bucketWindow && overlapsWindow(sh.startISO, sh.endISO, bucketWindow.startISO, bucketWindow.endExclusiveISO));
    const unassignedMinutes = bucketWindow
      ? calculateShiftHoursInWindow(weekUnassigned, bucketWindow.startISO, bucketWindow.endExclusiveISO)
      : 0;
    const weekGenerated = (generated || []).filter((sh) => bucketWindow && overlapsWindow(sh.startISO, sh.endISO, bucketWindow.startISO, bucketWindow.endExclusiveISO));
    const weekAssigned = (assignedGenerated || []).filter((sh) => bucketWindow && overlapsWindow(sh.startISO, sh.endISO, bucketWindow.startISO, bucketWindow.endExclusiveISO));
    const weekTotalScheduledMinutes = bucketWindow
      ? calculateShiftHoursInWindow(weekGenerated, bucketWindow.startISO, bucketWindow.endExclusiveISO)
      : 0;
    const weekAssignedScheduledMinutes = bucketWindow
      ? calculateShiftHoursInWindow(weekAssigned, bucketWindow.startISO, bucketWindow.endExclusiveISO)
      : 0;
    const assignedStaffIds = Array.from(new Set(weekAssigned.map((sh) => sh.staffId).filter(Boolean)));
    const remainingCapacity = calculateRemainingCapacityByStaff(weeklyHoursMap, assignedStaffIds, staffList);
    const minimumStaffRequired = calculateMinimumStaffRequired(weekTotalScheduledMinutes);
    const additionalStaffNeeded = calculateAdditionalStaffNeeded(
      weekTotalScheduledMinutes,
      weekAssignedScheduledMinutes,
      remainingCapacity.totalRemainingMinutes,
      remainingCapacity.usableStaffCount,
      minimumStaffRequired
    );

    for (const st of staffAt40) at40Set.add(st.id);
    for (const st of staffOver40) over40Set.add(st.id);

    weeklyBreakdown.push({
      weekStart: weekKey,
      totalScheduledMinutes: weekTotalScheduledMinutes,
      assignedScheduledMinutes: weekAssignedScheduledMinutes,
      unassignedCount: weekUnassigned.length,
      unassignedHours: unassignedMinutes,
      minimumStaffRequired,
      currentUsableStaff: remainingCapacity.usableStaffCount,
      remainingCapacityMinutes: remainingCapacity.totalRemainingMinutes,
      currentStaffingEnough: additionalStaffNeeded === 0,
      additionalStaffNeeded,
      staffAt40: staffAt40.map((st) => ({ id: st.id, name: st.name, minutes: weeklyHoursMap[st.id] || 0 })),
      staffOver40: staffOver40.map((st) => ({ id: st.id, name: st.name, minutes: weeklyHoursMap[st.id] || 0 })),
      remainingCapacityByStaff: remainingCapacity.entries,
      staffHours: (staffList || [])
        .map((st) => ({ id: st.id, name: st.name, minutes: weeklyHoursMap[st.id] || 0 }))
        .filter((entry) => entry.minutes > 0)
        .sort((a, b) => b.minutes - a.minutes || a.name.localeCompare(b.name)),
      unassignedShifts: weekUnassigned.map((sh) => ({
        id: sh.id,
        startISO: bucketWindow ? (clipShiftToWindow(sh.startISO, sh.endISO, bucketWindow.startISO, bucketWindow.endExclusiveISO)?.startISO || sh.startISO) : sh.startISO,
        endISO: bucketWindow ? (clipShiftToWindow(sh.startISO, sh.endISO, bucketWindow.startISO, bucketWindow.endExclusiveISO)?.endISO || sh.endISO) : sh.endISO,
      })),
    });
  }

  const combinedWeeklyHoursMap = weekKeys.reduce((acc, weekKey) => {
    acc[weekKey] = getStaffHoursMapForBucket([...(existingShifts || []), ...assignedGenerated], staffList, weekKey);
    return acc;
  }, {});
  const allAssignedStaffIds = assignedGenerated.map((sh) => sh.staffId).filter(Boolean);
  const overallRemainingCapacityEntries = Array.from(new Set(allAssignedStaffIds)).map((staffId) => {
    const minutesByWeek = weekKeys.map((weekKey) => combinedWeeklyHoursMap[weekKey]?.[staffId] || 0);
    const remainingByWeek = minutesByWeek.map((minutes) => Math.max(0, OT_THRESHOLD_MIN - minutes));
    const staff = (staffList || []).find((st) => st.id === staffId);
    return {
      id: staffId,
      name: staff?.name || staffId,
      remainingMinutes: remainingByWeek.reduce((sum, minutes) => sum + minutes, 0),
      isUsable: remainingByWeek.some((minutes) => minutes > 0),
    };
  });
  const currentUsableStaff = overallRemainingCapacityEntries.filter((entry) => entry.isUsable).length;
  const totalRemainingCapacityMinutes = overallRemainingCapacityEntries.reduce((sum, entry) => sum + entry.remainingMinutes, 0);
  const minimumStaffRequired = calculateMinimumStaffRequired(totalScheduledMinutes);
  const additionalStaffNeeded = calculateAdditionalStaffNeeded(
    totalScheduledMinutes,
    assignedScheduledMinutes,
    totalRemainingCapacityMinutes,
    currentUsableStaff,
    minimumStaffRequired
  );

  return {
    totalShiftsCreated: generated.length,
    totalScheduledMinutes,
    assignedScheduledMinutes,
    assignedShifts: assignedGenerated.length,
    unassignedShifts: unassignedGenerated.length,
    unassignedHours: payrollWindow
      ? calculateShiftHoursInWindow(unassignedGenerated, payrollWindow.startISO, payrollWindow.endExclusiveISO)
      : 0,
    minimumStaffRequired,
    currentUsableStaff,
    totalRemainingCapacityMinutes,
    currentStaffingEnough: additionalStaffNeeded === 0,
    additionalStaffNeeded,
    staffAt40Count: at40Set.size,
    staffOver40Count: over40Set.size,
    staffAtOrAbove40Count: new Set([...at40Set, ...over40Set]).size,
    hasStaffAtOrAbove40: at40Set.size > 0 || over40Set.size > 0,
    hasStaffOver40: over40Set.size > 0,
    weeklyBreakdown,
  };
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
      <div style={{ minHeight: "100vh", background: UI.bg, color: UI.text, padding: 16 }}>
        <div style={{ maxWidth: 520, margin: "28px auto", ...styles.card }}>
          <h2 style={{ marginTop: 0 }}>DSW Scheduler — Create Admin</h2>

          <div style={{ ...styles.twoCol, marginTop: 10 }}>
            <div>
              <div style={styles.tiny}>ID</div>
              <input style={styles.input} value={newId} onChange={(e) => setNewId(e.target.value)} placeholder="admin" />
            </div>
            <div>
              <div style={styles.tiny}>Name</div>
              <input style={styles.input} value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Admin" />
            </div>
            <div>
              <div style={styles.tiny}>PIN</div>
              <input style={styles.input} value={newPin} onChange={(e) => setNewPin(e.target.value)} placeholder="1234" type="password" />
            </div>
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
            <button
              style={styles.btn}
              onClick={() => {
                if (!newId.trim() || !newName.trim() || !newPin.trim()) return alert("All fields are required.");
                onCreateAdmin({ id: newId.trim(), name: newName.trim(), pin: newPin.trim() });
              }}
            >
              Create Admin
            </button>
          </div>

          <div style={{ marginTop: 10, ...styles.tiny, opacity: 0.85 }}>
            Tip: This will create the first user so you can log in and manage staff/clients.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: UI.bg, color: UI.text, padding: 16 }}>
      <div style={{ maxWidth: 520, margin: "28px auto", ...styles.card }}>
        <h2 style={{ marginTop: 0 }}>DSW Scheduler Login</h2>

        <div style={{ ...styles.twoCol, marginTop: 10 }}>
          <div>
            <div style={styles.tiny}>User</div>
            <select style={styles.select} value={picked} onChange={(e) => setPicked(e.target.value)}>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {formatUserOptionLabel(u)}
                </option>
              ))}
            </select>
          </div>

          <div>
            <div style={styles.tiny}>PIN</div>
            <input style={styles.input} value={pin} onChange={(e) => setPin(e.target.value)} placeholder="Enter PIN" type="password" />
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
          <button
            style={styles.btn}
            onClick={() => {
              console.log("Login attempt", { picked, pin, user });
              if (!user) return alert("Pick a user before logging in.");

              // If the stored user does not have a pin, allow logging in (for existing Supabase rows without pin).
              const pinMatches = !user.pin || String(pin || "") === String(user.pin || "");
              if (!pinMatches) {
                alert("Incorrect PIN.");
                return;
              }
              onLogin(user.id);
            }}
            disabled={!user}
          >
            Login
          </button>
        </div>

        <div style={{ marginTop: 10, ...styles.tiny, opacity: 0.85 }}>
          Tip: PIN login is a simple MVP. For real security later, we’ll swap to Supabase Auth + roles.
        </div>
      </div>
    </div>
  );
}

/* =========================
   Calendar (print/PDF)
========================= */

function CalendarWeek({ state, weekStartDate, visibleClients, canSeeAllShifts, canManageShiftForClient, setTab, setShiftDraft, deleteShift, staffPeriodMinutesMap }) {
  const shifts = state.shifts || [];
  const clients = state.clients || [];
  const staff = state.staff || [];
  const [dayDetail, setDayDetail] = useState(null);

  const clientName = (id) => clients.find((c) => c.id === id)?.name || "Unknown";
  const staffName = (id) => staff.find((s) => s.id === id)?.name || "Unknown";

  const start = new Date(weekStartDate);
  start.setHours(0, 0, 0, 0);

  const days = [...Array(7)].map((_, i) => {
    const d = addDays(start, i);
    return { d, dateStr: isoLocal(d).slice(0, 10) };
  });

  const visibleClientIds = new Set((visibleClients || []).map((c) => c.id));
  const DAY_BOX_HEIGHT = 254;
  const DAY_COLUMN_MIN_WIDTH = 172;

  function openShiftEditor(sh) {
    const linkedClientIds = getSharedClientIdsForShift(state.shifts || [], sh)
      .filter((id) => id !== sh.clientId);
    const staffingType = getShiftStaffingType(state.shifts || [], sh);
    setTab && setTab("schedule");
    setShiftDraft && setShiftDraft({
      clientId: sh.clientId,
      clientId2: linkedClientIds[0] || "",
      clientId3: linkedClientIds[1] || "",
      staffId: sh.staffId,
      startDate: sh.startISO.slice(0, 10),
      startTime: sh.startISO.slice(11, 16),
      endDate: sh.endISO.slice(0, 10),
      endTime: sh.endISO.slice(11, 16),
      staffingType,
      isShared: staffingType !== "single",
      sharedGroupId: sh.sharedGroupId || "",
    });
  }

  function dayShifts(dateStr) {
    return shifts
      .filter((sh) => {
        if (!canSeeAllShifts && !visibleClientIds.has(sh.clientId)) return false;
        return String(sh.startISO || "").slice(0, 10) === dateStr;
      })
      .sort((a, b) => new Date(a.startISO) - new Date(b.startISO));
  }

  function renderStatusBadges(sh) {
    const status = getShiftStatus(sh, staffPeriodMinutesMap);
    const colors = getShiftStatusColors(status);
    const badges = [];
    if (status.sharedSupport) {
      badges.push({
        key: "shared",
        label: getShiftStaffingLabel(shifts, sh),
        background: colors.sharedBadgeBg,
        color: colors.sharedBadgeText,
        borderColor: "rgba(79,125,243,0.24)",
      });
    }
    if (status.overtime) {
      badges.push({
        key: "ot",
        label: "40h+",
        background: colors.background,
        color: colors.text,
        borderColor: colors.border,
      });
    } else if (status.nearOvertime) {
      badges.push({
        key: "near",
        label: "Near 40h",
        background: colors.background,
        color: colors.text,
        borderColor: colors.border,
      });
    }
    return badges;
  }

  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ ...styles.card, marginBottom: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 980 }}>Weekly Calendar</div>
            <div style={styles.tiny}>Week of {start.toLocaleDateString()} • Click any shift row for edit/delete details.</div>
          </div>
          <button className="no-print" style={styles.btn2} onClick={() => window.print()}>
            Print / Save PDF
          </button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: `repeat(7, minmax(${DAY_COLUMN_MIN_WIDTH}px, 1fr))`, gap: 10, overflowX: "auto", alignItems: "start" }}>
        {days.map(({ d, dateStr }) => (
          <div
            key={dateStr}
            style={{
              ...styles.card,
              padding: 8,
              minHeight: DAY_BOX_HEIGHT,
              maxHeight: DAY_BOX_HEIGHT,
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
            }}
          >
            <div style={{ fontWeight: 900, fontSize: 11, letterSpacing: 0.35 }}>
              {d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }).toUpperCase()}
            </div>

            <div style={{ display: "grid", gap: 4, marginTop: 6, fontSize: 10, lineHeight: 1.25, flex: 1, minHeight: 0, overflowY: "auto", paddingRight: 2 }}>
              {(() => {
                const all = dayShifts(dateStr);
                if (all.length === 0) return <div style={{ opacity: 0.72, fontSize: 10 }}>No shifts</div>;

                return (
                  <div style={{ display: "grid", gap: 4, minHeight: 0 }}>
                    {all.map((sh) => {
                      const status = getShiftStatus(sh, staffPeriodMinutesMap);
                      const colors = getShiftStatusColors(status);
                      return (
                        <button
                          key={sh.id}
                          type="button"
                          onClick={() => setDayDetail({ dateStr, date: d })}
                          title={`${compactShiftRange(sh.startISO, sh.endISO)} | ${clientName(sh.clientId)} | ${staffName(sh.staffId)}`}
                          style={{
                            border: `1px solid ${colors.border}`,
                            borderLeft: `4px solid ${status.sharedSupport ? colors.sharedRail : colors.border}`,
                            borderRadius: 8,
                            padding: "4px 6px",
                            background: colors.background,
                            color: UI.text,
                            cursor: "pointer",
                            textAlign: "left",
                            display: "grid",
                            gridTemplateColumns: "70px minmax(0, 1fr) minmax(0, 1fr)",
                            gap: 8,
                            alignItems: "center",
                            minWidth: 0,
                          }}
                        >
                          <span style={{ whiteSpace: "nowrap", fontWeight: 800, fontVariantNumeric: "tabular-nums", color: UI.text }}>
                            {compactShiftRange(sh.startISO, sh.endISO)}
                          </span>
                          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: UI.text }}>
                            {clientName(sh.clientId)}
                          </span>
                          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: UI.textSecondary }}>
                            {staffName(sh.staffId)}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                );
              })()}
            </div>
          </div>
        ))}
      </div>
