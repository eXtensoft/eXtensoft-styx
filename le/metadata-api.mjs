const BASE = '/api';

async function getJson(url, label) {
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `${label} (${res.status})`);
    }
    return res.json();
}

function withFilter(params, filter) {
    if (filter.q) params.set('q', filter.q);
    if (filter.method) params.set('method', filter.method);
    if (filter.status) params.set('status', filter.status);
    if (filter.uri) params.set('uri', filter.uri);
    if (filter.minTime) params.set('minTime', filter.minTime);
    if (filter.fromTime) params.set('fromTime', filter.fromTime);
    if (filter.toTime) params.set('toTime', filter.toTime);
    if (filter.ip) params.set('ip', filter.ip);
    if (filter.agent) params.set('agent', filter.agent);
    return params;
}

const src = (id) => `${BASE}/sources/${encodeURIComponent(id)}`;

export async function fetchSources() {
    return getJson(`${BASE}/sources`, 'Failed to load sources');
}

export async function saveSources(config) {
    const res = await fetch(`${BASE}/sources`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
    });
    if (!res.ok) throw new Error(`Failed to save sources (${res.status})`);
}

export async function fetchDays(sourceId) {
    return getJson(`${src(sourceId)}/days`, 'Failed to load days');
}

export async function fetchEntries(sourceId, date, offset, limit, filter = {}) {
    const params = withFilter(new URLSearchParams({ date, offset, limit }), filter);
    return getJson(`${src(sourceId)}/entries?${params}`, 'Failed to load entries');
}

export async function fetchStats(sourceId, date, filter = {}) {
    const params = withFilter(new URLSearchParams({ date }), filter);
    return getJson(`${src(sourceId)}/stats?${params}`, 'Failed to load stats');
}

export async function fetchTrends(sourceId, dates, filter = {}) {
    const params = withFilter(new URLSearchParams({ dates: dates.join(',') }), filter);
    return getJson(`${src(sourceId)}/trends?${params}`, 'Failed to load trends');
}

export async function fetchAggregate(sourceIds, from, to, filter = {}) {
    const params = new URLSearchParams({ sources: sourceIds.join(',') });
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    withFilter(params, filter);
    return getJson(`${BASE}/aggregate/stats?${params}`, 'Failed to load aggregate');
}

export function exportEntriesUrl(sourceId, date, filter = {}) {
    const params = withFilter(new URLSearchParams({ date }), filter);
    return `${src(sourceId)}/export?${params}`;
}

export async function fetchCalendar() {
    return getJson(`${BASE}/calendar`, 'Failed to load calendar');
}

export async function fetchHeatmap(sourceIds, from, to) {
    const params = new URLSearchParams({ sources: sourceIds.join(','), from, to });
    return getJson(`${BASE}/calendar/heatmap?${params}`, 'Failed to load calendar heatmap');
}

export async function fetchHotspots() {
    return getJson(`${BASE}/hotspots`, 'Failed to load hotspots');
}
