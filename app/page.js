"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../lib/supabaseClient";

// On the client, Next.js replaces env vars at build time.
const SUPABASE_CONFIGURED = !!(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);

// Supabase errors (auth/RLS) should not break the app. When they happen we
// fall back to localStorage (and log a warning).
let supabaseErrorHandler = null;
function setSupabaseErrorHandler(fn) {
  supabaseErrorHandler = fn;
}
function reportSupabaseError(error) {
  console.warn("Supabase request failed; falling back to local storage.", error);
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
const OT_THRESHOLD_MIN = 40 * 60;
const MAX_HOURS_PER_24_MIN = 16 * 60;
const PAYROLL_CYCLE_DAYS = 14;
const PAYROLL_BUCKET_DAYS = 7;
const DEFAULT_PAYROLL_CYCLE_ANCHOR = "2026-03-08";

function normalizeRole(role) {
  return String(role || "").trim().toLowerCase();
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
  return splitShiftIntoWindowMinutes(shiftStartISO, shiftEndISO, windowStartISO, windowEndISO) > 0;
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
  return new Date(aStart) < new Date(bEnd) && new Date(bStart) < new Date(aEnd);
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
    <div className="no-print" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      {tabs.map((t) => (
        <button
          key={t.value}
          onClick={() => onChange(t.value)}
          style={{
            ...styles.btn2,
            padding: "7px 11px",
            fontSize: 12,
            lineHeight: 1.2,
            background: value === t.value ? "rgba(59,130,246,0.10)" : "#FFFFFF",
            color: value === t.value ? UI.accent : UI.textSecondary,
            borderColor: value === t.value ? "rgba(59,130,246,0.42)" : UI.border,
            boxShadow: value === t.value ? "inset 0 0 0 1px rgba(59,130,246,0.06)" : "none",
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
            background: "#FFFFFF",
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

function cloneDefaultDb() {
  return JSON.parse(JSON.stringify(DEFAULT_DB));
}

function readLocalDb() {
  try {
    const raw = localStorage.getItem("dsw_local_db");
    return raw ? JSON.parse(raw) : cloneDefaultDb();
  } catch {
    return cloneDefaultDb();
  }
}

function writeLocalDb(db) {
  localStorage.setItem("dsw_local_db", JSON.stringify(db));
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

async function sbSelect(table) {
  // Supabase or localStorage fallback
  if (SUPABASE_CONFIGURED && supabase) {
    const { data, error } = await supabase.from(table).select("*");
    if (!error) return data || [];
    reportSupabaseError(error);
  }

  // localStorage fallback
  try {
    const db = readLocalDb();
    return db[table] || [];
  } catch {
    return [];
  }
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
    if (!error) return;
    reportSupabaseError(error);
  }

  // localStorage upsert
  try {
    const db = readLocalDb();
    db[table] = db[table] || [];
    for (const r of rows) {
      const idx = db[table].findIndex((x) => x.id === r.id);
      if (idx >= 0) db[table][idx] = { ...db[table][idx], ...r };
      else db[table].push(r);
    }
    writeLocalDb(db);
    // refresh in-memory state by triggering loadAll externally (caller should reload)
  } catch (e) {
    console.error(e);
  }
}

async function sbDelete(table, id) {
  if (SUPABASE_CONFIGURED && supabase) {
    const { error } = await supabase.from(table).delete().eq("id", id);
    if (!error) return;
    reportSupabaseError(error);
  }

  try {
    const db = readLocalDb();
    db[table] = (db[table] || []).filter((x) => x.id !== id);
    writeLocalDb(db);
  } catch (e) {
    console.error(e);
  }
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
};

function normalizeFromDB({ users, staff, clients, shifts }) {
  return {
    settings: {
      includeUnassignedForSupervisors: true,
      hardStopConflicts: true,
      crossWeekConsecutiveProtection: false,
      maxConsecutiveDays: 6,
    },
    users: (users || []).map((u) => ({
      id: u.id,
      name: u.name,
      role: normalizeRole(u.role ?? u.dashboard_role) || "supervisor",
      pin: u.pin,
    })),
    staff: (staff || []).map((s) => ({ id: s.id, name: s.name, active: s.active !== false })),
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
      // Read canonical hours_allotted first; fall back to legacy weekly_hours if present.
      weeklyHours:
        typeof c.hours_allotted === "number"
          ? c.hours_allotted
          : Number(c.hours_allotted ?? c.weekly_hours) || 40,
      assignedStaffIds: parseAssignedStaffIds(c.assigned_staff_ids ?? c.assignedStaffIds),
      active: c.active !== false,
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
        };
      })
      .filter(Boolean),
  };
}

function toDB(state) {
  return {
    users: (state.users || []).map((u) => ({
      id: u.id,
      name: u.name,
      role: normalizeRole(u.role) || "supervisor",
      pin: u.pin,
    })),
    staff: (state.staff || []).map((s) => ({ id: s.id, name: s.name, active: s.active !== false })),
    clients: (state.clients || []).map((c) => ({
      id: c.id,
      name: c.name,
      supervisor_id: c.supervisorId || null,
      coverage_start: c.coverageStart || "07:00",
      coverage_end: c.coverageEnd || "23:00",
      is_24_hour: !!c.is24Hour,
      // Canonical DB column for client weekly hours
      hours_allotted: Number(c.weeklyHours) || 40,
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
    })),
  };
}

// Refresh in-memory state from DB or localStorage
async function refreshState(setStateLocal) {
  try {
    const [users, staff, clients, shifts] = await Promise.all([
      sbSelect("users"),
      sbSelect("staff"),
      sbSelect("clients"),
      sbSelect("shifts"),
    ]);
    const normalized = normalizeFromDB({ users, staff, clients, shifts });
    if (typeof setStateLocal === "function") setStateLocal((p) => ({ ...p, ...normalized }));
    return normalized;
  } catch (e) {
    console.error(e);
    return null;
  }
}

/* =========================
   Shared support OT logic
========================= */

function staffShiftUniqueKey(sh) {
  // Shared support: linked client rows (2:1 or 3:1) count once for staff OT
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
                  {u.name} ({u.role})
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

function CalendarWeek({ state, weekStartDate, visibleClients, canSeeAllShifts, canManageShiftForClient, setTab, setShiftDraft, deleteShift }) {
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
  const PREVIEW_LIMIT = 3;
  const DAY_BOX_HEIGHT = 188;

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
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))", gap: 8 }}>
        {days.map(({ d, dateStr }) => (
          <div
            key={dateStr}
            style={{
              ...styles.card,
              padding: 10,
              minHeight: DAY_BOX_HEIGHT,
              maxHeight: DAY_BOX_HEIGHT,
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
            }}
          >
            <div style={{ fontWeight: 900, fontSize: 11 }}>
              {d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}
            </div>

            <div style={{ display: "grid", gap: 5, marginTop: 8, fontSize: 10, lineHeight: 1.35, flex: 1, minHeight: 0 }}>
              {(() => {
                const all = dayShifts(dateStr);
                const preview = all.slice(0, PREVIEW_LIMIT);
                const hiddenCount = Math.max(0, all.length - PREVIEW_LIMIT);

                if (all.length === 0) return <div style={{ opacity: 0.72, fontSize: 10 }}>No shifts</div>;

                return (
                  <>
                    <div style={{ display: "grid", gap: 5, overflow: "hidden", minHeight: 0 }}>
                      {preview.map((sh) => (
                        <div
                          key={sh.id}
                          style={{
                            border: `1px solid ${UI.borderSoft}`,
                            borderRadius: 7,
                            padding: "4px 6px",
                            background: UI.panelAlt,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                          title={`${compactShiftRange(sh.startISO, sh.endISO)} • ${clientName(sh.clientId)} • ${staffName(sh.staffId)}`}
                        >
                          {compactShiftRange(sh.startISO, sh.endISO)} • {clientName(sh.clientId)} • {staffName(sh.staffId)}
                        </div>
                      ))}
                    </div>
                    {hiddenCount > 0 ? (
                      <button
                        type="button"
                        style={{
                          border: "none",
                          background: "transparent",
                          color: "#7fd1ff",
                          fontSize: 10,
                          fontWeight: 800,
                          padding: 0,
                          textAlign: "left",
                          cursor: "pointer",
                          justifySelf: "start",
                        }}
                        onClick={() => setDayDetail({ dateStr, date: d })}
                      >
                        +{hiddenCount} more
                      </button>
                    ) : null}
                  </>
                );
              })()}
            </div>
          </div>
        ))}
      </div>

      {dayDetail ? (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(31,41,51,0.24)",
            zIndex: 1000,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
          }}
          onClick={() => setDayDetail(null)}
        >
          <div
            style={{
              ...styles.card,
              width: "min(640px, 100%)",
              maxHeight: "82vh",
              overflowY: "auto",
              padding: 14,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
              <div>
                <div style={{ fontSize: 16, fontWeight: 900 }}>Day Details</div>
                <div style={styles.tiny}>
                  {dayDetail.date.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
                </div>
              </div>
              <button type="button" style={styles.btn2} onClick={() => setDayDetail(null)}>Close</button>
            </div>

            <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
              {dayShifts(dayDetail.dateStr).map((sh) => {
                const canManageShift = typeof canManageShiftForClient === "function"
                  ? canManageShiftForClient(sh.clientId)
                  : true;
                return (
                  <div key={sh.id} style={{ border: `1px solid ${UI.borderSoft}`, borderRadius: 10, padding: 10, background: UI.panelAlt }}>
                    <div style={{ fontSize: 12, fontWeight: 800, lineHeight: 1.35 }}>
                      {compactShiftRange(sh.startISO, sh.endISO)} • {clientName(sh.clientId)} • {staffName(sh.staffId)}
                    </div>
                    <div style={{ ...styles.tiny, marginTop: 3 }}>
                      {formatShiftDateTimeFromISO(sh.startISO)} to {formatShiftDateTimeFromISO(sh.endISO)}
                      {sh.isShared ? ` • ${getShiftStaffingLabel(shifts, sh)}` : ""}
                    </div>
                    {canManageShift ? (
                      <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                        <button
                          type="button"
                          style={{ ...styles.btn2, fontSize: 11, padding: "3px 8px" }}
                          onClick={() => {
                            openShiftEditor(sh);
                            setDayDetail(null);
                          }}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          style={{ ...styles.btnDanger, fontSize: 11, padding: "3px 8px" }}
                          onClick={() => {
                            if (typeof deleteShift === "function") deleteShift(sh.id);
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function CalendarMonth({ state, monthStartDate, visibleClients, canSeeAllShifts }) {
  const shifts = state.shifts || [];
  const clients = state.clients || [];
  const staff = state.staff || [];
  const [expandedDays, setExpandedDays] = useState({});

  const clientName = (id) => clients.find((c) => c.id === id)?.name || "Unknown";
  const staffName = (id) => staff.find((s) => s.id === id)?.name || "Unknown";

  const monthStart = new Date(monthStartDate);
  monthStart.setHours(0, 0, 0, 0);

  // Align the month view to a Sunday-start calendar grid
  const firstOfMonth = new Date(monthStart);
  firstOfMonth.setDate(1);
  const firstWeekday = firstOfMonth.getDay(); // 0=Sun
  const gridStart = addDays(firstOfMonth, -firstWeekday);

  const days = [...Array(42)].map((_, i) => {
    const d = addDays(gridStart, i);
    return { d, dateStr: isoLocal(d).slice(0, 10), inMonth: d.getMonth() === monthStart.getMonth() };
  });

  const visibleClientIds = new Set((visibleClients || []).map((c) => c.id));
  const PREVIEW_LIMIT = 2;

  function toggleDayExpanded(dateStr) {
    setExpandedDays((prev) => ({ ...prev, [dateStr]: !prev[dateStr] }));
  }

  function dayShifts(dateStr) {
    return shifts
      .filter((sh) => {
        if (!canSeeAllShifts && !visibleClientIds.has(sh.clientId)) return false;
        return String(sh.startISO || "").slice(0, 10) === dateStr;
      })
      .sort((a, b) => new Date(a.startISO) - new Date(b.startISO));
  }

  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ ...styles.card, marginBottom: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 980 }}>Monthly Calendar</div>
            <div style={styles.tiny}>{monthStart.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</div>
          </div>
          <button className="no-print" style={styles.btn2} onClick={() => window.print()}>
            Print / Save PDF
          </button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(120px, 1fr))", gap: 8, overflowX: "auto" }}>
        {WEEKDAY_NAMES.map((w) => (
          <div key={w} style={{ ...styles.card, fontWeight: 900, textAlign: "center" }}>
            {w}
          </div>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(120px, 1fr))", gap: 8, overflowX: "auto" }}>
        {days.map(({ d, dateStr, inMonth }) => (
          <div key={dateStr} style={{ ...styles.card, opacity: inMonth ? 1 : 0.45, padding: 8, minHeight: 116, maxHeight: 116, display: "flex", flexDirection: "column" }}>
            <div style={{ fontWeight: 900, fontSize: 11 }}>
              {d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}
            </div>
            <div style={{ display: "grid", gap: 3, marginTop: 4, fontSize: 10, lineHeight: 1.2, flex: 1, minHeight: 0 }}>
              {(() => {
                const all = dayShifts(dateStr);
                const isExpanded = !!expandedDays[dateStr];
                const preview = isExpanded ? all : all.slice(0, PREVIEW_LIMIT);
                const hiddenCount = Math.max(0, all.length - PREVIEW_LIMIT);

                if (all.length === 0) return <div style={{ opacity: 0.7, fontSize: 10 }}>No shifts</div>;

                return (
                  <>
                    <div style={{ display: "grid", gap: 3, overflowY: isExpanded ? "auto" : "hidden", minHeight: 0 }}>
                      {preview.map((sh) => (
                        <div key={sh.id} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={`${clientName(sh.clientId)} | ${staffName(sh.staffId)}`}>
                          {compactShiftRange(sh.startISO, sh.endISO)} {shortLabel(clientName(sh.clientId), 8)} / {shortLabel(staffName(sh.staffId), 8)}
                          {sh.isShared ? (
                            <span
                              style={{
                                marginLeft: 5,
                                fontSize: 9,
                                fontWeight: 900,
                                    color: UI.accent,
                                border: "1px solid rgba(76,201,240,0.45)",
                                borderRadius: 999,
                                padding: "0 5px",
                              }}
                            >
                              {getShiftStaffingLabel(shifts, sh)}
                            </span>
                          ) : null}
                        </div>
                      ))}
                    </div>
                    {hiddenCount > 0 && !isExpanded ? (
                      <button
                        type="button"
                        style={{ ...styles.btn2, fontSize: 10, padding: "1px 6px", justifySelf: "start" }}
                        onClick={() => toggleDayExpanded(dateStr)}
                      >
                        +{hiddenCount} more
                      </button>
                    ) : null}
                    {isExpanded && all.length > PREVIEW_LIMIT ? (
                      <button
                        type="button"
                        style={{ ...styles.btn2, fontSize: 10, padding: "1px 6px", justifySelf: "start" }}
                        onClick={() => toggleDayExpanded(dateStr)}
                      >
                        Show less
                      </button>
                    ) : null}
                  </>
                );
              })()}
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

  // “DB state”
  const [state, setState] = useState({
    settings: {
      includeUnassignedForSupervisors: true,
      hardStopConflicts: true,
      crossWeekConsecutiveProtection: false,
      maxConsecutiveDays: 6,
    },
    users: [],
    staff: [],
    clients: [],
    shifts: [],
  });

  // session login (local session only)
  const [sessionUserId, setSessionUserId] = useState(null);
  const [sessionUserSnapshot, setSessionUserSnapshot] = useState(null);

  // Supabase error state (used to show a warning banner when auth/RLS fails)
  const [supabaseError, setSupabaseError] = useState(null);

  // UI
  const [tab, setTab] = useState("schedule");

  // Payroll period selection
  const [payrollReferenceDate, setPayrollReferenceDate] = useState(() => formatDateOnlyLocal(new Date()));
  const [payrollStartDate, setPayrollStartDate] = useState(() => getPayrollCycleRangeForReferenceDate(new Date()).startDate);
  const [payrollFinishDate, setPayrollFinishDate] = useState(() => getPayrollCycleRangeForReferenceDate(new Date()).finishDate);

  const weekStartDate = useMemo(() => parseDateOnlyLocal(payrollStartDate) || parseDateOnlyLocal(new Date()) || new Date(), [payrollStartDate]);
  const selectedPeriodFinishDate = useMemo(() => parseDateOnlyLocal(payrollFinishDate) || weekStartDate, [payrollFinishDate, weekStartDate]);
  const weekEndDate = useMemo(() => addDays(selectedPeriodFinishDate, 1), [selectedPeriodFinishDate]);
  const selectedPeriodDayCount = useMemo(
    () => Math.max(1, daysBetweenDateOnly(weekStartDate, selectedPeriodFinishDate) + 1),
    [weekStartDate, selectedPeriodFinishDate]
  );
  const selectedPeriodWindow = useMemo(
    () => getDateRangeWindow(payrollStartDate, payrollFinishDate),
    [payrollStartDate, payrollFinishDate]
  );

  const monthStartDate = useMemo(() => {
    const d = new Date(weekStartDate);
    d.setDate(1);
    d.setHours(0, 0, 0, 0);
    return d;
  }, [weekStartDate]);

  function applyPayrollCycleFromReference(referenceDateValue = payrollReferenceDate) {
    const nextRange = getPayrollCycleRangeForReferenceDate(referenceDateValue);
    setPayrollReferenceDate(referenceDateValue);
    setPayrollStartDate(nextRange.startDate);
    setPayrollFinishDate(nextRange.finishDate);
  }

  useEffect(() => {
    if (selectedPeriodFinishDate < weekStartDate) {
      setPayrollFinishDate(payrollStartDate);
    }
  }, [payrollStartDate, payrollFinishDate, weekStartDate, selectedPeriodFinishDate]);

  const currentUser = useMemo(() => {
    const fromState = state.users.find((u) => u.id === sessionUserId) || null;
    if (fromState) return fromState;
    if (sessionUserSnapshot && sessionUserSnapshot.id === sessionUserId) return sessionUserSnapshot;
    return null;
  }, [state.users, sessionUserId, sessionUserSnapshot]);
  const normalizedRole = normalizeRole(currentUser?.role);
  const isAdmin = normalizedRole === "admin";
  const isSupervisor = normalizedRole === "supervisor";
  const canSeeAdminUI = isAdmin;

  useEffect(() => setMounted(true), []);

  // connect Supabase error handler (to surface failures like 401 / RLS policy failures)
  useEffect(() => {
    setSupabaseErrorHandler(setSupabaseError);
    return () => setSupabaseErrorHandler(null);
  }, []);

  // load session user
  useEffect(() => {
    if (!mounted) return;
    try {
      setSessionUserId(sessionStorage.getItem("dsw_user_id"));
      const raw = sessionStorage.getItem("dsw_user_snapshot");
      setSessionUserSnapshot(raw ? JSON.parse(raw) : null);
    } catch {}
  }, [mounted]);

  // Keep the snapshot fresh whenever the authoritative user row is available.
  useEffect(() => {
    if (!sessionUserId) return;
    const user = state.users.find((u) => u.id === sessionUserId);
    if (!user) return;
    const snapshot = { id: user.id, name: user.name, role: user.role };
    setSessionUserSnapshot(snapshot);
    try {
      sessionStorage.setItem("dsw_user_snapshot", JSON.stringify(snapshot));
    } catch {}
  }, [state.users, sessionUserId]);

  // initial fetch + realtime subscriptions
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

      // If the DB has never been seeded (e.g. fresh localStorage), ensure the default login user exists.
      if (!users || users.length === 0) {
        console.warn("No users found in DB — seeding default users for local dev.");
        users = DEFAULT_DB.users;
        await sbUpsert("users", users);
      }

      if (!alive) return;
      setState((prev) => ({ ...prev, ...normalizeFromDB({ users, staff, clients, shifts }) }));
    }

    loadAll().catch((e) => console.error(e));

    // Setup realtime subscriptions only when Supabase is configured
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
        } catch (e) {}
      };
    }

    return () => {
      alive = false;
    };
  }, [mounted]);

  function loginAs(userId) {
    const user = state.users.find((u) => u.id === userId) || null;
    try {
      sessionStorage.setItem("dsw_user_id", userId);
      if (user) {
        const snapshot = { id: user.id, name: user.name, role: user.role };
        sessionStorage.setItem("dsw_user_snapshot", JSON.stringify(snapshot));
        setSessionUserSnapshot(snapshot);
      }
    } catch {}
    setSessionUserId(userId);
  }

  function logout() {
    try {
      sessionStorage.removeItem("dsw_user_id");
      sessionStorage.removeItem("dsw_user_snapshot");
    } catch {}
    setSessionUserId(null);
    setSessionUserSnapshot(null);
  }

  async function createAdminUser({ id, name, pin }) {
    const row = { id, name, role: "admin", pin };
    await sbUpsert("users", [row]);
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
  }, [state.clients, state.settings?.includeUnassignedForSupervisors, isAdmin, currentUser?.id]);

  const manageableClientIds = useMemo(() => {
    return new Set((visibleClients || []).map((c) => c.id));
  }, [visibleClients]);

  function canManageClientId(clientId) {
    if (isAdmin) return true;
    return manageableClientIds.has(clientId);
  }

  const shiftsInSelectedPeriod = useMemo(() => {
    if (!selectedPeriodWindow) return [];
    return (state.shifts || []).filter((sh) => {
      return overlapsWindow(sh.startISO, sh.endISO, selectedPeriodWindow.startISO, selectedPeriodWindow.endExclusiveISO);
    });
  }, [state.shifts, selectedPeriodWindow]);

  const periodClientHours = useMemo(() => {
    const byClient = {};
    if (!selectedPeriodWindow) return byClient;
    for (const sh of shiftsInSelectedPeriod) {
      const id = sh.clientId;
      if (!id) continue;
      if (!byClient[id]) byClient[id] = { totalMin: 0, dayMin: 0, nightMin: 0 };
      const { totalMin, dayMin, nightMin } = splitDayNightMinutesInWindow(
        sh.startISO,
        sh.endISO,
        selectedPeriodWindow.startISO,
        selectedPeriodWindow.endExclusiveISO
      );
      byClient[id].totalMin += totalMin;
      byClient[id].dayMin += dayMin;
      byClient[id].nightMin += nightMin;
    }
    return byClient;
  }, [shiftsInSelectedPeriod, selectedPeriodWindow]);

  const staffPeriodMinutesMap = useMemo(() => {
    const out = {};
    for (const st of state.staff || []) {
      out[st.id] = selectedPeriodWindow
        ? staffMinutesDedupInWindow(shiftsInSelectedPeriod, st.id, selectedPeriodWindow.startISO, selectedPeriodWindow.endExclusiveISO)
        : 0;
    }
    return out;
  }, [state.staff, shiftsInSelectedPeriod, selectedPeriodWindow]);

  const staffSharedSupportMinutesMap = useMemo(() => {
    if (!selectedPeriodWindow) return {};
    return getSharedSupportMinutesByStaffInWindow(
      shiftsInSelectedPeriod,
      state.staff || [],
      selectedPeriodWindow.startISO,
      selectedPeriodWindow.endExclusiveISO
    );
  }, [state.staff, shiftsInSelectedPeriod, selectedPeriodWindow]);

  const payrollBucketKeys = useMemo(() => {
    const keys = Array.from(
      new Set(
        (shiftsInSelectedPeriod || [])
          .map((sh) => getPayrollBucketStartKey(sh.startISO, payrollStartDate))
          .filter(Boolean)
      )
    ).sort();
    if (!keys.length && payrollStartDate) keys.push(payrollStartDate);
    return keys;
  }, [shiftsInSelectedPeriod, payrollStartDate]);

  const staffPayrollBucketMinutesMap = useMemo(() => {
    return payrollBucketKeys.reduce((acc, bucketKey) => {
      acc[bucketKey] = getStaffHoursMapForBucket(shiftsInSelectedPeriod, state.staff || [], bucketKey);
      return acc;
    }, {});
  }, [payrollBucketKeys, shiftsInSelectedPeriod, state.staff]);

  const staffOtMinutesByPeriod = useMemo(() => {
    const out = {};
    for (const st of state.staff || []) {
      out[st.id] = payrollBucketKeys.reduce((sum, bucketKey) => {
        const bucketMinutes = staffPayrollBucketMinutesMap[bucketKey]?.[st.id] || 0;
        return sum + Math.max(0, bucketMinutes - OT_THRESHOLD_MIN);
      }, 0);
    }
    return out;
  }, [state.staff, payrollBucketKeys, staffPayrollBucketMinutesMap]);

  const crossWeekConsecutiveProtection = !!state.settings?.crossWeekConsecutiveProtection;
  const maxConsecutiveDays = Math.max(1, Number(state.settings?.maxConsecutiveDays) || 6);
  const [staffHoursSearch, setStaffHoursSearch] = useState("");
  const [staffHoursFilter, setStaffHoursFilter] = useState("worked"); // all | worked | ot
  const [clientHoursSearch, setClientHoursSearch] = useState("");
  const [showAllClientHours, setShowAllClientHours] = useState(false);

  // Draft shift form (now includes Shared Support)
  const [shiftDraft, setShiftDraft] = useState({
    clientId: "",
    clientId2: "",
    clientId3: "",
    staffId: "",
    startDate: payrollStartDate,
    startTime: "07:00",
    endDate: payrollFinishDate,
    endTime: "15:00",
    staffingType: "single",
    isShared: false,
    sharedGroupId: "",
  });
  const [extraShiftRows, setExtraShiftRows] = useState([]);
  const [shiftRowErrors, setShiftRowErrors] = useState({});

  function createShiftRowDraft(defaults = {}) {
    return normalizeShiftDraftDates({
      staffId: "",
      startDate: payrollStartDate,
      startTime: "07:00",
      endDate: payrollStartDate,
      endTime: "15:00",
      staffingType: "single",
      isShared: false,
      clientId2: "",
      clientId3: "",
      sharedGroupId: "",
      ...defaults,
    });
  }

  function clearShiftRowError(rowKey) {
    setShiftRowErrors((prev) => {
      if (!prev[rowKey]) return prev;
      const next = { ...prev };
      delete next[rowKey];
      return next;
    });
  }

  function updateExtraShiftRow(index, updater) {
    setExtraShiftRows((prev) => prev.map((row, rowIndex) => {
      if (rowIndex !== index) return row;
      const nextRow = typeof updater === "function" ? updater(row) : { ...row, ...updater };
      return normalizeShiftDraftDates(nextRow);
    }));
    clearShiftRowError(`extra_${index}`);
  }

  function addShiftRow() {
    setExtraShiftRows((prev) => [
      ...prev,
      createShiftRowDraft({
        startDate: shiftDraft.startDate,
        startTime: shiftDraft.startTime,
        endDate: shiftDraft.endDate,
        endTime: shiftDraft.endTime,
        staffingType: shiftDraft.staffingType,
        isShared: shiftDraft.isShared,
      }),
    ]);
  }

  function removeShiftRow(index) {
    setExtraShiftRows((prev) => prev.filter((_, rowIndex) => rowIndex !== index));
    setShiftRowErrors({});
  }

  const shiftDraftStaffingType = useMemo(
    () => normalizeDraftStaffingType(shiftDraft.staffingType || (shiftDraft.isShared ? "shared2" : "single")),
    [shiftDraft.staffingType, shiftDraft.isShared]
  );
  const draftIsSharedSupport = shiftDraftStaffingType !== "single";

  const draftPayrollBucketKey = useMemo(
    () => getPayrollBucketStartKey(shiftDraft.startDate || payrollStartDate, payrollStartDate) || payrollStartDate,
    [shiftDraft.startDate, payrollStartDate]
  );

  const staffDraftBucketMinutesMap = useMemo(
    () => getStaffHoursMapForBucket(state.shifts || [], state.staff || [], draftPayrollBucketKey),
    [state.shifts, state.staff, draftPayrollBucketKey]
  );

  // Auto-suggest staff for shift
  const suggestedStaff = useMemo(() => {
    const { clientId, startDate, startTime, endDate, endTime } = shiftDraft;
    if (!clientId || !startDate || !startTime || !endDate || !endTime) return null;
    const startISO = toISO(startDate, startTime);
    const endISO = toISO(endDate, endTime);
    const candidates = (state.staff || []).filter((s) => s.active !== false);
    let best = null;
    let bestScore = Infinity;
    for (const st of candidates) {
      // Check for conflicts
      const hasConflict = (state.shifts || []).some((sh) =>
        sh.staffId === st.id && overlaps(sh.startISO, sh.endISO, startISO, endISO)
      );
      if (hasConflict) continue;

      const projectedStreak = projectedConsecutiveStreak({
        allShifts: state.shifts || [],
        staffId: st.id,
        weekStartDate,
        weekEndDate,
        crossWeekProtection: crossWeekConsecutiveProtection,
        candidateShift: {
          id: "candidate",
          staffId: st.id,
          startISO,
          endISO,
        },
      });
      if (projectedStreak > maxConsecutiveDays) continue;
      // Compute OT after this shift
      const min = staffDraftBucketMinutesMap[st.id] || 0;
      const addMin = minutesBetweenISO(startISO, endISO);
      const afterMin = min + addMin;
      const ot = Math.max(0, afterMin - OT_THRESHOLD_MIN);
      // Prefer staff with least OT, then least total minutes
      const score = ot * 10000 + afterMin;
      if (score < bestScore) {
        best = st;
        bestScore = score;
      }
    }
    return best;
  }, [
    shiftDraft,
    state.staff,
    state.shifts,
    staffDraftBucketMinutesMap,
    weekStartDate,
    weekEndDate,
    crossWeekConsecutiveProtection,
    maxConsecutiveDays,
  ]);

  // 24-Hour Builder UI
  const [builderOpen, setBuilderOpen] = useState(false);
  const [builderClientId, setBuilderClientId] = useState("");
  const [builderTemplate, setBuilderTemplate] = useState("2x12");
  const [builderScheduleSource, setBuilderScheduleSource] = useState("template"); // template | client | custom
  const [builderCustomTemplate, setBuilderCustomTemplate] = useState("07:00-15:00\n15:00-23:00\n23:00-07:00");
  const [builderBlockAssignments, setBuilderBlockAssignments] = useState({});
  const [builderSummary, setBuilderSummary] = useState(null);
  const clientSchedule = useMemo(() => {
    return builderClientId ? loadClientSchedule(builderClientId) : null;
  }, [builderClientId]);
  const builderClient = useMemo(
    () => (state.clients || []).find((c) => c.id === builderClientId) || null,
    [state.clients, builderClientId]
  );
  const activeStaff = useMemo(
    () => (state.staff || []).filter((s) => s.active !== false),
    [state.staff]
  );

  const builderShiftInfo = useMemo(() => {
    try {
      if (builderScheduleSource === "client") {
        const shifts = clientSchedule?.shifts || [];
        return {
          shifts,
          error: shifts.length ? "" : "No saved schedule for this client.",
        };
      }

      if (builderScheduleSource === "custom") {
        return { shifts: parseShiftPattern(builderCustomTemplate), error: "" };
      }

      const templateShifts =
        builderTemplate === "2x12"
          ? [
              { start: "07:00", end: "19:00" },
              { start: "19:00", end: "07:00" },
            ]
          : [
              { start: "07:00", end: "15:00" },
              { start: "15:00", end: "23:00" },
              { start: "23:00", end: "07:00" },
            ];
      return { shifts: templateShifts, error: "" };
    } catch (e) {
      return { shifts: [], error: e?.message || "Invalid schedule format." };
    }
  }, [builderScheduleSource, builderTemplate, builderCustomTemplate, clientSchedule]);

  const builderClientAssignedStaffIds = useMemo(() => {
    if (!builderClient) return [];
    return parseAssignedStaffIds(builderClient.assignedStaffIds ?? builderClient.assigned_staff_ids);
  }, [builderClient]);

  const builderUsesAssignedPool = builderClientAssignedStaffIds.length > 0;
  const builderAssignedStaffIdSet = useMemo(
    () => new Set(builderClientAssignedStaffIds),
    [builderClientAssignedStaffIds]
  );
  const builderStaffPool = useMemo(() => activeStaff, [activeStaff]);

  const previousPayrollRangeRef = useRef({ start: payrollStartDate, finish: payrollFinishDate });

  // keep shift draft aligned with the selected payroll range unless the user has manually overridden it
  useEffect(() => {
    const previous = previousPayrollRangeRef.current;
    setShiftDraft((p) => {
      const next = { ...p };
      if (!p.startDate || p.startDate === previous.start) next.startDate = payrollStartDate;
      if (!p.endDate || p.endDate === previous.finish || p.endDate === previous.start) next.endDate = payrollFinishDate;
      return next;
    });
    setExtraShiftRows((rows) => rows.map((row) => {
      const next = { ...row };
      if (!row.startDate || row.startDate === previous.start) next.startDate = payrollStartDate;
      if (!row.endDate || row.endDate === previous.finish || row.endDate === previous.start) next.endDate = payrollFinishDate;
      return normalizeShiftDraftDates(next);
    }));
    previousPayrollRangeRef.current = { start: payrollStartDate, finish: payrollFinishDate };
  }, [payrollStartDate, payrollFinishDate]);

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

  function resetPrimaryShiftDraft() {
    setShiftDraft((prev) => createShiftRowDraft({ clientId: prev.clientId || "" }));
  }

  async function prepareRowsForShiftDraft({ draft, commonClientId, planned = [], rowLabel }) {
    const clientId = commonClientId || draft.clientId;
    const { clientId2, clientId3, staffId, startDate, startTime, endDate, endTime } = draft;
    const staffingType = normalizeDraftStaffingType(draft.staffingType || (draft.isShared ? "shared2" : "single"));
    const isShared = staffingType !== "single";
    const extraClientIds = staffingType === "shared3"
      ? [clientId2, clientId3]
      : staffingType === "shared2"
        ? [clientId2]
        : [];
    const selectedClientIds = [clientId, ...extraClientIds].filter(Boolean);
    const errors = [];

    if (!clientId) errors.push("Pick a client at the top of the form.");
    if (!staffId) errors.push("Pick a staff member.");
    if (!startDate || !startTime || !endDate || !endTime) errors.push("Start and end date/time are required.");

    if (staffingType === "shared2" && !clientId2) {
      errors.push("Client 2 is required for 2-to-1 staffing.");
    }
    if (staffingType === "shared3" && (!clientId2 || !clientId3)) {
      errors.push("Client 2 and Client 3 are required for 3-to-1 staffing.");
    }
    if (selectedClientIds.length && new Set(selectedClientIds).size !== selectedClientIds.length) {
      errors.push("All selected clients must be different.");
    }
    if (clientId && !canManageClientId(clientId)) {
      errors.push("You can only create shifts for your assigned clients.");
    }
    for (const sharedClientId of extraClientIds) {
      if (sharedClientId && !canManageClientId(sharedClientId)) {
        errors.push("You can only create shared shifts for your assigned clients.");
      }
    }
    if (errors.length) return { errors, rows: [], planned };

    const shouldSplitDaily = shouldSplitIntoDailyShifts(startDate, endDate, startTime, endTime);

    let windows = [];
    if (shouldSplitDaily) {
      windows = buildSeparateDailyShifts(startDate, endDate, startTime, endTime);
    } else {
      const startISO = toISO(startDate, startTime);
      let endISO = toISO(endDate, endTime);

      if (new Date(endISO) <= new Date(startISO) && startDate === endDate) {
        const nextDay = addDays(new Date(`${startDate}T00:00:00`), 1);
        endISO = `${isoLocal(nextDay).slice(0, 10)}T${endTime}:00`;
      }

      if (new Date(endISO) <= new Date(startISO)) {
        return { errors: ["End must be after start."], rows: [], planned };
      }
      windows = [{ startISO, endISO, dateStr: startDate }];
    }

    if (!windows.length) {
      return { errors: ["No valid shift windows were generated for this row."], rows: [], planned };
    }

    const sharedGroupBase = isShared
      ? (String(draft.sharedGroupId || "").trim() || `SS-${Date.now().toString().slice(-6)}`)
      : "";

    const createdBy = currentUser?.id || "unknown";
    const rows = [];
    const nextPlanned = [...planned];
    const projectedMinutesByBucket = {};

    for (let idx = 0; idx < windows.length; idx++) {
      const { startISO, endISO } = windows[idx];
      const payrollBucketKey = getPayrollBucketStartKey(startISO, payrollStartDate) || payrollStartDate;
      const sharedGroupId = isShared
        ? (windows.length > 1 ? `${sharedGroupBase}-${startISO.slice(0, 10)}` : sharedGroupBase)
        : "";

      const conflicts = await findStaffConflictsDB({ staffId, startISO, endISO });
      const localConflicts = nextPlanned.filter((p) => overlaps(p.startISO, p.endISO, startISO, endISO));
      const localAsDbShape = localConflicts.map((p) => ({
        ...p,
        clientId,
        isShared: !!isShared,
        sharedGroupId,
      }));

      const illegalConflicts = [...conflicts, ...localAsDbShape].filter((c) => {
        if (!isShared) return true;
        return !(
          c.isShared
          && c.sharedGroupId === sharedGroupId
          && c.startISO === startISO
          && c.endISO === endISO
        );
      });

      if (illegalConflicts.length) {
        const first = illegalConflicts[0];
        const conflictClient = (state.clients || []).find((x) => x.id === first.clientId);
        const sup = (state.users || []).find((u) => u.id === (conflictClient?.supervisorId || ""));
        const message =
          `${rowLabel}: conflict with ${conflictClient?.name || "Unknown"}` +
          ` (${sup ? sup.name : "Unassigned"})` +
          ` at ${formatShiftDateTimeFromISO(first.startISO)} → ${formatShiftDateTimeFromISO(first.endISO)}.`;
        if (state.settings?.hardStopConflicts) {
          return { errors: [message], rows: [], planned };
        }
        if (!confirm(`${message}\n\nContinue anyway?`)) {
          return { errors: [message], rows: [], planned };
        }
      }

      const workedDaysStreak = projectedConsecutiveStreak({
        allShifts: [...(state.shifts || []), ...nextPlanned],
        staffId,
        weekStartDate,
        weekEndDate,
        crossWeekProtection: crossWeekConsecutiveProtection,
        candidateShift: {
          id: `candidate_${rowLabel}_${idx}`,
          staffId,
          startISO,
          endISO,
        },
      });
      if (workedDaysStreak > maxConsecutiveDays) {
        const message =
          `${rowLabel}: projected consecutive days would be ${workedDaysStreak} ` +
          `(max ${maxConsecutiveDays}) for ${formatShiftDateTimeFromISO(startISO)} → ${formatShiftDateTimeFromISO(endISO)}.`;
        if (state.settings?.hardStopConflicts) {
          return { errors: [message], rows: [], planned };
        }
        if (!confirm(`${message}\n\nContinue anyway?`)) {
          return { errors: [message], rows: [], planned };
        }
      }

      if (wouldExceed16HoursIn24(staffId, startISO, endISO, [...(state.shifts || []), ...nextPlanned])) {
        return {
          errors: [`${rowLabel}: this staff would exceed 16 hours in a 24-hour period.`],
          rows: [],
          planned,
        };
      }

      const currentBucketMinutes = projectedMinutesByBucket[payrollBucketKey]
        ?? getStaffHoursMapForBucket([...(state.shifts || []), ...nextPlanned], [{ id: staffId }], payrollBucketKey)[staffId]
        ?? 0;
      const shiftMinutes = minutesBetweenISO(startISO, endISO);
      const afterMin = currentBucketMinutes + shiftMinutes;
      const otMin = Math.max(0, afterMin - OT_THRESHOLD_MIN);
      if (otMin > 0 && !confirm(`${rowLabel}: this shift creates overtime (${fmtHoursFromMin(otMin)}).\n\nContinue?`)) {
        return { errors: [`${rowLabel}: overtime was not approved.`], rows: [], planned };
      }

      projectedMinutesByBucket[payrollBucketKey] = afterMin;
      nextPlanned.push({ id: `planned_${rowLabel}_${idx}`, staffId, startISO, endISO });

      for (const selectedClientId of selectedClientIds) {
        rows.push({
          id: uid("sh"),
          client_id: selectedClientId,
          staff_id: staffId,
          start_iso: startISO,
          end_iso: endISO,
          created_by: createdBy,
          is_shared: !!isShared,
          shared_group_id: sharedGroupId,
        });
      }
    }

    return { errors: [], rows, planned: nextPlanned };
  }

  async function saveShiftDraftEntries(entries, { keepSavedFailures = false } = {}) {
    const commonClientId = shiftDraft.clientId;
    const nextErrors = {};
    const rowsToSave = [];
    let planned = [];

    for (const entry of entries) {
      const result = await prepareRowsForShiftDraft({
        draft: entry.draft,
        commonClientId,
        planned,
        rowLabel: entry.label,
      });
      if (result.errors.length) {
        nextErrors[entry.key] = result.errors;
        continue;
      }
      rowsToSave.push(...result.rows);
      planned = result.planned;
    }

    if (!rowsToSave.length) {
      setShiftRowErrors(nextErrors);
      return { saved: 0, errors: nextErrors };
    }

    await sbUpsert("shifts", rowsToSave);
    await refreshState(setState);

    if (!nextErrors.primary) {
      resetPrimaryShiftDraft();
    }

    if (keepSavedFailures) {
      const failedExtraEntries = entries.filter((entry) => entry.key.startsWith("extra_") && nextErrors[entry.key]);
      const remappedErrors = {};
      if (nextErrors.primary) remappedErrors.primary = nextErrors.primary;
      failedExtraEntries.forEach((entry, index) => {
        remappedErrors[`extra_${index}`] = nextErrors[entry.key];
      });
      setExtraShiftRows(failedExtraEntries.map((entry) => entry.draft));
      setShiftRowErrors(remappedErrors);
    } else {
      setExtraShiftRows([]);
      setShiftRowErrors(nextErrors);
    }

    return { saved: rowsToSave.length, errors: nextErrors };
  }

  async function runBuilder() {
    if (!builderClientId) return alert("Pick a client for the builder.");
    if (!canManageClientId(builderClientId)) {
      return alert("You can only manage schedules for your assigned clients.");
    }
    const client = (state.clients || []).find((c) => c.id === builderClientId);
    if (!client) return alert("Selected client was not found.");

    // Determine shift definitions based on selected source
    const shiftsDef = builderShiftInfo.shifts;
    if (builderShiftInfo.error) return alert(builderShiftInfo.error);
    if (!shiftsDef.length) return alert("No shift blocks found for the selected schedule source.");

    const { rows, generatedShifts } = createShiftRowsFromTemplate({
      clientId: client.id,
      rangeStartDate: payrollStartDate,
      rangeFinishDate: payrollFinishDate,
      shiftsDef,
      assignments: builderBlockAssignments,
      createdBy: currentUser?.id || "builder",
    });

    if (!rows.length) return alert("No shifts were generated from the selected template.");

    await sbUpsert("shifts", rows);
    await refreshState(setState);

    const summary = analyzeWeeklyStaffingNeeds({
      existingShifts: state.shifts || [],
      generatedShifts,
      staffList: activeStaff,
      payrollStartDate,
      payrollFinishDate,
    });

    setBuilderSummary(summary);
    setBuilderOpen(false);

    const summaryText = [
      `Created ${summary.totalShiftsCreated} shifts.`,
      `Total scheduled hours: ${fmtHoursFromMin(summary.totalScheduledMinutes)}.`,
      `Assigned staff hours: ${fmtHoursFromMin(summary.assignedScheduledMinutes)}.`,
      `Open hours: ${fmtHoursFromMin(summary.unassignedHours)}.`,
      `Minimum staff required at 40h max: ${summary.minimumStaffRequired}.`,
      `Current usable staff: ${summary.currentUsableStaff}.`,
      `Assigned: ${summary.assignedShifts}.`,
      `Unassigned: ${summary.unassignedShifts}.`,
      `Staff at 40h: ${summary.staffAt40Count}.`,
      `Staff over 40h: ${summary.staffOver40Count}.`,
      `${summary.currentStaffingEnough ? "Current staffing is enough." : "Current staffing is not enough."}`,
      `Additional staff needed: ${summary.additionalStaffNeeded}.`,
    ].join(" ");

    alert(summaryText);
  }

  function getBuilderAssignmentValue(slotKey) {
    return builderBlockAssignments[slotKey] || "";
  }

  function setBuilderAssignment(slotKey, staffId) {
    setBuilderBlockAssignments((prev) => {
      if (!staffId) {
        const next = { ...prev };
        delete next[slotKey];
        return next;
      }
      return {
        ...prev,
        [slotKey]: staffId,
      };
    });
  }

  // Cross-supervisor (global) staff conflict check
  async function findStaffConflictsDB({ staffId, startISO, endISO }) {
    // Use sbSelect which supports Supabase or local fallback
    const rows = await sbSelect("shifts");
    const all = (rows || [])
      .map((sh) => {
        const normalizedStartISO = normalizeDateTimeISO(sh.start_iso || sh.startISO);
        const normalizedEndISO = normalizeDateTimeISO(sh.end_iso || sh.endISO);
        if (!normalizedStartISO || !normalizedEndISO) return null;
        return {
          id: sh.id,
          staffId: sh.staff_id || sh.staffId,
          clientId: sh.client_id || sh.clientId,
          startISO: normalizedStartISO,
          endISO: normalizedEndISO,
          isShared: !!(sh.is_shared || sh.isShared),
          sharedGroupId: sh.shared_group_id || sh.sharedGroupId || "",
        };
      })
      .filter(Boolean);

    return all.filter((sh) => sh.staffId === staffId && overlaps(sh.startISO, sh.endISO, startISO, endISO));
  }

  async function addShift() {
    clearShiftRowError("primary");
    const result = await saveShiftDraftEntries([
      { key: "primary", draft: shiftDraft, label: "Shift row 1" },
    ]);
    if (result.saved === 0 && result.errors.primary?.length) {
      alert(result.errors.primary.join("\n"));
    }
  }

  async function saveAllShifts() {
    clearShiftRowError("primary");
    const entries = [
      { key: "primary", draft: shiftDraft, label: "Shift row 1" },
      ...extraShiftRows.map((row, index) => ({
        key: `extra_${index}`,
        draft: row,
        label: `Shift row ${index + 2}`,
      })),
    ];
    const result = await saveShiftDraftEntries(entries, { keepSavedFailures: true });
    if (result.saved > 0 && Object.keys(result.errors).length > 0) {
      alert(`Saved ${result.saved} shift record(s). Some rows still need attention.`);
      return;
    }
    if (result.saved > 0) {
      alert(`Saved ${result.saved} shift record(s).`);
      return;
    }
    alert("No shifts were saved. Check the row errors and try again.");
  }

  async function deleteShift(id) {
    const allShifts = await sbSelect("shifts");
    const target = (allShifts || []).find((sh) => sh.id === id);
    const targetClientId = target?.client_id || target?.clientId || "";
    if (!canManageClientId(targetClientId)) {
      return alert("You can only delete shifts for your assigned clients.");
    }
    const sharedGroupId = target?.shared_group_id || target?.sharedGroupId || "";
    const idsToDelete = sharedGroupId
      ? (allShifts || [])
          .filter((sh) => (sh.shared_group_id || sh.sharedGroupId || "") === sharedGroupId)
          .map((sh) => sh.id)
      : [id];

    const uniqueIds = Array.from(new Set(idsToDelete.length ? idsToDelete : [id]));
    if (
      !confirm(
        uniqueIds.length > 1
          ? `Delete this shared shift group (${uniqueIds.length} linked shifts)?`
          : "Delete this shift?"
      )
    ) {
      return;
    }

    for (const shiftId of uniqueIds) {
      await sbDelete("shifts", shiftId);
    }
    await refreshState(setState);
  }

  // Admin: drafts
  const [staffDraftName, setStaffDraftName] = useState("");
  const createEmptyClientDraft = () => ({
    id: "",
    name: "",
    supervisorId: "",
    coverageStart: "07:00",
    coverageEnd: "23:00",
    weeklyHours: 40,
    assignedStaffIds: [],
    is24Hour: false,
    active: true,
  });
  const [clientDraft, setClientDraft] = useState(() => createEmptyClientDraft());
  const lastEditedClientIdRef = useRef(null);
  const [isSavingClient, setIsSavingClient] = useState(false);
  const [userDraft, setUserDraft] = useState({ id: "", name: "", role: "supervisor", pin: "" });

  function resetClientDraft() {
    setClientDraft(createEmptyClientDraft());
  }

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
    if (!canSeeAdminUI) return alert("Only admins can manage clients in this section.");
    if (isSavingClient) return;
    const name = clientDraft.name.trim();
    if (!name) return alert("Client name required.");
    const isEditingExisting = !!clientDraft.id;
    const row = {
      id: clientDraft.id || uid("cl"),
      name,
      supervisor_id: clientDraft.supervisorId || null,
      coverage_start: clientDraft.coverageStart || "07:00",
      coverage_end: clientDraft.coverageEnd || "23:00",
      // Canonical DB column for client weekly hours
      hours_allotted: Number(clientDraft.weeklyHours) || 40,
      assigned_staff_ids: serializeAssignedStaffIds(clientDraft.assignedStaffIds || []),
      is_24_hour: !!clientDraft.is24Hour,
      active: clientDraft.active !== false,
    };
    try {
      setIsSavingClient(true);
      if (isEditingExisting) lastEditedClientIdRef.current = row.id;
      await sbUpsert("clients", [row]);
      await refreshState(setState);
      resetClientDraft();

      // UX: after editing, jump back to that client row in the list.
      if (isEditingExisting) {
        requestAnimationFrame(() => {
          const el = document.getElementById(`client-row-${lastEditedClientIdRef.current}`);
          if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
        });
      }
    } catch (e) {
      console.error("saveClient failed", e);
      alert("Unable to save client. Please try again.");
    } finally {
      setIsSavingClient(false);
    }
  }

  async function handleSaveClientClick(e) {
    e.preventDefault();
    await saveClient();
  }

  async function deleteClient(id) {
    if (!canSeeAdminUI) return alert("Only admins can delete clients.");
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
    if (!canSeeAdminUI) return alert("Only admins can manage users.");
    if (!userDraft.id.trim() || !userDraft.name.trim() || !userDraft.pin.trim()) {
      return alert("User id, name, and PIN required.");
    }
    const row = {
      id: userDraft.id.trim(),
      name: userDraft.name.trim(),
      role: normalizeRole(userDraft.role) || "supervisor",
      pin: userDraft.pin.trim(),
    };
    await sbUpsert("users", [row]);
    await refreshState(setState);
    setUserDraft({ id: "", name: "", role: "supervisor", pin: "" });
  }

  async function deleteUser(id) {
    if (!canSeeAdminUI) return alert("Only admins can manage users.");
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
    { value: "hours", label: "Hours & OT" },
    // --- Client Profiles tab for users who can see clients ---
    ...(visibleClients.length > 0 ? [
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
  ];

  useEffect(() => {
    if (!tabs.some((t) => t.value === tab)) {
      setTab("schedule");
    }
  }, [tab, tabs]);

  // --- Client Profiles state ---
  const [selectedClientId, setSelectedClientId] = useState("");

  // Client profile access follows client visibility permissions.
  const allClients = useMemo(() => (visibleClients || []).filter((c) => c), [visibleClients]);

  // Memo: selected client object
  const selectedClient = useMemo(() => (allClients || []).find(c => c.id === selectedClientId) || null, [allClients, selectedClientId]);

  useEffect(() => {
    if (!selectedClientId) return;
    if (!allClients.some((c) => c.id === selectedClientId)) {
      setSelectedClientId("");
    }
  }, [selectedClientId, allClients]);

  useEffect(() => {
    if (!builderClientId) return;
    if (!canManageClientId(builderClientId)) {
      setBuilderClientId("");
    }
  }, [builderClientId, canSeeAdminUI, manageableClientIds]);

  // Memo: all shifts for selected client in selected week
  const selectedClientShifts = useMemo(() => {
    if (!selectedClientId) return [];
    if (!selectedPeriodWindow) return [];
    return (state.shifts || [])
      .filter(sh => sh.clientId === selectedClientId)
      .filter(sh => {
        return overlapsWindow(sh.startISO, sh.endISO, selectedPeriodWindow.startISO, selectedPeriodWindow.endExclusiveISO);
      })
      .sort((a, b) => new Date(a.startISO) - new Date(b.startISO));
  }, [state.shifts, selectedClientId, selectedPeriodWindow]);

  // Memo: unique staff assigned to this client in selected week, with total minutes
  const selectedClientStaffSummary = useMemo(() => {
    if (!selectedClientShifts.length) return [];
    const staffMap = {};
    for (const sh of selectedClientShifts) {
      if (!sh.staffId) continue;
      if (!staffMap[sh.staffId]) staffMap[sh.staffId] = { staff: (state.staff || []).find(s => s.id === sh.staffId), min: 0 };
      staffMap[sh.staffId].min += selectedPeriodWindow
        ? splitShiftIntoWindowMinutes(sh.startISO, sh.endISO, selectedPeriodWindow.startISO, selectedPeriodWindow.endExclusiveISO)
        : 0;
    }
    return Object.values(staffMap).sort((a, b) => (a.staff?.name || "").localeCompare(b.staff?.name || ""));
  }, [selectedClientShifts, selectedPeriodWindow, state.staff]);

  // Memo: client payroll-period hours summary (total, day, night, remaining)
  const selectedClientWeekHours = useMemo(() => {
    let totalMin = 0, dayMin = 0, nightMin = 0;
    for (const sh of selectedClientShifts) {
      const { totalMin: t, dayMin: d, nightMin: n } = selectedPeriodWindow
        ? splitDayNightMinutesInWindow(sh.startISO, sh.endISO, selectedPeriodWindow.startISO, selectedPeriodWindow.endExclusiveISO)
        : { totalMin: 0, dayMin: 0, nightMin: 0 };
      totalMin += t; dayMin += d; nightMin += n;
    }
    const allottedMin = getMinutesForWeeklyHoursAcrossRange(selectedClient?.weeklyHours, selectedPeriodDayCount);
    const remainingMin = allottedMin - totalMin;
    return { totalMin, dayMin, nightMin, allottedMin, remainingMin };
  }, [selectedClientShifts, selectedClient, selectedPeriodDayCount, selectedPeriodWindow]);

  const selectedClientAssignedStaffIds = useMemo(() => {
    if (!selectedClientId) return [];
    return parseAssignedStaffIds(selectedClient?.assignedStaffIds ?? selectedClient?.assigned_staff_ids);
  }, [selectedClientId, selectedClient]);

  const selectedClientAssignedStaff = useMemo(() => {
    return selectedClientAssignedStaffIds
      .map((id) => (state.staff || []).find((s) => s.id === id))
      .filter(Boolean);
  }, [selectedClientAssignedStaffIds, state.staff]);

  const clientAssignedStaffIdSet = useMemo(() => {
    return new Set(selectedClientAssignedStaffIds);
  }, [selectedClientAssignedStaffIds]);

  const staffHoursRows = useMemo(() => {
    const q = staffHoursSearch.trim().toLowerCase();
    return (state.staff || [])
      .map((st) => {
        const min = staffPeriodMinutesMap[st.id] || 0;
        const sharedSupportMin = staffSharedSupportMinutesMap[st.id] || 0;
        const otMin = staffOtMinutesByPeriod[st.id] || 0;
        return { st, min, otMin, sharedSupportMin };
      })
      .filter(({ st, min, otMin, sharedSupportMin }) => {
        if (staffHoursFilter === "worked" && min <= 0) return false;
        if (staffHoursFilter === "ot" && otMin <= 0) return false;
        if (staffHoursFilter === "shared" && sharedSupportMin <= 0) return false;
        if (!q) return true;
        return String(st.name || "").toLowerCase().includes(q);
      })
      .sort((a, b) => b.min - a.min || String(a.st.name || "").localeCompare(String(b.st.name || "")));
  }, [state.staff, staffPeriodMinutesMap, staffOtMinutesByPeriod, staffSharedSupportMinutesMap, staffHoursSearch, staffHoursFilter]);

  const clientHoursRows = useMemo(() => {
    const q = clientHoursSearch.trim().toLowerCase();
    return (visibleClients || [])
      .map((c) => {
        const h = periodClientHours[c.id] || { totalMin: 0, dayMin: 0, nightMin: 0 };
        const allottedMin = getMinutesForWeeklyHoursAcrossRange(c.weeklyHours, selectedPeriodDayCount);
        const remainingMin = allottedMin - h.totalMin;
        return { c, h, allottedMin, remainingMin };
      })
      .filter(({ c, h, allottedMin }) => {
        if (!showAllClientHours && !(h.totalMin > 0 || allottedMin > 0)) return false;
        if (!q) return true;
        return String(c.name || "").toLowerCase().includes(q);
      })
      .sort((a, b) => b.h.totalMin - a.h.totalMin || String(a.c.name || "").localeCompare(String(b.c.name || "")));
  }, [visibleClients, periodClientHours, clientHoursSearch, selectedPeriodDayCount, showAllClientHours]);

  const hoursSummary = useMemo(() => {
    const staffWorking = (state.staff || []).filter((st) => (staffPeriodMinutesMap[st.id] || 0) > 0).length;
    const staffInOt = (state.staff || []).filter((st) => (staffOtMinutesByPeriod[st.id] || 0) > 0).length;
    const totalSharedSupportMin = (state.staff || []).reduce((sum, st) => sum + (staffSharedSupportMinutesMap[st.id] || 0), 0);
    const clientsWithHours = (visibleClients || []).filter((c) => (periodClientHours[c.id]?.totalMin || 0) > 0).length;
    const totalClientMin = (visibleClients || []).reduce((sum, c) => sum + (periodClientHours[c.id]?.totalMin || 0), 0);
    return { staffWorking, staffInOt, totalSharedSupportMin, clientsWithHours, totalClientMin };
  }, [state.staff, staffPeriodMinutesMap, staffOtMinutesByPeriod, staffSharedSupportMinutesMap, visibleClients, periodClientHours]);

  if (!mounted) return null;

  // If Supabase isn't configured we'll show a banner inside the UI and
  // fall back to localStorage for data persistence.

  if (!currentUser) {
    return <LoginScreen users={state.users} onLogin={loginAs} onCreateAdmin={createAdminUser} />;
  }

  const canSeeAllShifts = isAdmin || isSupervisor;
  const accessSummary = isAdmin
    ? "Admin access: global management + scheduling"
    : "Supervisor access: global schedule visibility, own-client management only";

  return (
    <div style={{ minHeight: "100vh", background: UI.bg, color: UI.text, padding: 10 }}>
      <div style={{ maxWidth: 1220, margin: "0 auto" }}>
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
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center", flexWrap: "wrap", paddingBottom: 2 }}>
          <div>
            <div style={{ fontSize: 22, fontWeight: 980, lineHeight: 1.12, letterSpacing: "0.01em" }}>DSW Scheduler</div>
            <div style={styles.tiny}>
              Logged in as <b>{currentUser.name}</b> ({currentUser.role})
            </div>
            <div style={{ ...styles.tiny, marginTop: 2 }}>
              <b>Access:</b> {accessSummary}
            </div>
          </div>

          <div className="no-print" style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button style={styles.btn2} onClick={saveAllNow}>Save</button>
            <button style={styles.btn2} onClick={logout}>Logout</button>
          </div>
        </div>

        <div className="no-print" style={{ marginTop: 4, display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "center", paddingBottom: 2 }}>
          <Tabs value={tab} onChange={setTab} tabs={tabs} />
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(140px, auto))", gap: 6, alignItems: "end" }}>
            <div>
              <div style={styles.tiny}>Payroll Start Date</div>
              <input
                style={{ ...styles.input, width: 150, padding: "7px 9px" }}
                type="date"
                value={payrollStartDate}
                onChange={(e) => setPayrollStartDate(e.target.value)}
              />
            </div>
            <div>
              <div style={styles.tiny}>Payroll Finish Date</div>
              <input
                style={{ ...styles.input, width: 150, padding: "7px 9px" }}
                type="date"
                value={payrollFinishDate}
                onChange={(e) => setPayrollFinishDate(e.target.value)}
              />
            </div>
            <div>
              <div style={styles.tiny}>Payroll Reference Date</div>
              <input
                style={{ ...styles.input, width: 150, padding: "7px 9px" }}
                type="date"
                value={payrollReferenceDate}
                onChange={(e) => setPayrollReferenceDate(e.target.value)}
              />
            </div>
            <button style={{ ...styles.btn2, height: 34 }} onClick={() => applyPayrollCycleFromReference()}>
              Auto-fill Cycle
            </button>
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

    <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(220px, 320px) 1fr", gap: 10, alignItems: "end" }}>
        <div>
          <div style={styles.tiny}>Client 1</div>
          <select
            style={styles.select}
            value={shiftDraft.clientId}
            onChange={(e) => {
              clearShiftRowError("primary");
              setShiftDraft((p) => ({
                ...p,
                clientId: e.target.value,
                clientId2: p.clientId2 === e.target.value ? "" : p.clientId2,
                clientId3: p.clientId3 === e.target.value ? "" : p.clientId3,
              }));
            }}
          >
            <option value="">Select…</option>
            {visibleClients.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
          <button type="button" style={styles.btn2} onClick={addShiftRow}>+ Add Shift Row</button>
          <button type="button" style={styles.btn2} onClick={saveAllShifts}>Save All Shifts</button>
          <button style={styles.btn} onClick={addShift}>Add Shift</button>
        </div>
      </div>

      {[{ key: "primary", draft: shiftDraft, isPrimary: true }, ...extraShiftRows.map((draft, index) => ({ key: `extra_${index}`, draft, index, isPrimary: false }))].map((entry, visualIndex) => {
        const rowDraft = entry.draft;
        const rowStaffingType = normalizeDraftStaffingType(rowDraft.staffingType || (rowDraft.isShared ? "shared2" : "single"));
        const rowIsSharedSupport = rowStaffingType !== "single";
        const rowErrors = shiftRowErrors[entry.key] || [];

        return (
          <div key={entry.key} style={{ ...styles.card, padding: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
              <div style={{ fontSize: 13, fontWeight: 900 }}>Shift Row {visualIndex + 1}</div>
              {!entry.isPrimary ? (
                <button type="button" style={{ ...styles.btnDanger, padding: "4px 8px", fontSize: 12 }} onClick={() => removeShiftRow(entry.index)}>
                  Remove Row
                </button>
              ) : null}
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "minmax(150px, 180px) minmax(200px, 1fr) minmax(220px, 1fr) minmax(220px, 1fr)", gap: 8 }}>
              <div>
                <div style={styles.tiny}>Staffing Type</div>
                <select
                  style={styles.select}
                  value={rowStaffingType}
                  onChange={(e) => {
                    const nextType = normalizeDraftStaffingType(e.target.value);
                    const updater = (p) => ({
                      ...p,
                      staffingType: nextType,
                      isShared: nextType !== "single",
                      clientId2: nextType === "single" ? "" : p.clientId2,
                      clientId3: nextType === "shared3" ? p.clientId3 : "",
                      sharedGroupId: nextType === "single" ? "" : p.sharedGroupId,
                    });
                    clearShiftRowError(entry.key);
                    if (entry.isPrimary) {
                      setShiftDraft((p) => updater(p));
                    } else {
                      updateExtraShiftRow(entry.index, updater);
                    }
                  }}
                >
                  <option value="single">Normal 1:1</option>
                  <option value="shared2">Shared Support 2:1</option>
                  <option value="shared3">Shared Support 3:1</option>
                </select>
              </div>

              <div>
                <div style={styles.tiny}>Staff</div>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <select
                    style={styles.select}
                    value={rowDraft.staffId}
                    onChange={(e) => {
                      clearShiftRowError(entry.key);
                      if (entry.isPrimary) {
                        setShiftDraft((p) => ({ ...p, staffId: e.target.value }));
                      } else {
                        updateExtraShiftRow(entry.index, { staffId: e.target.value });
                      }
                    }}
                  >
                    <option value="">Select…</option>
                    {entry.isPrimary && suggestedStaff ? (
                      <option value={suggestedStaff.id}>⭐ Suggested: {suggestedStaff.name}</option>
                    ) : null}
                    {(state.staff || []).filter((s) => !entry.isPrimary || !suggestedStaff || s.id !== suggestedStaff.id).map((s) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                  {entry.isPrimary && suggestedStaff && rowDraft.staffId !== suggestedStaff.id ? (
                    <button
                      type="button"
                      style={{ ...styles.btn2, padding: "2px 8px", fontSize: 12 }}
                      onClick={() => {
                        clearShiftRowError(entry.key);
                        setShiftDraft((p) => ({ ...p, staffId: suggestedStaff.id }));
                      }}
                    >
                      Suggest
                    </button>
                  ) : null}
                </div>
                {entry.isPrimary && suggestedStaff ? (
                  <div style={{ fontSize: 12, color: UI.accent, marginTop: 2 }}>
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
                    value={rowDraft.startDate}
                    onChange={(e) => {
                      clearShiftRowError(entry.key);
                      const updater = (p) => normalizeShiftDraftDates({ ...p, startDate: e.target.value });
                      if (entry.isPrimary) {
                        setShiftDraft((p) => updater(p));
                      } else {
                        updateExtraShiftRow(entry.index, updater);
                      }
                    }}
                  />
                  <input
                    style={styles.input}
                    type="time"
                    value={rowDraft.startTime}
                    onChange={(e) => {
                      clearShiftRowError(entry.key);
                      const updater = (p) => normalizeShiftDraftDates({ ...p, startTime: e.target.value });
                      if (entry.isPrimary) {
                        setShiftDraft((p) => updater(p));
                      } else {
                        updateExtraShiftRow(entry.index, updater);
                      }
                    }}
                  />
                </div>
              </div>

              <div>
                <div style={styles.tiny}>End</div>
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    style={styles.input}
                    type="date"
                    value={rowDraft.endDate}
                    onChange={(e) => {
                      clearShiftRowError(entry.key);
                      if (entry.isPrimary) {
                        setShiftDraft((p) => ({ ...p, endDate: e.target.value }));
                      } else {
                        updateExtraShiftRow(entry.index, { endDate: e.target.value });
                      }
                    }}
                  />
                  <input
                    style={styles.input}
                    type="time"
                    value={rowDraft.endTime}
                    onChange={(e) => {
                      clearShiftRowError(entry.key);
                      const updater = (p) => normalizeShiftDraftDates({ ...p, endTime: e.target.value });
                      if (entry.isPrimary) {
                        setShiftDraft((p) => updater(p));
                      } else {
                        updateExtraShiftRow(entry.index, updater);
                      }
                    }}
                  />
                </div>
                <div style={styles.tiny}>Auto bump end date if end time is earlier than start.</div>
              </div>
            </div>

            {rowIsSharedSupport ? (
              <div style={{ ...styles.grid4, gap: 8, marginTop: 8 }}>
                <div>
                  <div style={styles.tiny}>Client 2</div>
                  <select
                    style={styles.select}
                    value={rowDraft.clientId2 || ""}
                    onChange={(e) => {
                      clearShiftRowError(entry.key);
                      if (entry.isPrimary) {
                        setShiftDraft((p) => ({ ...p, clientId2: e.target.value }));
                      } else {
                        updateExtraShiftRow(entry.index, { clientId2: e.target.value });
                      }
                    }}
                  >
                    <option value="">Select…</option>
                    {visibleClients
                      .filter((c) => c.id !== shiftDraft.clientId && c.id !== rowDraft.clientId3)
                      .map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                  </select>
                </div>

                {rowStaffingType === "shared3" ? (
                  <div>
                    <div style={styles.tiny}>Client 3</div>
                    <select
                      style={styles.select}
                      value={rowDraft.clientId3 || ""}
                      onChange={(e) => {
                        clearShiftRowError(entry.key);
                        if (entry.isPrimary) {
                          setShiftDraft((p) => ({ ...p, clientId3: e.target.value }));
                        } else {
                          updateExtraShiftRow(entry.index, { clientId3: e.target.value });
                        }
                      }}
                    >
                      <option value="">Select…</option>
                      {visibleClients
                        .filter((c) => c.id !== shiftDraft.clientId && c.id !== rowDraft.clientId2)
                        .map((c) => (
                          <option key={c.id} value={c.id}>{c.name}</option>
                        ))}
                    </select>
                  </div>
                ) : null}

                <div>
                  <div style={styles.tiny}>Shared Group ID (optional)</div>
                  <input
                    style={styles.input}
                    value={rowDraft.sharedGroupId || ""}
                    onChange={(e) => {
                      clearShiftRowError(entry.key);
                      if (entry.isPrimary) {
                        setShiftDraft((p) => ({ ...p, sharedGroupId: e.target.value }));
                      } else {
                        updateExtraShiftRow(entry.index, { sharedGroupId: e.target.value });
                      }
                    }}
                    placeholder="Auto-generated if empty"
                  />
                </div>

                <div style={{ ...styles.tiny, alignSelf: "end" }}>
                  One staff + one time block is applied to each selected client while staff worked hours are deduped to count once.
                </div>
              </div>
            ) : null}

            {rowErrors.length ? (
              <div style={{ marginTop: 8, display: "grid", gap: 4 }}>
                {rowErrors.map((message) => (
                  <div key={message} style={{ ...styles.warn, marginTop: 0 }}>{message}</div>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>

    {builderOpen ? (
      <div style={{ position: "fixed", inset: 0, display: "grid", placeItems: "center", background: "rgba(31,41,51,0.28)", zIndex: 1300, padding: 14 }} className="no-print">
        <div style={{ width: "min(980px, 96vw)", maxHeight: "90vh", background: UI.panel, border: `1px solid ${UI.border}`, borderRadius: 14, display: "grid", gridTemplateRows: "auto minmax(0, 1fr) auto", overflow: "hidden", boxShadow: UI.shadowLg, position: "relative" }}>
          <div style={{ padding: "12px 14px 8px 14px", borderBottom: `1px solid ${UI.borderSoft}` }}>
          <h3 style={{ marginTop: 0 }}>24-Hour Builder</h3>
            <div style={styles.tiny}>
              {builderClientId
                ? (builderUsesAssignedPool
                    ? "Assigned client staff are available as options, but blank slots stay unassigned."
                    : "No client-specific staff saved. Assign staff manually or leave slots unassigned.")
                : "Pick a client to configure slot assignments."}
            </div>
          </div>

          <div style={{ padding: 14, overflowY: "auto", overflowX: "auto", display: "grid", gap: 10, position: "relative", zIndex: 1 }}>
            <div>
              <div style={styles.tiny}>Client</div>
              <select style={styles.select} value={builderClientId} onChange={(e) => setBuilderClientId(e.target.value)}>
                <option value="">Select…</option>
                {visibleClients.map((c) => (
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
              <div style={styles.tiny}>Payroll generation window</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(180px, 1fr))", gap: 8, marginTop: 4 }}>
                <div style={{ ...styles.shift, padding: 8 }}>
                  <div style={styles.tiny}>Payroll Start Date</div>
                  <div style={{ fontSize: 13, fontWeight: 900 }}>{payrollStartDate}</div>
                </div>
                <div style={{ ...styles.shift, padding: 8 }}>
                  <div style={styles.tiny}>Payroll Finish Date</div>
                  <div style={{ fontSize: 13, fontWeight: 900 }}>{payrollFinishDate}</div>
                </div>
              </div>
              <div style={{ ...styles.tiny, marginTop: 6 }}>
                Builder generation follows the selected payroll range exactly and creates separate daily shifts for each date in that range.
              </div>
            </div>

            <div>
              <div style={styles.tiny}>Optional slot assignments</div>
              <div style={{ ...styles.tiny, marginBottom: 6 }}>
                The builder creates every shift block exactly as entered. Only explicitly selected staff are assigned.
              </div>

              {builderShiftInfo.error ? (
                <div style={{ ...styles.warn, marginTop: 0 }}>{builderShiftInfo.error}</div>
              ) : null}

              {builderShiftInfo.shifts.length ? (
                <div style={{ display: "grid", gap: 8, position: "relative", zIndex: 5 }}>
                  {builderShiftInfo.shifts.map((block, blockIdx) => (
                    <div key={`${block.start}-${block.end}-${blockIdx}`} style={{ ...styles.card, padding: 10, position: "relative", zIndex: 6 }}>
                      <div style={{ fontSize: 12, fontWeight: 900, marginBottom: 6 }}>
                        Block {blockIdx + 1}: {formatTime12(block.start)} - {formatTime12(block.end)}
                      </div>
                      <div style={{ overflowX: "auto" }}>
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(130px, 1fr))", gap: 6, minWidth: 920 }}>
                        {WEEKDAY_NAMES.map((day, dayIdx) => {
                          const slotKey = `${dayIdx}_${blockIdx}`;
                          const selectId = `builder-slot-${dayIdx}-${blockIdx}`;
                          return (
                            <div key={slotKey} style={{ display: "flex", flexDirection: "column", minWidth: 120, position: "relative", zIndex: 7 }}>
                              <label htmlFor={selectId} style={{ fontSize: 11, opacity: 0.82, marginBottom: 2, cursor: "pointer" }}>{day}</label>
                              <select
                                id={selectId}
                                style={{ ...styles.select, position: "relative", zIndex: 8, pointerEvents: "auto", minHeight: 34 }}
                                value={getBuilderAssignmentValue(slotKey)}
                                onChange={(e) => setBuilderAssignment(slotKey, e.target.value)}
                              >
                                <option value="">Unassigned</option>
                                {builderStaffPool.map((s) => (
                                  <option key={s.id} value={s.id}>
                                    {builderAssignedStaffIdSet.has(s.id) ? `${s.name} (Assigned)` : s.name}
                                  </option>
                                ))}
                              </select>
                            </div>
                          );
                        })}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={styles.tiny}>No shift blocks loaded yet.</div>
              )}

              <div style={{ ...styles.tiny, marginTop: 8 }}>
                Assigned staff for this client: {builderClientAssignedStaffIds.length
                  ? builderClientAssignedStaffIds
                      .map((id) => activeStaff.find((s) => s.id === id)?.name || id)
                      .join(", ")
                  : "None selected"}
              </div>
            </div>

            {builderSummary ? (
              <div style={{ ...styles.card, padding: 10 }}>
                <div style={{ fontSize: 13, fontWeight: 900, marginBottom: 8 }}>Latest Builder Summary</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(140px, 1fr))", gap: 8 }}>
                  <div style={{ ...styles.shift, padding: 8 }}>
                    <div style={styles.tiny}>Total Shifts</div>
                    <div style={{ fontSize: 16, fontWeight: 900 }}>{builderSummary.totalShiftsCreated}</div>
                  </div>
                  <div style={{ ...styles.shift, padding: 8 }}>
                    <div style={styles.tiny}>Total Scheduled Hours</div>
                    <div style={{ fontSize: 16, fontWeight: 900 }}>{fmtHoursFromMin(builderSummary.totalScheduledMinutes)}</div>
                  </div>
                  <div style={{ ...styles.shift, padding: 8 }}>
                    <div style={styles.tiny}>Assigned Staff Hours</div>
                    <div style={{ fontSize: 16, fontWeight: 900 }}>{fmtHoursFromMin(builderSummary.assignedScheduledMinutes)}</div>
                  </div>
                  <div style={{ ...styles.shift, padding: 8 }}>
                    <div style={styles.tiny}>Open Hours</div>
                    <div style={{ fontSize: 16, fontWeight: 900 }}>{fmtHoursFromMin(builderSummary.unassignedHours)}</div>
                  </div>
                  <div style={{ ...styles.shift, padding: 8 }}>
                    <div style={styles.tiny}>Minimum Staff Required</div>
                    <div style={{ fontSize: 16, fontWeight: 900 }}>{builderSummary.minimumStaffRequired}</div>
                  </div>
                  <div style={{ ...styles.shift, padding: 8 }}>
                    <div style={styles.tiny}>Current Usable Staff</div>
                    <div style={{ fontSize: 16, fontWeight: 900 }}>{builderSummary.currentUsableStaff}</div>
                  </div>
                  <div style={{ ...styles.shift, padding: 8 }}>
                    <div style={styles.tiny}>Additional Staff Needed</div>
                    <div style={{ fontSize: 16, fontWeight: 900 }}>{builderSummary.additionalStaffNeeded}</div>
                  </div>
                  <div style={{ ...styles.shift, padding: 8 }}>
                    <div style={styles.tiny}>Staff At 40h</div>
                    <div style={{ fontSize: 16, fontWeight: 900 }}>{builderSummary.staffAt40Count}</div>
                  </div>
                  <div style={{ ...styles.shift, padding: 8 }}>
                    <div style={styles.tiny}>Staff Over 40h</div>
                    <div style={{ fontSize: 16, fontWeight: 900, color: builderSummary.staffOver40Count ? UI.danger : "inherit" }}>{builderSummary.staffOver40Count}</div>
                  </div>
                  <div style={{ ...styles.shift, padding: 8 }}>
                    <div style={styles.tiny}>Staffing Status</div>
                    <div style={{ fontSize: 16, fontWeight: 900, color: builderSummary.currentStaffingEnough ? "inherit" : UI.warning }}>
                      {builderSummary.currentStaffingEnough ? "Enough" : "Need more staff"}
                    </div>
                  </div>
                </div>

                <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
                  {builderSummary.weeklyBreakdown.map((week) => (
                    <div key={week.weekStart} style={{ ...styles.shift, padding: 8 }}>
                      <div style={{ fontSize: 12, fontWeight: 900, marginBottom: 4 }}>Payroll Week Starting {week.weekStart}</div>
                      <div style={styles.tiny}>
                        Total scheduled hours: {fmtHoursFromMin(week.totalScheduledMinutes)} | Assigned staff hours: {fmtHoursFromMin(week.assignedScheduledMinutes)} | Open hours: {fmtHoursFromMin(week.unassignedHours)}
                      </div>
                      <div style={{ ...styles.tiny, marginTop: 2 }}>
                        Minimum staff required to keep everyone at 40 hours max: {week.minimumStaffRequired} | Current usable staff: {week.currentUsableStaff} | Additional staff needed: {week.additionalStaffNeeded}
                      </div>
                      <div style={{ ...styles.tiny, marginTop: 2 }}>
                        Staffing status: {week.currentStaffingEnough ? "Current staffing is enough." : "Current staffing is not enough."}
                      </div>
                      <div style={{ ...styles.tiny, marginTop: 4 }}>
                        Staff at 40h: {week.staffAt40.length ? week.staffAt40.map((st) => st.name).join(", ") : "None"}
                      </div>
                      <div style={{ ...styles.tiny, marginTop: 2 }}>
                        Staff over 40h: {week.staffOver40.length ? week.staffOver40.map((st) => st.name).join(", ") : "None"}
                      </div>
                      <div style={styles.tableWrapCompact}>
                        <table className="app-table" style={styles.tableCompact}>
                          <thead>
                            <tr>
                              <th style={styles.thCompact}>Staff</th>
                              <th style={styles.thCompactNum}>Payroll Week Hours</th>
                            </tr>
                          </thead>
                          <tbody>
                            {week.staffHours.length ? week.staffHours.map((entry) => (
                              <tr key={`${week.weekStart}_${entry.id}`}>
                                <td style={styles.tdCompact}>{entry.name}</td>
                                <td style={styles.tdCompactNum}>{fmtHoursFromMin(entry.minutes)}</td>
                              </tr>
                            )) : (
                              <tr>
                                <td style={styles.tdCompactEmpty} colSpan={2}>No assigned staff hours for this payroll week.</td>
                              </tr>
                            )}
                          </tbody>
                        </table>
                      </div>
                      <div style={{ ...styles.tiny, marginTop: 6 }}>
                        Unassigned shifts: {week.unassignedShifts.length
                          ? week.unassignedShifts.map((sh) => `${formatShiftDateTimeFromISO(sh.startISO)} → ${formatShiftDateTimeFromISO(sh.endISO)}`).join(" | ")
                          : "None"}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            <div>
              <div style={styles.tiny}>Current week assigned staff on client profile</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {builderClientAssignedStaffIds.length ? (
                  builderClientAssignedStaffIds.map((id) => {
                    const st = activeStaff.find((s) => s.id === id);
                    return (
                      <span key={id} style={{ ...styles.shift, padding: "4px 8px", borderRadius: 999 }}>
                        {st?.name || id}
                      </span>
                    );
                  })
                ) : (
                  <span style={styles.tiny}>No assigned staff selected in Client Profiles.</span>
                )}
              </div>
            </div>
          </div>

          <div style={{ position: "relative", zIndex: 4, display: "flex", gap: 8, justifyContent: "flex-end", padding: 12, borderTop: `1px solid ${UI.borderSoft}`, background: UI.panel }}>
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
                    if (!canManageClientId(builderClientId)) {
                      return alert("You can only manage schedules for your assigned clients.");
                    }
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
    ) : null}

    {builderSummary ? (
      <div style={{ marginTop: 12, ...styles.card }}>
        <div style={{ fontSize: 14, fontWeight: 900, marginBottom: 8 }}>Builder Staffing Summary</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(140px, 1fr))", gap: 8 }}>
          <div style={{ ...styles.shift, padding: 8 }}>
            <div style={styles.tiny}>Total Shifts Created</div>
            <div style={{ fontSize: 16, fontWeight: 900 }}>{builderSummary.totalShiftsCreated}</div>
          </div>
          <div style={{ ...styles.shift, padding: 8 }}>
            <div style={styles.tiny}>Total Scheduled Hours</div>
            <div style={{ fontSize: 16, fontWeight: 900 }}>{fmtHoursFromMin(builderSummary.totalScheduledMinutes)}</div>
          </div>
          <div style={{ ...styles.shift, padding: 8 }}>
            <div style={styles.tiny}>Assigned Staff Hours</div>
            <div style={{ fontSize: 16, fontWeight: 900 }}>{fmtHoursFromMin(builderSummary.assignedScheduledMinutes)}</div>
          </div>
          <div style={{ ...styles.shift, padding: 8 }}>
            <div style={styles.tiny}>Open Hours</div>
            <div style={{ fontSize: 16, fontWeight: 900 }}>{fmtHoursFromMin(builderSummary.unassignedHours)}</div>
          </div>
          <div style={{ ...styles.shift, padding: 8 }}>
            <div style={styles.tiny}>Minimum Staff Required</div>
            <div style={{ fontSize: 16, fontWeight: 900 }}>{builderSummary.minimumStaffRequired}</div>
          </div>
          <div style={{ ...styles.shift, padding: 8 }}>
            <div style={styles.tiny}>Current Usable Staff</div>
            <div style={{ fontSize: 16, fontWeight: 900 }}>{builderSummary.currentUsableStaff}</div>
          </div>
          <div style={{ ...styles.shift, padding: 8 }}>
            <div style={styles.tiny}>Additional Staff Needed</div>
            <div style={{ fontSize: 16, fontWeight: 900 }}>{builderSummary.additionalStaffNeeded}</div>
          </div>
          <div style={{ ...styles.shift, padding: 8 }}>
            <div style={styles.tiny}>Staff At 40h</div>
            <div style={{ fontSize: 16, fontWeight: 900 }}>{builderSummary.staffAt40Count}</div>
          </div>
          <div style={{ ...styles.shift, padding: 8 }}>
            <div style={styles.tiny}>Staff Over 40h</div>
            <div style={{ fontSize: 16, fontWeight: 900, color: builderSummary.staffOver40Count ? UI.danger : "inherit" }}>{builderSummary.staffOver40Count}</div>
          </div>
          <div style={{ ...styles.shift, padding: 8 }}>
            <div style={styles.tiny}>Staffing Status</div>
            <div style={{ fontSize: 16, fontWeight: 900, color: builderSummary.currentStaffingEnough ? "inherit" : UI.warning }}>
              {builderSummary.currentStaffingEnough ? "Enough" : "Need more staff"}
            </div>
          </div>
        </div>

        <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
          {builderSummary.weeklyBreakdown.map((week) => (
            <div key={`summary_${week.weekStart}`} style={{ ...styles.shift, padding: 8 }}>
              <div style={{ fontSize: 12, fontWeight: 900, marginBottom: 4 }}>Payroll Week Starting {week.weekStart}</div>
              <div style={styles.tiny}>
                Total scheduled hours: {fmtHoursFromMin(week.totalScheduledMinutes)} | Assigned staff hours: {fmtHoursFromMin(week.assignedScheduledMinutes)} | Open hours: {fmtHoursFromMin(week.unassignedHours)}
              </div>
              <div style={{ ...styles.tiny, marginTop: 2 }}>
                Minimum staff required to keep everyone at 40 hours max: {week.minimumStaffRequired} | Current usable staff: {week.currentUsableStaff} | Additional staff needed: {week.additionalStaffNeeded}
              </div>
              <div style={{ ...styles.tiny, marginTop: 2 }}>
                Staffing status: {week.currentStaffingEnough ? "Current staffing is enough." : "Current staffing is not enough."}
              </div>
              <div style={{ ...styles.tiny, marginTop: 4 }}>
                Staff at 40h: {week.staffAt40.length ? week.staffAt40.map((st) => st.name).join(", ") : "None"}
              </div>
              <div style={{ ...styles.tiny, marginTop: 2 }}>
                Staff over 40h: {week.staffOver40.length ? week.staffOver40.map((st) => st.name).join(", ") : "None"}
              </div>
            </div>
          ))}
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
            canManageShiftForClient={canManageClientId}
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
            <div style={styles.tiny}>Shows shifts for each staff member in the selected payroll period.</div>

            <div style={styles.tableWrap}>
              <table className="app-table" style={styles.tableBase}>
                <thead>
                  <tr>
                    <th style={styles.th}>Staff</th>
                    <th style={styles.th}>Shift</th>
                    <th style={styles.th}>Client</th>
                  </tr>
                </thead>
                <tbody>
                  {(state.staff || []).map((st) => {
                    const shifts = shiftsInSelectedPeriod
                      .filter((sh) => sh.staffId === st.id)
                      .filter((sh) => (canSeeAllShifts ? true : visibleClients.some((c) => c.id === sh.clientId)))
                      .sort((a, b) => new Date(a.startISO) - new Date(b.startISO));

                    if (!shifts.length) {
                      return (
                        <tr key={st.id}>
                          <td style={styles.td}><b>{st.name}</b></td>
                          <td style={styles.tdMuted} colSpan={2}>
                            No shifts in this payroll period
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
                            {formatShiftDateTimeFromISO(sh.startISO)} → {formatShiftDateTimeFromISO(sh.endISO)}
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

        {/* ================= Hours & OT ================= */}
        {tab === "hours" && (
          <div style={{ marginTop: 12, ...styles.card }}>
            <h3 style={{ marginTop: 0, marginBottom: 6 }}>Hours & Overtime</h3>
            <div style={styles.tiny}>Shared support counts once for staff OT, and client totals stay unchanged.</div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(150px, 1fr))", gap: 8, marginTop: 10 }}>
              <div style={{ ...styles.card, padding: 8 }}>
                <div style={styles.tiny}>Staff Working This Payroll Period</div>
                <div style={{ fontSize: 18, fontWeight: 900 }}>{hoursSummary.staffWorking}</div>
              </div>
              <div style={{ ...styles.card, padding: 8 }}>
                <div style={styles.tiny}>Staff In OT</div>
                <div style={{ fontSize: 18, fontWeight: 900, color: hoursSummary.staffInOt ? UI.danger : "inherit" }}>{hoursSummary.staffInOt}</div>
              </div>
              <div style={{ ...styles.card, padding: 8 }}>
                <div style={styles.tiny}>Clients With Hours</div>
                <div style={{ fontSize: 18, fontWeight: 900 }}>{hoursSummary.clientsWithHours}</div>
              </div>
              <div style={{ ...styles.card, padding: 8 }}>
                <div style={styles.tiny}>Total Shared Support Hours This Payroll Period</div>
                <div style={{ fontSize: 18, fontWeight: 900 }}>{fmtHoursFromMin(hoursSummary.totalSharedSupportMin)}</div>
              </div>
              <div style={{ ...styles.card, padding: 8 }}>
                <div style={styles.tiny}>Total Scheduled Client Hours</div>
                <div style={{ fontSize: 18, fontWeight: 900 }}>{fmtHoursFromMin(hoursSummary.totalClientMin)}</div>
              </div>
            </div>

            {(isSupervisor || isAdmin) && hoursSummary.staffInOt > 0 ? (
              <div style={styles.warn}>One or more staff have reached overtime in this payroll period.</div>
            ) : null}

            <details open style={{ marginTop: 10 }}>
              <summary style={{ cursor: "pointer", fontWeight: 900 }}>Staff Hours</summary>
              <div style={{ display: "grid", gridTemplateColumns: "minmax(200px, 1fr) auto", gap: 8, marginTop: 8, alignItems: "center" }}>
                <input
                  style={{ ...styles.input, padding: "7px 9px" }}
                  placeholder="Search staff..."
                  value={staffHoursSearch}
                  onChange={(e) => setStaffHoursSearch(e.target.value)}
                />
                <select
                  style={{ ...styles.select, width: 180, padding: "7px 9px" }}
                  value={staffHoursFilter}
                  onChange={(e) => setStaffHoursFilter(e.target.value)}
                >
                  <option value="worked">Worked This Payroll Period</option>
                  <option value="ot">Overtime Only</option>
                  <option value="shared">Shared Support Only</option>
                  <option value="all">All Staff</option>
                </select>
              </div>

              <div style={styles.tableWrapReport}>
                <table className="app-table app-table-report" style={styles.staffHoursTable}>
                  <colgroup>
                    <col style={{ width: 220 }} />
                    <col style={{ width: 120 }} />
                    <col style={{ width: 120 }} />
                    <col style={{ width: 160 }} />
                  </colgroup>
                  <thead>
                    <tr>
                      <th style={styles.staffHoursThName}>Staff</th>
                      <th style={styles.staffHoursThNum}>Payroll Period Hours</th>
                      <th style={styles.staffHoursThNum}>OT Hours</th>
                      <th style={styles.staffHoursThNum}>Shared Support Hours</th>
                    </tr>
                  </thead>
                  <tbody>
                    {staffHoursRows.map(({ st, min, otMin, sharedSupportMin }) => (
                      <tr key={st.id}>
                        <td style={styles.staffHoursTdName}><b>{st.name}</b></td>
                        <td style={styles.staffHoursTdNum}>{fmtHoursFromMin(min)}</td>
                        <td style={{ ...styles.staffHoursTdNum, color: otMin > 0 ? UI.danger : "inherit" }}>{fmtHoursFromMin(otMin)}</td>
                        <td style={styles.staffHoursTdNum}>{fmtHoursFromMin(sharedSupportMin)}</td>
                      </tr>
                    ))}
                    {staffHoursRows.length === 0 ? (
                      <tr>
                        <td style={styles.staffHoursTdEmpty} colSpan={4}>No staff rows match this filter.</td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </details>

            <details style={{ marginTop: 10 }}>
              <summary style={{ cursor: "pointer", fontWeight: 900 }}>Client Payroll Period Hours</summary>
              <div style={{ display: "grid", gridTemplateColumns: "minmax(200px, 1fr) auto", gap: 8, marginTop: 8, alignItems: "center" }}>
                <input
                  style={{ ...styles.input, padding: "7px 9px" }}
                  placeholder="Search clients..."
                  value={clientHoursSearch}
                  onChange={(e) => setClientHoursSearch(e.target.value)}
                />
                <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12 }}>
                  <input
                    type="checkbox"
                    checked={showAllClientHours}
                    onChange={(e) => setShowAllClientHours(e.target.checked)}
                  />
                  Show All Clients
                </label>
              </div>

              <div style={styles.tableWrapReportWide}>
                <table className="app-table app-table-report" style={styles.tableCompact}>
                  <thead>
                    <tr>
                      <th style={styles.thCompact}>Client</th>
                      <th style={styles.thCompactNum}>Allotted</th>
                      <th style={styles.thCompactNum}>Payroll Total</th>
                      <th style={styles.thCompactNum}>Remaining</th>
                      <th style={styles.thCompactNum}>Day</th>
                      <th style={styles.thCompactNum}>Night</th>
                    </tr>
                  </thead>
                  <tbody>
                    {clientHoursRows.map(({ c, h, allottedMin, remainingMin }) => (
                      <tr key={c.id}>
                        <td style={styles.tdCompact}><b>{c.name}</b></td>
                        <td style={styles.tdCompactNum}>{fmtHoursFromMin(allottedMin)}</td>
                        <td style={styles.tdCompactNum}>{fmtHoursFromMin(h.totalMin)}</td>
                        <td style={{ ...styles.tdCompactNum, color: remainingMin < 0 ? UI.danger : "inherit" }}>{fmtHoursFromMin(remainingMin)}</td>
                        <td style={styles.tdCompactNum}>{fmtHoursFromMin(h.dayMin)}</td>
                        <td style={styles.tdCompactNum}>{fmtHoursFromMin(h.nightMin)}</td>
                      </tr>
                    ))}
                    {clientHoursRows.length === 0 ? (
                      <tr>
                        <td style={styles.tdCompactEmpty} colSpan={6}>No client rows match this filter.</td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </details>
          </div>
        )}

        {/* ================= Client Profiles ================= */}
        {tab === "clientProfiles" && (
          <div style={{ marginTop: 12, ...styles.card }}>
            <h3 style={{ marginTop: 0 }}>Client Profiles</h3>
            <div style={{ marginBottom: 16 }}>
              <div style={styles.tiny}>Select a client to view their profile:</div>
              <select
                style={{ ...styles.select, maxWidth: 320, marginTop: 6 }}
                value={selectedClientId}
                onChange={(e) => setSelectedClientId(e.target.value)}
              >
                <option value="">Select...</option>
                {allClients.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>

            {!selectedClient ? (
              <div style={{ ...styles.tiny, marginTop: 24 }}>Select a client to view profile.</div>
            ) : (
              <div style={{ ...styles.card, background: "rgba(255,255,255,0.02)", marginTop: 0 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                  <div>
                    <div style={{ fontSize: 22, fontWeight: 900, marginBottom: 2 }}>{selectedClient.name}</div>
                    <div style={styles.tiny}>
                      Supervisor: <b>{(state.users || []).find((u) => u.id === selectedClient.supervisorId)?.name || "Unassigned"}</b> &nbsp;|&nbsp;
                      Status: <b>{selectedClient.active !== false ? "Active" : "Inactive"}</b> &nbsp;|&nbsp;
                      24-hour: <b>{selectedClient.is24Hour ? "Yes" : "No"}</b>
                    </div>
                    <div style={styles.tiny}>
                      Coverage: <b>{selectedClient.coverageStart} - {selectedClient.coverageEnd}</b> &nbsp;|&nbsp;
                      Weekly Allotment: <b>{Number(selectedClient.weeklyHours) || 0}h</b>
                    </div>
                    <div style={styles.tiny}>
                      Payroll Range: <b>{payrollStartDate}</b> to <b>{payrollFinishDate}</b>
                    </div>
                  </div>

                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button
                      style={styles.btn2}
                      onClick={() => {
                        setTab("schedule");
                        setShiftDraft((p) => ({ ...p, clientId: selectedClient.id }));
                      }}
                    >
                      Add Shift for This Client
                    </button>
                    <button
                      style={styles.btn2}
                      onClick={() => {
                        setTab("schedule");
                        setBuilderClientId(selectedClient.id);
                        setBuilderOpen(true);
                      }}
                    >
                      Open 24-Hour Builder
                    </button>
                  </div>
                </div>

                <div style={{ marginTop: 18, marginBottom: 10 }}>
                  <div style={styles.tiny}>Payroll Period Hours Summary</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ height: 10, width: "100%", background: "rgba(255,255,255,0.12)", borderRadius: 4, overflow: "hidden" }}>
                        <div
                          style={{
                            height: "100%",
                            width: `${Math.min(100, selectedClientWeekHours.allottedMin ? Math.round((selectedClientWeekHours.totalMin / selectedClientWeekHours.allottedMin) * 100) : 0)}%`,
                            background: selectedClientWeekHours.remainingMin < 0 ? UI.danger : UI.accent,
                          }}
                        />
                      </div>
                    </div>
                    <div style={{ fontSize: 13, minWidth: 120 }}>
                      {fmtHoursFromMin(selectedClientWeekHours.totalMin)} / {fmtHoursFromMin(selectedClientWeekHours.allottedMin)}
                    </div>
                    <div style={{ fontSize: 13, color: selectedClientWeekHours.remainingMin < 0 ? UI.danger : "inherit" }}>
                      Rem: {fmtHoursFromMin(selectedClientWeekHours.remainingMin)}
                    </div>
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.8, marginTop: 2 }}>
                    Day: {fmtHoursFromMin(selectedClientWeekHours.dayMin)} &nbsp;|&nbsp; Night: {fmtHoursFromMin(selectedClientWeekHours.nightMin)}
                  </div>
                </div>

                <div style={{ marginTop: 18 }}>
                  <h4 style={{ margin: "10px 0 6px 0" }}>Profile Assigned Staff (used by 24-hour builder first)</h4>
                  <AssignedStaffDropdown
                    label="Assigned Staff"
                    selectedIds={selectedClientAssignedStaffIds}
                    staffOptions={activeStaff}
                    onChange={(next) => {
                      if (!canManageClientId(selectedClient.id)) {
                        alert("You can only edit assigned staff for your own clients.");
                        return;
                      }
                      sbUpsert("clients", [
                        {
                          id: selectedClient.id,
                          assigned_staff_ids: serializeAssignedStaffIds(next),
                        },
                      ])
                        .then(() => refreshState(setState))
                        .catch((err) => {
                          console.error("save assigned staff failed", err);
                          alert("Unable to save assigned staff.");
                        });
                    }}
                  />
                  <div style={{ ...styles.tiny, marginTop: 8 }}>
                    Selected: {selectedClientAssignedStaff.length
                      ? selectedClientAssignedStaff.map((s) => s.name).join(", ")
                      : "None"}
                  </div>
                </div>

                <div style={{ marginTop: 18 }}>
                  <h4 style={{ margin: "10px 0 6px 0" }}>Client Schedule</h4>
                  {selectedClientShifts.length === 0 ? (
                    <div style={styles.tiny}>No shifts scheduled for this client in this payroll period.</div>
                  ) : (
                    <div style={styles.tableWrap}>
                      <table className="app-table" style={styles.tableBase}>
                        <thead>
                          <tr>
                            <th style={styles.th}>Date</th>
                            <th style={styles.th}>Start</th>
                            <th style={styles.th}>End</th>
                            <th style={styles.th}>Staff</th>
                            <th style={styles.thCenter}>Shared</th>
                            <th style={styles.th}>Group</th>
                          </tr>
                        </thead>
                        <tbody>
                          {selectedClientShifts.map((sh) => {
                            const staff = (state.staff || []).find((s) => s.id === sh.staffId);
                            return (
                              <tr key={sh.id}>
                                <td style={styles.td}>{sh.startISO.slice(0, 10)}</td>
                                <td style={styles.td}>{formatShiftTimeFromISO(sh.startISO)}</td>
                                <td style={styles.td}>{formatShiftTimeFromISO(sh.endISO)}</td>
                                <td style={styles.td}>{staff ? staff.name : "Unknown"}</td>
                                <td style={styles.tdCenter}>{sh.isShared ? getShiftStaffingLabel(selectedClientShifts, sh) : "No"}</td>
                                <td style={styles.td}>{sh.sharedGroupId || ""}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                <div style={{ marginTop: 18 }}>
                  <h4 style={{ margin: "10px 0 6px 0" }}>Assigned Staff</h4>
                  {selectedClientStaffSummary.length === 0 ? (
                    <div style={styles.tiny}>No staff assigned in this payroll period.</div>
                  ) : (
                    <div style={styles.tableWrapCompact}>
                      <table className="app-table app-table-report" style={styles.tableCompact}>
                        <thead>
                          <tr>
                            <th style={styles.th}>Staff</th>
                            <th style={styles.thNum}>Total Hours</th>
                          </tr>
                        </thead>
                        <tbody>
                          {selectedClientStaffSummary.map(({ staff, min }) => (
                            <tr key={staff?.id || "unknown"}>
                              <td style={styles.td}>
                                {staff?.name || "Unknown"}
                                {staff?.id && clientAssignedStaffIdSet.has(staff.id) ? " (Profile assigned)" : ""}
                              </td>
                              <td style={styles.tdNum}>{fmtHoursFromMin(min)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>
            )}
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
                  {(state.users || []).filter((u) => isSupervisorRole(u.role)).map((u) => (
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

              <div style={{ gridColumn: "1 / -1" }}>
                <AssignedStaffDropdown
                  label="Assigned Staff"
                  selectedIds={clientDraft.assignedStaffIds || []}
                  staffOptions={activeStaff}
                  onChange={(next) => setClientDraft((p) => ({ ...p, assignedStaffIds: parseAssignedStaffIds(next) }))}
                />
              </div>
            </div>

            {/* Form actions */}
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10, gap: 8 }}>
              <button type="button" style={styles.btn2} onClick={resetClientDraft}>Cancel</button>
              <button type="button" style={styles.btn} onClick={handleSaveClientClick} disabled={isSavingClient}>
                {isSavingClient ? "Saving..." : "Save Client"}
              </button>
            </div>

            <div style={styles.hr} />

            <div style={{ display: "grid", gap: 10 }}>
              {(state.clients || []).map((c) => {
                const sup = (state.users || []).find((u) => u.id === (c.supervisorId || ""));
                return (
                  <div key={c.id} id={`client-row-${c.id}`} style={styles.shift}>
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
                              weeklyHours: Number(c.weeklyHours ?? c.hours_allotted ?? c.weekly_hours) || 40,
                              assignedStaffIds: parseAssignedStaffIds(c.assignedStaffIds ?? c.assigned_staff_ids),
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
                        <button style={styles.btnDanger} onClick={() => deleteClient(c.id)}>Delete</button>
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
                      <button style={styles.btnDanger} onClick={() => deleteUser(u.id)}>Delete</button>
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

            <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10 }}>
              <input
                type="checkbox"
                checked={!!state.settings?.crossWeekConsecutiveProtection}
                onChange={(e) =>
                  setState((p) => ({
                    ...p,
                    settings: { ...p.settings, crossWeekConsecutiveProtection: e.target.checked },
                  }))
                }
              />
              Cross-week consecutive protection (include 7-day buffer before/after selected payroll period)
            </label>

            <div style={{ marginTop: 10, maxWidth: 280 }}>
              <div style={styles.tiny}>Max consecutive worked days</div>
              <input
                style={styles.input}
                type="number"
                min={1}
                max={14}
                value={maxConsecutiveDays}
                onChange={(e) =>
                  setState((p) => ({
                    ...p,
                    settings: {
                      ...p.settings,
                      maxConsecutiveDays: Math.max(1, Number(e.target.value) || 1),
                    },
                  }))
                }
              />
            </div>
          </div>
        )}
      </div>

      <style jsx global>{`
        :root {
          color-scheme: light;
        }

        html, body {
          background: ${UI.bg};
          color: ${UI.text};
          font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }

        * {
          box-sizing: border-box;
        }

        input,
        select,
        textarea,
        button {
          font: inherit;
        }

        select {
          background-color: #ffffff;
          color: ${UI.text};
          border: 1px solid ${UI.border};
          -webkit-text-fill-color: ${UI.text};
        }

        select option {
          color: ${UI.text};
          background-color: #ffffff;
        }

        input:focus,
        select:focus,
        textarea:focus {
          border-color: ${UI.accent};
          outline: 3px solid rgba(59, 130, 246, 0.18);
          outline-offset: 1px;
        }

        button {
          transition: background-color 120ms ease, border-color 120ms ease, box-shadow 120ms ease, color 120ms ease;
        }

        .app-table {
          width: 100%;
          border-collapse: collapse;
          table-layout: auto;
          background: #ffffff;
        }

        .app-table thead th {
          position: sticky;
          top: 0;
          z-index: 1;
          background: #f8fafc;
        }

        .app-table tbody tr:nth-child(even) td {
          background: #fbfcfd;
        }

        .app-table tbody tr:hover td {
          background: rgba(59, 130, 246, 0.05);
        }

        summary {
          list-style: none;
        }

        summary::-webkit-details-marker {
          display: none;
        }
      `}</style>
    </div>
  );
}

/* =========================
   Styles
========================= */

const UI = {
  bg: "#F4F6F8",
  panel: "#FFFFFF",
  panelAlt: "#F8FAFC",
  border: "#E3E7EB",
  borderSoft: "#EDF1F4",
  text: "#1F2933",
  textSecondary: "#6B7280",
  textMuted: "#9CA3AF",
  accent: "#3B82F6",
  accentHover: "#2563EB",
  success: "#22C55E",
  warning: "#F59E0B",
  danger: "#EF4444",
  shadowSm: "0 1px 2px rgba(15, 23, 42, 0.04)",
  shadowMd: "0 6px 18px rgba(15, 23, 42, 0.05)",
  shadowLg: "0 14px 34px rgba(15, 23, 42, 0.12)",
};

const styles = {
  card: {
    border: `1px solid ${UI.border}`,
    borderRadius: 12,
    padding: 12,
    background: UI.panel,
    boxShadow: UI.shadowSm,
  },
  btn: {
    padding: "8px 12px",
    borderRadius: 10,
    border: `1px solid ${UI.accent}`,
    background: UI.accent,
    color: "#FFFFFF",
    fontWeight: 700,
    cursor: "pointer",
    boxShadow: "0 1px 2px rgba(59,130,246,0.14)",
  },
  btn2: {
    padding: "7px 10px",
    borderRadius: 10,
    border: `1px solid ${UI.border}`,
    background: "#FFFFFF",
    color: UI.textSecondary,
    fontWeight: 600,
    cursor: "pointer",
  },
  btnDanger: {
    padding: "7px 10px",
    borderRadius: 10,
    border: "1px solid rgba(239,68,68,0.24)",
    background: "#FEF2F2",
    color: UI.danger,
    fontWeight: 600,
    cursor: "pointer",
  },
  input: {
    width: "100%",
    padding: "8px 10px",
    borderRadius: 10,
    border: `1px solid ${UI.border}`,
    background: "#FFFFFF",
    color: UI.text,
    outline: "none",
  },
  select: {
    width: "100%",
    padding: "8px 10px",
    borderRadius: 10,
    border: `1px solid ${UI.border}`,
    background: "#ffffff",
    color: UI.text,
    outline: "none",
  },
  grid4: { display: "grid", gridTemplateColumns: "repeat(4, minmax(220px, 1fr))", gap: 10 },
  twoCol: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 },
  tiny: { fontSize: 11, color: UI.textMuted, lineHeight: 1.4 },
  shift: { border: `1px solid ${UI.border}`, borderRadius: 12, padding: 10, background: UI.panelAlt },
  shiftTop: { display: "flex", justifyContent: "space-between", gap: 8, alignItems: "flex-start" },
  shiftTitle: { fontWeight: 700, fontSize: 13, marginBottom: 4, color: UI.text },
  shiftMeta: { fontSize: 11, color: UI.textSecondary, lineHeight: 1.4 },
  hr: { height: 1, background: UI.borderSoft, margin: "10px 0" },
  warn: { color: UI.warning, fontSize: 12, marginTop: 6 },
  tableWrap: {
    marginTop: 10,
    overflowX: "auto",
    maxWidth: "100%",
  },
  tableWrapCompact: {
    marginTop: 6,
    overflowX: "auto",
    maxWidth: "100%",
  },
  tableWrapReport: {
    marginTop: 8,
    overflowX: "auto",
    maxWidth: 700,
  },
  tableWrapReportWide: {
    marginTop: 8,
    overflowX: "auto",
    maxWidth: 860,
  },
  tableBase: {
    width: "100%",
    borderCollapse: "collapse",
    tableLayout: "auto",
  },
  tableCompact: {
    width: "100%",
    borderCollapse: "collapse",
    tableLayout: "auto",
  },
  th: {
    textAlign: "left",
    fontSize: 12,
    fontWeight: 700,
    color: UI.textSecondary,
    padding: "9px 12px",
    borderBottom: `1px solid ${UI.border}`,
    whiteSpace: "nowrap",
  },
  thNum: {
    textAlign: "right",
    fontSize: 12,
    fontWeight: 700,
    color: UI.textSecondary,
    padding: "9px 12px",
    borderBottom: `1px solid ${UI.border}`,
    whiteSpace: "nowrap",
    fontVariantNumeric: "tabular-nums",
  },
  thCenter: {
    textAlign: "center",
    fontSize: 12,
    fontWeight: 700,
    color: UI.textSecondary,
    padding: "9px 12px",
    borderBottom: `1px solid ${UI.border}`,
    whiteSpace: "nowrap",
  },
  td: {
    padding: "8px 12px",
    borderBottom: `1px solid ${UI.borderSoft}`,
    fontSize: 12,
    textAlign: "left",
    verticalAlign: "top",
    color: UI.text,
  },
  tdNum: {
    padding: "8px 12px",
    borderBottom: `1px solid ${UI.borderSoft}`,
    fontSize: 12,
    textAlign: "right",
    verticalAlign: "top",
    whiteSpace: "nowrap",
    fontVariantNumeric: "tabular-nums",
    color: UI.text,
  },
  tdCenter: {
    padding: "8px 12px",
    borderBottom: `1px solid ${UI.borderSoft}`,
    fontSize: 12,
    textAlign: "center",
    verticalAlign: "top",
    whiteSpace: "nowrap",
    color: UI.text,
  },
  tdMuted: {
    padding: "8px 12px",
    borderBottom: `1px solid ${UI.borderSoft}`,
    fontSize: 12,
    textAlign: "left",
    verticalAlign: "top",
    color: UI.textMuted,
  },
  thCompact: {
    textAlign: "left",
    fontSize: 12,
    fontWeight: 700,
    color: UI.textSecondary,
    padding: "8px 12px",
    borderBottom: `1px solid ${UI.border}`,
    whiteSpace: "nowrap",
  },
  thCompactNum: {
    textAlign: "right",
    fontSize: 12,
    fontWeight: 700,
    color: UI.textSecondary,
    padding: "8px 12px",
    borderBottom: `1px solid ${UI.border}`,
    whiteSpace: "nowrap",
    fontVariantNumeric: "tabular-nums",
  },
  tdCompact: {
    padding: "8px 12px",
    borderBottom: `1px solid ${UI.borderSoft}`,
    fontSize: 12,
    textAlign: "left",
    verticalAlign: "top",
    color: UI.text,
  },
  tdCompactNum: {
    padding: "8px 12px",
    borderBottom: `1px solid ${UI.borderSoft}`,
    fontSize: 12,
    textAlign: "right",
    verticalAlign: "top",
    whiteSpace: "nowrap",
    fontVariantNumeric: "tabular-nums",
    color: UI.text,
  },
  tdCompactEmpty: {
    padding: "8px 12px",
    borderBottom: `1px solid ${UI.borderSoft}`,
    fontSize: 12,
    textAlign: "left",
    color: UI.textMuted,
  },
  staffHoursTable: {
    width: "100%",
    minWidth: 620,
    borderCollapse: "collapse",
    tableLayout: "auto",
  },
  staffHoursThName: {
    ...{
      textAlign: "left",
      fontSize: 12,
      fontWeight: 700,
      color: UI.textSecondary,
      padding: "8px 14px",
      borderBottom: `1px solid ${UI.border}`,
    },
    whiteSpace: "nowrap",
  },
  staffHoursThNum: {
    ...{
      textAlign: "right",
      fontSize: 12,
      fontWeight: 700,
      color: UI.textSecondary,
      padding: "8px 14px",
      borderBottom: `1px solid ${UI.border}`,
    },
    whiteSpace: "nowrap",
    fontVariantNumeric: "tabular-nums",
  },
  staffHoursTdName: {
    padding: "8px 14px",
    borderBottom: `1px solid ${UI.borderSoft}`,
    fontSize: 12,
    textAlign: "left",
    whiteSpace: "nowrap",
    color: UI.text,
  },
  staffHoursTdNum: {
    padding: "8px 14px",
    borderBottom: `1px solid ${UI.borderSoft}`,
    fontSize: 12,
    textAlign: "right",
    whiteSpace: "nowrap",
    fontVariantNumeric: "tabular-nums",
    color: UI.text,
  },
  staffHoursTdEmpty: {
    padding: "8px 14px",
    borderBottom: `1px solid ${UI.borderSoft}`,
    fontSize: 12,
    textAlign: "left",
    color: UI.textMuted,
  },
};
