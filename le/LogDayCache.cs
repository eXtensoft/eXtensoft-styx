using System.Text;
using Microsoft.Extensions.Options;

namespace LogExplorer.Services
{
    /// <summary>
    /// Caches a day's parsed rows in memory keyed by (logPath, day), so paging and analytics over the
    /// same day reuse a single disk read + parse. Invalidated when the day's files change (length or
    /// last-write-time). Bounded by a total **byte** budget (raw-log bytes), LRU-evicted — so a few
    /// large days can't grow the heap without bound. Days too large to cache are streamed by the caller.
    /// </summary>
    public class LogDayCache
    {
        private readonly long _budgetBytes;
        private readonly object _lock = new();
        private readonly Dictionary<string, Entry> _entries = new();
        private long _seq;
        private long _totalBytes;

        public LogDayCache(IOptions<ScaleOptions> options)
        {
            _budgetBytes = options.Value.MaxCacheTotalBytes;
        }

        private sealed class Entry
        {
            public required string Signature { get; init; }
            public required IReadOnlyList<ParsedRow> Rows { get; init; }
            public required long Bytes { get; init; }
            public long LastUsed { get; set; }
        }

        public IReadOnlyList<ParsedRow> GetOrLoad(string logPath, DateOnly day, IReadOnlyList<string> files, Func<IReadOnlyList<ParsedRow>> load)
        {
            var key = $"{logPath}::{day:yyyy-MM-dd}";
            var (signature, bytes) = Stat(files);

            lock (_lock)
            {
                if (_entries.TryGetValue(key, out var hit) && hit.Signature == signature)
                {
                    hit.LastUsed = ++_seq;
                    return hit.Rows;
                }
            }

            var rows = load();

            lock (_lock)
            {
                if (_entries.TryGetValue(key, out var old)) _totalBytes -= old.Bytes;
                _entries[key] = new Entry { Signature = signature, Rows = rows, Bytes = bytes, LastUsed = ++_seq };
                _totalBytes += bytes;

                while (_totalBytes > _budgetBytes && _entries.Count > 1)
                {
                    var oldest = _entries.OrderBy(kv => kv.Value.LastUsed).First();
                    _totalBytes -= oldest.Value.Bytes;
                    _entries.Remove(oldest.Key);
                }
                return rows;
            }
        }

        private static (string Signature, long Bytes) Stat(IReadOnlyList<string> files)
        {
            var sb = new StringBuilder();
            long bytes = 0;
            foreach (var path in files)
            {
                var fi = new FileInfo(path);
                bytes += fi.Length;
                sb.Append(path).Append('|').Append(fi.Length).Append('|').Append(fi.LastWriteTimeUtc.Ticks).Append(';');
            }
            return (sb.ToString(), bytes);
        }
    }
}
