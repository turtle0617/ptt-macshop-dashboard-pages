const DATA = window.MACSHOP_DATA || {};
const $ = (id) => document.getElementById(id);

const FILTER_CONFIG = {
  family: { field: "family", formatter: value => value, numeric: false },
  year: { field: "model_year", formatter: value => value, numeric: false },
  chip: { field: "chip", formatter: value => value, numeric: false },
  storage: { field: "storage_gb", formatter: value => formatStorage(Number(value)), numeric: true },
  memory: { field: "memory_gb", formatter: value => `${value}GB`, numeric: true }
};
const FILTER_IDS = Object.keys(FILTER_CONFIG);
const DEFAULT_PAGE_SIZE = 50;
const MAX_CHART_POINTS = 800;
const DAY_MS = 24 * 60 * 60 * 1000;

const state = {
  records: Array.isArray(DATA.listings) ? DATA.listings : [],
  filters: {
    family: new Set(),
    year: new Set(),
    chip: new Set(),
    storage: new Set(),
    memory: new Set()
  },
  sortKey: "published_at",
  sortDir: "desc",
  page: 1,
  pageSize: DEFAULT_PAGE_SIZE,
  dateRange: { min: "", max: "" },
  filteredRows: []
};

let marketChart;
let specChart;
let searchTimer;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatPrice(value) {
  return value == null ? "-" : `NT$${Number(value).toLocaleString("zh-TW")}`;
}

function formatStorage(gb) {
  return Number(gb) >= 1024 ? `${Number(gb) / 1024}TB` : `${gb}GB`;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function average(values) {
  if (!values.length) return null;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function parseCurrentFilters() {
  return {
    family: state.filters.family,
    year: state.filters.year,
    chip: state.filters.chip,
    storage: state.filters.storage,
    memory: state.filters.memory,
    search: $("search").value.trim().toLowerCase(),
    minPrice: Number($("minPrice").value || 0),
    maxPrice: Number($("maxPrice").value || Infinity),
    dateFrom: $("dateFrom").value || "0000-01-01",
    dateTo: $("dateTo").value || "9999-12-31"
  };
}

function matchesSearch(row, search) {
  if (!search) return true;
  const haystack = `${row.title} ${row.family} ${row.model_year} ${row.chip} ${row.memory_gb} ${row.storage_gb} ${row.location}`.toLowerCase();
  return haystack.includes(search);
}

function matchesFilters(row, filters, excludeId = null) {
  for (const id of FILTER_IDS) {
    if (excludeId === id) continue;
    const selected = filters[id];
    if (!selected.size) continue;
    const value = String(row[FILTER_CONFIG[id].field]);
    if (!selected.has(value)) return false;
  }
  return matchesSearch(row, filters.search)
    && Number(row.price_ntd) >= filters.minPrice
    && Number(row.price_ntd) <= filters.maxPrice
    && String(row.published_at) >= filters.dateFrom
    && String(row.published_at) <= filters.dateTo;
}

function matchesScalarFilters(row, filters) {
  return matchesSearch(row, filters.search)
    && Number(row.price_ntd) >= filters.minPrice
    && Number(row.price_ntd) <= filters.maxPrice
    && String(row.published_at) >= filters.dateFrom
    && String(row.published_at) <= filters.dateTo;
}

function optionSort(id) {
  if (FILTER_CONFIG[id].numeric) {
    return (a, b) => Number(a.value) - Number(b.value);
  }
  return (a, b) => String(a.value).localeCompare(String(b.value), "zh-Hant");
}

function buildFacets(records, filters) {
  const facets = {};
  for (const id of FILTER_IDS) {
    const field = FILTER_CONFIG[id].field;
    const counts = new Map();
    for (const row of records) {
      if (!matchesFilters(row, filters, id)) continue;
      const value = String(row[field]);
      counts.set(value, (counts.get(value) || 0) + 1);
    }
    facets[id] = [...counts.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort(optionSort(id));
  }
  return facets;
}

function buildStats(rows) {
  const prices = rows.map(row => Number(row.price_ntd)).filter(Number.isFinite);
  return {
    count: rows.length,
    median: median(prices),
    average: average(prices),
    min: prices.length ? Math.min(...prices) : null,
    max: prices.length ? Math.max(...prices) : null
  };
}

function hasExactSpecSelected() {
  return ["family", "chip", "storage", "memory"].every(id => state.filters[id].size === 1);
}

function point(row, label) {
  return {
    x: Date.parse(row.published_at),
    y: Number(row.price_ntd),
    label,
    article_id: row.article_id,
    title: row.title,
    year: row.model_year,
    spec: `${row.family} ${row.model_year} ${row.chip} ${row.memory_gb}GB/${formatStorage(row.storage_gb)}`,
    url: row.url
  };
}

function comparableSpecLabel(row) {
  return `${row.family} ${row.chip} ${row.memory_gb}GB/${formatStorage(row.storage_gb)}`;
}

function hasActiveFilters(filters) {
  return FILTER_IDS.some(id => filters[id].size > 0)
    || Boolean(filters.search)
    || filters.minPrice > 0
    || Number.isFinite(filters.maxPrice)
    || filters.dateFrom !== (state.dateRange.min || "0000-01-01")
    || filters.dateTo !== (state.dateRange.max || "9999-12-31");
}

function spreadSameDayPoints(points) {
  const buckets = new Map();
  for (const p of points) {
    const date = new Date(p.x).toISOString().slice(0, 10);
    const key = `${p.label}|${date}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(p);
  }

  return [...buckets.values()].flatMap(items => {
    const sorted = [...items].sort((a, b) => {
      const aid = Number(a.article_id?.match(/^M\.(\d+)\./)?.[1] || 0);
      const bid = Number(b.article_id?.match(/^M\.(\d+)\./)?.[1] || 0);
      return aid - bid || a.y - b.y;
    });
    return sorted.map((item, index) => ({
      ...item,
      displayX: item.x + ((index + 1) / (sorted.length + 1)) * DAY_MS
    }));
  }).sort((a, b) => a.displayX - b.displayX);
}

function compactChart(points) {
  if (points.length <= MAX_CHART_POINTS) return { mode: "raw", points };
  const buckets = new Map();
  for (const p of points) {
    const date = new Date(p.x).toISOString().slice(0, 10);
    const key = `${p.label}|${date}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(p);
  }
  return {
    mode: "daily-median",
    points: [...buckets.entries()].map(([key, items]) => {
      const [label, date] = key.split("|");
      const prices = items.map(item => item.y);
      return {
        x: Date.parse(date),
        y: median(prices),
        label,
        title: `${items.length} posts`,
        spec: label,
        min: Math.min(...prices),
        max: Math.max(...prices),
        count: items.length
      };
    }).sort((a, b) => a.x - b.x)
  };
}

function buildMarketChart(rows, filters = parseCurrentFilters()) {
  const useComparableSpecColors = hasActiveFilters(filters);
  const points = rows
    .filter(row => Number.isFinite(Number(row.price_ntd)) && Date.parse(row.published_at))
    .sort((a, b) => Date.parse(a.published_at) - Date.parse(b.published_at))
    .map(row => point(row, useComparableSpecColors ? comparableSpecLabel(row) : row.family));
  return compactChart(points);
}

function buildSameSpecChart(rows) {
  if (!hasExactSpecSelected()) {
    return { state: "needs_exact_spec", mode: "raw", points: [] };
  }
  const selectedFamily = [...state.filters.family][0];
  const selectedChip = [...state.filters.chip][0];
  const selectedMemory = [...state.filters.memory][0];
  const selectedStorage = [...state.filters.storage][0];
  const scalarFilters = parseCurrentFilters();
  const sameSpecRows = state.records.filter(row =>
    row.family === selectedFamily
    && row.chip === selectedChip
    && String(row.memory_gb) === selectedMemory
    && String(row.storage_gb) === selectedStorage
    && matchesScalarFilters(row, scalarFilters)
  );
  const label = `${selectedFamily} ${selectedChip} ${selectedMemory}GB/${formatStorage(selectedStorage)}`;
  const points = sameSpecRows
    .filter(row => Number.isFinite(Number(row.price_ntd)) && Date.parse(row.published_at))
    .sort((a, b) => Date.parse(a.published_at) - Date.parse(b.published_at))
    .map(row => point(row, label));
  return { state: points.length ? "ready" : "empty", mode: "raw", points: spreadSameDayPoints(points) };
}

function specLabel(parts, count) {
  return `${parts[0]} ${parts[1]} ${parts[2]}GB/${formatStorage(parts[3])} - ${count} posts`;
}

function buildSpecs(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = [row.family, row.chip, row.memory_gb, row.storage_gb].map(String).join("|");
    if (!groups.has(key)) groups.set(key, { key, count: 0, parts: key.split("|") });
    groups.get(key).count += 1;
  }
  return [...groups.values()]
    .map(group => ({ value: group.key, label: specLabel(group.parts, group.count), count: group.count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "zh-Hant"));
}

function sortRows(rows) {
  const dir = state.sortDir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = a[state.sortKey];
    const bv = b[state.sortKey];
    if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
    return String(av).localeCompare(String(bv), "zh-Hant") * dir;
  });
}

function paginateRows(rows) {
  const totalPages = Math.max(1, Math.ceil(rows.length / state.pageSize));
  if (state.page > totalPages) state.page = totalPages;
  const start = (state.page - 1) * state.pageSize;
  return {
    rows: rows.slice(start, start + state.pageSize),
    pagination: { page: state.page, pageSize: state.pageSize, total: rows.length, totalPages }
  };
}

function populateMultiFilter(id, options) {
  const container = $(id);
  const current = state.filters[id] || new Set();
  const validValues = new Set(options.map(option => String(option.value)));
  current.forEach(value => {
    if (!validValues.has(value)) current.delete(value);
  });
  container.innerHTML = options.map(option => {
    const value = String(option.value);
    const checked = current.has(value) ? "checked" : "";
    const label = `${FILTER_CONFIG[id].formatter(value)} (${option.count})`;
    return `
      <label class="multi-option">
        <input type="checkbox" value="${escapeHtml(value)}" ${checked}>
        <span>${escapeHtml(label)}</span>
      </label>
    `;
  }).join("");

  container.querySelectorAll("input[type='checkbox']").forEach(input => {
    input.addEventListener("change", () => {
      state.filters[id] = new Set(
        [...container.querySelectorAll("input[type='checkbox']:checked")].map(el => el.value)
      );
      state.page = 1;
      render();
    });
  });
}

function renderFilterOptions(facets) {
  for (const id of FILTER_IDS) populateMultiFilter(id, facets[id] || []);
}

function renderStats(stats) {
  $("statCount").textContent = stats.count;
  $("statMedian").textContent = formatPrice(stats.median);
  $("statAverage").textContent = formatPrice(stats.average);
  $("statMin").textContent = formatPrice(stats.min);
  $("statMax").textContent = formatPrice(stats.max);
  $("resultLabel").textContent = `${stats.count} results`;
}

function renderChips() {
  const chips = [];
  const multiMap = [
    ["family", "Series"],
    ["year", "Year"],
    ["chip", "Chip"],
    ["storage", "Storage"],
    ["memory", "Memory"]
  ];
  for (const [id, label] of multiMap) {
    const values = [...state.filters[id]];
    if (!values.length) continue;
    chips.push(`<span class="chip">${escapeHtml(label)}: ${escapeHtml(values.map(FILTER_CONFIG[id].formatter).join(", "))}</span>`);
  }
  for (const [id, label] of [["search", "Search"], ["minPrice", "Min"], ["maxPrice", "Max"], ["dateFrom", "From"], ["dateTo", "To"]]) {
    const value = $(id).value;
    if (!value) continue;
    const text = id === "minPrice" || id === "maxPrice" ? formatPrice(Number(value)) : value;
    chips.push(`<span class="chip">${escapeHtml(label)}: ${escapeHtml(text)}</span>`);
  }
  $("activeChips").innerHTML = chips.length ? chips.join("") : `<span class="chip">No active filters</span>`;
}

function renderSpecPreset(specs) {
  const select = $("specPreset");
  const current = select.value;
  select.innerHTML = [
    `<option value="">Choose an exact spec...</option>`,
    ...specs.map(spec => `<option value="${escapeHtml(spec.value)}">${escapeHtml(spec.label)}</option>`)
  ].join("");
  if ([...select.options].some(option => option.value === current)) select.value = current;
}

function setChartEmpty(id, isVisible, title, body) {
  const empty = $(id);
  empty.classList.toggle("is-visible", isVisible);
  if (title || body) {
    empty.innerHTML = `
      <div>
        <strong>${escapeHtml(title)}</strong>
        <span>${escapeHtml(body)}</span>
      </div>
    `;
  }
}

function chartScales() {
  return {
    x: {
      type: "linear",
      ticks: {
        color: "#94a3b8",
        maxRotation: 35,
        minRotation: 0,
        callback: value => new Date(Number(value)).toISOString().slice(5, 10)
      },
      grid: { color: "rgba(148,163,184,.12)" }
    },
    y: {
      ticks: { color: "#94a3b8", callback: value => `NT$${Number(value).toLocaleString("zh-TW")}` },
      grid: { color: "rgba(148,163,184,.12)" }
    }
  };
}

function colorForLabel(label) {
  if (label === "Air") return "#60a5fa";
  if (label === "Pro") return "#22c55e";
  let hash = 0;
  for (const char of label) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 82% 64%)`;
}

function groupedDatasets(points) {
  const grouped = new Map();
  points.forEach(chartPoint => {
    if (!grouped.has(chartPoint.label)) grouped.set(chartPoint.label, []);
    grouped.get(chartPoint.label).push({ x: chartPoint.displayX || chartPoint.x, y: chartPoint.y, point: chartPoint });
  });
  return [...grouped.entries()].map(([label, data]) => {
    const color = colorForLabel(label);
    const prices = data.map(item => item.y);
    return {
      label,
      data,
      meta: {
        min: prices.length ? Math.min(...prices) : null,
        median: median(prices),
        max: prices.length ? Math.max(...prices) : null
      },
      borderColor: color,
      backgroundColor: color,
      tension: 0.22,
      borderWidth: 2,
      showLine: data.length > 1,
      spanGaps: false,
      pointRadius: 5,
      pointHoverRadius: 7
    };
  });
}

function renderMarketChart(chartData) {
  const points = chartData.points || [];
  const ctx = $("marketChart");
  if (marketChart) {
    marketChart.destroy();
    marketChart = null;
  }
  if (!points.length) {
    setChartEmpty("marketEmpty", true, "No matching listings", "放寬篩選條件，或按 Reset 回到完整市場分布。");
    return;
  }
  setChartEmpty("marketEmpty", false);
  marketChart = new Chart(ctx, {
    type: "scatter",
    data: { datasets: groupedDatasets(points).map(dataset => ({ ...dataset, showLine: false, borderWidth: 0 })) },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      parsing: false,
      plugins: {
        legend: { labels: { color: "#cbd5e1" } },
        tooltip: {
          callbacks: {
            title: items => items[0].raw.point.title || "",
            label: item => [
              `Price: ${formatPrice(item.raw.y)}`,
              `Spec: ${item.raw.point.spec}`
            ]
          }
        }
      },
      scales: chartScales()
    }
  });
}

function renderSpecChart(chartData) {
  const points = chartData.points || [];
  const ctx = $("specChart");
  if (specChart) {
    specChart.destroy();
    specChart = null;
  }
  if (chartData.state === "needs_exact_spec") {
    setChartEmpty("specEmpty", true, "Select one comparable spec", "請先用 Quick spec，或選定 Series、Chip、Memory、Storage 各一個選項。Year 會保留在圖表點位資訊中。");
    return;
  }
  if (!points.length) {
    setChartEmpty("specEmpty", true, "No same-spec history", "目前條件沒有符合資料，請放寬價格、日期或搜尋條件。");
    return;
  }
  setChartEmpty("specEmpty", false);
  specChart = new Chart(ctx, {
    type: "line",
    data: { datasets: groupedDatasets(points) },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      parsing: false,
      plugins: {
        legend: { labels: { color: "#cbd5e1" } },
        tooltip: {
          callbacks: {
            title: items => items[0].raw.point.title || "",
            label: item => {
              const meta = item.dataset.meta;
              const point = item.raw.point;
              return [
                `Price: ${formatPrice(item.raw.y)}`,
                `Spec: ${item.dataset.label}`,
                `Year: ${point.year}`,
                `Date: ${new Date(point.x).toISOString().slice(0, 10)}`,
                `Range: ${formatPrice(meta.min)} / ${formatPrice(meta.median)} / ${formatPrice(meta.max)}`
              ];
            }
          }
        }
      },
      scales: chartScales()
    }
  });
}

function renderTable(rows) {
  const tbody = $("tbody");
  $("tableEmpty").hidden = rows.length > 0;
  tbody.innerHTML = rows.map(row => `
    <tr>
      <td class="date-cell">${escapeHtml(row.published_at)}</td>
      <td><span class="badge">${escapeHtml(row.family)}</span></td>
      <td>${escapeHtml(row.model_year)}</td>
      <td>${escapeHtml(row.chip)}</td>
      <td>${escapeHtml(row.memory_gb)}GB</td>
      <td>${escapeHtml(formatStorage(row.storage_gb))}</td>
      <td class="price">${escapeHtml(formatPrice(row.price_ntd))}</td>
      <td class="muted">${escapeHtml(row.location || "-")}</td>
      <td class="title-cell">${escapeHtml(row.title)}</td>
      <td><a href="${escapeHtml(row.url)}" target="_blank" rel="noopener noreferrer">原文</a></td>
    </tr>
  `).join("");
}

function renderPager(pagination) {
  $("pageInfo").textContent = `Page ${pagination.page} / ${pagination.totalPages}`;
  $("prevPageBtn").disabled = pagination.page <= 1;
  $("nextPageBtn").disabled = pagination.page >= pagination.totalPages;
}

function renderError(message) {
  $("activeChips").innerHTML = `<span class="chip">${escapeHtml(message)}</span>`;
  $("tableEmpty").hidden = false;
  $("tableEmpty").textContent = message;
}

function render() {
  if (!state.records.length) {
    renderError("No listing data loaded.");
    return;
  }
  const filters = parseCurrentFilters();
  const facets = buildFacets(state.records, filters);
  renderFilterOptions(facets);

  const cleanedFilters = parseCurrentFilters();
  const filtered = state.records.filter(row => matchesFilters(row, cleanedFilters));
  const sorted = sortRows(filtered);
  const page = paginateRows(sorted);
  state.filteredRows = sorted;

  renderStats(buildStats(filtered));
  renderChips();
  renderSpecPreset(buildSpecs(state.records.filter(row => matchesScalarFilters(row, cleanedFilters))));
  renderMarketChart(buildMarketChart(filtered, cleanedFilters));
  renderSpecChart(buildSameSpecChart(filtered));
  renderTable(page.rows);
  renderPager(page.pagination);
}

function resetFilters() {
  Object.values(state.filters).forEach(set => set.clear());
  ["search", "minPrice", "maxPrice"].forEach(id => {
    $(id).value = "";
  });
  $("dateFrom").value = state.dateRange.min || "";
  $("dateTo").value = state.dateRange.max || "";
  state.sortKey = "published_at";
  state.sortDir = "desc";
  state.page = 1;
  render();
}

function debounceRender() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.page = 1;
    render();
  }, 180);
}

function csvEscape(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function exportCSV() {
  const headers = ["published_at", "family", "model_year", "chip", "memory_gb", "storage_gb", "price_ntd", "location", "condition", "title", "url"];
  const csv = [
    headers.join(","),
    ...state.filteredRows.map(row => headers.map(header => csvEscape(row[header])).join(","))
  ].join("\n");
  const blob = new Blob([`\ufeff${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `macshop-listings-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function initDateRange() {
  const dates = state.records.map(row => row.published_at).filter(Boolean).sort();
  state.dateRange = { min: dates[0] || "", max: dates[dates.length - 1] || "" };
  $("dateFrom").value = state.dateRange.min;
  $("dateTo").value = state.dateRange.max;
}

function initEvents() {
  $("search").addEventListener("input", debounceRender);
  for (const id of ["minPrice", "maxPrice", "dateFrom", "dateTo"]) {
    $(id).addEventListener("input", () => {
      state.page = 1;
      render();
    });
    $(id).addEventListener("change", () => {
      state.page = 1;
      render();
    });
  }
  $("resetBtn").addEventListener("click", resetFilters);
  $("csvBtn").addEventListener("click", exportCSV);
  $("prevPageBtn").addEventListener("click", () => {
    state.page = Math.max(1, state.page - 1);
    render();
  });
  $("nextPageBtn").addEventListener("click", () => {
    state.page += 1;
    render();
  });
  $("specPreset").addEventListener("change", () => {
    const selected = $("specPreset").value;
    if (!selected) return;
    const [family, chip, memory, storage] = selected.split("|");
    Object.values(state.filters).forEach(set => set.clear());
    state.filters.family.add(family);
    state.filters.chip.add(chip);
    state.filters.memory.add(memory);
    state.filters.storage.add(storage);
    ["search", "minPrice", "maxPrice"].forEach(id => {
      $(id).value = "";
    });
    $("dateFrom").value = state.dateRange.min || "";
    $("dateTo").value = state.dateRange.max || "";
    state.page = 1;
    render();
  });
  document.querySelectorAll("th[data-sort]").forEach(th => {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      if (state.sortKey === key) {
        state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
      } else {
        state.sortKey = key;
        state.sortDir = "asc";
      }
      state.page = 1;
      render();
    });
  });
}

function init() {
  if (!window.MACSHOP_DATA || !Array.isArray(window.MACSHOP_DATA.listings)) {
    renderError("Listing data file is missing or invalid.");
    return;
  }
  initDateRange();
  initEvents();
  render();
}

init();
