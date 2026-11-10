import test from "node:test";
import assert from "node:assert/strict";
import {
  PANE_ORDER,
  PROVINCE_POINTER_EVENTS,
  acquisitionGeometryKey,
  beginTimelineDateSelection,
  clearTimelineDateSelection,
  cleanProvinceName,
  dedupeFeatures,
  gapStats,
  matchesFilters,
  paginate,
  monthlyTicks,
  timelinePosition,
  timelineSummary,
  transitionSpatialSelection,
} from "../../site/assets/logic.js";

const f = (
  id,
  date,
  track = "1",
  frame = "1",
  product = "GCOV",
  orbit = "ASCENDING",
  maturity = "VALIDATED",
) => ({
  type: "Feature",
  id,
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [100, 10],
        [101, 10],
        [101, 11],
        [100, 11],
        [100, 10],
      ],
    ],
  },
  properties: {
    id,
    startTime: `${date}T00:00:00Z`,
    track,
    frame,
    acquisitionGeometry: `${orbit}|T${track}|F${frame}`,
    product,
    orbitDirection: orbit,
    dataMaturity: maturity,
    provinceIds: ["THA-10"],
  },
});

test("distinct granules are counted once while processing versions remain distinct", () => {
  assert.deepEqual(
    dedupeFeatures([
      f("P05023", "2026-01-01"),
      f("P05023", "2026-01-01"),
      f("P05036", "2026-01-01"),
    ]).map((x) => x.id),
    ["P05023", "P05036"],
  );
});

test("all-track and same-acquisition-geometry gaps are independent", () => {
  const result = gapStats([
    f("a", "2026-01-01", "1", "9"),
    f("b", "2026-01-05", "2", "9"),
    f("c", "2026-01-11", "1", "9"),
  ]);
  assert.equal(result.allTrack.days, 6);
  assert.equal(result.sameGeometry.days, 10);
  assert.equal(result.sameGeometry.track, "1");
  assert.equal(result.sameGeometry.frame, "9");
});

test("different frames on one track are never combined", () => {
  const result = gapStats([
    f("a", "2026-01-01", "112", "8"),
    f("b", "2026-01-20", "112", "9"),
    f("c", "2026-01-13", "112", "8"),
  ]);
  assert.equal(result.sameGeometry.days, 12);
  assert.equal(result.sameGeometry.frame, "8");
});

test("unknown geometry fields are excluded from repeat-gap calculation", () => {
  const a = f("a", "2026-01-01", "UNKNOWN", "UNKNOWN");
  a.properties.acquisitionGeometry = "UNKNOWN";
  const b = f("b", "2026-01-20", "UNKNOWN", "UNKNOWN");
  b.properties.acquisitionGeometry = "UNKNOWN";
  assert.equal(gapStats([a, b]).sameGeometry, null);
  assert.equal(acquisitionGeometryKey(a.properties), null);
});

test("filters combine metadata, maturity, date, and spatial intersection", () => {
  const filters = {
    products: new Set(["GCOV"]),
    orbits: new Set(["ASCENDING"]),
    maturities: new Set(["VALIDATED"]),
    start: "2026-01-01",
    end: "2026-01-31",
    provinceId: "THA-10",
    aoi: {},
  };
  assert.equal(
    matchesFilters(f("a", "2026-01-02"), filters, () => true),
    true,
  );
  assert.equal(
    matchesFilters(f("b", "2026-02-02"), filters, () => true),
    false,
  );
  assert.equal(
    matchesFilters(
      f("c", "2026-01-02", "1", "1", "GCOV", "ASCENDING", "PROVISIONAL"),
      filters,
      () => true,
    ),
    false,
  );
  assert.equal(
    matchesFilters(f("d", "2026-01-02"), filters, () => false),
    false,
  );
  const wrongProvince = f("e", "2026-01-02");
  wrongProvince.properties.provinceIds = ["THA-20"];
  assert.equal(
    matchesFilters(wrongProvince, { ...filters, aoi: null }, () => true),
    false,
  );
});

test("spatial predicate is invoked only with AOI", () => {
  let calls = 0;
  const filters = {
    products: new Set(),
    orbits: new Set(),
    maturities: new Set(),
    start: "",
    end: "",
    provinceId: "",
    aoi: null,
  };
  assert.equal(
    matchesFilters(f("a", "2026-01-02"), filters, () => {
      calls++;
      return false;
    }),
    true,
  );
  assert.equal(calls, 0);
});

test("province labels remove only a trailing Province suffix", () => {
  assert.equal(cleanProvinceName("Amnat Charoen Province"), "Amnat Charoen");
  assert.equal(cleanProvinceName("Bangkok"), "Bangkok");
  assert.equal(cleanProvinceName("Province Road"), "Province Road");
});

test("province and custom AOI transitions are mutually exclusive", () => {
  let state = { mode: "thailand", provinceId: "" };
  state = transitionSpatialSelection(state, {
    type: "SELECT_PROVINCE",
    provinceId: "THA-50",
  });
  assert.deepEqual(state, { mode: "province", provinceId: "THA-50" });
  state = transitionSpatialSelection(state, { type: "DRAW_AOI" });
  assert.deepEqual(state, { mode: "custom", provinceId: "" });
  state = transitionSpatialSelection(state, {
    type: "SELECT_PROVINCE",
    provinceId: "THA-10",
  });
  assert.deepEqual(state, { mode: "province", provinceId: "THA-10" });
});

test("All Thailand, clear AOI, and reset return to Thailand state", () => {
  const province = { mode: "province", provinceId: "THA-10" },
    custom = { mode: "custom", provinceId: "" };
  assert.deepEqual(
    transitionSpatialSelection(province, {
      type: "SELECT_PROVINCE",
      provinceId: "",
    }),
    { mode: "thailand", provinceId: "" },
  );
  assert.deepEqual(transitionSpatialSelection(custom, { type: "CLEAR_AOI" }), {
    mode: "thailand",
    provinceId: "",
  });
  assert.deepEqual(transitionSpatialSelection(province, { type: "RESET" }), {
    mode: "thailand",
    provinceId: "",
  });
});

test("province boundaries remain clickable without intercepting polygon interiors", () => {
  assert.ok(PANE_ORDER.province > PANE_ORDER.scene);
  assert.equal(PROVINCE_POINTER_EVENTS, "stroke");
  assert.ok(PANE_ORDER.selection > PANE_ORDER.scene);
});

test("pagination clamps pages without dropping or duplicating results", () => {
  const source = Array.from({ length: 45 }, (_, i) => i + 1);
  assert.deepEqual(paginate(source, 1, 20).items, source.slice(0, 20));
  assert.deepEqual(paginate(source, 3, 20).items, source.slice(40));
  assert.equal(paginate(source, 99, 20).page, 3);
  assert.equal(
    new Set([1, 2, 3].flatMap((page) => paginate(source, page, 20).items)).size,
    45,
  );
});

test("timeline counts granules while keeping acquisition dates distinct", () => {
  const features = [
    f("a", "2026-06-01", "1", "1", "GCOV"),
    f("b", "2026-06-01", "1", "1", "GSLC"),
    f("c", "2026-06-13", "1", "1", "RSLC"),
  ];
  const result = timelineSummary(features);
  assert.equal(result.granules, 3);
  assert.equal(result.uniqueDates, 2);
  assert.equal(result.entries[0].count, 2);
  assert.deepEqual(result.entries[0].products, { GCOV: 1, GSLC: 1 });
});

test("timeline positions and monthly ticks use proportional UTC spacing", () => {
  assert.equal(timelinePosition("2026-01-16", "2026-01-01", "2026-01-31"), 0.5);
  assert.deepEqual(monthlyTicks("2026-01-15", "2026-04-12"), [
    "2026-02-01",
    "2026-03-01",
    "2026-04-01",
  ]);
});

test("timeline has a stable empty-data summary", () => {
  assert.deepEqual(timelineSummary([]), {
    entries: [],
    uniqueDates: 0,
    granules: 0,
    first: null,
    last: null,
    maxCount: 0,
  });
});

test("timeline date selection restores the preceding range after repeated selection", () => {
  const first = beginTimelineDateSelection(
    { start: "2026-07-01", end: "2026-09-30" },
    "2026-07-10",
  );
  assert.deepEqual(first.range, { start: "2026-07-10", end: "2026-07-10" });
  const repeated = beginTimelineDateSelection(
    first.range,
    "2026-07-10",
    first.previous,
  );
  assert.deepEqual(repeated.previous, {
    start: "2026-07-01",
    end: "2026-09-30",
  });
  assert.deepEqual(clearTimelineDateSelection(repeated.previous), {
    start: "2026-07-01",
    end: "2026-09-30",
  });
  assert.deepEqual(clearTimelineDateSelection(), { start: "", end: "" });
});
