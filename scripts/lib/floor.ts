/**
 * Splits an iBigFun floor cell like "4/4樓" into floor and total floors.
 * The cell encodes "<floor>/<total>" with a 樓 (or F) unit on the total.
 * Pure and unit-tested.
 */

function clean(s: string): string | null {
  const out = s.replace(/樓|F/gi, '').trim();
  return out || null;
}

export function parseFloorField(raw: string | null): {
  floor: string | null;
  totalFloors: string | null;
} {
  if (!raw || !raw.trim()) return { floor: null, totalFloors: null };
  const slash = raw.indexOf('/');
  if (slash === -1) return { floor: raw.trim(), totalFloors: null };
  return {
    floor: clean(raw.slice(0, slash)),
    totalFloors: clean(raw.slice(slash + 1)),
  };
}
