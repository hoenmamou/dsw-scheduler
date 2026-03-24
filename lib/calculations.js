export function calculateHours(shifts = []) {
  return shifts.reduce((total, shift) => {
    const start = new Date(shift.start);
    const end = new Date(shift.end);
    const hours = (end - start) / (1000 * 60 * 60);
    return total + (isNaN(hours) ? 0 : hours);
  }, 0);
}

export function computeDashboardSummary(shifts = []) {
  const totalHours = calculateHours(shifts);

  return {
    totalHours,
    totalShifts: Array.isArray(shifts) ? shifts.length : 0,
    overtimeHours: totalHours > 40 ? totalHours - 40 : 0,
  };
}
