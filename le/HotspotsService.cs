using LogExplorer.Models;
using Microsoft.Extensions.Options;

namespace LogExplorer.Services
{
    public record Vital(
        string SourceId, string Application, string Type, string Stage, string Server, string Instance, string? Date,
        int Total, double ErrorRate, double ClientErrorRate, int P95, int AvgTimeTaken, string Health,
        IReadOnlyList<MetricContrast> Metrics);

    // One metric seen through both lenses: its value now, what's normal for this source (baseline median),
    // and the hard target line. State crosses the two: ok / watch (rising, still under target) /
    // elevated (stable but over target — the chronic case) / acute (rising AND over) / nobaseline.
    // Series = the trailing per-day values (oldest→newest, today last) in display units, for the sparkline.
    public record MetricContrast(string Key, string Label, double Current, double? Baseline, double Target, string Unit, string State, double[] Series);

    public record Issue(
        string SourceId, string Application, string Type, string Stage, string Server, string? Date,
        string IssueType, string Severity, string Title, int Count, string? FilterStatus, int? FilterMinTime);

    public record HotspotsReport(IReadOnlyList<Vital> Vitals, IReadOnlyList<Issue> Issues);

    /// <summary>
    /// Builds the Hotspots report: per-log-source vitals plus a ranked feed of suspect conditions over
    /// each source's most recent day. Conditions are **baseline-relative anomalies** (the latest day vs
    /// the source's own trailing history, robust median+MAD) for 5xx rate / latency / volume, falling back
    /// to static thresholds for auth/404 and where there's too little history. Reuses the day cache.
    /// </summary>
    public class HotspotsService
    {
        private const int BaselineDays = 14;

        private readonly MetadataStore _store;
        private readonly LogFileScanner _scanner;
        private readonly LogReader _reader;
        private readonly LogDayCache _cache;
        private readonly ScaleOptions _scale;
        private readonly HotspotTargets _targets;

        public HotspotsService(MetadataStore store, LogFileScanner scanner, LogReader reader, LogDayCache cache,
            IOptions<ScaleOptions> scale, IOptions<HotspotsOptions> hotspots)
        {
            _store = store;
            _scanner = scanner;
            _reader = reader;
            _cache = cache;
            _scale = scale.Value;
            _targets = hotspots.Value.Targets;
        }

        public async Task<HotspotsReport> BuildAsync()
        {
            var config = await _store.LoadAsync();
            var vitals = new List<Vital>();
            var issues = new List<Issue>();

            foreach (var src in config.LogSources)
            {
                var days = _scanner.GetAvailableDays(src.LogPath);
                if (days == null || days.Count == 0)
                {
                    vitals.Add(new Vital(src.Id, src.Application, src.Type, src.Stage, src.Server, src.Instance, null, 0, 0, 0, 0, 0, "nodata", Array.Empty<MetricContrast>()));
                    issues.Add(new Issue(src.Id, src.Application, src.Type, src.Stage, src.Server, null,
                        "silent", "medium", "No logs found", 0, null, null));
                    continue;
                }

                var date = days[0].Date; // newest first
                var ds = date.ToString("yyyy-MM-dd");
                var files = _scanner.GetDayFiles(src.LogPath, date)!;
                var h = _reader.ComputeHealth(RowsFor(src.LogPath, date, files));

                double errRate = h.Total > 0 ? (double)h.Err / h.Total : 0;
                double clientRate = h.Total > 0 ? (double)h.Warn / h.Total : 0;
                string health = errRate >= 0.01 || h.P95 >= 3000 ? "red"
                    : errRate >= 0.002 || clientRate >= 0.05 || h.P95 >= 1000 ? "amber" : "green";

                var b = Baseline(src, days);
                bool hasBaseline = b.Err.Count >= 3;
                var fired = DetectAnomalies(src, ds, h, b, issues);
                // Once a source has its own baseline, the baseline governs the issue feed; the chronic
                // "stable-but-over-target" case lives in the contrast widget, not as a nagging static issue.
                if (!hasBaseline) DetectThresholdIssues(src, ds, h, errRate, issues);

                vitals.Add(new Vital(src.Id, src.Application, src.Type, src.Stage, src.Server, src.Instance, ds,
                    h.Total, errRate, clientRate, h.P95, h.AvgTimeTaken, health, BuildContrast(h, b, fired, hasBaseline)));
            }

            issues = issues.OrderBy(i => SeverityRank(i.Severity)).ThenByDescending(i => i.Count).ToList();
            vitals = vitals.OrderBy(v => HealthRank(v.Health)).ThenByDescending(v => v.ErrorRate).ToList();
            return new HotspotsReport(vitals, issues);
        }

        // Per-day rates/values over the source's own recent history (current day excluded). Lat = p95.
        private record BaselineSet(List<double> Err, List<int> Vol, List<int> Lat, List<double> Auth, List<double> NotFound);

        // Which baseline-relative anomalies fired (so the matching static threshold is suppressed).
        private record FiredSet(bool Err, bool Slow, bool Auth, bool NotFound);

        private BaselineSet Baseline(LogSource src, IReadOnlyList<DayInfo> days)
        {
            var b = new BaselineSet(new(), new(), new(), new(), new());
            foreach (var d in days.Skip(1).Take(BaselineDays))
            {
                var files = _scanner.GetDayFiles(src.LogPath, d.Date);
                if (files == null || files.Count == 0) continue;
                var su = _reader.ComputeSummary(RowsFor(src.LogPath, d.Date, files), LogFilter.None);
                if (su.Total == 0) continue;
                b.Err.Add((double)su.Err / su.Total);
                b.Vol.Add(su.Total);
                b.Lat.Add(su.P95);
                b.Auth.Add((double)su.Auth / su.Total);
                b.NotFound.Add((double)su.NotFound / su.Total);
            }
            return b;
        }

        private FiredSet DetectAnomalies(LogSource src, string ds, HealthMetrics cur, BaselineSet b, List<Issue> issues)
        {
            if (b.Err.Count < 3) return new FiredSet(false, false, false, false); // too little history

            bool firedErr = false, firedSlow = false, firedAuth = false, firedNf = false;
            int authCount = cur.StatusCounts.GetValueOrDefault("401") + cur.StatusCounts.GetValueOrDefault("403");
            int nfCount = cur.StatusCounts.GetValueOrDefault("404");
            double curErr = Rate(cur.Err, cur.Total), curAuth = Rate(authCount, cur.Total), curNf = Rate(nfCount, cur.Total);

            // 5xx rate — degradation (upward) only
            var (e, ez, eMed) = AnomalyUp(curErr, b.Err, madFloor: 0.002, minDelta: 0.005);
            if (e)
            {
                firedErr = true;
                issues.Add(MakeIssue(src, ds, "anomaly-5xx", ez >= 6 ? "high" : "medium",
                    $"5xx {curErr:P1} — {Norm(curErr, eMed)}", cur.Err, "5xx", null));
            }

            // p95 latency — upward only
            double curLat = cur.P95;
            var (l, lz, lMed) = AnomalyUp(curLat, b.Lat.Select(x => (double)x).ToList(), madFloor: 50, minDelta: 200);
            if (l)
            {
                firedSlow = true;
                issues.Add(MakeIssue(src, ds, "anomaly-latency", lz >= 6 ? "high" : "medium",
                    $"p95 latency {curLat:N0} ms — {(lMed >= 1 ? $"{curLat / lMed:N1}× normal ({lMed:N0} ms)" : "vs ~0")}",
                    cur.P95, null, (int)Math.Max(lMed * 2, 500)));
            }

            // Auth failures (401+403) rate — upward only
            var (a, az, aMed) = AnomalyUp(curAuth, b.Auth, madFloor: 0.005, minDelta: 0.01);
            if (a)
            {
                firedAuth = true;
                issues.Add(MakeIssue(src, ds, "anomaly-auth", az >= 6 ? "high" : "medium",
                    $"auth failures {curAuth:P1} — {Norm(curAuth, aMed)}", authCount, "401", null));
            }

            // 404 rate — upward only
            var (n, nz, nMed) = AnomalyUp(curNf, b.NotFound, madFloor: 0.01, minDelta: 0.02);
            if (n)
            {
                firedNf = true;
                issues.Add(MakeIssue(src, ds, "anomaly-404", nz >= 6 ? "high" : "medium",
                    $"not-found {curNf:P1} — {Norm(curNf, nMed)}", nfCount, "404", null));
            }

            // Volume — both directions (spike or drop), relative to median
            double vMed = Median(b.Vol.Select(x => (double)x).ToList());
            if (vMed >= 50)
            {
                double ratio = cur.Total / vMed;
                if (ratio >= 3)
                    issues.Add(MakeIssue(src, ds, "anomaly-volume", ratio >= 5 ? "high" : "medium",
                        $"traffic {cur.Total:N0} — {ratio:N1}× normal ({vMed:N0})", cur.Total, null, null));
                else if (ratio <= 0.3)
                    issues.Add(MakeIssue(src, ds, "anomaly-volume", ratio <= 0.2 ? "high" : "medium",
                        $"traffic {cur.Total:N0} — {ratio * 100:N0}% of normal ({vMed:N0})", cur.Total, null, null));
            }

            return new FiredSet(firedErr, firedSlow, firedAuth, firedNf);
        }

        // Static thresholds — the fallback for sources too new to have a baseline yet. The primary
        // "over the line" boundary is the configured target; the secondary high-severity step is fixed.
        private void DetectThresholdIssues(LogSource src, string ds, HealthMetrics h, double errRate, List<Issue> issues)
        {
            if (h.Err > 0 && (errRate >= _targets.FiveXxRate / 10 || h.Err >= 5))
            {
                string sev = errRate >= _targets.FiveXxRate ? "high" : errRate >= _targets.FiveXxRate / 5 ? "medium" : "low";
                issues.Add(MakeIssue(src, ds, "5xx", sev, $"{h.Err:N0} server errors ({errRate:P1})", h.Err, "5xx", null));
            }

            int auth = h.StatusCounts.GetValueOrDefault("401") + h.StatusCounts.GetValueOrDefault("403");
            double authRate = Rate(auth, h.Total);
            if (auth >= 10 || authRate >= _targets.AuthRate)
            {
                string sev = authRate >= _targets.AuthRate * 5 ? "high" : "medium";
                issues.Add(MakeIssue(src, ds, "auth", sev, $"{auth:N0} auth failures ({authRate:P1})", auth, "401", null));
            }

            int nf = h.StatusCounts.GetValueOrDefault("404");
            double nfRate = Rate(nf, h.Total);
            if (nf >= 50 || nfRate >= _targets.NotFoundRate)
            {
                string sev = nfRate >= _targets.NotFoundRate * 4 ? "high" : "medium";
                issues.Add(MakeIssue(src, ds, "404", sev, $"{nf:N0} not-found ({nfRate:P1})", nf, "404", null));
            }

            if (h.P95 >= _targets.P95Ms)
            {
                string sev = h.P95 >= _targets.P95Ms * 3 ? "high" : "medium";
                issues.Add(MakeIssue(src, ds, "slow", sev, $"p95 latency {h.P95:N0} ms · {h.SlowCount:N0} slow", h.SlowCount, null, _targets.P95Ms));
            }
        }

        // The contrast widget's data: each metric through both lenses (current vs own baseline vs hard
        // target). Targets come from config (HotspotTargets). Percentages are 0–100 for display.
        private List<MetricContrast> BuildContrast(HealthMetrics h, BaselineSet b, FiredSet fired, bool hasBaseline)
        {
            int auth = h.StatusCounts.GetValueOrDefault("401") + h.StatusCounts.GetValueOrDefault("403");
            int nf = h.StatusCounts.GetValueOrDefault("404");
            double curErr = Rate(h.Err, h.Total) * 100, curAuth = Rate(auth, h.Total) * 100, curNf = Rate(nf, h.Total) * 100;
            var latBase = b.Lat.Select(x => (double)x).ToList();
            return new()
            {
                Contrast("5xx", "5xx rate", curErr, hasBaseline ? Median(b.Err) * 100 : null, _targets.FiveXxRate * 100, "%", fired.Err, hasBaseline, Series(Pct(b.Err), curErr)),
                Contrast("latency", "p95 latency", h.P95, hasBaseline ? Median(latBase) : null, _targets.P95Ms, "ms", fired.Slow, hasBaseline, Series(latBase, h.P95)),
                Contrast("auth", "auth rate", curAuth, hasBaseline ? Median(b.Auth) * 100 : null, _targets.AuthRate * 100, "%", fired.Auth, hasBaseline, Series(Pct(b.Auth), curAuth)),
                Contrast("404", "404 rate", curNf, hasBaseline ? Median(b.NotFound) * 100 : null, _targets.NotFoundRate * 100, "%", fired.NotFound, hasBaseline, Series(Pct(b.NotFound), curNf)),
            };
        }

        private static MetricContrast Contrast(string key, string label, double cur, double? baseline, double target, string unit, bool deviating, bool hasBaseline, double[] series)
        {
            bool over = cur > target;
            string state = !hasBaseline ? "nobaseline"
                : deviating && over ? "acute"
                : deviating ? "watch"
                : over ? "elevated"
                : "ok";
            return new MetricContrast(key, label, Math.Round(cur, unit == "ms" ? 0 : 2),
                baseline.HasValue ? Math.Round(baseline.Value, unit == "ms" ? 0 : 2) : null, target, unit, state, series);
        }

        private static List<double> Pct(IReadOnlyList<double> rates) => rates.Select(x => x * 100).ToList();

        // Baseline values arrive newest→oldest (days.Skip(1)); reverse to oldest→newest and append today.
        private static double[] Series(IReadOnlyList<double> baselineNewestFirst, double current)
        {
            int n = baselineNewestFirst.Count;
            var s = new double[n + 1];
            for (int i = 0; i < n; i++) s[i] = Math.Round(baselineNewestFirst[n - 1 - i], 2);
            s[n] = Math.Round(current, 2);
            return s;
        }

        private static double Rate(int n, int total) => total > 0 ? (double)n / total : 0;
        private static string Norm(double cur, double med) => med >= 0.0005 ? $"{cur / med:N1}× normal ({med:P1})" : "normally ~0%";

        // True when `current` is >= 3 scaled-MAD above the baseline median AND the absolute rise clears minDelta.
        private static (bool, double Z, double Median) AnomalyUp(double current, IReadOnlyList<double> baseline, double madFloor, double minDelta)
        {
            double median = Median(baseline);
            double spread = Math.Max(ScaledMad(baseline, median), madFloor);
            double z = (current - median) / spread;
            return (z >= 3 && current - median >= minDelta, z, median);
        }

        private static double Median(IReadOnlyList<double> v)
        {
            if (v.Count == 0) return 0;
            var s = v.OrderBy(x => x).ToArray();
            int n = s.Length;
            return n % 2 == 1 ? s[n / 2] : (s[n / 2 - 1] + s[n / 2]) / 2.0;
        }

        private static double ScaledMad(IReadOnlyList<double> v, double median)
        {
            if (v.Count == 0) return 0;
            return Median(v.Select(x => Math.Abs(x - median)).ToList()) * 1.4826;
        }

        private IEnumerable<ParsedRow> RowsFor(string logPath, DateOnly day, IReadOnlyList<string> files)
        {
            bool compressed = files.Any(f => f.EndsWith(".gz", StringComparison.OrdinalIgnoreCase));
            long bytes = 0;
            foreach (var f in files) bytes += new FileInfo(f).Length;
            return !compressed && bytes <= _scale.MaxCachedDayBytes
                ? _cache.GetOrLoad(logPath, day, files, () => _reader.Parse(files))
                : _reader.Stream(files);
        }

        private static Issue MakeIssue(LogSource s, string ds, string type, string sev, string title, int count, string? fStatus, int? fMinTime)
            => new(s.Id, s.Application, s.Type, s.Stage, s.Server, ds, type, sev, title, count, fStatus, fMinTime);

        private static int SeverityRank(string s) => s == "high" ? 0 : s == "medium" ? 1 : 2;
        private static int HealthRank(string h) => h == "red" ? 0 : h == "amber" ? 1 : h == "green" ? 2 : 3;
    }
}
