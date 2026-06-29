using System.IO.Compression;

namespace LogExplorer.Services
{
    public record LogFilter(string? Text, string? Method, string? Status, string? UriContains, int? MinTimeTaken,
        string? FromTime = null, string? ToTime = null, string? Ip = null, string? Agent = null)
    {
        public bool HasFieldPredicate =>
            Method != null || Status != null || UriContains != null || MinTimeTaken != null
            || FromTime != null || ToTime != null || Ip != null || Agent != null;

        public static readonly LogFilter None = new(null, null, null, null, null);
    }

    public record LogPage(
        IReadOnlyList<string> Columns,
        IReadOnlyList<IReadOnlyList<string>> Rows,
        int Offset,
        int Limit,
        int Total,
        bool HasMore);

    public record Count(string Key, int Value);
    public record ClientStat(string Key, int Count, int ServerErrors);
    public record RouteStat(string Route, int Count, int ServerErrors, int AvgTimeTaken);
    public record HourStat(int Hour, int Count, int ServerErrors, int AvgTimeTaken);
    public record SlowRequest(string Time, string Method, string Uri, string Status, int TimeTaken);
    public record ErrorDetail(string Status, string SubStatus, int Count);

    public record Timing(
        string? First, string? Last, int SpanMinutes, int ActiveMinutes,
        int PeakHour, int PeakHourCount, string? BusiestMinute, int BusiestMinuteCount);

    public record LogStats(
        int Total,
        IReadOnlyList<Count> StatusDistribution,
        IReadOnlyList<Count> MethodDistribution,
        IReadOnlyList<RouteStat> TopRoutes,
        IReadOnlyList<HourStat> RequestsPerHour,
        IReadOnlyList<SlowRequest> Slowest,
        IReadOnlyList<ErrorDetail> ErrorBreakdown,
        Timing Timing,
        IReadOnlyList<ClientStat> TopClients,
        IReadOnlyList<ClientStat> TopAgents,
        IReadOnlyList<string> Fields);

    public record DaySummary(int Total, int Ok, int Redir, int Warn, int Err, int Other, int AvgTimeTaken, int Auth, int NotFound, int P95);

    public record HealthMetrics(
        int Total, int Ok, int Redir, int Warn, int Err, int Other,
        int AvgTimeTaken, int P95, int P99, int SlowCount,
        IReadOnlyDictionary<string, int> StatusCounts,
        IReadOnlyList<Count> TopErrorUris);

    /// <summary>Field names of a <c>#Fields:</c> directive with the column indices the reader needs precomputed.</summary>
    public sealed class LogSchema
    {
        public string[] Fields { get; }
        public int Method { get; }
        public int Status { get; }
        public int SubStatus { get; }
        public int Uri { get; }
        public int TimeTaken { get; }
        public int Clock { get; }
        public int ClientIp { get; }
        public int Agent { get; }

        public LogSchema(string[] fields)
        {
            Fields = fields;
            Method = Array.IndexOf(fields, "cs-method");
            Status = Array.IndexOf(fields, "sc-status");
            SubStatus = Array.IndexOf(fields, "sc-substatus");
            Uri = Array.IndexOf(fields, "cs-uri-stem");
            TimeTaken = Array.IndexOf(fields, "time-taken");
            Clock = Array.IndexOf(fields, "time");
            ClientIp = Array.IndexOf(fields, "c-ip");
            Agent = Array.IndexOf(fields, "cs(User-Agent)");
        }
    }

    /// <summary>One parsed data line. Values are split lazily so free-text-only scans never pay for the split.</summary>
    public sealed class ParsedRow
    {
        public LogSchema Schema { get; }
        public string Line { get; }
        private string[]? _values;

        public ParsedRow(LogSchema schema, string line)
        {
            Schema = schema;
            Line = line;
        }

        public string[] Values => _values ??= Line.Split(' ');
    }

    public class LogReader
    {
        private const string FieldsDirective = "#Fields:";

        /// <summary>Materialized parse of the day's files (cached by LogDayCache for days small enough to hold).</summary>
        public IReadOnlyList<ParsedRow> Parse(IReadOnlyList<string> files) => Stream(files).ToList();

        /// <summary>Lazy line-by-line parse — yields one ParsedRow at a time so a too-large day can be
        /// processed with bounded memory (no full materialization).</summary>
        public IEnumerable<ParsedRow> Stream(IReadOnlyList<string> files)
        {
            foreach (var path in files)
            {
                var schema = new LogSchema(Array.Empty<string>());
                using var reader = OpenText(path);
                string? line;
                while ((line = reader.ReadLine()) != null)
                {
                    if (line.Length == 0) continue;
                    if (line[0] == '#')
                    {
                        if (line.StartsWith(FieldsDirective, StringComparison.OrdinalIgnoreCase))
                            schema = new LogSchema(line[FieldsDirective.Length..].Split(' ', StringSplitOptions.RemoveEmptyEntries));
                        continue;
                    }
                    yield return new ParsedRow(schema, line);
                }
            }
        }

        // Opens a log file as text, transparently decompressing gzip-archived (.gz) logs.
        private static StreamReader OpenText(string path)
        {
            Stream s = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
            if (path.EndsWith(".gz", StringComparison.OrdinalIgnoreCase))
                s = new GZipStream(s, CompressionMode.Decompress);
            return new StreamReader(s);
        }

        /// <summary>
        /// Applies <paramref name="filter"/> (AND of all set predicates) over the parsed rows and collects
        /// the page window [offset, offset+limit). Page columns are the union of field sets in the returned
        /// rows. When <paramref name="knownTotal"/> is supplied (the match count was cached from a prior scan
        /// of the same unchanged files + filter), it's trusted — so once the page is filled we **stop early**
        /// instead of scanning the rest of the day just to recount. That makes shallow paging of a large
        /// streamed day read only up to the page (the lazy stream stops when we break out).
        /// </summary>
        public LogPage ReadPage(IEnumerable<ParsedRow> rows, int offset, int limit, LogFilter filter, int? knownTotal = null)
        {
            if (knownTotal is int kt && offset >= kt)
                return new LogPage(Array.Empty<string>(), Array.Empty<IReadOnlyList<string>>(), offset, limit, kt, false);

            var collected = new List<ParsedRow>();
            int total = 0;
            string? text = string.IsNullOrEmpty(filter.Text) ? null : filter.Text;
            bool fieldPredicate = filter.HasFieldPredicate;

            foreach (var row in rows)
            {
                if (text != null && row.Line.IndexOf(text, StringComparison.OrdinalIgnoreCase) < 0) continue;
                if (fieldPredicate && !Matches(filter, row)) continue;

                int matchIndex = total++;
                if (matchIndex >= offset && collected.Count < limit) collected.Add(row);
                if (knownTotal.HasValue && collected.Count == limit) break; // page full + total known → stop
            }

            var columns = new List<string>();
            var seen = new HashSet<string>();
            foreach (var r in collected)
                foreach (var f in r.Schema.Fields)
                    if (seen.Add(f)) columns.Add(f);

            var outRows = collected.Select(r => AlignRow(columns, r.Schema.Fields, r.Values)).ToList();
            int finalTotal = knownTotal ?? total;
            bool hasMore = offset + collected.Count < finalTotal;
            return new LogPage(columns, outRows, offset, limit, finalTotal, hasMore);
        }

        /// <summary>Single pass over the parsed rows with the same filter, accumulating aggregates for analytics.</summary>
        public LogStats ComputeStats(IEnumerable<ParsedRow> rows, LogFilter filter, int topUris = 15, int slowestCount = 10)
        {
            var status = new Dictionary<string, int>();
            var method = new Dictionary<string, int>();
            var routes = new Dictionary<string, RouteAcc>();
            var perHour = new int[24];
            var perHourErr = new int[24];
            var perHourTimeSum = new long[24];
            var perHourTimeCnt = new int[24];
            var perMinute = new int[1440];
            string? firstClock = null, lastClock = null;
            var slow = new List<SlowRequest>();
            var errorCombos = new Dictionary<(string, string), int>();
            var clients = new Dictionary<string, int[]>();
            var agents = new Dictionary<string, int[]>();
            var fieldSet = new HashSet<string>();
            var fieldList = new List<string>();
            LogSchema? lastSchema = null;
            int total = 0;
            string? text = string.IsNullOrEmpty(filter.Text) ? null : filter.Text;

            foreach (var row in rows)
            {
                if (!ReferenceEquals(row.Schema, lastSchema))
                {
                    lastSchema = row.Schema;
                    foreach (var fld in row.Schema.Fields) if (fieldSet.Add(fld)) fieldList.Add(fld);
                }
                if (text != null && row.Line.IndexOf(text, StringComparison.OrdinalIgnoreCase) < 0) continue;
                if (filter.HasFieldPredicate && !Matches(filter, row)) continue;

                var v = row.Values;
                var s = row.Schema;
                total++;

                bool isServerError = false;
                if (s.Status >= 0 && s.Status < v.Length)
                {
                    var code = v[s.Status];
                    Bump(status, code);
                    if (code.Length > 0 && (code[0] == '4' || code[0] == '5'))
                    {
                        isServerError = code[0] == '5';
                        var sub = s.SubStatus >= 0 && s.SubStatus < v.Length && v[s.SubStatus].Length > 0 ? v[s.SubStatus] : "0";
                        var key = (code, sub);
                        errorCombos[key] = errorCombos.GetValueOrDefault(key) + 1;
                    }
                }
                if (s.Method >= 0 && s.Method < v.Length) Bump(method, v[s.Method]);

                RouteAcc? routeAcc = null;
                if (s.Uri >= 0 && s.Uri < v.Length)
                {
                    var route = NormalizeRoute(v[s.Uri]);
                    if (!routes.TryGetValue(route, out routeAcc)) routes[route] = routeAcc = new RouteAcc();
                    routeAcc.Count++;
                    if (isServerError) routeAcc.Err++;
                }

                if (s.ClientIp >= 0 && s.ClientIp < v.Length) BumpClient(clients, v[s.ClientIp], isServerError);
                if (s.Agent >= 0 && s.Agent < v.Length) BumpClient(agents, v[s.Agent], isServerError);

                int hour = -1;
                if (s.Clock >= 0 && s.Clock < v.Length)
                {
                    var clock = v[s.Clock];
                    hour = ParseHour(clock);
                    if (hour >= 0)
                    {
                        perHour[hour]++;
                        if (isServerError) perHourErr[hour]++;
                    }
                    int mi = MinuteIndex(clock);
                    if (mi >= 0) perMinute[mi]++;
                    if (firstClock == null || string.CompareOrdinal(clock, firstClock) < 0) firstClock = clock;
                    if (lastClock == null || string.CompareOrdinal(clock, lastClock) > 0) lastClock = clock;
                }

                if (s.TimeTaken >= 0 && s.TimeTaken < v.Length && int.TryParse(v[s.TimeTaken], out var tt))
                {
                    TrackSlowest(slow, slowestCount, new SlowRequest(
                        At(v, s.Clock), At(v, s.Method), At(v, s.Uri), At(v, s.Status), tt));
                    if (hour >= 0) { perHourTimeSum[hour] += tt; perHourTimeCnt[hour]++; }
                    if (routeAcc != null) { routeAcc.TimeSum += tt; routeAcc.TimeCount++; }
                }
            }

            return new LogStats(
                total,
                status.OrderBy(kv => int.TryParse(kv.Key, out var c) ? c : int.MaxValue).Select(kv => new Count(kv.Key, kv.Value)).ToList(),
                method.OrderByDescending(kv => kv.Value).Select(kv => new Count(kv.Key, kv.Value)).ToList(),
                routes.OrderByDescending(kv => kv.Value.Count).Take(topUris)
                    .Select(kv => new RouteStat(kv.Key, kv.Value.Count, kv.Value.Err,
                        kv.Value.TimeCount > 0 ? (int)(kv.Value.TimeSum / kv.Value.TimeCount) : 0)).ToList(),
                Enumerable.Range(0, 24).Select(h => new HourStat(h, perHour[h], perHourErr[h],
                    perHourTimeCnt[h] > 0 ? (int)(perHourTimeSum[h] / perHourTimeCnt[h]) : 0)).ToList(),
                slow.OrderByDescending(s => s.TimeTaken).ToList(),
                errorCombos.OrderByDescending(kv => kv.Value).Take(15)
                    .Select(kv => new ErrorDetail(kv.Key.Item1, kv.Key.Item2, kv.Value)).ToList(),
                BuildTiming(total, perHour, perMinute, firstClock, lastClock),
                clients.OrderByDescending(kv => kv.Value[0]).Take(15)
                    .Select(kv => new ClientStat(kv.Key, kv.Value[0], kv.Value[1])).ToList(),
                agents.OrderByDescending(kv => kv.Value[0]).Take(10)
                    .Select(kv => new ClientStat(kv.Key, kv.Value[0], kv.Value[1])).ToList(),
                fieldList);
        }

        private static void BumpClient(Dictionary<string, int[]> d, string key, bool err)
        {
            if (!d.TryGetValue(key, out var a)) { a = new int[2]; d[key] = a; }
            a[0]++;
            if (err) a[1]++;
        }

        private static Timing BuildTiming(int total, int[] perHour, int[] perMinute, string? first, string? last)
        {
            int peakHour = 0;
            for (int i = 1; i < 24; i++) if (perHour[i] > perHour[peakHour]) peakHour = i;

            int busiest = 0;
            for (int i = 1; i < 1440; i++) if (perMinute[i] > perMinute[busiest]) busiest = i;

            int active = perMinute.Count(x => x > 0);
            int span = first != null && last != null ? MinuteIndex(last) - MinuteIndex(first) + 1 : 0;
            string? busiestMin = perMinute[busiest] > 0 ? $"{busiest / 60:00}:{busiest % 60:00}" : null;

            return new Timing(first, last, span, active,
                peakHour, perHour[peakHour], busiestMin, perMinute[busiest]);
        }

        private static int MinuteIndex(string clock) =>
            clock.Length >= 5
            && int.TryParse(clock.AsSpan(0, 2), out var h) && h is >= 0 and < 24
            && int.TryParse(clock.AsSpan(3, 2), out var m) && m is >= 0 and < 60
                ? h * 60 + m : -1;

        /// <summary>Reduced per-day aggregate for the cross-day trends view (volume by status class + avg latency).</summary>
        public DaySummary ComputeSummary(IEnumerable<ParsedRow> rows, LogFilter filter)
        {
            int total = 0, ok = 0, redir = 0, warn = 0, err = 0, other = 0, timeCount = 0, auth = 0, notFound = 0;
            long sumTime = 0;
            const int cap = 30000;          // p95 via a fixed histogram (bounded memory; times above cap pile into the top bucket)
            int[]? hist = null;
            string? text = string.IsNullOrEmpty(filter.Text) ? null : filter.Text;

            foreach (var row in rows)
            {
                if (text != null && row.Line.IndexOf(text, StringComparison.OrdinalIgnoreCase) < 0) continue;
                if (filter.HasFieldPredicate && !Matches(filter, row)) continue;

                var v = row.Values;
                var s = row.Schema;
                total++;

                char cls = s.Status >= 0 && s.Status < v.Length && v[s.Status].Length > 0 ? v[s.Status][0] : '0';
                switch (cls)
                {
                    case '2': ok++; break;
                    case '3': redir++; break;
                    case '4':
                        warn++;
                        var code = v[s.Status];
                        if (code == "401" || code == "403") auth++;
                        else if (code == "404") notFound++;
                        break;
                    case '5': err++; break;
                    default: other++; break;
                }

                if (s.TimeTaken >= 0 && s.TimeTaken < v.Length && int.TryParse(v[s.TimeTaken], out var t))
                {
                    sumTime += t;
                    timeCount++;
                    (hist ??= new int[cap + 1])[Math.Clamp(t, 0, cap)]++;
                }
            }

            int avg = timeCount > 0 ? (int)(sumTime / timeCount) : 0;
            int p95 = 0;
            if (timeCount > 0)
            {
                int rank = (int)Math.Ceiling(0.95 * timeCount), cum = 0;
                for (int i = 0; i <= cap; i++) { cum += hist![i]; if (cum >= rank) { p95 = i; break; } }
            }
            return new DaySummary(total, ok, redir, warn, err, other, avg, auth, notFound, p95);
        }

        /// <summary>Reduced per-day health metrics for the Hotspots view (status classes, latency percentiles, error endpoints).</summary>
        public HealthMetrics ComputeHealth(IEnumerable<ParsedRow> rows)
        {
            int total = 0, ok = 0, redir = 0, warn = 0, err = 0, other = 0, timeCount = 0, slow = 0;
            long sumTime = 0;
            var statusCounts = new Dictionary<string, int>();
            var errUris = new Dictionary<string, int>();
            var times = new List<int>();

            foreach (var row in rows)
            {
                var v = row.Values;
                var s = row.Schema;
                total++;

                string code = s.Status >= 0 && s.Status < v.Length ? v[s.Status] : "";
                if (code.Length > 0) Bump(statusCounts, code);
                char cls = code.Length > 0 ? code[0] : '0';
                switch (cls)
                {
                    case '2': ok++; break;
                    case '3': redir++; break;
                    case '4': warn++; break;
                    case '5': err++; break;
                    default: other++; break;
                }

                if ((cls == '4' || cls == '5') && s.Uri >= 0 && s.Uri < v.Length) Bump(errUris, v[s.Uri]);

                if (s.TimeTaken >= 0 && s.TimeTaken < v.Length && int.TryParse(v[s.TimeTaken], out var t))
                {
                    sumTime += t;
                    timeCount++;
                    times.Add(t);
                    if (t >= 1000) slow++;
                }
            }

            times.Sort();
            int avg = timeCount > 0 ? (int)(sumTime / timeCount) : 0;
            var topErrUris = errUris.OrderByDescending(kv => kv.Value).Take(5).Select(kv => new Count(kv.Key, kv.Value)).ToList();
            return new HealthMetrics(total, ok, redir, warn, err, other, avg,
                Percentile(times, 0.95), Percentile(times, 0.99), slow, statusCounts, topErrUris);
        }

        private static int Percentile(List<int> sorted, double p)
        {
            if (sorted.Count == 0) return 0;
            int idx = (int)Math.Ceiling(p * sorted.Count) - 1;
            return sorted[Math.Clamp(idx, 0, sorted.Count - 1)];
        }

        private static bool Matches(LogFilter f, ParsedRow row)
        {
            var v = row.Values;
            var s = row.Schema;
            if (f.Method != null && !(s.Method >= 0 && s.Method < v.Length && v[s.Method].Equals(f.Method, StringComparison.OrdinalIgnoreCase)))
                return false;
            if (f.Status != null && !(s.Status >= 0 && s.Status < v.Length && StatusMatch(v[s.Status], f.Status)))
                return false;
            if (f.UriContains != null && !(s.Uri >= 0 && s.Uri < v.Length && v[s.Uri].Contains(f.UriContains, StringComparison.OrdinalIgnoreCase)))
                return false;
            if (f.MinTimeTaken != null && !(s.TimeTaken >= 0 && s.TimeTaken < v.Length && int.TryParse(v[s.TimeTaken], out var t) && t >= f.MinTimeTaken))
                return false;
            if ((f.FromTime != null || f.ToTime != null))
            {
                if (s.Clock < 0 || s.Clock >= v.Length) return false;
                var clock = v[s.Clock];
                if (f.FromTime != null && string.CompareOrdinal(clock, f.FromTime) < 0) return false;
                if (f.ToTime != null && string.CompareOrdinal(clock, f.ToTime) > 0) return false;
            }
            if (f.Ip != null && !(s.ClientIp >= 0 && s.ClientIp < v.Length && v[s.ClientIp].Equals(f.Ip, StringComparison.OrdinalIgnoreCase)))
                return false;
            if (f.Agent != null && !(s.Agent >= 0 && s.Agent < v.Length && v[s.Agent].Contains(f.Agent, StringComparison.OrdinalIgnoreCase)))
                return false;
            return true;
        }

        // Exact code ("404") or class ("4xx", "5xx").
        private static bool StatusMatch(string value, string filter)
        {
            if (filter.Length == 3 && char.IsDigit(filter[0]) && (filter[1] | 0x20) == 'x' && (filter[2] | 0x20) == 'x')
                return value.Length > 0 && value[0] == filter[0];
            return value.Equals(filter, StringComparison.OrdinalIgnoreCase);
        }

        private sealed class RouteAcc { public int Count; public int Err; public long TimeSum; public int TimeCount; }

        /// <summary>Collapses id-like path segments to <c>{id}</c> so endpoint families aggregate (query string is already excluded — it lives in cs-uri-query).</summary>
        private static string NormalizeRoute(string stem)
        {
            if (stem.Length <= 1 || stem.IndexOf('/') < 0) return stem;
            var parts = stem.Split('/');
            bool changed = false;
            for (int i = 0; i < parts.Length; i++)
                if (IsIdSegment(parts[i])) { parts[i] = "{id}"; changed = true; }
            return changed ? string.Join('/', parts) : stem;
        }

        private static bool IsIdSegment(string seg)
        {
            if (seg.Length == 0) return false;

            bool allDigits = true;
            foreach (var c in seg) if (!char.IsAsciiDigit(c)) { allDigits = false; break; }
            if (allDigits) return true;

            if (seg.Length == 36 && Guid.TryParseExact(seg, "D", out _)) return true;

            if (seg.Length >= 16)
            {
                bool hex = true;
                foreach (var c in seg) if (!Uri.IsHexDigit(c)) { hex = false; break; }
                if (hex) return true;
            }
            return false;
        }

        private static void Bump(Dictionary<string, int> d, string key) => d[key] = d.GetValueOrDefault(key) + 1;

        private static string At(string[] v, int i) => i >= 0 && i < v.Length ? v[i] : "";

        private static int ParseHour(string clock) =>
            clock.Length >= 2 && int.TryParse(clock.AsSpan(0, 2), out var h) && h is >= 0 and < 24 ? h : -1;

        private static void TrackSlowest(List<SlowRequest> slow, int n, SlowRequest item)
        {
            if (slow.Count < n) { slow.Add(item); return; }
            int min = 0;
            for (int i = 1; i < slow.Count; i++)
                if (slow[i].TimeTaken < slow[min].TimeTaken) min = i;
            if (item.TimeTaken > slow[min].TimeTaken) slow[min] = item;
        }

        /// <summary>The ordered union of all <c>#Fields:</c> declared across the files — the CSV export header.</summary>
        public IReadOnlyList<string> FieldUnion(IReadOnlyList<string> files)
        {
            var cols = new List<string>();
            var seen = new HashSet<string>();
            foreach (var path in files)
            {
                using var reader = OpenText(path);
                string? line;
                while ((line = reader.ReadLine()) != null)
                {
                    if (line.Length > 0 && line[0] == '#' && line.StartsWith(FieldsDirective, StringComparison.OrdinalIgnoreCase))
                        foreach (var f in line[FieldsDirective.Length..].Split(' ', StringSplitOptions.RemoveEmptyEntries))
                            if (seen.Add(f)) cols.Add(f);
                }
            }
            return cols;
        }

        /// <summary>Streams the filtered rows aligned to <paramref name="columns"/> (for CSV export); bounded memory.</summary>
        public IEnumerable<string[]> ExportRows(IEnumerable<ParsedRow> rows, IReadOnlyList<string> columns, LogFilter filter)
        {
            string? text = string.IsNullOrEmpty(filter.Text) ? null : filter.Text;
            bool fieldPredicate = filter.HasFieldPredicate;
            foreach (var row in rows)
            {
                if (text != null && row.Line.IndexOf(text, StringComparison.OrdinalIgnoreCase) < 0) continue;
                if (fieldPredicate && !Matches(filter, row)) continue;

                var v = row.Values;
                var f = row.Schema.Fields;
                var map = new Dictionary<string, string>(f.Length);
                for (int i = 0; i < f.Length && i < v.Length; i++) map[f[i]] = v[i];
                yield return columns.Select(c => map.GetValueOrDefault(c, "")).ToArray();
            }
        }

        private static IReadOnlyList<string> AlignRow(List<string> columns, string[] fields, string[] values)
        {
            var map = new Dictionary<string, string>(fields.Length);
            for (int i = 0; i < fields.Length && i < values.Length; i++)
                map[fields[i]] = values[i];
            return columns.Select(c => map.GetValueOrDefault(c, "")).ToList();
        }
    }
}
