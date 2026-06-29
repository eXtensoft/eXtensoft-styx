namespace LogExplorer.Services
{
    /// <summary>
    /// Remembers the match count (Total) of a paged view, keyed by (logPath, day, file-signature, filter),
    /// so paging doesn't re-scan the whole day to recount on every page. Tiny entries (an int); a changed
    /// file invalidates via the signature in the key. Small LRU by count.
    /// </summary>
    public class ScanTotalCache
    {
        private const int Capacity = 500;

        private readonly object _lock = new();
        private readonly Dictionary<string, (int Total, long LastUsed)> _entries = new();
        private long _seq;

        public int? TryGet(string key)
        {
            lock (_lock)
            {
                if (_entries.TryGetValue(key, out var e))
                {
                    _entries[key] = (e.Total, ++_seq);
                    return e.Total;
                }
                return null;
            }
        }

        public void Set(string key, int total)
        {
            lock (_lock)
            {
                _entries[key] = (total, ++_seq);
                while (_entries.Count > Capacity)
                {
                    var oldest = _entries.OrderBy(kv => kv.Value.LastUsed).First().Key;
                    _entries.Remove(oldest);
                }
            }
        }
    }
}
