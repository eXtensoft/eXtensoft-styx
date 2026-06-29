import { fetchSources, saveSources, fetchDays, fetchEntries, fetchStats, fetchTrends, fetchCalendar, fetchHotspots, fetchAggregate, exportEntriesUrl, fetchHeatmap } from './metadata-api.mjs';

const GROUP_FACETS = ['application', 'stage', 'server', 'type'];

export class LogExplorer {
    constructor(rootId) {
        this.root = document.getElementById(rootId);
        this.config = { version: 2, logSources: [] };
        this.dirty = false;
        this.editor = null;
        this.mode = 'hotspots';
        this.browseGroupBy = 'application';
        this.selectedSource = null;
        this.days = { loading: false, error: null, data: null };
        this.day = null;
        this.dayView = 'entries';
        this.dayOrigin = null;
        this.entries = { loading: false, error: null, data: null, offset: 0 };
        this.stats = { loading: false, error: null, data: null };
        this.detail = null;
        this.filter = emptyFilter();
        this.pageLimit = 100;
        this.selectedDays = new Set();
        this.trendDates = null;
        this.trends = { loading: false, error: null, data: null };
        this.calendar = { loading: false, error: null, data: null };
        this.calMonth = null;
        this.calScope = 'all';
        this.heatmap = { loading: false, error: null, data: null };
        this.hotspots = { loading: false, error: null, data: null };
        this.dashGroupBy = 'none';
        this.dashProblemsOnly = false;
        this.aggregate = null;
        this.tz = 'local';
    }

    async init() {
        this.root.innerHTML = `
            <div class="lx">
                <div class="lx-toolbar">
                    <h2 class="lx-title">IIS Log Explorer</h2>
                    <div class="lx-modes">
                        <button class="lx-tab" data-action="mode-hotspots">Hotspots</button>
                        <button class="lx-tab" data-action="mode-dashboard">Dashboard</button>
                        <button class="lx-tab" data-action="mode-browse">Browse</button>
                        <button class="lx-tab" data-action="mode-calendar">Calendar</button>
                        <button class="lx-tab" data-action="mode-manage">Manage</button>
                    </div>
                    <div class="lx-toolbar-actions">
                        <span class="lx-status" data-ref="status"></span>
                        <button class="lx-btn lx-btn-sm" data-action="toggle-tz" data-ref="tz" title="Toggle display timezone (UTC ⇄ local)"></button>
                        <button class="lx-btn lx-btn-primary" data-action="save" hidden>Save Changes</button>
                    </div>
                </div>
                <div class="lx-content" data-ref="content"></div>
                <div class="lx-overlay" data-ref="overlay" hidden></div>
            </div>`;

        this.contentEl = this.root.querySelector('[data-ref="content"]');
        this.statusEl = this.root.querySelector('[data-ref="status"]');
        this.saveBtn = this.root.querySelector('[data-action="save"]');
        this.overlayEl = this.root.querySelector('[data-ref="overlay"]');
        this.tzBtn = this.root.querySelector('[data-ref="tz"]');

        this.root.addEventListener('click', (e) => this.onClick(e));
        this.root.addEventListener('submit', (e) => this.onSubmit(e));

        try {
            this.config = await fetchSources();
            if (!this.config.logSources) this.config.logSources = [];
        } catch (err) {
            this.setStatus(err.message, true);
        }

        const params = new URLSearchParams(location.hash.slice(1));
        if (params.get('mode')) await this.restoreState(params);
        else if (this.mode === 'hotspots') this.loadHotspots();
        else this.render();
    }

    // ---- rendering -------------------------------------------------------

    render() {
        for (const m of ['hotspots', 'dashboard', 'browse', 'calendar', 'manage'])
            this.root.querySelector(`[data-action="mode-${m}"]`).classList.toggle('lx-tab-active', this.mode === m);

        if (this.mode === 'manage') this.renderManage();
        else if (this.mode === 'hotspots') this.renderHotspots();
        else if (this.mode === 'dashboard') this.renderDashboard();
        else if (this.mode === 'calendar') this.renderCalendar();
        else if (this.aggregate) this.renderAggregate();
        else if (this.trendDates) this.renderTrends();
        else if (this.day) this.renderDay();
        else this.renderBrowse();

        this.renderOverlay();
        this.tzBtn.textContent = this.tzLabel();
        this.saveBtn.hidden = this.mode !== 'manage';
        this.saveBtn.disabled = !this.dirty;
        this.syncUrl();
    }

    // ---- browse (faceted) ------------------------------------------------

    renderBrowse() {
        if (!this.config.logSources.length) {
            this.contentEl.innerHTML = `<p class="lx-empty">No log sources configured. Switch to Manage to add one.</p>`;
            return;
        }
        this.contentEl.innerHTML = `
            <div class="lx-browse">
                <nav class="lx-tree">
                    ${this.renderGroupBy()}
                    ${this.renderSourceGroups()}
                </nav>
                <div class="lx-days">${this.renderDaysPanel()}</div>
            </div>`;
    }

    renderGroupBy() {
        const tabs = GROUP_FACETS.map((f) =>
            `<button class="lx-gb${f === this.browseGroupBy ? ' lx-gb-active' : ''}" data-action="groupby" data-facet="${f}">${f}</button>`).join('');
        return `<div class="lx-groupby"><span class="lx-gb-label">group by</span>${tabs}</div>`;
    }

    renderSourceGroups() {
        const key = this.browseGroupBy;
        const groups = new Map();
        for (const s of this.config.logSources) {
            const g = s[key] || '(none)';
            if (!groups.has(g)) groups.set(g, []);
            groups.get(g).push(s);
        }
        return [...groups.keys()].sort().map((g) => {
            const items = groups.get(g)
                .sort((a, b) => this.sourceSubLabel(a).localeCompare(this.sourceSubLabel(b)))
                .map((s) => {
                    const sel = this.selectedSource === s.id;
                    return `<li><button class="lx-tree-app${sel ? ' lx-selected' : ''}"
                                data-action="select-source" data-source="${esc(s.id)}">${esc(this.sourceSubLabel(s))}</button></li>`;
                }).join('');
            return `
                <div class="lx-tree-server">
                    <div class="lx-tree-server-name">
                        <span>${esc(g)}</span>
                        <button class="lx-link lx-analyze" data-action="analyze-group" data-group="${esc(g)}" title="Aggregate analytics across this group">Analyze →</button>
                    </div>
                    <ul>${items}</ul>
                </div>`;
        }).join('');
    }

    renderDaysPanel() {
        if (!this.selectedSource) return `<p class="lx-empty">Select a log source to see available days.</p>`;

        const src = this.source(this.selectedSource);
        const label = this.sourceLabel(src);

        if (this.days.loading) return `<div class="lx-days-head"><h3>${esc(label)}</h3></div><p class="lx-empty">Loading…</p>`;
        if (this.days.error) return `<div class="lx-days-head"><h3>${esc(label)}</h3></div><p class="lx-days-error">${esc(this.days.error)}</p>`;

        const data = this.days.data;
        const n = this.selectedDays.size;
        const head = `
            <div class="lx-days-head">
                <h3>${esc(label)}</h3>
                <span class="lx-spacer"></span>
                <button class="lx-btn lx-btn-sm" data-action="open-trends" ${n >= 1 ? '' : 'disabled'}>Trends${n ? ` (${n})` : ''}</button>
            </div>`;
        const path = `<div class="lx-days-path">${esc(data.logPath)}</div>`;
        if (!data.days.length) return head + path + `<p class="lx-empty">No log files found.</p>`;

        const allChecked = data.days.length && data.days.every((d) => this.selectedDays.has(d.date));
        const rows = data.days.map((day) => `
            <tr>
                <td class="lx-day-check"><input type="checkbox" data-action="toggle-day" data-date="${esc(day.date)}" ${this.selectedDays.has(day.date) ? 'checked' : ''} /></td>
                <td><button class="lx-link" data-action="select-day" data-date="${esc(day.date)}">${esc(day.date)}</button></td>
                <td>${day.fileCount}</td>
                <td>${formatBytes(day.bytes)}</td>
            </tr>`).join('');

        return head + path + `
            <table class="lx-days-table">
                <thead><tr>
                    <th class="lx-day-check"><input type="checkbox" data-action="toggle-all-days" ${allChecked ? 'checked' : ''} /></th>
                    <th>Date</th><th>Files</th><th>Size</th>
                </tr></thead>
                <tbody>${rows}</tbody>
            </table>`;
    }

    // ---- day view (entries / analytics) ----------------------------------

    renderDay() {
        const label = this.sourceLabel(this.source(this.selectedSource));
        const body = this.dayView === 'analytics' ? this.renderAnalytics() : this.renderEntriesBody();
        const backLabel = this.dayOrigin?.type === 'trends' ? '← Trends'
            : this.dayOrigin?.type === 'calendar' ? '← Calendar'
            : this.dayOrigin?.type === 'hotspots' ? '← Hotspots' : '← Days';
        this.contentEl.innerHTML = `
            <div class="lx-entries-view">
                <div class="lx-entries-head">
                    <button class="lx-link" data-action="go-back">${backLabel}</button>
                    <span class="lx-entries-title">${esc(label)} · ${esc(this.day)}</span>
                    <span class="lx-dayview">
                        <button class="lx-tab${this.dayView === 'entries' ? ' lx-tab-active' : ''}" data-action="dayview-entries">Entries</button>
                        <button class="lx-tab${this.dayView === 'analytics' ? ' lx-tab-active' : ''}" data-action="dayview-analytics">Analytics</button>
                    </span>
                    ${this.dayView === 'entries'
                        ? `<a class="lx-btn lx-btn-sm" href="${esc(exportEntriesUrl(this.selectedSource, this.day, this.filter))}" title="Download all matching rows as CSV">Export CSV</a>`
                        : ''}
                </div>
                ${this.renderFilterBar()}
                ${body}
            </div>`;
    }

    renderEntriesBody() {
        const e = this.entries;
        let grid;
        if (e.loading) {
            grid = `<p class="lx-empty">Loading…</p>`;
        } else if (e.error) {
            grid = `<p class="lx-days-error">${esc(e.error)}</p>`;
        } else if (!e.data.rows.length) {
            grid = `<p class="lx-empty">No entries match.</p>`;
        } else {
            const cols = e.data.columns.map((c) => `<th>${esc(c)}</th>`).join('');
            const iDate = e.data.columns.indexOf('date');
            const iTime = e.data.columns.indexOf('time');
            const local = this.tz === 'local' && iDate >= 0 && iTime >= 0;
            const rows = e.data.rows.map((r, i) => {
                let cells = r;
                if (local) {
                    const z = this.toZone(r[iDate], r[iTime]);
                    cells = r.slice();
                    cells[iDate] = z.date;
                    cells[iTime] = z.time;
                }
                return `<tr class="lx-entry-row" data-action="row-detail" data-row="${i}"><td class="lx-rownum">${(e.offset + i + 1).toLocaleString()}</td>${cells.map((v) => `<td>${cell(v)}</td>`).join('')}</tr>`;
            }).join('');
            grid = `
                <div class="lx-entries-scroll">
                    <table class="lx-entries">
                        <thead><tr><th class="lx-rownum">#</th>${cols}</tr></thead>
                        <tbody>${rows}</tbody>
                    </table>
                </div>`;
        }
        return `<div class="lx-pager">${this.renderPager()}</div>${grid}`;
    }

    // Which standard W3C fields are present, a per-card "needs field" gate, and a banner.
    fieldNotes(fields) {
        const has = new Set(fields || []);
        const need = (field, render) =>
            has.has(field) ? render() : `<p class="lx-empty">Not logged: <code>${esc(field)}</code></p>`;
        const standard = ['date', 'time', 'cs-method', 'cs-uri-stem', 'sc-status', 'time-taken', 'c-ip', 'cs(User-Agent)'];
        const missing = standard.filter((f) => !has.has(f));
        const banner = missing.length
            ? `<div class="lx-fieldnote">⚠ Not logged for this source: ${missing.map((f) => `<code>${esc(f)}</code>`).join(', ')} — the related analytics below are unavailable.</div>`
            : '';
        return { need, banner };
    }

    renderAnalytics() {
        const s = this.stats;
        if (s.loading) return `<p class="lx-empty">Loading…</p>`;
        if (s.error) return `<p class="lx-days-error">${esc(s.error)}</p>`;
        const d = s.data;
        if (!d.total) return `<p class="lx-empty">No entries match.</p>`;
        const { need, banner } = this.fieldNotes(d.fields);

        return `
            <div class="lx-analytics">
                <div class="lx-stat-total">${d.total.toLocaleString()} requests</div>
                ${banner}
                <div class="lx-stat-grid">
                    ${this.statCard('Status', need('sc-status', () => this.statusBreakdown(d.statusDistribution, d.total)))}
                    ${d.errorBreakdown?.length ? this.statCard('Error detail (status.substatus)', this.errorBreakdown(d.errorBreakdown)) : ''}
                    ${this.statCard('Method', need('cs-method', () => this.barList(d.methodDistribution, 'method')))}
                    ${this.statCard('Requests by hour (UTC)', need('time', () => this.hourChart(d.requestsPerHour)))}
                    ${this.statCard(`Timing (${this.tzShort()})`, need('time', () => this.renderTiming(d.timing, d.total)))}
                    ${this.statCard('Top routes', need('cs-uri-stem', () => this.routesCard(d.topRoutes)))}
                    ${this.statCard('Top clients (IP)', need('c-ip', () => this.clientCard(d.topClients, 'ip')))}
                    ${this.statCard('Top user agents', need('cs(User-Agent)', () => this.clientCard(d.topAgents, 'agent')))}
                    ${this.statCard('Slowest requests', need('time-taken', () => this.slowTable(d.slowest)))}
                </div>
            </div>`;
    }

    statCard(title, inner) {
        return `<section class="lx-card"><h4>${esc(title)}</h4>${inner}</section>`;
    }

    errorBreakdown(items) {
        return `<div class="lx-errdetail">` + items.map((e) => {
            const code = `${e.status}.${e.subStatus}`;
            return `
                <button class="lx-errrow" data-action="drill" data-field="status" data-value="${esc(e.status)}" title="Drill into ${esc(e.status)}">
                    <span class="lx-err-code">${esc(code)}</span>
                    <span class="lx-err-name">${esc(substatusHint(e.status, e.subStatus))}</span>
                    <span class="lx-err-val">${e.count.toLocaleString()}</span>
                </button>`;
        }).join('') + `</div>`;
    }

    statusBreakdown(distribution, total) {
        if (!distribution.length) return `<p class="lx-empty">—</p>`;

        const groups = { '5': [], '4': [], '3': [], '2': [], other: [] };
        for (const it of distribution) {
            const head = it.key[0];
            (groups['2345'.includes(head) ? head : 'other']).push(it);
        }

        const meta = {
            '5': ['Server error', 'err'], '4': ['Client error', 'warn'],
            '3': ['Redirect', 'redir'], '2': ['Success', 'ok'], other: ['Other', 'other']
        };

        const out = ['5', '4', '3', '2', 'other'].map((g) => {
            const items = groups[g];
            if (!items.length) return '';
            const [label, cls] = meta[g];
            const sum = items.reduce((a, b) => a + b.value, 0);
            const pct = total ? (sum / total * 100).toFixed(1) : '0.0';
            const classDrill = g === 'other' ? '' : `data-action="drill" data-field="status" data-value="${g}xx"`;
            const codes = items.slice().sort((a, b) => b.value - a.value).map((it) => `
                <button class="lx-stg-code" data-action="drill" data-field="status" data-value="${esc(it.key)}">
                    <span class="lx-code-num">${esc(it.key)}</span>
                    <span class="lx-code-name">${esc(statusLabel(it.key))}</span>
                    <span class="lx-code-val">${it.value.toLocaleString()}</span>
                </button>`).join('');
            return `
                <div class="lx-stg lx-stg-${cls}">
                    <button class="lx-stg-head" ${classDrill}>
                        <span class="lx-stg-label">${label}</span>
                        <span class="lx-stg-count">${sum.toLocaleString()}</span>
                        <span class="lx-stg-pct">${pct}%</span>
                    </button>
                    <div class="lx-stg-codes">${codes}</div>
                </div>`;
        }).join('');

        return `<div class="lx-status-groups">${out}</div>`;
    }

    clientCard(items, field) {
        if (!items?.length) return `<p class="lx-empty">—</p>`;
        const heading = field === 'ip' ? 'Client IP' : 'User agent';
        const head = `<div class="lx-route lx-route-head"><span>${heading}</span><span>Reqs</span><span>5xx</span></div>`;
        const rows = items.map((it) => {
            const er = it.count ? it.serverErrors / it.count : 0;
            const cls = er >= 0.02 ? 'lx-route-err-hi' : er >= 0.005 ? 'lx-route-err-mid' : '';
            const disp = field === 'agent' ? it.key.replace(/\+/g, ' ') : it.key;
            return `
                <button class="lx-route" data-action="drill" data-field="${field}" data-value="${esc(it.key)}" title="Filter by ${esc(disp)}">
                    <span class="lx-route-name">${esc(disp)}</span>
                    <span class="lx-route-count">${it.count.toLocaleString()}</span>
                    <span class="lx-route-pct ${cls}">${(er * 100).toFixed(1)}%</span>
                </button>`;
        }).join('');
        return `<div class="lx-routes lx-clients">${head}${rows}</div>`;
    }

    routesCard(routes) {
        if (!routes.length) return `<p class="lx-empty">—</p>`;
        const head = `<div class="lx-route lx-route-head"><span>Route</span><span>Reqs</span><span>5xx</span><span>Avg</span></div>`;
        const rows = routes.map((r) => {
            const errRate = r.count ? r.serverErrors / r.count : 0;
            const errCls = errRate >= 0.02 ? 'lx-route-err-hi' : errRate >= 0.005 ? 'lx-route-err-mid' : '';
            const prefix = r.route.split('{')[0] || r.route;
            return `
                <button class="lx-route" data-action="drill" data-field="uri" data-value="${esc(prefix)}" title="Filter URI contains ${esc(prefix)}">
                    <span class="lx-route-name">${esc(r.route)}</span>
                    <span class="lx-route-count">${r.count.toLocaleString()}</span>
                    <span class="lx-route-pct ${errCls}">${(errRate * 100).toFixed(1)}%</span>
                    <span class="lx-route-ms">${r.avgTimeTaken.toLocaleString()}</span>
                </button>`;
        }).join('');
        return `<div class="lx-routes">${head}${rows}</div>`;
    }

    barList(items, field, classOf) {
        if (!items.length) return `<p class="lx-empty">—</p>`;
        const max = Math.max(...items.map((i) => i.value)) || 1;
        return `<div class="lx-bars">` + items.map((it) => {
            const pct = Math.round((it.value / max) * 100);
            const cls = classOf ? ` lx-bar-${classOf(it.key)}` : '';
            return `
                <div class="lx-bar-row lx-drill" data-action="drill" data-field="${field}" data-value="${esc(it.key)}" title="Filter by ${esc(it.key)}">
                    <span class="lx-bar-label">${esc(it.key)}</span>
                    <span class="lx-bar-track"><span class="lx-bar-fill${cls}" style="width:${pct}%"></span></span>
                    <span class="lx-bar-val">${it.value.toLocaleString()}</span>
                </div>`;
        }).join('') + `</div>`;
    }

    hourChart(hours) {
        const maxCount = Math.max(...hours.map((h) => h.count)) || 1;
        const maxMs = Math.max(...hours.map((h) => h.avgTimeTaken), 1);

        const bars = hours.map((h) => {
            const pct = Math.round((h.count / maxCount) * 100);
            const rate = h.count ? h.serverErrors / h.count : 0;
            const cls = rate >= 0.02 ? 'err' : rate >= 0.005 ? 'warn' : 'ok';
            const hh = String(h.hour).padStart(2, '0');
            const tip = `${hh}:00 — ${h.count.toLocaleString()} req · ${h.serverErrors.toLocaleString()} 5xx (${(rate * 100).toFixed(1)}%) · avg ${h.avgTimeTaken.toLocaleString()} ms`;
            return `<span class="lx-hour lx-drill" data-action="drill-hour" data-hour="${h.hour}" title="${tip}">
                        <span class="lx-hour-bar lx-hbar-${cls}" style="height:${pct}%"></span>
                    </span>`;
        }).join('');

        const pts = hours.map((h, i) => `${i + 0.5},${(100 - (h.avgTimeTaken / maxMs) * 100).toFixed(1)}`).join(' ');
        const axis = hours.map((h) => `<span>${h.hour % 6 === 0 ? h.hour : ''}</span>`).join('');
        const half = Math.round(maxCount / 2);
        const halfMs = Math.round(maxMs / 2);

        return `
            <div class="lx-hours-wrap">
                <div class="lx-hours-grid">
                    <div class="lx-yaxis"><span>${maxCount.toLocaleString()}</span><span>${half.toLocaleString()}</span><span>0</span></div>
                    <div class="lx-hours">
                        ${bars}
                        <svg class="lx-hour-line" viewBox="0 0 24 100" preserveAspectRatio="none"><polyline points="${pts}"></polyline></svg>
                    </div>
                    <div class="lx-yaxis lx-yaxis-lat"><span>${maxMs.toLocaleString()}</span><span>${halfMs.toLocaleString()}</span><span>0</span></div>
                    <div></div>
                    <div class="lx-hours-axis">${axis}</div>
                    <div></div>
                </div>
                <div class="lx-hours-legend"><span class="lx-leg-req">requests</span> · <span class="lx-leg-lat">avg latency ms</span> · bar color = 5xx rate</div>
            </div>`;
    }

    renderTiming(t, total) {
        if (!t || !t.first) return `<p class="lx-empty">—</p>`;
        const rate = t.spanMinutes > 0 ? total / t.spanMinutes : 0;
        const peakPct = total ? Math.round(t.peakHourCount / total * 100) : 0;
        const meanActive = t.activeMinutes ? total / t.activeMinutes : 0;
        const burst = meanActive > 0 && t.busiestMinuteCount >= 10 * meanActive;
        const peakHh = String(t.peakHour).padStart(2, '0');
        const peakDisp = this.toZone(this.day, `${peakHh}:00:00`).time.slice(0, 5);
        const busiestDisp = t.busiestMinute ? this.zoneTime(t.busiestMinute) : '';

        const busiestRow = t.busiestMinute
            ? `<div><dt>Busiest min</dt><dd>
                   <button class="lx-tlink" data-action="drill-minute" data-minute="${esc(t.busiestMinute)}">${esc(busiestDisp)}</button>
                   · ${t.busiestMinuteCount.toLocaleString()}${burst ? ' <span class="lx-burst">⚡ burst</span>' : ''}
               </dd></div>`
            : '';

        return `
            <dl class="lx-timing">
                <div><dt>First</dt><dd>${esc(this.zoneTime(t.first))}</dd></div>
                <div><dt>Last</dt><dd>${esc(this.zoneTime(t.last))}</dd></div>
                <div><dt>Span</dt><dd>${formatSpan(t.spanMinutes)} · ${rate.toFixed(1)}/min</dd></div>
                <div><dt>Peak hour</dt><dd>
                    <button class="lx-tlink" data-action="drill-hour" data-hour="${t.peakHour}">${esc(peakDisp)}</button>
                    · ${t.peakHourCount.toLocaleString()} (${peakPct}%)
                </dd></div>
                ${busiestRow}
            </dl>`;
    }

    slowTable(rows) {
        if (!rows.length) return `<p class="lx-empty">—</p>`;
        return `
            <table class="lx-slow">
                <thead><tr><th>ms</th><th>Time</th><th>Method</th><th>URL</th><th>St</th></tr></thead>
                <tbody>${rows.map((r) => `
                    <tr class="lx-drill" data-action="drill" data-field="uri" data-value="${esc(r.uri)}" title="Filter by ${esc(r.uri)}">
                        <td class="lx-slow-ms">${r.timeTaken.toLocaleString()}</td>
                        <td>${esc(this.zoneTime(r.time))}</td>
                        <td>${esc(r.method)}</td>
                        <td class="lx-slow-uri">${esc(r.uri)}</td>
                        <td>${esc(r.status)}</td>
                    </tr>`).join('')}</tbody>
            </table>`;
    }

    renderFilterBar() {
        const f = this.filter;
        const methods = ['', 'GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS', 'PATCH'];
        const options = methods.map((m) =>
            `<option value="${m}"${m === f.method ? ' selected' : ''}>${m || 'Any method'}</option>`).join('');
        const ctx = this.filterDateContext();
        const ftDisp = f.fromTime ? this.toZone(ctx, f.fromTime).time : '';
        const ttDisp = f.toTime ? this.toZone(ctx, f.toTime).time : '';
        return `
            <form class="lx-filter" data-action="apply-filter">
                <input name="q" class="lx-filter-q" placeholder="Search text" value="${esc(f.q)}" />
                <select name="method">${options}</select>
                <input name="status" placeholder="Status (500, 5xx)" value="${esc(f.status)}" />
                <input name="uri" placeholder="URI contains" value="${esc(f.uri)}" />
                <input name="minTime" type="number" min="0" placeholder="Min ms" value="${esc(f.minTime)}" />
                <input name="fromTime" type="time" value="${esc(ftDisp)}" title="From time (${this.tzShort()})" />
                <input name="toTime" type="time" value="${esc(ttDisp)}" title="To time (${this.tzShort()})" />
                <input name="ip" placeholder="Client IP" value="${esc(f.ip)}" />
                <input name="agent" placeholder="User agent" value="${esc(f.agent)}" />
                <button type="submit" class="lx-btn lx-btn-sm lx-btn-primary">Apply</button>
                <button type="button" class="lx-btn lx-btn-sm" data-action="clear-filter">Clear</button>
            </form>`;
    }

    renderPager() {
        const e = this.entries;
        const count = e.data ? e.data.rows.length : 0;
        const total = e.data ? e.data.total : 0;
        const from = count ? e.offset + 1 : 0;
        const to = e.offset + count;
        const canPrev = e.offset > 0;
        const canNext = !!(e.data && e.data.hasMore);
        return `
            <span class="lx-range">${from.toLocaleString()}–${to.toLocaleString()} of ${total.toLocaleString()} lines</span>
            <button class="lx-btn lx-btn-sm" data-action="entries-prev" ${canPrev ? '' : 'disabled'}>Prev</button>
            <button class="lx-btn lx-btn-sm" data-action="entries-next" ${canNext ? '' : 'disabled'}>Next</button>`;
    }

    selectDay(date, origin = { type: 'days' }) {
        this.day = date;
        this.dayView = 'entries';
        this.dayOrigin = origin;
        this.filter = emptyFilter();
        this.entries = { loading: false, error: null, data: null, offset: 0 };
        this.stats = { loading: false, error: null, data: null };
        this.loadEntries();
    }

    goBack() {
        const origin = this.dayOrigin;
        this.day = null;
        this.detail = null;
        this.dayOrigin = null;

        if (origin?.type === 'trends') {
            this.trendDates = origin.dates;
            this.trends = { loading: false, error: null, data: null };
            this.loadTrends();
        } else if (origin?.type === 'calendar') {
            this.mode = 'calendar';
            this.render();
        } else if (origin?.type === 'hotspots') {
            this.mode = 'hotspots';
            this.render();
        } else {
            this.filter = emptyFilter();
            this.entries = { loading: false, error: null, data: null, offset: 0 };
            this.stats = { loading: false, error: null, data: null };
            this.render();
        }
    }

    setDayView(view) {
        if (this.dayView === view) return;
        this.dayView = view;
        this.detail = null;
        if (view === 'analytics' && !this.stats.data && !this.stats.loading) this.loadStats();
        else if (view === 'entries' && !this.entries.data && !this.entries.loading) this.loadEntries();
        else this.render();
    }

    applyFilter(form) {
        const d = Object.fromEntries(new FormData(form).entries());
        this.filter = {
            q: (d.q || '').trim(),
            method: (d.method || '').trim(),
            status: (d.status || '').trim(),
            uri: (d.uri || '').trim(),
            minTime: (d.minTime || '').trim(),
            fromTime: this.toUtcTime(this.filterDateContext(), (d.fromTime || '').trim()),
            toTime: this.toUtcTime(this.filterDateContext(), (d.toTime || '').trim()),
            ip: (d.ip || '').trim(),
            agent: (d.agent || '').trim()
        };
        this.refreshDay();
    }

    clearFilter() {
        this.filter = emptyFilter();
        this.refreshDay();
    }

    refreshDay() {
        if (this.aggregate) { this.loadAggregate(); return; }
        if (this.trendDates) {
            this.trends = { loading: false, error: null, data: null };
            this.loadTrends();
            return;
        }
        this.entries = { loading: false, error: null, data: null, offset: 0 };
        this.stats = { loading: false, error: null, data: null };
        if (this.dayView === 'analytics') this.loadStats();
        else this.loadEntries();
    }

    drill(field, value) {
        this.filter = { ...this.filter, [field]: value };
        if (this.aggregate) { this.loadAggregate(); return; }
        this.dayView = 'entries';
        this.entries = { loading: false, error: null, data: null, offset: 0 };
        this.stats = { loading: false, error: null, data: null };
        this.loadEntries();
    }

    drillHour(hour) {
        const hh = String(hour).padStart(2, '0');
        this.filter = { ...this.filter, fromTime: `${hh}:00`, toTime: `${hh}:59` };
        this.dayView = 'entries';
        this.detail = null;
        this.entries = { loading: false, error: null, data: null, offset: 0 };
        this.stats = { loading: false, error: null, data: null };
        this.loadEntries();
    }

    drillMinute(hhmm) {
        this.filter = { ...this.filter, fromTime: hhmm, toTime: `${hhmm}:59` };
        this.dayView = 'entries';
        this.detail = null;
        this.entries = { loading: false, error: null, data: null, offset: 0 };
        this.stats = { loading: false, error: null, data: null };
        this.loadEntries();
    }

    async loadStats() {
        const sourceId = this.selectedSource;
        this.stats = { loading: true, error: null, data: null };
        this.render();

        const token = this.statsToken();
        try {
            const data = await fetchStats(sourceId, this.day, this.filter);
            if (this.statsToken() !== token) return;
            this.stats = { loading: false, error: null, data };
        } catch (err) {
            if (this.statsToken() !== token) return;
            this.stats = { loading: false, error: err.message, data: null };
        }
        this.render();
    }

    statsToken() {
        return `${this.selectionKey()}/${this.day}/${JSON.stringify(this.filter)}`;
    }

    async loadEntries() {
        const sourceId = this.selectedSource;
        const offset = this.entries.offset;
        this.detail = null;
        this.entries = { loading: true, error: null, data: null, offset };
        this.render();

        const token = this.entryToken();
        try {
            const data = await fetchEntries(sourceId, this.day, offset, this.pageLimit, this.filter);
            if (this.entryToken() !== token) return;
            this.entries = { loading: false, error: null, data, offset };
        } catch (err) {
            if (this.entryToken() !== token) return;
            this.entries = { loading: false, error: err.message, data: null, offset };
        }
        this.render();
    }

    entryToken() {
        return `${this.selectionKey()}/${this.day}/${this.entries.offset}/${JSON.stringify(this.filter)}`;
    }

    entriesPrev() {
        this.entries.offset = Math.max(0, this.entries.offset - this.pageLimit);
        this.loadEntries();
    }

    entriesNext() {
        this.entries.offset += this.pageLimit;
        this.loadEntries();
    }

    backToDays() {
        this.day = null;
        this.dayView = 'entries';
        this.detail = null;
        this.dayOrigin = null;
        this.trendDates = null;
        this.filter = emptyFilter();
        this.entries = { loading: false, error: null, data: null, offset: 0 };
        this.stats = { loading: false, error: null, data: null };
        this.render();
    }

    // ---- cross-day trends ------------------------------------------------

    toggleDay(date) {
        if (this.selectedDays.has(date)) this.selectedDays.delete(date);
        else this.selectedDays.add(date);
        this.renderBrowse();
    }

    toggleAllDays() {
        const all = this.days.data?.days ?? [];
        const allChecked = all.length && all.every((d) => this.selectedDays.has(d.date));
        if (allChecked) this.selectedDays.clear();
        else all.forEach((d) => this.selectedDays.add(d.date));
        this.renderBrowse();
    }

    openTrends() {
        if (!this.selectedDays.size) return;
        this.trendDates = [...this.selectedDays].sort();
        this.day = null;
        this.detail = null;
        this.filter = emptyFilter();
        this.trends = { loading: false, error: null, data: null };
        this.loadTrends();
    }

    drillDay(date) {
        const dates = this.trendDates;
        this.trendDates = null;
        this.day = date;
        this.dayView = 'entries';
        this.dayOrigin = { type: 'trends', dates };
        this.detail = null;
        this.entries = { loading: false, error: null, data: null, offset: 0 };
        this.stats = { loading: false, error: null, data: null };
        this.loadEntries();
    }

    async loadTrends() {
        const sourceId = this.selectedSource;
        this.trends = { loading: true, error: null, data: null };
        this.render();

        const token = this.trendsToken();
        try {
            const data = await fetchTrends(sourceId, this.trendDates, this.filter);
            if (this.trendsToken() !== token) return;
            this.trends = { loading: false, error: null, data };
        } catch (err) {
            if (this.trendsToken() !== token) return;
            this.trends = { loading: false, error: err.message, data: null };
        }
        this.render();
    }

    trendsToken() {
        return `${this.selectionKey()}/${this.trendDates?.join(',')}/${JSON.stringify(this.filter)}`;
    }

    renderTrends() {
        const label = this.sourceLabel(this.source(this.selectedSource));
        const t = this.trends;
        let body;
        if (t.loading) {
            body = `<p class="lx-empty">Loading…</p>`;
        } else if (t.error) {
            body = `<p class="lx-days-error">${esc(t.error)}</p>`;
        } else if (!t.data.days.length) {
            body = `<p class="lx-empty">No data for the selected days.</p>`;
        } else {
            const days = t.data.days;
            const max = Math.max(...days.map((d) => d.total)) || 1;
            const bars = days.map((d) => {
                const seg = (n, cls) => n ? `<span class="lx-bar-fill lx-bar-${cls}" style="height:${(n / max) * 100}%" title="${cls}: ${n.toLocaleString()}"></span>` : '';
                return `
                    <div class="lx-trend-col" data-action="drill-day" data-date="${esc(d.date)}" title="${esc(d.date)} — ${d.total.toLocaleString()} requests · open">
                        <span class="lx-trend-stack">
                            ${seg(d.err, 'err')}${seg(d.warn, 'warn')}${seg(d.redir, 'redir')}${seg(d.other, 'other')}${seg(d.ok, 'ok')}
                        </span>
                        <span class="lx-trend-x">${esc(d.date.slice(5))}</span>
                    </div>`;
            }).join('');

            const rows = days.map((d) => {
                const errPct = d.total ? ((d.warn + d.err) / d.total * 100).toFixed(1) : '0.0';
                return `
                    <tr class="lx-trend-row" data-action="drill-day" data-date="${esc(d.date)}" title="Open ${esc(d.date)}">
                        <td>${esc(d.date)}</td>
                        <td class="lx-num">${d.total.toLocaleString()}</td>
                        <td class="lx-num">${d.ok.toLocaleString()}</td>
                        <td class="lx-num">${d.redir.toLocaleString()}</td>
                        <td class="lx-num">${d.warn.toLocaleString()}</td>
                        <td class="lx-num">${d.err.toLocaleString()}</td>
                        <td class="lx-num">${d.avgTimeTaken.toLocaleString()}</td>
                        <td class="lx-num">${errPct}%</td>
                    </tr>`;
            }).join('');

            body = `
                <div class="lx-trend-chart">${bars}</div>
                <table class="lx-days-table lx-trend-table">
                    <thead><tr><th>Date</th><th>Total</th><th>2xx</th><th>3xx</th><th>4xx</th><th>5xx</th><th>Avg ms</th><th>Err %</th></tr></thead>
                    <tbody>${rows}</tbody>
                </table>`;
        }

        this.contentEl.innerHTML = `
            <div class="lx-entries-view">
                <div class="lx-entries-head">
                    <button class="lx-link" data-action="back-to-days">← Days</button>
                    <span class="lx-entries-title">${esc(label)} · Trends (${this.trendDates.length} days)</span>
                </div>
                ${this.renderFilterBar()}
                ${body}
            </div>`;
    }

    // ---- aggregate (group + span) ----------------------------------------

    analyzeGroup(group) {
        const sources = this.config.logSources.filter((s) => (s[this.browseGroupBy] || '(none)') === group).map((s) => s.id);
        if (!sources.length) return;
        this.aggregate = { label: group, sources, from: null, to: null, origin: 'browse', loading: false, error: null, data: null };
        this.filter = emptyFilter();
        this.day = null;
        this.trendDates = null;
        this.detail = null;
        this.loadAggregate();
    }

    async loadAggregate() {
        const a = this.aggregate;
        a.loading = true; a.error = null;
        this.render();

        const token = this.aggToken();
        try {
            const data = await fetchAggregate(a.sources, a.from, a.to, this.filter);
            if (this.aggToken() !== token) return;
            a.loading = false; a.data = data; a.from = data.from; a.to = data.to;
        } catch (err) {
            if (this.aggToken() !== token) return;
            a.loading = false; a.error = err.message; a.data = null;
        }
        this.render();
    }

    aggToken() {
        const a = this.aggregate;
        return `${a?.sources.join(',')}/${a?.from}/${a?.to}/${JSON.stringify(this.filter)}`;
    }

    applySpan(form) {
        const d = Object.fromEntries(new FormData(form).entries());
        this.aggregate.from = (d.from || '').trim() || null;
        this.aggregate.to = (d.to || '').trim() || null;
        this.loadAggregate();
    }

    aggDay(date) {
        this.aggregate.from = date;
        this.aggregate.to = date;
        this.loadAggregate();
    }

    aggOpenSource(sourceId) {
        this.aggregate = null;
        this.openSource(sourceId);
    }

    backFromAggregate() {
        const origin = this.aggregate?.origin;
        this.aggregate = null;
        if (origin === 'calendar') this.mode = 'calendar';
        this.render();
    }

    openCalendarDay(date) {
        const sources = this.scopeSources();
        if (!sources.length) return;
        this.mode = 'browse';
        this.aggregate = { label: this.calScopeLabel(), sources, from: date, to: date, origin: 'calendar', loading: false, error: null, data: null };
        this.filter = emptyFilter();
        this.day = null;
        this.trendDates = null;
        this.detail = null;
        this.loadAggregate();
    }

    renderAggregate() {
        const a = this.aggregate;
        let body;
        if (a.loading) {
            body = `<p class="lx-empty">Loading…</p>`;
        } else if (a.error) {
            body = `<p class="lx-days-error">${esc(a.error)}</p>`;
        } else if (!a.data || !a.data.total) {
            body = `<p class="lx-empty">No requests for this group and span.</p>`;
        } else {
            const d = a.data;
            const { need, banner } = this.fieldNotes(d.fields);
            body = `
                <div class="lx-agg-summary">${d.total.toLocaleString()} requests · ${d.sourceCount} sources · ${esc(d.from)} → ${esc(d.to)}</div>
                ${banner}
                <div class="lx-stat-grid">
                    ${this.statCard('By instance', this.aggSourceTable(d.perSource))}
                    ${this.statCard('By day', this.aggDayChart(d.perDay))}
                    ${this.statCard('Status', need('sc-status', () => this.statusBreakdown(d.statusDistribution, d.total)))}
                    ${d.errorBreakdown?.length ? this.statCard('Error detail (status.substatus)', this.errorBreakdown(d.errorBreakdown)) : ''}
                    ${this.statCard('Method', need('cs-method', () => this.barList(d.methodDistribution, 'method')))}
                    ${this.statCard('By hour of day (UTC)', need('time', () => this.hourChart(d.requestsPerHour)))}
                    ${this.statCard('Top routes', need('cs-uri-stem', () => this.routesCard(d.topRoutes)))}
                    ${this.statCard('Top clients (IP)', need('c-ip', () => this.clientCard(d.topClients, 'ip')))}
                    ${this.statCard('Top user agents', need('cs(User-Agent)', () => this.clientCard(d.topAgents, 'agent')))}
                    ${this.statCard('Slowest requests', need('time-taken', () => this.slowTable(d.slowest)))}
                </div>`;
        }

        this.contentEl.innerHTML = `
            <div class="lx-entries-view">
                <div class="lx-entries-head">
                    <button class="lx-link" data-action="agg-back">${a.origin === 'calendar' ? '← Calendar' : '← Browse'}</button>
                    <span class="lx-entries-title">${esc(a.label)}</span>
                    <span class="lx-spacer"></span>
                    <form class="lx-span" data-action="apply-span">
                        <input type="date" name="from" value="${esc(a.from ?? '')}" />
                        <span>→</span>
                        <input type="date" name="to" value="${esc(a.to ?? '')}" />
                        <button type="submit" class="lx-btn lx-btn-sm">Span</button>
                    </form>
                </div>
                ${this.renderFilterBar()}
                ${body}
            </div>`;
    }

    aggSourceTable(perSource) {
        if (!perSource.length) return `<p class="lx-empty">—</p>`;
        const head = `<div class="lx-route lx-route-head"><span>Instance</span><span>Reqs</span><span>5xx</span><span>Avg</span></div>`;
        const rows = perSource.map((s) => {
            const er = s.total ? s.serverErrors / s.total : 0;
            const cls = er >= 0.02 ? 'lx-route-err-hi' : er >= 0.005 ? 'lx-route-err-mid' : '';
            const lbl = [s.type, s.stage, s.server, s.instance].filter(Boolean).join(' · ');
            return `
                <button class="lx-route" data-action="agg-source" data-source="${esc(s.sourceId)}" title="Browse ${esc(s.sourceId)}">
                    <span class="lx-route-name">${esc(lbl)}</span>
                    <span class="lx-route-count">${s.total.toLocaleString()}</span>
                    <span class="lx-route-pct ${cls}">${(er * 100).toFixed(1)}%</span>
                    <span class="lx-route-ms">${s.avgTimeTaken.toLocaleString()}</span>
                </button>`;
        }).join('');
        return `<div class="lx-routes">${head}${rows}</div>`;
    }

    aggDayChart(perDay) {
        if (!perDay.length) return `<p class="lx-empty">—</p>`;
        const max = Math.max(...perDay.map((d) => d.total)) || 1;
        return `<div class="lx-trend-chart">` + perDay.map((d) => {
            const seg = (n, cls) => n ? `<span class="lx-bar-fill lx-bar-${cls}" style="height:${n / max * 100}%" title="${cls}: ${n.toLocaleString()}"></span>` : '';
            const ok = d.total - d.serverErrors - d.clientErrors;
            return `
                <div class="lx-trend-col" data-action="agg-day" data-date="${esc(d.date)}" title="${esc(d.date)} — ${d.total.toLocaleString()} req · ${d.serverErrors.toLocaleString()} 5xx">
                    <span class="lx-trend-stack">${seg(d.serverErrors, 'err')}${seg(d.clientErrors, 'warn')}${seg(ok, 'ok')}</span>
                    <span class="lx-trend-x">${esc(d.date.slice(5))}</span>
                </div>`;
        }).join('') + `</div>`;
    }

    // ---- hotspots --------------------------------------------------------

    async loadHotspots() {
        this.hotspots = { loading: true, error: null, data: null };
        this.render();
        try {
            const data = await fetchHotspots();
            this.hotspots = { loading: false, error: null, data };
        } catch (err) {
            this.hotspots = { loading: false, error: err.message, data: null };
        }
        this.render();
    }

    renderHotspots() {
        const s = this.hotspots;
        if (s.loading) { this.contentEl.innerHTML = `<p class="lx-empty">Loading…</p>`; return; }
        if (s.error) { this.contentEl.innerHTML = `<p class="lx-days-error">${esc(s.error)}</p>`; return; }
        const d = s.data;

        const label = (x) => `${esc(x.application)} · ${esc(x.type)} · ${esc(x.stage)} · ${esc(x.server)}`;

        const issues = d.issues.length
            ? d.issues.map((i) => {
                const anom = (i.issueType ?? '').startsWith('anomaly-');
                return `
                <button class="lx-issue lx-sev-${i.severity}${anom ? ' lx-issue-anom' : ''}" data-action="issue-open"
                        data-source="${esc(i.sourceId)}" data-date="${esc(i.date ?? '')}"
                        data-fstatus="${esc(i.filterStatus ?? '')}" data-fmintime="${i.filterMinTime ?? ''}">
                    <span class="lx-sev-badge">${esc(i.severity)}</span>
                    <span class="lx-issue-app">${label(i)}</span>
                    <span class="lx-issue-title">${anom ? '<span class="lx-issue-tag">baseline</span>' : ''}${esc(i.title)}</span>
                    <span class="lx-issue-date">${esc(i.date ?? '')}</span>
                </button>`; }).join('')
            : `<p class="lx-empty">No issues detected across the most recent day of each log source.</p>`;

        this.contentEl.innerHTML = `
            <div class="lx-hotspots">
                <div class="lx-hot-head">
                    <h3>Hotspots</h3>
                    <span class="lx-hot-sub">issues across the most recent day per log source</span>
                    <span class="lx-spacer"></span>
                    <button class="lx-btn lx-btn-sm" data-action="hot-refresh">Refresh</button>
                </div>
                ${this.summaryBar(d.vitals)}
                <p class="lx-hot-hint">Deviations from each source's own baseline (tagged <span class="lx-issue-tag">baseline</span>) plus static-threshold issues for sources too new to have one. The <strong>Dashboard</strong> tab shows every source's full baseline-vs-target picture. Click to drill in.</p>
                <div class="lx-hot-issues">${issues}</div>
            </div>`;
    }

    // ---- dashboard (health/alert matrix over the same /api/hotspots data) ----

    renderDashboard() {
        const s = this.hotspots;
        if (s.loading) { this.contentEl.innerHTML = `<p class="lx-empty">Loading…</p>`; return; }
        if (s.error) { this.contentEl.innerHTML = `<p class="lx-days-error">${esc(s.error)}</p>`; return; }
        const label = (x) => `${esc(x.application)} · ${esc(x.type)} · ${esc(x.stage)} · ${esc(x.server)}`;

        const all = s.data.vitals;
        let vitals = this.dashProblemsOnly
            ? all.filter((v) => ['acute', 'elevated', 'watch'].includes(worstState(v)))
            : all.slice();

        const sample = all.find((v) => v.metrics && v.metrics.length);
        const cols = sample ? sample.metrics.map((m) => m.label) : ['5xx rate', 'p95 latency', 'auth rate', '404 rate'];
        const sortWorst = (arr) => arr.sort((a, b) => stateRank(worstState(a)) - stateRank(worstState(b)) || b.errorRate - a.errorRate);

        const rowFor = (v) => {
            const id = `<td class="lx-db-id">
                <button class="lx-link" data-action="vital-open" data-source="${esc(v.sourceId)}" data-date="${esc(v.date ?? '')}">${label(v)}</button>
                <div class="lx-db-sub">${v.health === 'nodata' ? 'no logs' : `${v.total.toLocaleString()} req · ${esc(v.date ?? '')}`}</div>
            </td>`;
            if (!v.metrics || !v.metrics.length)
                return `<tr class="lx-db-row">${id}<td class="lx-db-na" colspan="${cols.length}">no logs for this source</td></tr>`;
            const cells = v.metrics.map((m) => {
                const f = metricDrill(m);
                const base = m.baseline == null ? '—' : fmtMetric(m.baseline, m.unit);
                return `<td class="lx-dc lx-dc-${m.state}">
                    <button class="lx-dc-btn" data-action="issue-open"
                            data-source="${esc(v.sourceId)}" data-date="${esc(v.date ?? '')}"
                            data-fstatus="${esc(f.status ?? '')}" data-fmintime="${f.minTime ?? ''}"
                            title="${esc(m.label)} — normal ${base} · target ${fmtMetric(m.target, m.unit)} · ${esc(STATE_TEXT[m.state] ?? m.state)} · last ${m.series ? m.series.length : 0} days">
                        ${sparkline(m.series, m.target, m.state)}<span class="lx-dc-val">${fmtMetric(m.current, m.unit)}</span>
                    </button>
                </td>`;
            }).join('');
            return `<tr class="lx-db-row">${id}${cells}</tr>`;
        };

        let body;
        if (!vitals.length) {
            body = `<tr><td class="lx-empty" colspan="${cols.length + 1}">No sources match.</td></tr>`;
        } else if (this.dashGroupBy === 'none') {
            body = sortWorst(vitals).map(rowFor).join('');
        } else {
            const groups = new Map();
            for (const v of vitals) {
                const key = v[this.dashGroupBy] || '—';
                (groups.get(key) ?? groups.set(key, []).get(key)).push(v);
            }
            body = [...groups.entries()]
                .sort((a, b) => Math.min(...a[1].map((v) => stateRank(worstState(v)))) - Math.min(...b[1].map((v) => stateRank(worstState(v)))))
                .map(([key, list]) =>
                    `<tr class="lx-db-group"><td colspan="${cols.length + 1}">${esc(this.dashGroupBy)}: <strong>${esc(key)}</strong> · ${list.length}</td></tr>`
                    + sortWorst(list).map(rowFor).join('')).join('');
        }

        const groupPills = ['none', 'application', 'stage', 'server', 'type'].map((f) =>
            `<button class="lx-gb${this.dashGroupBy === f ? ' lx-gb-active' : ''}" data-action="dash-group" data-facet="${f}">${f === 'none' ? 'flat' : f}</button>`).join('');

        this.contentEl.innerHTML = `
            <div class="lx-dashboard">
                <div class="lx-hot-head">
                    <h3>Dashboard</h3>
                    <span class="lx-hot-sub">latest day · each metric vs its own baseline and the hard target</span>
                    <span class="lx-spacer"></span>
                    <button class="lx-btn lx-btn-sm" data-action="hot-refresh">Refresh</button>
                </div>
                ${this.summaryBar(all)}
                <div class="lx-db-controls">
                    <span class="lx-db-ctl-label">Group</span>${groupPills}
                    <span class="lx-spacer"></span>
                    <label class="lx-db-check"><input type="checkbox" data-action="dash-problems" ${this.dashProblemsOnly ? 'checked' : ''}/> Problems only</label>
                </div>
                <table class="lx-db-table">
                    <thead><tr><th class="lx-db-id">Source</th>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
                    <tbody>${body}</tbody>
                </table>
            </div>`;
    }

    // Shared alert summary — counts of sources by their worst metric state. Used by Hotspots + Dashboard.
    summaryBar(vitals) {
        const counts = { acute: 0, elevated: 0, watch: 0, ok: 0, other: 0 };
        for (const v of vitals) { const w = worstState(v); if (w in counts) counts[w]++; else counts.other++; }
        const chip = (n, st, lbl) => `<span class="lx-db-chip lx-db-chip-${st}">${n} ${lbl}</span>`;
        return `<div class="lx-db-summary">${
            chip(counts.acute, 'acute', 'acute') + chip(counts.elevated, 'elevated', 'elevated')
            + chip(counts.watch, 'watch', 'watch') + chip(counts.ok, 'ok', 'healthy')
            + (counts.other ? chip(counts.other, 'nobaseline', 'no baseline / data') : '')
        }</div>`;
    }

    setDashGroup(facet) { this.dashGroupBy = facet; this.render(); }
    toggleDashProblems() { this.dashProblemsOnly = !this.dashProblemsOnly; this.render(); }

    issueOpen(btn) {
        const { source, date, fstatus, fmintime } = btn.dataset;
        if (!date) { this.openSource(source); return; }
        this.openWithFilter(source, date, { status: fstatus || '', minTime: fmintime || '' });
    }

    vitalOpen(btn) {
        const { source, date } = btn.dataset;
        if (!date) { this.openSource(source); return; }
        this.openWithFilter(source, date, {});
    }

    async openWithFilter(sourceId, date, filter) {
        this.mode = 'browse';
        await this.selectSource(sourceId);
        this.day = date;
        this.dayView = 'entries';
        this.dayOrigin = { type: 'hotspots' };
        this.detail = null;
        this.filter = { ...emptyFilter(), ...filter };
        this.entries = { loading: false, error: null, data: null, offset: 0 };
        this.stats = { loading: false, error: null, data: null };
        this.loadEntries();
    }

    openSource(sourceId) {
        this.mode = 'browse';
        this.selectSource(sourceId);
    }

    // ---- calendar (by application) ---------------------------------------

    async loadCalendar() {
        this.calendar = { loading: true, error: null, data: null };
        this.render();
        try {
            const data = await fetchCalendar();
            this.calendar = { loading: false, error: null, data };
            if (!this.calMonth) {
                const last = data.days.length ? data.days[data.days.length - 1].date : null;
                const d = last ? new Date(last + 'T00:00:00') : new Date();
                this.calMonth = { year: d.getFullYear(), month: d.getMonth() };
            }
        } catch (err) {
            this.calendar = { loading: false, error: err.message, data: null };
        }
        this.render();
        this.loadHeatmap();
    }

    scopeSources() {
        const all = this.config.logSources;
        if (this.calScope === 'all') return all.map((s) => s.id);
        const [facet, value] = this.calScope.split(/:(.*)/s);
        return all.filter((s) => s[facet] === value).map((s) => s.id);
    }

    calScopeLabel() {
        return this.calScope === 'all' ? 'All sources' : (this.calScope.split(/:(.*)/s)[1] || this.calScope);
    }

    setCalScope(scope) {
        if (this.calScope === scope) return;
        this.calScope = scope;
        this.loadHeatmap();
    }

    async loadHeatmap() {
        const sources = this.scopeSources();
        if (!sources.length || !this.calMonth) {
            this.heatmap = { loading: false, error: null, data: null };
            this.render();
            return;
        }
        const { year, month } = this.calMonth;
        const from = `${year}-${pad2(month + 1)}-01`;
        const to = `${year}-${pad2(month + 1)}-${pad2(new Date(year, month + 1, 0).getDate())}`;
        const sig = () => `${this.calScope}|${year}-${month}`;
        const token = sig();
        this.heatmap = { loading: true, error: null, data: null };
        this.render();
        try {
            const data = await fetchHeatmap(sources, from, to);
            if (sig() !== token) return;
            this.heatmap = { loading: false, error: null, data };
        } catch (err) {
            if (sig() !== token) return;
            this.heatmap = { loading: false, error: err.message, data: null };
        }
        this.render();
    }

    shiftMonth(delta) {
        const d = new Date(this.calMonth.year, this.calMonth.month + delta, 1);
        this.calMonth = { year: d.getFullYear(), month: d.getMonth() };
        this.loadHeatmap();
    }

    renderCalendar() {
        const c = this.calendar;
        if (c.loading) { this.contentEl.innerHTML = `<p class="lx-empty">Loading…</p>`; return; }
        if (c.error) { this.contentEl.innerHTML = `<p class="lx-days-error">${esc(c.error)}</p>`; return; }

        const apps = [...new Set(c.data.sources.map((s) => s.application))].filter(Boolean).sort();
        const stages = [...new Set(c.data.sources.map((s) => s.stage))].filter(Boolean).sort();
        const pill = (scope, text) =>
            `<button class="lx-gb${this.calScope === scope ? ' lx-gb-active' : ''}" data-action="cal-scope" data-scope="${esc(scope)}">${esc(text)}</button>`;
        const scopes = [pill('all', 'All')]
            .concat(apps.map((a) => pill('application:' + a, a)))
            .concat(stages.map((s) => pill('stage:' + s, s)))
            .join('');

        const byDate = {};
        let maxVol = 1;
        for (const d of this.heatmap.data?.days ?? []) { byDate[d.date] = d; if (d.total > maxVol) maxVol = d.total; }

        const { year, month } = this.calMonth;
        const monthLabel = new Date(year, month, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
        const first = new Date(year, month, 1).getDay();
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
            .map((w) => `<div class="lx-cal-wd">${w}</div>`).join('');

        const cells = [];
        for (let i = 0; i < first; i++) cells.push(`<div class="lx-cal-cell lx-cal-empty"></div>`);
        for (let day = 1; day <= daysInMonth; day++) {
            const date = `${year}-${pad2(month + 1)}-${pad2(day)}`;
            const m = byDate[date];
            if (!m) { cells.push(`<div class="lx-cal-cell"><span class="lx-cal-num">${day}</span></div>`); continue; }
            const rate = m.total ? m.serverErrors / m.total : 0;
            const health = rate >= 0.02 ? 'err' : rate >= 0.005 ? 'warn' : 'ok';
            const opacity = (0.15 + 0.65 * (m.total / maxVol)).toFixed(3);
            const tip = `${date} — ${m.total.toLocaleString()} req · ${(rate * 100).toFixed(2)}% 5xx · avg ${m.avgTimeTaken} ms`;
            cells.push(`
                <button class="lx-cal-cell lx-cal-heat lx-heat-${health}" style="--vol:${opacity}" data-action="cal-day" data-date="${esc(date)}" title="${esc(tip)}">
                    <span class="lx-cal-num">${day}</span>
                    <span class="lx-cal-metric">${compactNum(m.total)}</span>
                    <span class="lx-cal-err">${(rate * 100).toFixed(1)}% 5xx</span>
                </button>`);
        }

        const note = this.heatmap.loading ? `<span class="lx-hot-sub">loading…</span>` : '';
        this.contentEl.innerHTML = `
            <div class="lx-calendar">
                <div class="lx-cal-head">
                    <button class="lx-btn lx-btn-sm" data-action="cal-prev">‹</button>
                    <span class="lx-cal-month">${esc(monthLabel)}</span>
                    <button class="lx-btn lx-btn-sm" data-action="cal-next">›</button>
                    ${note}
                    <span class="lx-spacer"></span>
                    <span class="lx-cal-legend">5xx:
                        <span class="lx-legend-sw" style="background:#2da44e"></span>low
                        <span class="lx-legend-sw" style="background:#bf8700"></span>med
                        <span class="lx-legend-sw" style="background:#cf222e"></span>high · shade = volume</span>
                </div>
                <div class="lx-cal-scopes">${scopes}</div>
                <div class="lx-cal-grid">${weekdays}${cells.join('')}</div>
            </div>`;
    }

    // ---- selection -------------------------------------------------------

    async selectSource(sourceId) {
        this.selectedSource = sourceId;
        this.aggregate = null;
        this.day = null;
        this.detail = null;
        this.dayOrigin = null;
        this.trendDates = null;
        this.selectedDays.clear();
        this.days = { loading: true, error: null, data: null };
        this.renderBrowse();

        const token = this.selectionKey();
        try {
            const result = await fetchDays(sourceId);
            if (this.selectionKey() !== token) return;
            this.days = { loading: false, error: null, data: result };
        } catch (err) {
            if (this.selectionKey() !== token) return;
            this.days = { loading: false, error: err.message, data: null };
        }
        this.renderBrowse();
    }

    selectionKey() {
        return this.selectedSource;
    }

    setGroupBy(facet) {
        this.browseGroupBy = facet;
        this.renderBrowse();
    }

    // ---- manage (flat sources) -------------------------------------------

    renderManage() {
        const rows = this.config.logSources.length
            ? this.config.logSources.map((s) => this.renderSourceRow(s)).join('')
            : `<tr><td colspan="7" class="lx-empty">No log sources yet. Add one to begin.</td></tr>`;
        this.contentEl.innerHTML = `
            <table class="lx-sources">
                <thead><tr><th>Application</th><th>Type</th><th>Stage</th><th>Server</th><th>Instance</th><th>Log Path</th><th></th></tr></thead>
                <tbody>${rows}</tbody>
            </table>
            <div class="lx-add-row"><button class="lx-btn" data-action="add-source">+ Add Log Source</button></div>`;
    }

    renderSourceRow(s) {
        return `
            <tr>
                <td>${esc(s.application)}</td>
                <td>${esc(s.type)}</td>
                <td>${esc(s.stage)}</td>
                <td>${esc(s.server)}</td>
                <td><code>${esc(s.instance)}</code></td>
                <td class="lx-path">${esc(s.logPath)}</td>
                <td class="lx-row-actions">
                    <button class="lx-link" data-action="edit-source" data-source="${esc(s.id)}">Edit</button>
                    <button class="lx-link lx-danger" data-action="delete-source" data-source="${esc(s.id)}">Delete</button>
                </td>
            </tr>`;
    }

    renderOverlay() {
        if (this.editor) { this.renderEditorDialog(); return; }
        if (this.detail) { this.renderDetailDialog(); return; }
        this.overlayEl.hidden = true;
        this.overlayEl.innerHTML = '';
    }

    renderDetailDialog() {
        const { columns, values } = this.detail;
        const rows = columns.map((c, i) => `
            <div class="lx-detail-row">
                <dt>${esc(c)}</dt>
                <dd>${cell(values[i])}</dd>
            </div>`).join('');
        this.overlayEl.hidden = false;
        this.overlayEl.innerHTML = `
            <div class="lx-dialog lx-detail">
                <div class="lx-detail-head">
                    <h3>Entry</h3>
                    <button class="lx-link" data-action="close-detail">Close</button>
                </div>
                <dl class="lx-detail-list">${rows}</dl>
            </div>`;
    }

    renderEditorDialog() {
        const e = this.editor;
        const d = e.draft;
        const title = `${e.mode === 'add' ? 'Add' : 'Edit'} Log Source`;
        const field = (name, label, req) =>
            `<label class="lx-field"><span>${label}</span><input name="${name}" value="${esc(d[name] ?? '')}" ${req ? 'required' : ''} /></label>`;

        this.overlayEl.hidden = false;
        this.overlayEl.innerHTML = `
            <form class="lx-dialog lx-dialog-wide" data-action="submit-editor">
                <h3>${title}</h3>
                <p class="lx-form-error" data-ref="form-error" hidden></p>
                <div class="lx-field-grid">
                    ${field('application', 'Application', true)}
                    ${field('type', 'Type', true)}
                    ${field('stage', 'Stage', true)}
                    ${field('server', 'Server', true)}
                    ${field('instance', 'Instance', false)}
                </div>
                ${field('logPath', 'Log Path', true)}
                ${field('tags', 'Tags (comma-separated)', false)}
                <div class="lx-dialog-actions">
                    <button type="button" class="lx-btn" data-action="cancel-edit">Cancel</button>
                    <button type="submit" class="lx-btn lx-btn-primary">OK</button>
                </div>
            </form>`;
    }

    // ---- events ----------------------------------------------------------

    onClick(e) {
        if (this.detail && e.target === this.overlayEl) { this.closeDetail(); return; }
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        const action = btn.dataset.action;
        const sourceId = btn.dataset.source;

        switch (action) {
            case 'mode-browse': this.setMode('browse'); break;
            case 'mode-calendar': this.setMode('calendar'); break;
            case 'mode-hotspots': this.setMode('hotspots'); break;
            case 'mode-dashboard': this.setMode('dashboard'); break;
            case 'mode-manage': this.setMode('manage'); break;
            case 'dash-group': this.setDashGroup(btn.dataset.facet); break;
            case 'dash-problems': this.toggleDashProblems(); break;
            case 'groupby': this.setGroupBy(btn.dataset.facet); break;
            case 'analyze-group': this.analyzeGroup(btn.dataset.group); break;
            case 'agg-source': this.aggOpenSource(sourceId); break;
            case 'agg-day': this.aggDay(btn.dataset.date); break;
            case 'agg-back': this.backFromAggregate(); break;
            case 'hot-refresh': this.loadHotspots(); break;
            case 'issue-open': this.issueOpen(btn); break;
            case 'vital-open': this.vitalOpen(btn); break;
            case 'drill-hour': this.drillHour(Number(btn.dataset.hour)); break;
            case 'drill-minute': this.drillMinute(btn.dataset.minute); break;
            case 'select-source': this.selectSource(sourceId); break;
            case 'select-day': this.selectDay(btn.dataset.date); break;
            case 'toggle-day': this.toggleDay(btn.dataset.date); break;
            case 'toggle-all-days': this.toggleAllDays(); break;
            case 'open-trends': this.openTrends(); break;
            case 'drill-day': this.drillDay(btn.dataset.date); break;
            case 'cal-prev': this.shiftMonth(-1); break;
            case 'cal-next': this.shiftMonth(1); break;
            case 'cal-scope': this.setCalScope(btn.dataset.scope); break;
            case 'cal-day': this.openCalendarDay(btn.dataset.date); break;
            case 'back-to-days': this.backToDays(); break;
            case 'go-back': this.goBack(); break;
            case 'dayview-entries': this.setDayView('entries'); break;
            case 'dayview-analytics': this.setDayView('analytics'); break;
            case 'drill': this.drill(btn.dataset.field, btn.dataset.value); break;
            case 'row-detail': this.openDetail(Number(btn.dataset.row)); break;
            case 'close-detail': this.closeDetail(); break;
            case 'entries-prev': this.entriesPrev(); break;
            case 'entries-next': this.entriesNext(); break;
            case 'clear-filter': this.clearFilter(); break;
            case 'toggle-tz': this.toggleTz(); break;
            case 'save': this.doSave(); break;
            case 'add-source': this.openEditor({ mode: 'add', draft: emptySourceDraft() }); break;
            case 'edit-source': this.openEditor({ mode: 'edit', draft: editSourceDraft(this.source(sourceId)) }); break;
            case 'delete-source': this.deleteSource(sourceId); break;
            case 'cancel-edit': this.closeEditor(); break;
        }
    }

    onSubmit(e) {
        const form = e.target.closest('form[data-action]');
        if (!form) return;
        e.preventDefault();

        if (form.dataset.action === 'apply-filter') {
            this.applyFilter(form);
            return;
        }
        if (form.dataset.action === 'apply-span') {
            this.applySpan(form);
            return;
        }
        this.commitSource(this.editor, Object.fromEntries(new FormData(form).entries()), form);
    }

    setMode(mode) {
        if (this.mode === mode) return;
        this.mode = mode;
        this.detail = null;
        this.aggregate = null;
        if (mode === 'calendar' && !this.calendar.data && !this.calendar.loading) this.loadCalendar();
        else if ((mode === 'hotspots' || mode === 'dashboard') && !this.hotspots.data && !this.hotspots.loading) this.loadHotspots();
        else this.render();
    }

    // ---- mutations -------------------------------------------------------

    commitSource(editor, data, form) {
        const fields = {
            application: (data.application || '').trim(),
            type: (data.type || '').trim(),
            stage: (data.stage || '').trim(),
            server: (data.server || '').trim(),
            instance: (data.instance || '').trim(),
            logPath: (data.logPath || '').trim(),
            tags: (data.tags || '').split(',').map((t) => t.trim()).filter(Boolean)
        };

        if (editor.mode === 'add') {
            this.config.logSources.push({ id: this.uniqueId(fields), ...fields });
        } else {
            Object.assign(this.source(editor.draft.id), fields);
        }
        this.markDirty();
        this.closeEditor();
    }

    deleteSource(id) {
        if (!confirm('Delete this log source?')) return;
        this.config.logSources = this.config.logSources.filter((s) => s.id !== id);
        if (this.selectedSource === id) this.clearSelection();
        this.markDirty();
        this.render();
    }

    clearSelection() {
        this.selectedSource = null;
        this.day = null;
        this.days = { loading: false, error: null, data: null };
        this.entries = { loading: false, error: null, data: null, offset: 0 };
    }

    async doSave() {
        this.saveBtn.disabled = true;
        this.setStatus('Saving…', false);
        try {
            await saveSources(this.config);
            this.dirty = false;
            this.setStatus('Saved.', false);
        } catch (err) {
            this.setStatus(err.message, true);
        }
        this.saveBtn.disabled = !this.dirty;
    }

    // ---- helpers ---------------------------------------------------------

    source(id) { return this.config.logSources.find((s) => s.id === id); }

    sourceLabel(s) {
        return s ? `${s.application} · ${s.type} · ${s.stage} · ${s.server}` : '';
    }

    sourceSubLabel(s) {
        // the facets other than the current group-by, to identify a source within its group
        return GROUP_FACETS.filter((f) => f !== this.browseGroupBy).map((f) => s[f]).filter(Boolean).join(' · ')
            || s.instance || s.id;
    }

    // ---- timezone (display only; logs/buckets are UTC) -------------------

    toggleTz() {
        this.tz = this.tz === 'utc' ? 'local' : 'utc';
        this.render();
    }

    tzLabel() {
        if (this.tz === 'utc') return 'UTC';
        const off = -new Date().getTimezoneOffset();
        const sign = off >= 0 ? '+' : '−';
        const a = Math.abs(off);
        return `Local (UTC${sign}${pad2(a / 60 | 0)}:${pad2(a % 60)})`;
    }

    tzShort() { return this.tz === 'utc' ? 'UTC' : 'local'; }

    filterDateContext() { return this.day || this.aggregate?.from || todayStr(); }

    // UTC date+time -> selected display zone ({date, time}); identity when UTC.
    toZone(dateStr, timeStr) {
        if (this.tz === 'utc' || !dateStr || !timeStr) return { date: dateStr, time: timeStr };
        const [Y, M, D] = dateStr.split('-').map(Number);
        const p = timeStr.split(':').map(Number);
        const d = new Date(Date.UTC(Y, M - 1, D, p[0] || 0, p[1] || 0, p[2] || 0));
        const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
        const time = p.length > 2
            ? `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
            : `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
        return { date, time };
    }

    // selected-zone time-of-day (on a context date) -> UTC "HH:mm[:ss]"; identity when UTC.
    toUtcTime(dateStr, localTime) {
        if (this.tz === 'utc' || !localTime) return localTime;
        const [Y, M, D] = (dateStr || todayStr()).split('-').map(Number);
        const p = localTime.split(':').map(Number);
        const d = new Date(Y, M - 1, D, p[0] || 0, p[1] || 0, p[2] || 0);
        return p.length > 2
            ? `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`
            : `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
    }

    zoneTime(timeStr) { return this.toZone(this.day, timeStr).time; }

    // ---- permalink (view state in the URL hash) --------------------------

    syncUrl() {
        const p = new URLSearchParams();
        p.set('mode', this.mode);
        if (this.tz === 'utc') p.set('tz', 'utc');
        if (this.mode === 'browse') {
            if (this.aggregate) {
                p.set('aggsrc', this.aggregate.sources.join(','));
                p.set('agg', this.aggregate.label);
                if (this.aggregate.from) p.set('from', this.aggregate.from);
                if (this.aggregate.to) p.set('to', this.aggregate.to);
                writeFilterParams(p, this.filter);
            } else if (this.selectedSource) {
                p.set('src', this.selectedSource);
                if (this.trendDates) { p.set('trends', this.trendDates.join(',')); writeFilterParams(p, this.filter); }
                else if (this.day) { p.set('day', this.day); p.set('view', this.dayView); writeFilterParams(p, this.filter); }
            }
        }
        const hash = '#' + p.toString();
        if (location.hash !== hash) {
            try { history.replaceState(null, '', hash); } catch { /* sandboxed */ }
        }
    }

    async restoreState(p) {
        this.tz = p.get('tz') === 'utc' ? 'utc' : 'local';
        this.mode = p.get('mode') || 'browse';
        this.filter = readFilterParams(p);

        if (this.mode === 'calendar') return this.loadCalendar();
        if (this.mode === 'hotspots' || this.mode === 'dashboard') return this.loadHotspots();
        if (this.mode === 'manage') return this.render();

        const agg = p.get('agg');
        if (agg) {
            const sources = (p.get('aggsrc') || '').split(',').filter(Boolean);
            this.aggregate = { label: agg, sources, from: p.get('from') || null, to: p.get('to') || null, origin: 'browse', loading: false, error: null, data: null };
            return this.loadAggregate();
        }

        const srcId = p.get('src');
        if (srcId && this.source(srcId)) {
            this.selectedSource = srcId;
            this.days = { loading: true, error: null, data: null };
            this.render();
            try { this.days = { loading: false, error: null, data: await fetchDays(srcId) }; }
            catch (err) { this.days = { loading: false, error: err.message, data: null }; }

            const trends = p.get('trends');
            if (trends) { this.trendDates = trends.split(','); return this.loadTrends(); }
            const day = p.get('day');
            if (day) {
                this.day = day;
                this.dayView = p.get('view') === 'analytics' ? 'analytics' : 'entries';
                this.dayOrigin = { type: 'days' };
                return this.dayView === 'analytics' ? this.loadStats() : this.loadEntries();
            }
            return this.render();
        }
        this.render();
    }

    openEditor(editor) { this.editor = editor; this.renderOverlay(); }
    closeEditor() { this.editor = null; this.render(); }

    openDetail(i) {
        this.detail = { columns: this.entries.data.columns, values: this.entries.data.rows[i] };
        this.renderOverlay();
    }
    closeDetail() { this.detail = null; this.renderOverlay(); }

    formError(form, message) {
        const el = form.querySelector('[data-ref="form-error"]');
        el.textContent = message;
        el.hidden = false;
    }

    markDirty() { this.dirty = true; }
    setStatus(text, isError) {
        this.statusEl.textContent = text || '';
        this.statusEl.classList.toggle('lx-status-error', !!isError);
    }

    uniqueId(fields) {
        const base = slugify(`${fields.application}-${fields.type}-${fields.stage}-${fields.server}`) || 'source';
        const taken = new Set(this.config.logSources.map((s) => s.id));
        if (!taken.has(base)) return base;
        let n = 2;
        while (taken.has(`${base}-${n}`)) n++;
        return `${base}-${n}`;
    }
}

const FILTER_KEYS = ['q', 'method', 'status', 'uri', 'minTime', 'fromTime', 'toTime', 'ip', 'agent'];

function emptyFilter() {
    return { q: '', method: '', status: '', uri: '', minTime: '', fromTime: '', toTime: '', ip: '', agent: '' };
}

function writeFilterParams(p, f) {
    for (const k of FILTER_KEYS) if (f[k]) p.set(k, f[k]);
}

function readFilterParams(p) {
    const f = emptyFilter();
    for (const k of FILTER_KEYS) if (p.get(k)) f[k] = p.get(k);
    return f;
}

function emptySourceDraft() {
    return { application: '', type: '', stage: '', server: '', instance: '', logPath: '', tags: '' };
}

function editSourceDraft(s) {
    return { ...s, tags: (s.tags ?? []).join(', ') };
}

const STATUS_LABELS = {
    200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content', 206: 'Partial Content', 304: 'Not Modified',
    301: 'Moved Permanently', 302: 'Found', 307: 'Temporary Redirect', 308: 'Permanent Redirect',
    400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed',
    406: 'Not Acceptable', 408: 'Request Timeout', 409: 'Conflict', 410: 'Gone', 413: 'Payload Too Large',
    414: 'URI Too Long', 429: 'Too Many Requests',
    500: 'Internal Server Error', 501: 'Not Implemented', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout'
};

function statusLabel(code) {
    return STATUS_LABELS[Number(code)] ?? '';
}

// Well-known IIS sc-substatus meanings; falls back to the parent status name.
const SUBSTATUS_HINTS = {
    '401.1': 'Logon failed', '401.2': 'Logon failed — server config', '401.3': 'Denied by ACL',
    '401.4': 'Denied by filter', '401.5': 'Denied by ISAPI/CGI',
    '403.1': 'Execute access denied', '403.4': 'SSL required', '403.6': 'IP address rejected',
    '403.14': 'Directory listing denied', '403.18': 'Cannot execute in this app pool',
    '404.4': 'No handler configured', '404.13': 'Content length too large',
    '500.0': 'Module or ISAPI error', '500.13': 'Server too busy', '500.19': 'Invalid configuration data',
    '500.21': 'Module not recognized', '500.24': 'Impersonation in integrated pipeline',
    '503.0': 'Service unavailable', '503.2': 'Concurrent request limit exceeded'
};

function substatusHint(status, sub) {
    return SUBSTATUS_HINTS[`${status}.${sub}`] ?? statusLabel(status);
}

function slugify(name) {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// ---- baseline-vs-target metric shared helpers (contrast widget + dashboard) ----
const STATE_TEXT = {
    ok: 'healthy', watch: 'rising · under target', elevated: 'stable · over target',
    acute: 'rising · over target', nobaseline: 'building baseline', nodata: 'no logs'
};
const STATE_ORDER = ['acute', 'elevated', 'watch', 'ok', 'nobaseline', 'nodata'];
const stateRank = (s) => { const i = STATE_ORDER.indexOf(s); return i < 0 ? 99 : i; };

function metricDrill(m) {
    if (m.key === 'latency') return { minTime: String(Math.round(m.target)) };
    return ({ '5xx': { status: '5xx' }, auth: { status: '401' }, '404': { status: '404' } })[m.key] ?? {};
}

function fmtMetric(val, unit) {
    return unit === 'ms' ? `${Math.round(val).toLocaleString()} ms` : `${val.toFixed(1)}%`;
}

// Inline SVG sparkline of a metric's trailing series (oldest→newest, today last), with a dashed
// target reference line and the last point dotted in the cell's state color.
function sparkline(series, target, state) {
    if (!series || !series.length) return '';
    const w = 56, h = 18, pad = 2;
    const lo = Math.min(...series, target), hi = Math.max(...series, target);
    const span = hi - lo || 1;
    const x = (i) => series.length < 2 ? w / 2 : pad + (i * (w - 2 * pad)) / (series.length - 1);
    const y = (val) => h - pad - ((val - lo) / span) * (h - 2 * pad);
    const pts = series.map((val, i) => `${x(i).toFixed(1)},${y(val).toFixed(1)}`).join(' ');
    const ty = y(target).toFixed(1);
    const li = series.length - 1;
    return `<svg class="lx-spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">
        <line class="lx-spark-tgt" x1="0" y1="${ty}" x2="${w}" y2="${ty}"/>
        ${series.length > 1 ? `<polyline class="lx-spark-line" points="${pts}"/>` : ''}
        <circle class="lx-spark-dot lx-spark-${state}" cx="${x(li).toFixed(1)}" cy="${y(series[li]).toFixed(1)}" r="2.2"/>
    </svg>`;
}

// Worst (most severe) state across a source's metrics — drives dashboard sort + summary.
function worstState(v) {
    if (v.health === 'nodata' || !v.metrics || !v.metrics.length) return 'nodata';
    return v.metrics.reduce((w, m) => stateRank(m.state) < stateRank(w) ? m.state : w, 'nobaseline');
}

function cell(value) {
    return value === '-' || value === '' ? `<span class="lx-dash">${esc(value)}</span>` : esc(value);
}

function pad2(n) { return String(Math.trunc(n)).padStart(2, '0'); }

function compactNum(n) {
    if (n < 1000) return String(n);
    if (n < 1e6) return (n / 1000).toFixed(n < 10000 ? 1 : 0) + 'k';
    return (n / 1e6).toFixed(1) + 'M';
}

function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function formatSpan(minutes) {
    if (minutes <= 0) return '—';
    const h = Math.floor(minutes / 60), m = minutes % 60;
    return h ? `${h}h ${m}m` : `${m}m`;
}

function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let v = n / 1024, i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(1)} ${units[i]}`;
}

function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}
