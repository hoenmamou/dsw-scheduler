// lib/auditLog.js
// Audit trail for schedule changes. Logs to Supabase when available,
// falls back to localStorage.

import { SUPABASE_CONFIGURED, supabase } from "./supabaseClient";

const AUDIT_LOCAL_KEY = "dsw_audit_logs";
const MAX_LOCAL_ENTRIES = 500;

function uid(prefix = "aud") {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function readLocalAudit() {
  try {
    const raw = localStorage.getItem(AUDIT_LOCAL_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function writeLocalAudit(entries) {
  try {
    // Keep only the most recent entries
    const trimmed = entries.slice(-MAX_LOCAL_ENTRIES);
    localStorage.setItem(AUDIT_LOCAL_KEY, JSON.stringify(trimmed));
  } catch {
    // Storage full — silently drop oldest
  }
}

/**
 * Log an audit entry.
 * @param {object} entry
 * @param {string} entry.action    - create | edit | delete | call_out | reassign
 * @param {string} entry.tableName - shifts | clients | staff | call_outs
 * @param {string} entry.recordId  - ID of the affected record
 * @param {object} [entry.oldValues] - previous values (for edits/deletes)
 * @param {object} [entry.newValues] - new values (for creates/edits)
 * @param {string} [entry.userId]  - who performed the action
 * @param {string} [entry.userName] - display name
 * @param {string} [entry.reason]  - optional context
 */
export async function logAudit({
  action,
  tableName,
  recordId,
  oldValues = {},
  newValues = {},
  userId = "unknown",
  userName = "",
  reason = "",
}) {
  const entry = {
    id: uid(),
    action,
    table_name: tableName,
    record_id: recordId,
    old_values: oldValues,
    new_values: newValues,
    user_id: userId,
    user_name: userName,
    reason,
    created_at: new Date().toISOString(),
  };

  // Always save locally first (resilient)
  const local = readLocalAudit();
  local.push(entry);
  writeLocalAudit(local);

  // Try to save to Supabase
  if (SUPABASE_CONFIGURED && supabase) {
    try {
      const { error } = await supabase.from("audit_logs").insert([{
        ...entry,
        old_values: JSON.stringify(oldValues),
        new_values: JSON.stringify(newValues),
      }]);
      if (error) {
        console.warn("Audit log Supabase insert failed (kept locally):", error.message);
      }
    } catch (e) {
      console.warn("Audit log Supabase insert failed (kept locally):", e.message);
    }
  }

  return entry;
}

// Convenience wrappers
export async function logShiftCreate(shift, userId, userName) {
  return logAudit({
    action: "shift_create",
    tableName: "shifts",
    recordId: shift?.id || "",
    newValues: shift,
    userId,
    userName,
  });
}

export async function logShiftEdit(oldShift, newShift, userId, userName, reason = "") {
  return logAudit({
    action: "shift_edit",
    tableName: "shifts",
    recordId: newShift?.id || oldShift?.id || "",
    oldValues: oldShift,
    newValues: newShift,
    userId,
    userName,
    reason,
  });
}

export async function logShiftDelete(shift, userId, userName) {
  return logAudit({
    action: "shift_delete",
    tableName: "shifts",
    recordId: shift?.id || "",
    oldValues: shift,
    userId,
    userName,
  });
}

export async function logCallOut(shift, userId, userName, reason = "") {
  return logAudit({
    action: "call_out",
    tableName: "shifts",
    recordId: shift?.id || "",
    oldValues: shift,
    userId,
    userName,
    reason,
  });
}

export async function logReassignment(shift, oldStaffId, newStaffId, userId, userName) {
  return logAudit({
    action: "reassignment",
    tableName: "shifts",
    recordId: shift?.id || "",
    oldValues: { staff_id: oldStaffId },
    newValues: { staff_id: newStaffId },
    userId,
    userName,
  });
}

/**
 * Fetch audit logs.
 * @param {object} [filters]
 * @param {string} [filters.recordId]
 * @param {string} [filters.action]
 * @param {string} [filters.tableName]
 * @param {number} [filters.limit]
 * @returns {Promise<Array>}
 */
export async function fetchAuditLogs(filters = {}) {
  const limit = filters.limit || 200;

  if (SUPABASE_CONFIGURED && supabase) {
    try {
      let query = supabase
        .from("audit_logs")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(limit);

      if (filters.recordId) query = query.eq("record_id", filters.recordId);
      if (filters.action) query = query.eq("action", filters.action);
      if (filters.tableName) query = query.eq("table_name", filters.tableName);

      const { data, error } = await query;
      if (!error && data) {
        return data.map((row) => ({
          ...row,
          old_values: typeof row.old_values === "string" ? JSON.parse(row.old_values) : row.old_values,
          new_values: typeof row.new_values === "string" ? JSON.parse(row.new_values) : row.new_values,
        }));
      }
      if (error) console.warn("Audit log fetch failed, using local:", error.message);
    } catch (e) {
      console.warn("Audit log fetch failed, using local:", e.message);
    }
  }

  // Fallback to local
  let entries = readLocalAudit()
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  if (filters.recordId) entries = entries.filter((e) => e.record_id === filters.recordId);
  if (filters.action) entries = entries.filter((e) => e.action === filters.action);
  if (filters.tableName) entries = entries.filter((e) => e.table_name === filters.tableName);

  return entries.slice(0, limit);
}
