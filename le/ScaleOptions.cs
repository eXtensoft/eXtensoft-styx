namespace LogExplorer.Services
{
    /// <summary>
    /// Memory guardrails (raw-log bytes). A day larger than <see cref="MaxCachedDayBytes"/> is
    /// streamed from disk per request instead of being held in the cache; the cache as a whole
    /// is evicted (LRU) to stay under <see cref="MaxCacheTotalBytes"/>.
    /// </summary>
    public class ScaleOptions
    {
        public long MaxCachedDayBytes { get; set; } = 64L * 1024 * 1024;
        public long MaxCacheTotalBytes { get; set; } = 512L * 1024 * 1024;
    }
}
