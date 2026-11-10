import {
  PANE_ORDER,
  PROVINCE_POINTER_EVENTS,
  beginTimelineDateSelection,
  clearTimelineDateSelection,
  cleanProvinceName,
  dedupeFeatures,
  gapStats,
  matchesFilters,
  monthlyTicks,
  paginate,
  timelinePosition,
  timelineSummary,
  transitionSpatialSelection,
} from "./logic.js";

const $ = (selector) => document.querySelector(selector);
const PRODUCT_COLORS = { GCOV: "#0d6157", GSLC: "#e86d38", RSLC: "#596cb3" },
  PAGE_SIZE = 20;
const state = {
  scenes: [],
  filtered: [],
  provinces: null,
  provinceLayer: null,
  selectedProvinceLayer: null,
  sceneLayer: null,
  sceneLayers: new Map(),
  drawn: null,
  status: null,
  drawing: false,
  spatial: { mode: "thailand", provinceId: "" },
  selectedSceneId: null,
  page: 1,
  visibleProducts: new Set(Object.keys(PRODUCT_COLORS)),
  timelinePreviousRange: null,
  timelineSelectedDate: null,
};
const map = L.map("map", { zoomControl: false, preferCanvas: false }).setView(
  [13.1, 101.4],
  6,
);
for (const [name, z] of Object.entries(PANE_ORDER))
  map.createPane(`${name}Pane`).style.zIndex = String(z);
L.control.zoom({ position: "bottomright" }).addTo(map);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 18,
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);

const customAOIStyle = {
  color: "#7b2cbf",
  weight: 3,
  opacity: 1,
  dashArray: "8 5",
  fillColor: "#b56de2",
  fillOpacity: 0.14,
};
const drawnGroup = new L.FeatureGroup().addTo(map);
map.addControl(
  new L.Control.Draw({
    position: "topright",
    draw: {
      polyline: false,
      circle: false,
      circlemarker: false,
      marker: false,
      polygon: {
        allowIntersection: false,
        showArea: true,
        shapeOptions: { ...customAOIStyle, pane: "customAoiPane" },
      },
      rectangle: { shapeOptions: { ...customAOIStyle, pane: "customAoiPane" } },
    },
    edit: { featureGroup: drawnGroup, remove: true },
  }),
);
const legend = L.control({ position: "bottomleft" });
legend.onAdd = () => {
  const div = L.DomUtil.create("div", "map-legend");
  div.innerHTML =
    '<strong>Map layers</strong><span><i class="province-key"></i>Selected province</span><span><i class="aoi-key"></i>Custom AOI</span><span><i class="gcov"></i>GCOV footprint</span><span><i class="gslc"></i>GSLC footprint</span><span><i class="rslc"></i>RSLC footprint</span>';
  return div;
};
legend.addTo(map);

function afterLayoutChange() {
  requestAnimationFrame(() =>
    setTimeout(() => map.invalidateSize({ pan: false }), 180),
  );
}
function fitThailand() {
  if (state.provinceLayer) {
    map.fitBounds(state.provinceLayer.getBounds(), {
      padding: [12, 12],
      maxZoom: 7,
    });
    afterLayoutChange();
  }
}
if ("ResizeObserver" in window)
  new ResizeObserver(() => map.invalidateSize({ pan: false })).observe(
    $("#map"),
  );
function provinceById(id) {
  return state.provinces?.features?.find(
    (item) => String(item.properties.id) === String(id),
  );
}
function removeProvinceHighlight() {
  if (state.selectedProvinceLayer) {
    state.selectedProvinceLayer.remove();
    state.selectedProvinceLayer = null;
  }
}
function showProvinceHighlight(feature) {
  removeProvinceHighlight();
  state.selectedProvinceLayer = L.geoJSON(feature, {
    pane: "selectionPane",
    interactive: false,
    style: {
      color: "#f06d24",
      weight: 3,
      opacity: 1,
      fillColor: "#f59d62",
      fillOpacity: 0.14,
    },
  }).addTo(map);
}
function clearDrawnAOI() {
  drawnGroup.clearLayers();
  state.drawn = null;
}
function updateSpatialUI() {
  const status = $("#aoi-status"),
    clear = $("#clear-aoi");
  if (state.spatial.mode === "custom") {
    status.textContent = "Custom AOI selected";
    status.className = "aoi-status custom";
    clear.classList.remove("hidden");
  } else if (state.spatial.mode === "province") {
    const feature = provinceById(state.spatial.provinceId),
      name = cleanProvinceName(feature?.properties?.name);
    status.textContent = `Selected province: ${name}`;
    status.className = "aoi-status province";
    clear.classList.add("hidden");
  } else {
    status.textContent = "Select a province or draw an area on the map.";
    status.className = "aoi-status";
    clear.classList.add("hidden");
  }
}
function selectProvince(provinceId, { fit = true } = {}) {
  clearDrawnAOI();
  removeProvinceHighlight();
  state.spatial = transitionSpatialSelection(state.spatial, {
    type: "SELECT_PROVINCE",
    provinceId,
  });
  $("#province").value = state.spatial.provinceId;
  const feature = provinceById(state.spatial.provinceId);
  if (feature) {
    showProvinceHighlight(feature);
    if (fit)
      map.fitBounds(state.selectedProvinceLayer.getBounds(), {
        padding: [28, 28],
        maxZoom: 9,
      });
  } else if (fit) fitThailand();
  updateSpatialUI();
  state.page = 1;
  render();
}
function setDrawing(active) {
  state.drawing = active;
  for (const pane of ["provincePane", "scenePane"])
    map.getPane(pane).style.pointerEvents = active ? "none" : "";
}
map.on(L.Draw.Event.DRAWSTART, () => setDrawing(true));
map.on(L.Draw.Event.DRAWSTOP, () => setDrawing(false));
map.on(L.Draw.Event.CREATED, (event) => {
  clearDrawnAOI();
  removeProvinceHighlight();
  event.layer.options.pane = "customAoiPane";
  event.layer.setStyle?.(customAOIStyle);
  drawnGroup.addLayer(event.layer);
  state.drawn = event.layer.toGeoJSON();
  state.spatial = transitionSpatialSelection(state.spatial, {
    type: "DRAW_AOI",
  });
  $("#province").value = "";
  updateSpatialUI();
  state.page = 1;
  render();
});
map.on(L.Draw.Event.DELETED, () => {
  state.drawn = null;
  state.spatial = transitionSpatialSelection(state.spatial, {
    type: "CLEAR_AOI",
  });
  $("#province").value = "";
  updateSpatialUI();
  fitThailand();
  state.page = 1;
  render();
});
map.on(L.Draw.Event.EDITED, (event) => {
  event.layers.eachLayer((layer) => {
    layer.setStyle?.(customAOIStyle);
    state.drawn = layer.toGeoJSON();
  });
  state.page = 1;
  render();
});

function escapeHtml(value) {
  return String(value ?? "—").replace(
    /[&<>'"]/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[
        char
      ],
  );
}
function optionGroup(element, values) {
  element.innerHTML = "";
  [...new Set(values)].sort().forEach((value) => {
    const label = document.createElement("label");
    label.className = "check";
    label.innerHTML = `<input type="checkbox" value="${escapeHtml(value)}"><span>${escapeHtml(value)}</span>`;
    element.append(label);
  });
}
function selected(id) {
  return new Set(
    [...document.querySelectorAll(`#${id} input:checked`)].map(
      (input) => input.value,
    ),
  );
}
function filters() {
  return {
    products: selected("product-options"),
    orbits: selected("orbit-options"),
    maturities: selected("maturity-options"),
    start: $("#date-start").value,
    end: $("#date-end").value,
    provinceId:
      state.spatial.mode === "province" ? state.spatial.provinceId : "",
    aoi: state.spatial.mode === "custom" ? state.drawn : null,
  };
}
function sourceLinks(p) {
  const links = [];
  if (p.metadataUrl)
    links.push(
      `<a href="${escapeHtml(p.metadataUrl)}" target="_blank" rel="noopener">View ASF metadata <span aria-hidden="true">↗</span></a>`,
    );
  if (p.downloadUrl)
    links.push(
      `<a class="download-link" href="${escapeHtml(p.downloadUrl)}" target="_blank" rel="noopener">Download HDF5 product <span aria-hidden="true">↗</span></a>`,
    );
  return links.join("");
}
function baseSceneStyle(feature) {
  const active = String(feature.id) === String(state.selectedSceneId),
    color = PRODUCT_COLORS[feature.properties.product] || "#596cb3";
  return {
    color,
    weight: active ? 4 : 0.8,
    opacity: active ? 1 : 0.72,
    fillColor: color,
    fillOpacity: active ? 0.22 : 0.035,
    className: active ? "scene-footprint selected" : "scene-footprint",
  };
}
function setLayerStyle(layer, mode = "base") {
  if (!layer) return;
  const active = String(layer.feature.id) === String(state.selectedSceneId),
    base = baseSceneStyle(layer.feature);
  layer.setStyle(
    mode === "hover" && !active
      ? { ...base, weight: 2.5, opacity: 1, fillOpacity: 0.12 }
      : base,
  );
  layer.getElement()?.classList.toggle("selected", active);
  if (mode !== "base" || active) layer.bringToFront();
}
function selectScene(id, { fit = false, scrollDetails = false } = {}) {
  const previous = state.sceneLayers.get(String(state.selectedSceneId));
  state.selectedSceneId = id ? String(id) : null;
  if (previous) setLayerStyle(previous);
  if (state.selectedSceneId) {
    const index = state.filtered.findIndex(
      (item) => String(item.id) === state.selectedSceneId,
    );
    if (index >= 0) state.page = Math.floor(index / PAGE_SIZE) + 1;
  }
  const layer = state.sceneLayers.get(String(state.selectedSceneId));
  if (layer) {
    setLayerStyle(layer);
    if (fit)
      map.fitBounds(layer.getBounds(), { maxZoom: 9, padding: [40, 40] });
  }
  updateDetails();
  updateList(state.filtered);
  if (scrollDetails)
    $("#scene-details").scrollIntoView({
      behavior: "smooth",
      block: "nearest",
    });
}

function updateDetails() {
  const panel = $("#scene-details"),
    feature = state.scenes.find(
      (item) => String(item.id) === String(state.selectedSceneId),
    );
  if (!feature) {
    panel.classList.add("hidden");
    panel.innerHTML = "";
    return;
  }
  const p = feature.properties;
  panel.classList.remove("hidden");
  panel.innerHTML = `<div class="details-heading"><div><span class="eyebrow">SELECTED SCENE</span><h2>${escapeHtml(p.product)} · ${escapeHtml(p.startTime)}</h2></div><button type="button" class="icon-button" id="close-details" aria-label="Close scene details">×</button></div><div class="details-grid"><div><span>Orbit</span><strong>${escapeHtml(p.orbitDirection)}</strong></div><div><span>Track / frame</span><strong>${escapeHtml(p.track)} / ${escapeHtml(p.frame)}</strong></div><div><span>Maturity</span><strong>${escapeHtml(p.dataMaturity)}</strong></div><div><span>Production</span><strong>${escapeHtml(p.productionConfiguration)}</strong></div><div class="wide"><span>Collection</span><strong>${escapeHtml(p.collection)}</strong></div><div class="wide"><span>Granule ID</span><code>${escapeHtml(p.granuleName)}</code><button type="button" class="copy-button" data-copy="${escapeHtml(p.granuleName)}">Copy ID</button></div></div><div class="details-links">${sourceLinks(p)}</div>`;
  $("#close-details").addEventListener("click", () => selectScene(null));
  panel
    .querySelector(".copy-button")
    .addEventListener("click", async (event) => {
      await navigator.clipboard.writeText(event.currentTarget.dataset.copy);
      event.currentTarget.textContent = "Copied";
    });
}

function render() {
  const current = filters();
  state.filtered = state.scenes.filter((feature) =>
    matchesFilters(feature, current, (a, b) => {
      try {
        return turf.booleanIntersects(a, b);
      } catch {
        return false;
      }
    }),
  );
  if (
    state.selectedSceneId &&
    !state.filtered.some((f) => String(f.id) === String(state.selectedSceneId))
  )
    state.selectedSceneId = null;
  if (state.sceneLayer) state.sceneLayer.remove();
  state.sceneLayers.clear();
  const mapped = state.filtered.filter((feature) =>
    state.visibleProducts.has(feature.properties.product),
  );
  state.sceneLayer = L.geoJSON(
    { type: "FeatureCollection", features: mapped },
    {
      pane: "scenePane",
      style: baseSceneStyle,
      onEachFeature: (feature, layer) => {
        state.sceneLayers.set(String(feature.id), layer);
        layer.on({
          mouseover: () => setLayerStyle(layer, "hover"),
          mouseout: () => setLayerStyle(layer),
          click: (event) => {
            L.DomEvent.stopPropagation(event);
            selectScene(feature.id);
          },
        });
      },
    },
  ).addTo(map);
  updateStats(state.filtered);
  updateTimeline(state.filtered);
  updateActiveFilters(current);
  updateDetails();
  updateList(state.filtered);
}
function updateStats(features) {
  const gaps = gapStats(features),
    same = gaps.sameGeometry;
  $("#scene-count").textContent = features.length.toLocaleString();
  $("#date-count").textContent = gaps.dates.length.toLocaleString();
  $("#date-range").textContent = gaps.dates.length
    ? `${gaps.dates[0]} / ${gaps.dates.at(-1)}`
    : "—";
  $("#all-gap").textContent = gaps.allTrack
    ? `${gaps.allTrack.days} days`
    : "—";
  $("#all-gap-detail").textContent = gaps.allTrack
    ? `${gaps.allTrack.from} → ${gaps.allTrack.to}`
    : "Fewer than two acquisition dates";
  $("#geometry-gap").textContent = same ? `${same.days} days` : "—";
  $("#geometry-gap-detail").textContent = same
    ? `${same.direction} · Track ${same.track} · Frame ${same.frame} · ${same.from} → ${same.to}`
    : "No geometry has two acquisition dates";
}

function updateTimeline(features) {
  const summary = timelineSummary(features);
  const chart = $("#timeline-chart");
  const gap = gapStats(features).allTrack;
  const selectedDate =
    $("#date-start").value && $("#date-start").value === $("#date-end").value
      ? $("#date-start").value
      : "";
  $("#clear-timeline-date").classList.toggle("hidden", !selectedDate);
  $("#clear-timeline-date").textContent = state.timelinePreviousRange
    ? "Restore previous date range"
    : "Clear selected date";
  if (!summary.entries.length) {
    $("#timeline-summary").textContent = "0 acquisition dates · 0 granules";
    $("#timeline-gap-note").textContent =
      "No cataloged acquisition dates match the current filters.";
    chart.innerHTML =
      '<div class="timeline-empty"><strong>No timeline data</strong><span>Adjust the area, date, product, orbit, or maturity filters.</span></div>';
    return;
  }
  $("#timeline-summary").textContent =
    `${summary.uniqueDates.toLocaleString()} distinct acquisition dates · ` +
    `${summary.granules.toLocaleString()} granules · ${summary.first} → ${summary.last}`;
  $("#timeline-gap-note").textContent = gap
    ? `Largest observed all-track catalog gap: ${gap.days} days (${gap.from} → ${gap.to}). Not a local AOI revisit interval.`
    : "Fewer than two distinct acquisition dates; no all-track catalog gap can be calculated.";

  const width = 1000,
    height = 172,
    left = 34,
    right = 18,
    top = 16,
    baseline = 126,
    plotWidth = width - left - right,
    plotHeight = baseline - top;
  const x = (date) =>
    left + timelinePosition(date, summary.first, summary.last) * plotWidth;
  const barWidth = Math.max(
    5,
    Math.min(11, plotWidth / Math.max(8, summary.entries.length) - 3),
  );
  const gapBands = [];
  for (let index = 1; index < summary.entries.length; index += 1) {
    const previous = summary.entries[index - 1].date;
    const current = summary.entries[index].date;
    const days = Math.round(
      (Date.parse(`${current}T00:00:00Z`) -
        Date.parse(`${previous}T00:00:00Z`)) /
        86400000,
    );
    if (days > 1) {
      const fromX = x(previous) + barWidth / 2;
      const toX = x(current) - barWidth / 2;
      gapBands.push(
        `<rect class="timeline-gap-band" x="${fromX.toFixed(2)}" y="${top}" width="${Math.max(1, toX - fromX).toFixed(2)}" height="${plotHeight}" aria-hidden="true"><title>Observed catalog gap: ${days} days, ${previous} to ${current}</title></rect>`,
      );
    }
  }
  const ticks = monthlyTicks(summary.first, summary.last)
    .map((date) => {
      const position = x(date);
      const label = new Date(`${date}T00:00:00Z`).toLocaleDateString(
        undefined,
        {
          month: "short",
          year: "2-digit",
          timeZone: "UTC",
        },
      );
      return `<line class="timeline-tick-line" x1="${position}" x2="${position}" y1="${top}" y2="${baseline + 5}"/><text class="timeline-tick-label" x="${position}" y="${baseline + 25}" text-anchor="middle">${escapeHtml(label)}</text>`;
    })
    .join("");
  const bars = summary.entries
    .map((item) => {
      const barHeight = Math.max(
        4,
        (item.count / summary.maxCount) * plotHeight,
      );
      const breakdown = Object.entries(item.products)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([product, count]) => `${product}: ${count}`)
        .join(", ");
      return `<rect class="timeline-bar${item.date === selectedDate ? " selected" : ""}" role="button" tabindex="0" data-date="${item.date}" data-count="${item.count}" data-products="${escapeHtml(breakdown)}" aria-label="${item.date}: ${item.count} granules. ${escapeHtml(breakdown)}" x="${(x(item.date) - barWidth / 2).toFixed(2)}" y="${(baseline - barHeight).toFixed(2)}" width="${barWidth.toFixed(2)}" height="${barHeight.toFixed(2)}" rx="2"><title>${item.date} · ${item.count} granules · ${escapeHtml(breakdown)}</title></rect>`;
    })
    .join("");
  chart.innerHTML = `<svg class="timeline-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Daily granule histogram across ${summary.uniqueDates} distinct UTC acquisition dates"><line class="timeline-baseline" x1="${left}" x2="${width - right}" y1="${baseline}" y2="${baseline}"/>${gapBands.join("")}${ticks}${bars}<text class="timeline-edge-label" x="${left}" y="${height - 2}">${summary.first}</text><text class="timeline-edge-label" x="${width - right}" y="${height - 2}" text-anchor="end">${summary.last}</text></svg>`;
}

function showTimelineTooltip(bar) {
  const tooltip = $("#timeline-tooltip");
  tooltip.innerHTML = `<strong>${escapeHtml(bar.dataset.date)}</strong><span>${escapeHtml(bar.dataset.count)} granules</span><span>${escapeHtml(bar.dataset.products)}</span><small>Click to filter this UTC date</small>`;
  tooltip.classList.remove("hidden");
}
function selectTimelineDate(date) {
  const selection = beginTimelineDateSelection(
    { start: $("#date-start").value, end: $("#date-end").value },
    date,
    state.timelinePreviousRange,
  );
  state.timelinePreviousRange = selection.previous;
  state.timelineSelectedDate = date;
  $("#date-start").value = selection.range.start;
  $("#date-end").value = selection.range.end;
  state.page = 1;
  render();
}
function updateActiveFilters(current) {
  const chips = [],
    add = (label, type, value = "") =>
      chips.push(
        `<button type="button" class="filter-chip" data-type="${type}" data-value="${escapeHtml(value)}" aria-label="Remove ${escapeHtml(label)} filter">${escapeHtml(label)} <span aria-hidden="true">×</span></button>`,
      );
  if (current.provinceId)
    add(
      cleanProvinceName(provinceById(current.provinceId)?.properties?.name),
      "province",
    );
  if (current.aoi) add("Custom AOI", "aoi");
  if (current.start) add(`From ${current.start}`, "start");
  if (current.end) add(`To ${current.end}`, "end");
  for (const [key, set] of [
    ["product", current.products],
    ["orbit", current.orbits],
    ["maturity", current.maturities],
  ])
    for (const value of set) add(value, key, value);
  $("#active-filters").innerHTML = chips.length
    ? chips.join("")
    : '<span class="all-data-label">All Thailand · all metadata</span>';
  $("#filter-count").textContent = String(chips.length);
}
function updateList(features) {
  const result = paginate(features, state.page, PAGE_SIZE);
  state.page = result.page;
  const list = $("#scene-list");
  list.innerHTML = "";
  $("#result-note").textContent = result.total
    ? `Showing ${result.start + 1}–${result.start + result.items.length} of ${result.total} matching granules.`
    : "No matching granules.";
  result.items.forEach((feature) => {
    const p = feature.properties,
      article = document.createElement("article");
    article.className = `scene-row${String(feature.id) === String(state.selectedSceneId) ? " selected" : ""}`;
    article.setAttribute("role", "listitem");
    article.tabIndex = 0;
    article.innerHTML = `<div class="scene-primary"><span class="product-mark ${escapeHtml(String(p.product).toLowerCase())}">${escapeHtml(p.product)}</span><strong>${escapeHtml(String(p.startTime).slice(0, 10))}</strong><span>${escapeHtml(p.orbitDirection)}</span></div><div class="scene-secondary"><span>Track ${escapeHtml(p.track)} · Frame ${escapeHtml(p.frame)}</span><span>${escapeHtml(p.dataMaturity)}</span></div><span class="scene-id">${escapeHtml(p.granuleName)}</span>`;
    const choose = () =>
      selectScene(feature.id, { fit: true, scrollDetails: true });
    article.addEventListener("click", choose);
    article.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        choose();
      }
    });
    list.append(article);
  });
  if (!features.length)
    list.innerHTML =
      '<div class="empty-state"><strong>No matching scenes</strong><p>Try removing a date, product, orbit, maturity, or area filter.</p><button type="button" class="quiet" id="empty-reset">Reset filters</button></div>';
  const nav = $("#pagination");
  nav.innerHTML = result.total
    ? `<button type="button" data-page="${result.page - 1}" ${result.page === 1 ? "disabled" : ""}>Previous</button><span>Page ${result.page} of ${result.pages}</span><button type="button" data-page="${result.page + 1}" ${result.page === result.pages ? "disabled" : ""}>Next</button>`
    : "";
  $("#empty-reset")?.addEventListener("click", () => $("#filters").reset());
}

async function load() {
  try {
    const [scenes, provinces, status] = await Promise.all([
      fetch("data/scenes.geojson").then(check),
      fetch("data/thailand-provinces.geojson").then(check),
      fetch("data/status.json").then(check),
    ]);
    state.scenes = dedupeFeatures(scenes.features || []);
    state.provinces = provinces;
    state.status = status;
    optionGroup($("#product-options"), ["GCOV", "GSLC", "RSLC"]);
    optionGroup($("#orbit-options"), [
      ...new Set(
        state.scenes.map((feature) => feature.properties.orbitDirection),
      ),
    ]);
    optionGroup($("#maturity-options"), [
      "BETA",
      "PROVISIONAL",
      "VALIDATED",
      ...state.scenes.map((feature) => feature.properties.dataMaturity),
    ]);
    const select = $("#province");
    [...(provinces.features || [])]
      .sort((a, b) =>
        cleanProvinceName(a.properties.name).localeCompare(
          cleanProvinceName(b.properties.name),
        ),
      )
      .forEach((feature) => {
        const option = document.createElement("option");
        option.value = feature.properties.id;
        option.textContent = cleanProvinceName(feature.properties.name);
        select.append(option);
      });
    if (provinces.features?.length) {
      state.provinceLayer = L.geoJSON(provinces, {
        pane: "provincePane",
        interactive: true,
        style: {
          color: "#315b55",
          weight: 0.75,
          opacity: 0.62,
          fillColor: "#6a8c86",
          fillOpacity: 0.01,
        },
        onEachFeature: (feature, layer) => {
          layer.bindTooltip(cleanProvinceName(feature.properties.name), {
            sticky: true,
          });
          layer.on("click", (event) => {
            if (state.drawing) return;
            L.DomEvent.stopPropagation(event);
            selectProvince(feature.properties.id);
          });
        },
      }).addTo(map);
      state.provinceLayer.eachLayer((layer) =>
        layer
          .getElement()
          ?.style.setProperty("pointer-events", PROVINCE_POINTER_EVENTS),
      );
      fitThailand();
    }
    const updated = status.updatedAt
      ? new Date(status.updatedAt).toLocaleString(undefined, {
          dateStyle: "medium",
          timeStyle: "short",
          timeZone: "UTC",
        }) + " UTC"
      : "Never";
    $("#updated-at").textContent = updated;
    $("#freshness-label").textContent = status.successful
      ? "Snapshot current"
      : "Snapshot incomplete";
    $("#status-dot").style.background = status.successful
      ? "#d7e64a"
      : "#e0a33c";
    $("#coverage-note").textContent =
      `ASF candidates: ${(status.retrievedGranuleCount ?? state.scenes.length).toLocaleString()} · Excluded outside Thailand: ${(status.excludedOutsideThailand ?? 0).toLocaleString()}`;
    if (status.stale || status.errors?.length) {
      $("#notice").classList.remove("hidden");
      $("#notice").dataset.state = "stale";
      $("#notice").textContent =
        "Snapshot update incomplete — showing the last available static metadata.";
    }
    updateSpatialUI();
    render();
  } catch (error) {
    $("#notice").classList.remove("hidden");
    $("#notice").dataset.state = "error";
    $("#notice").textContent =
      `Data snapshot unavailable: ${error.message}. Refresh the page or check the repository workflow.`;
  }
}
function check(response) {
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

$("#filters").addEventListener("change", (event) => {
  if (event.target.id === "date-start" || event.target.id === "date-end") {
    state.timelinePreviousRange = null;
    state.timelineSelectedDate = null;
  }
  state.page = 1;
  if (event.target.id === "province") selectProvince(event.target.value);
  else render();
});
$("#filters").addEventListener("reset", () =>
  setTimeout(() => {
    clearDrawnAOI();
    removeProvinceHighlight();
    state.spatial = transitionSpatialSelection(state.spatial, {
      type: "RESET",
    });
    state.selectedSceneId = null;
    state.timelinePreviousRange = null;
    state.timelineSelectedDate = null;
    state.page = 1;
    $("#province").value = "";
    updateSpatialUI();
    fitThailand();
    render();
  }, 0),
);
$("#clear-aoi").addEventListener("click", () => {
  clearDrawnAOI();
  removeProvinceHighlight();
  state.spatial = transitionSpatialSelection(state.spatial, {
    type: "CLEAR_AOI",
  });
  state.page = 1;
  $("#province").value = "";
  updateSpatialUI();
  fitThailand();
  render();
});
$(".layer-switcher").addEventListener("change", (event) => {
  event.target.checked
    ? state.visibleProducts.add(event.target.value)
    : state.visibleProducts.delete(event.target.value);
  render();
});
$("#pagination").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-page]");
  if (!button) return;
  state.page = Number(button.dataset.page);
  updateList(state.filtered);
  $(".results-head").scrollIntoView({ behavior: "smooth", block: "start" });
});
$("#active-filters").addEventListener("click", (event) => {
  const chip = event.target.closest(".filter-chip");
  if (!chip) return;
  const { type, value } = chip.dataset;
  if (type === "province") selectProvince("");
  else if (type === "aoi") $("#clear-aoi").click();
  else if (type === "start" || type === "end") {
    $(`#date-${type}`).value = "";
    state.page = 1;
    render();
  } else {
    document.querySelector(
      `#${type}-options input[value="${CSS.escape(value)}"]`,
    ).checked = false;
    state.page = 1;
    render();
  }
});
$("#timeline-chart").addEventListener("mouseover", (event) => {
  const bar = event.target.closest?.(".timeline-bar");
  if (bar) showTimelineTooltip(bar);
});
$("#timeline-chart").addEventListener("focusin", (event) => {
  const bar = event.target.closest?.(".timeline-bar");
  if (bar) showTimelineTooltip(bar);
});
$("#timeline-chart").addEventListener("click", (event) => {
  const bar = event.target.closest?.(".timeline-bar");
  if (bar) selectTimelineDate(bar.dataset.date);
});
$("#timeline-chart").addEventListener("keydown", (event) => {
  const bar = event.target.closest?.(".timeline-bar");
  if (bar && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    selectTimelineDate(bar.dataset.date);
  }
});
$("#timeline-chart").addEventListener("mouseleave", () =>
  $("#timeline-tooltip").classList.add("hidden"),
);
$("#clear-timeline-date").addEventListener("click", () => {
  const restored = clearTimelineDateSelection(state.timelinePreviousRange);
  $("#date-start").value = restored.start;
  $("#date-end").value = restored.end;
  state.timelinePreviousRange = null;
  state.timelineSelectedDate = null;
  state.page = 1;
  $("#timeline-tooltip").classList.add("hidden");
  render();
});
const panel = $("#filter-panel"),
  backdrop = $("#filter-backdrop"),
  openButton = $("#open-filters"),
  closeButton = $("#close-filters");
let filterReturnFocus = null;
function setMobileFilters(open) {
  panel.classList.toggle("mobile-open", open);
  backdrop.classList.toggle("hidden", !open);
  openButton.setAttribute("aria-expanded", String(open));
  panel.setAttribute(
    "aria-hidden",
    String(!open && matchMedia("(max-width: 900px)").matches),
  );
  document.body.classList.toggle("filters-open", open);
  if (open) {
    filterReturnFocus = document.activeElement;
    closeButton.focus();
  } else filterReturnFocus?.focus();
  afterLayoutChange();
}
openButton.addEventListener("click", () => setMobileFilters(true));
closeButton.addEventListener("click", () => setMobileFilters(false));
backdrop.addEventListener("click", () => setMobileFilters(false));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && panel.classList.contains("mobile-open"))
    setMobileFilters(false);
});
$("#toggle-sidebar").addEventListener("click", (event) => {
  const collapsed = document.body.classList.toggle("sidebar-collapsed");
  event.currentTarget.textContent = collapsed ? "Show filters" : "Hide filters";
  event.currentTarget.setAttribute("aria-expanded", String(!collapsed));
  panel.setAttribute("aria-hidden", String(collapsed));
  afterLayoutChange();
});
load();
