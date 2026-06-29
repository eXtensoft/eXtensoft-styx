using System.Text.RegularExpressions;

namespace LogExplorer.Services
{
    public record DayInfo(DateOnly Date, int FileCount, long Bytes);

    public partial class LogFileScanner
    {
        private readonly PathGuard _guard;

        public LogFileScanner(PathGuard guard) => _guard = guard;

        // IIS log names: optional letter/underscore prefix (ex, u_ex, nc, u_nc, in, u_in),
        // then YYMMDD (daily) or YYMMDDHH (hourly), then ".log", optionally gzip-archived (".gz").
        [GeneratedRegex(@"^[a-z_]*?(\d{2})(\d{2})(\d{2})(\d{2})?\.log(\.gz)?$", RegexOptions.IgnoreCase)]
        private static partial Regex LogName();

        /// <summary>
        /// Returns the distinct days (newest first) for which log files exist under
        /// <paramref name="logPath"/>, collapsing hourly files into their day. Returns
        /// null when the directory does not exist.
        /// </summary>
        public IReadOnlyList<DayInfo>? GetAvailableDays(string logPath)
        {
            if (!_guard.IsAllowed(logPath)) return null;
            var dir = new DirectoryInfo(logPath);
            if (!dir.Exists) return null;

            var byDay = new Dictionary<DateOnly, (int Count, long Bytes)>();

            foreach (var file in dir.EnumerateFiles("*.log*"))
            {
                var m = LogName().Match(file.Name);
                if (!m.Success) continue;

                int yy = int.Parse(m.Groups[1].Value);
                int mm = int.Parse(m.Groups[2].Value);
                int dd = int.Parse(m.Groups[3].Value);

                DateOnly day;
                try { day = new DateOnly(2000 + yy, mm, dd); }
                catch (ArgumentOutOfRangeException) { continue; }

                var cur = byDay.GetValueOrDefault(day);
                byDay[day] = (cur.Count + 1, cur.Bytes + file.Length);
            }

            return byDay
                .OrderByDescending(kv => kv.Key)
                .Select(kv => new DayInfo(kv.Key, kv.Value.Count, kv.Value.Bytes))
                .ToList();
        }

        /// <summary>
        /// Returns the log files for a single day, ordered (daily file first, then hourly
        /// files by hour). Returns null when the directory does not exist.
        /// </summary>
        public IReadOnlyList<string>? GetDayFiles(string logPath, DateOnly date)
        {
            if (!_guard.IsAllowed(logPath)) return null;
            var dir = new DirectoryInfo(logPath);
            if (!dir.Exists) return null;

            var matches = new List<(string Hour, string Path)>();

            foreach (var file in dir.EnumerateFiles("*.log*"))
            {
                var m = LogName().Match(file.Name);
                if (!m.Success) continue;

                int yy = int.Parse(m.Groups[1].Value);
                int mm = int.Parse(m.Groups[2].Value);
                int dd = int.Parse(m.Groups[3].Value);

                DateOnly day;
                try { day = new DateOnly(2000 + yy, mm, dd); }
                catch (ArgumentOutOfRangeException) { continue; }
                if (day != date) continue;

                matches.Add((m.Groups[4].Value, file.FullName));
            }

            return matches
                .OrderBy(x => x.Hour, StringComparer.Ordinal)
                .Select(x => x.Path)
                .ToList();
        }
    }
}
