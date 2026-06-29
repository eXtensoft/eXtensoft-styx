using System.Globalization;
using LogExplorer.Models;
using LogExplorer.Services;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Options;

namespace LogExplorer.Controllers
{
    [ApiController]
    [Route("api")]
    public class MetadataController : ControllerBase
    {
        private readonly MetadataStore _store;
        private readonly LogFileScanner _scanner;
        private readonly LogReader _reader;
        private readonly LogDayCache _cache;
        private readonly HotspotsService _hotspots;
        private readonly ScaleOptions _scale;
        private readonly PathGuard _guard;
        private readonly ScanTotalCache _totals;

        public MetadataController(MetadataStore store, LogFileScanner scanner, LogReader reader, LogDayCache cache,
            HotspotsService hotspots, IOptions<ScaleOptions> scale, PathGuard guard, ScanTotalCache totals)
        {
            _store = store;
            _scanner = scanner;
            _reader = reader;
            _cache = cache;
            _hotspots = hotspots;
            _scale = scale.Value;
            _guard = guard;
            _totals = totals;
        }

        // Cache the day's rows when it's small enough; stream from disk (bounded memory) when it
        // isn't, or when any file is gzip-archived (decompressed size is unknown, so don't cache).
        private IEnumerable<ParsedRow> RowsFor(string logPath, DateOnly day, IReadOnlyList<string> files)
        {
            bool compressed = files.Any(f => f.EndsWith(".gz", StringComparison.OrdinalIgnoreCase));
            long bytes = 0;
            foreach (var f in files) bytes += new FileInfo(f).Length;
            return !compressed && bytes <= _scale.MaxCachedDayBytes
                ? _cache.GetOrLoad(logPath, day, files, () => _reader.Parse(files))
                : _reader.Stream(files);
        }

        // ---- metadata spine --------------------------------------------------

        [HttpGet("sources")]
        public Task<MetadataConfig> GetSources() => _store.LoadAsync();

        [HttpPut("sources")]
        public async Task<IActionResult> PutSources([FromBody] MetadataConfig config)
        {
            var disallowed = config.LogSources
                .Where(s => !_guard.IsAllowed(s.LogPath))
                .Select(s => s.LogPath)
                .ToList();
            if (disallowed.Count > 0)
                return BadRequest(new { error = "Log path(s) outside the allowed roots.", paths = disallowed });

            await _store.SaveAsync(config);
            return NoContent();
        }

        // ---- per-source (instance-scoped) ------------------------------------

        [HttpGet("sources/{id}/days")]
        public async Task<IActionResult> GetDays(string id)
        {
            var src = await FindSource(id);
            if (src == null) return NotFound(new { error = "Log source not found." });

            var days = _scanner.GetAvailableDays(src.LogPath);
            if (days == null) return NotFound(new { error = "Log path not found.", logPath = src.LogPath });
            return Ok(new { logPath = src.LogPath, days });
        }

        [HttpGet("sources/{id}/entries")]
        public async Task<IActionResult> GetEntries(
            string id, [FromQuery] string date, [FromQuery] int offset = 0, [FromQuery] int limit = 100,
            [FromQuery] string? q = null, [FromQuery] string? method = null, [FromQuery] string? status = null,
            [FromQuery] string? uri = null, [FromQuery] int? minTime = null,
            [FromQuery] string? fromTime = null, [FromQuery] string? toTime = null,
            [FromQuery] string? ip = null, [FromQuery] string? agent = null)
        {
            var src = await FindSource(id);
            if (src == null) return NotFound(new { error = "Log source not found." });
            if (!TryDay(date, out var day)) return BadRequest(new { error = "Invalid date; expected yyyy-MM-dd." });

            var files = _scanner.GetDayFiles(src.LogPath, day);
            if (files == null) return NotFound(new { error = "Log path not found.", logPath = src.LogPath });

            offset = Math.Max(0, offset);
            limit = Math.Clamp(limit, 1, 500);

            var rows = RowsFor(src.LogPath, day, files);
            var filter = MakeFilter(q, method, status, uri, minTime, fromTime, toTime, ip, agent);

            var key = $"{src.LogPath}|{date}|{FileSignature(files)}|{filter}";
            int? knownTotal = _totals.TryGet(key);
            var page = _reader.ReadPage(rows, offset, limit, filter, knownTotal);
            if (knownTotal == null) _totals.Set(key, page.Total);

            return Ok(new { date, page.Columns, page.Rows, page.Offset, page.Limit, page.Total, page.HasMore });
        }

        [HttpGet("sources/{id}/stats")]
        public async Task<IActionResult> GetStats(
            string id, [FromQuery] string date,
            [FromQuery] string? q = null, [FromQuery] string? method = null, [FromQuery] string? status = null,
            [FromQuery] string? uri = null, [FromQuery] int? minTime = null,
            [FromQuery] string? fromTime = null, [FromQuery] string? toTime = null,
            [FromQuery] string? ip = null, [FromQuery] string? agent = null)
        {
            var src = await FindSource(id);
            if (src == null) return NotFound(new { error = "Log source not found." });
            if (!TryDay(date, out var day)) return BadRequest(new { error = "Invalid date; expected yyyy-MM-dd." });

            var files = _scanner.GetDayFiles(src.LogPath, day);
            if (files == null) return NotFound(new { error = "Log path not found.", logPath = src.LogPath });

            var rows = RowsFor(src.LogPath, day, files);
            var filter = MakeFilter(q, method, status, uri, minTime, fromTime, toTime, ip, agent);
            var stats = _reader.ComputeStats(rows, filter);
            return Ok(new
            {
                date,
                stats.Total,
                stats.StatusDistribution,
                stats.MethodDistribution,
                stats.TopRoutes,
                stats.RequestsPerHour,
                stats.Slowest,
                stats.ErrorBreakdown,
                stats.Timing,
                stats.TopClients,
                stats.TopAgents,
                stats.Fields
            });
        }

        [HttpGet("sources/{id}/export")]
        public async Task<IActionResult> Export(
            string id, [FromQuery] string date,
            [FromQuery] string? q = null, [FromQuery] string? method = null, [FromQuery] string? status = null,
            [FromQuery] string? uri = null, [FromQuery] int? minTime = null,
            [FromQuery] string? fromTime = null, [FromQuery] string? toTime = null,
            [FromQuery] string? ip = null, [FromQuery] string? agent = null)
        {
            var src = await FindSource(id);
            if (src == null) return NotFound(new { error = "Log source not found." });
            if (!TryDay(date, out var day)) return BadRequest(new { error = "Invalid date; expected yyyy-MM-dd." });

            var files = _scanner.GetDayFiles(src.LogPath, day);
            if (files == null) return NotFound(new { error = "Log path not found.", logPath = src.LogPath });

            var columns = _reader.FieldUnion(files);
            var filter = MakeFilter(q, method, status, uri, minTime, fromTime, toTime, ip, agent);
            var rows = RowsFor(src.LogPath, day, files);

            Response.ContentType = "text/csv; charset=utf-8";
            Response.Headers.ContentDisposition = $"attachment; filename=\"{src.Id}_{date}.csv\"";
            await using var writer = new StreamWriter(Response.Body);
            await writer.WriteLineAsync(string.Join(',', columns.Select(Csv)));
            foreach (var row in _reader.ExportRows(rows, columns, filter))
                await writer.WriteLineAsync(string.Join(',', row.Select(Csv)));
            return new EmptyResult();
        }

        // RFC-4180 minimal escaping: quote when the value contains a comma, quote, or newline.
        private static string Csv(string value)
        {
            if (value.IndexOfAny(new[] { ',', '"', '\n', '\r' }) < 0) return value;
            return '"' + value.Replace("\"", "\"\"") + '"';
        }

        [HttpGet("sources/{id}/trends")]
        public async Task<IActionResult> GetTrends(
            string id, [FromQuery] string dates,
            [FromQuery] string? q = null, [FromQuery] string? method = null, [FromQuery] string? status = null,
            [FromQuery] string? uri = null, [FromQuery] int? minTime = null)
        {
            var src = await FindSource(id);
            if (src == null) return NotFound(new { error = "Log source not found." });

            var filter = MakeFilter(q, method, status, uri, minTime, null, null);
            var requested = (dates ?? "")
                .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Take(60);

            var result = new List<object>();
            foreach (var ds in requested)
            {
                if (!TryDay(ds, out var day)) continue;
                var files = _scanner.GetDayFiles(src.LogPath, day);
                if (files == null) return NotFound(new { error = "Log path not found.", logPath = src.LogPath });

                var rows = RowsFor(src.LogPath, day, files);
                var s = _reader.ComputeSummary(rows, filter);
                result.Add(new { date = ds, s.Total, s.Ok, s.Redir, s.Warn, s.Err, s.Other, s.AvgTimeTaken });
            }
            return Ok(new { days = result });
        }

        // ---- cross-source views ---------------------------------------------

        [HttpGet("calendar")]
        public async Task<IActionResult> GetCalendar()
        {
            var config = await _store.LoadAsync();
            var byDate = new Dictionary<DateOnly, List<string>>();

            foreach (var src in config.LogSources)
            {
                var days = _scanner.GetAvailableDays(src.LogPath);
                if (days == null) continue;
                foreach (var d in days)
                {
                    if (!byDate.TryGetValue(d.Date, out var ids)) byDate[d.Date] = ids = new List<string>();
                    ids.Add(src.Id);
                }
            }

            var days2 = byDate
                .OrderBy(kv => kv.Key)
                .Select(kv => new { date = kv.Key.ToString("yyyy-MM-dd"), sourceIds = kv.Value })
                .ToList();
            return Ok(new { sources = config.LogSources.Select(Facets), days = days2 });
        }

        [HttpGet("hotspots")]
        public async Task<IActionResult> GetHotspots() => Ok(await _hotspots.BuildAsync());

        // Per-day health for the calendar heatmap: total + 5xx + 4xx + avg latency, across the
        // scoped sources, for each day in the range that has data. Reuses ComputeSummary + cache.
        [HttpGet("calendar/heatmap")]
        public async Task<IActionResult> GetCalendarHeatmap([FromQuery] string sources, [FromQuery] string from, [FromQuery] string to)
        {
            var config = await _store.LoadAsync();
            var ids = (sources ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
            var srcs = ids.Select(id => config.LogSources.FirstOrDefault(s => s.Id == id)).OfType<LogSource>().ToList();
            if (srcs.Count == 0) return Ok(new { days = Array.Empty<object>() });
            if (!TryDay(from ?? "", out var f) || !TryDay(to ?? "", out var t))
                return BadRequest(new { error = "Invalid date range; expected yyyy-MM-dd." });
            if (t < f) (f, t) = (t, f);

            var result = new List<object>();
            for (var d = f; d <= t && result.Count < 62; d = d.AddDays(1))
            {
                var day = d;
                IEnumerable<ParsedRow> Rows() => srcs.SelectMany(s =>
                {
                    var files = _scanner.GetDayFiles(s.LogPath, day);
                    return files == null || files.Count == 0 ? Enumerable.Empty<ParsedRow>() : RowsFor(s.LogPath, day, files);
                });
                var su = _reader.ComputeSummary(Rows(), LogFilter.None);
                if (su.Total > 0)
                    result.Add(new { date = day.ToString("yyyy-MM-dd"), su.Total, serverErrors = su.Err, clientErrors = su.Warn, su.AvgTimeTaken });
            }
            return Ok(new { days = result });
        }

        // Aggregate analytics over a set of sources and a day span (defaults to the last
        // 7 available days). Reuses the per-(source,day) cache; combines row references.
        [HttpGet("aggregate/stats")]
        public async Task<IActionResult> GetAggregateStats(
            [FromQuery] string sources, [FromQuery] string? from = null, [FromQuery] string? to = null,
            [FromQuery] string? q = null, [FromQuery] string? method = null, [FromQuery] string? status = null,
            [FromQuery] string? uri = null, [FromQuery] int? minTime = null,
            [FromQuery] string? fromTime = null, [FromQuery] string? toTime = null,
            [FromQuery] string? ip = null, [FromQuery] string? agent = null)
        {
            var config = await _store.LoadAsync();
            var ids = (sources ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
            var srcs = ids.Select(id => config.LogSources.FirstOrDefault(s => s.Id == id)).OfType<LogSource>().ToList();
            if (srcs.Count == 0) return NotFound(new { error = "No matching log sources." });

            List<DateOnly> dates;
            if (TryDay(from ?? "", out var f) && TryDay(to ?? "", out var t))
            {
                if (t < f) (f, t) = (t, f);
                dates = new List<DateOnly>();
                for (var d = f; d <= t && dates.Count < 62; d = d.AddDays(1)) dates.Add(d);
            }
            else
            {
                var avail = new HashSet<DateOnly>();
                foreach (var s in srcs)
                {
                    var days = _scanner.GetAvailableDays(s.LogPath);
                    if (days != null) foreach (var dd in days) avail.Add(dd.Date);
                }
                dates = avail.OrderByDescending(x => x).Take(7).OrderBy(x => x).ToList();
            }

            if (dates.Count == 0)
                return Ok(new { from = (string?)null, to = (string?)null, sourceCount = srcs.Count, total = 0 });

            var filter = MakeFilter(q, method, status, uri, minTime, fromTime, toTime, ip, agent);

            // Lazy row sources — never materialize the whole span. ComputeStats/ComputeSummary
            // are bounded single-pass, so each of these enumerations uses bounded memory; cached
            // days are reused in-place, oversized days re-stream from disk per pass.
            IEnumerable<ParsedRow> Rows(LogSource s, DateOnly d)
            {
                var files = _scanner.GetDayFiles(s.LogPath, d);
                return files == null || files.Count == 0 ? Enumerable.Empty<ParsedRow>() : RowsFor(s.LogPath, d, files);
            }

            var combined = srcs.SelectMany(s => dates.SelectMany(d => Rows(s, d)));
            var stats = _reader.ComputeStats(combined, filter);
            var perDay = dates.Select(d =>
            {
                var su = _reader.ComputeSummary(srcs.SelectMany(s => Rows(s, d)), filter);
                return new { date = d.ToString("yyyy-MM-dd"), su.Total, serverErrors = su.Err, clientErrors = su.Warn, su.AvgTimeTaken };
            }).ToList();
            var perSource = srcs.Select(s =>
            {
                var su = _reader.ComputeSummary(dates.SelectMany(d => Rows(s, d)), filter);
                return new { sourceId = s.Id, s.Application, s.Type, s.Stage, s.Server, s.Instance, su.Total, serverErrors = su.Err, clientErrors = su.Warn, su.AvgTimeTaken };
            }).OrderByDescending(x => x.Total).ToList();

            return Ok(new
            {
                from = dates[0].ToString("yyyy-MM-dd"),
                to = dates[^1].ToString("yyyy-MM-dd"),
                sourceCount = srcs.Count,
                stats.Total,
                stats.StatusDistribution,
                stats.MethodDistribution,
                stats.TopRoutes,
                stats.RequestsPerHour,
                stats.Slowest,
                stats.ErrorBreakdown,
                stats.TopClients,
                stats.TopAgents,
                stats.Fields,
                perDay,
                perSource
            });
        }

        // ---- helpers ---------------------------------------------------------

        private async Task<LogSource?> FindSource(string id)
        {
            var config = await _store.LoadAsync();
            return config.LogSources.FirstOrDefault(s => s.Id == id);
        }

        private static object Facets(LogSource s) => new
        {
            s.Id, s.Application, s.Type, s.Stage, s.Server, s.Instance, s.Tags
        };

        private static LogFilter MakeFilter(string? q, string? method, string? status, string? uri, int? minTime,
            string? fromTime, string? toTime, string? ip = null, string? agent = null)
            => new(Trim(q), Trim(method), Trim(status), Trim(uri), minTime, NormalizeTime(fromTime), NormalizeTime(toTime), Trim(ip), Trim(agent));

        private static bool TryDay(string date, out DateOnly day) =>
            DateOnly.TryParseExact(date, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out day);

        private static string FileSignature(IReadOnlyList<string> files)
        {
            long len = 0, ticks = 0;
            foreach (var f in files)
            {
                var fi = new FileInfo(f);
                len += fi.Length;
                ticks = Math.Max(ticks, fi.LastWriteTimeUtc.Ticks);
            }
            return $"{len}:{ticks}";
        }

        private static string? Trim(string? value) => string.IsNullOrWhiteSpace(value) ? null : value.Trim();

        // Accepts "HH", "HH:mm", or "HH:mm:ss" and normalizes to "HH:mm:ss" for ordinal comparison.
        private static string? NormalizeTime(string? value)
        {
            if (string.IsNullOrWhiteSpace(value)) return null;
            var p = value.Trim().Split(':');
            int hh = p.Length > 0 && int.TryParse(p[0], out var a) ? a : 0;
            int mm = p.Length > 1 && int.TryParse(p[1], out var b) ? b : 0;
            int ss = p.Length > 2 && int.TryParse(p[2], out var c) ? c : 0;
            return $"{hh:00}:{mm:00}:{ss:00}";
        }
    }
}
