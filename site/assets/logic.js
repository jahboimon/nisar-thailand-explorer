export function stableSceneId(feature) {
  const p = feature.properties || {};
  return String(
    feature.id || p.id || p.fileID || p.granuleName || p.sceneName || "",
  );
}
export function dedupeFeatures(features) {
  const seen = new Set();
  return features.filter((f) => {
    const id = stableSceneId(f);
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}
export function cleanProvinceName(value) {
  return String(value ?? "")
    .replace(/\s+Province\s*$/i, "")
    .trim();
}
export function transitionSpatialSelection(current, event) {
  const type = event?.type;
  if (type === "SELECT_PROVINCE")
    return event.provinceId
      ? { mode: "province", provinceId: String(event.provinceId) }
      : { mode: "thailand", provinceId: "" };
  if (type === "DRAW_AOI") return { mode: "custom", provinceId: "" };
  if (type === "CLEAR_AOI" || type === "RESET")
    return { mode: "thailand", provinceId: "" };
  return current;
}
export function utcDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.valueOf()) ? null : d.toISOString().slice(0, 10);
}
export function acquisitionGeometryKey(properties = {}) {
  if (
    properties.acquisitionGeometry &&
    properties.acquisitionGeometry !== "UNKNOWN"
  )
    return properties.acquisitionGeometry;
  const direction = String(properties.orbitDirection ?? "UNKNOWN"),
    track = String(properties.track ?? "UNKNOWN"),
    frame = String(properties.frame ?? "UNKNOWN");
  return [direction, track, frame].includes("UNKNOWN")
    ? null
    : `${direction}|T${track}|F${frame}`;
}
function largestGap(items) {
  let best = null;
  for (let i = 1; i < items.length; i++) {
    const days = Math.round(
      (new Date(items[i]) - new Date(items[i - 1])) / 86400000,
    );
    if (!best || days > best.days)
      best = { days, from: items[i - 1], to: items[i] };
  }
  return best;
}
export function gapStats(features) {
  const dates = [
    ...new Set(
      features.map((f) => utcDate(f.properties?.startTime)).filter(Boolean),
    ),
  ].sort();
  const geometries = new Map();
  features.forEach((f) => {
    const p = f.properties || {},
      key = acquisitionGeometryKey(p),
      d = utcDate(p.startTime);
    if (key && d) {
      if (!geometries.has(key))
        geometries.set(key, {
          dates: new Set(),
          track: String(p.track),
          frame: String(p.frame),
          direction: String(p.orbitDirection),
        });
      geometries.get(key).dates.add(d);
    }
  });
  let sameGeometry = null;
  for (const [geometry, item] of geometries) {
    const gap = largestGap([...item.dates].sort());
    if (gap && (!sameGeometry || gap.days > sameGeometry.days))
      sameGeometry = { ...gap, ...item, geometry };
  }
  return {
    dates,
    allTrack: largestGap(dates),
    sameGeometry,
    sameTrack: sameGeometry,
  };
}
export function matchesFilters(feature, filters, intersects) {
  const p = feature.properties || {},
    d = utcDate(p.startTime);
  return (
    (!filters.products.size || filters.products.has(p.product)) &&
    (!filters.orbits.size || filters.orbits.has(p.orbitDirection)) &&
    (!filters.maturities.size || filters.maturities.has(p.dataMaturity)) &&
    (!filters.start || d >= filters.start) &&
    (!filters.end || d <= filters.end) &&
    (!filters.provinceId || p.provinceIds?.includes(filters.provinceId)) &&
    (!filters.aoi || intersects(feature, filters.aoi))
  );
}
export const PANE_ORDER = Object.freeze({
  scene: 410,
  province: 430,
  selection: 450,
  customAoi: 460,
});
export const PROVINCE_POINTER_EVENTS = "stroke";
export function paginate(items, page = 1, pageSize = 20) {
  const total = items.length,
    pages = Math.max(1, Math.ceil(total / pageSize)),
    current = Math.min(Math.max(1, Number(page) || 1), pages),
    start = (current - 1) * pageSize;
  return {
    items: items.slice(start, start + pageSize),
    page: current,
    pageSize,
    total,
    pages,
    start,
  };
}

export function timelineSummary(features) {
  const days = new Map();
  for (const feature of features) {
    const date = utcDate(feature.properties?.startTime);
    if (!date) continue;
    if (!days.has(date)) days.set(date, { date, count: 0, products: {} });
    const item = days.get(date);
    const product = String(feature.properties?.product ?? "UNKNOWN");
    item.count += 1;
    item.products[product] = (item.products[product] ?? 0) + 1;
  }
  const entries = [...days.values()].sort((a, b) =>
    a.date.localeCompare(b.date),
  );
  return {
    entries,
    uniqueDates: entries.length,
    granules: entries.reduce((sum, item) => sum + item.count, 0),
    first: entries[0]?.date ?? null,
    last: entries.at(-1)?.date ?? null,
    maxCount: Math.max(0, ...entries.map((item) => item.count)),
  };
}

export function timelinePosition(date, first, last) {
  const start = Date.parse(`${first}T00:00:00Z`);
  const end = Date.parse(`${last}T00:00:00Z`);
  const value = Date.parse(`${date}T00:00:00Z`);
  if (![start, end, value].every(Number.isFinite) || end <= start) return 0.5;
  return Math.min(1, Math.max(0, (value - start) / (end - start)));
}

export function monthlyTicks(first, last) {
  if (!first || !last) return [];
  const start = new Date(`${first}T00:00:00Z`);
  const end = new Date(`${last}T00:00:00Z`);
  if (Number.isNaN(start.valueOf()) || Number.isNaN(end.valueOf())) return [];
  const ticks = [];
  const cursor = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1),
  );
  while (cursor < end) {
    ticks.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return ticks;
}

export function beginTimelineDateSelection(current, date, previous = null) {
  return {
    range: { start: date, end: date },
    previous: previous ?? {
      start: String(current?.start ?? ""),
      end: String(current?.end ?? ""),
    },
  };
}

export function clearTimelineDateSelection(previous = null) {
  return previous ?? { start: "", end: "" };
}
