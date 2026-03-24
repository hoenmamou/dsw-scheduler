export function calculateHours(shifts) {
  if (!Array.isArray(shifts)) {
    return 0;
  }

  return shifts.reduce((total, shift) => {
    const start = new Date(shift?.start);
    const end = new Date(shift?.end);

    if (!start || !end || isNaN(start) || isNaN(end)) {
      return total;
    }

    const hours = (end - start) / (1000 * 60 * 60);
    return total + (isNaN(hours) ? 0 : hours);
  }, 0);
}
export function computeDashboardSummary(shifts = []) {
  if (!Array.isArray(shifts)) {
    return {
      totalHours: 0,
      shiftCount: 0,
    };
  }

  const totalHours = calculateHours(shifts);

  return {
    totalHours: isNaN(totalHours) ? 0 : totalHours,
    shiftCount: shifts.length || 0,
  };
}
