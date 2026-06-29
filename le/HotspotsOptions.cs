namespace LogExplorer.Services
{
    /// <summary>
    /// The hard "target" lines (absolute SLO thresholds) used by the Hotspots contrast widget and by
    /// the static-threshold fallback for sources too new to have a baseline. Rates are fractions (0–1).
    /// </summary>
    public class HotspotsOptions
    {
        public HotspotTargets Targets { get; set; } = new();
    }

    public class HotspotTargets
    {
        public double FiveXxRate { get; set; } = 0.01;    // 1% of requests are 5xx
        public int P95Ms { get; set; } = 1000;            // p95 latency, milliseconds
        public double AuthRate { get; set; } = 0.02;      // 2% are 401/403
        public double NotFoundRate { get; set; } = 0.05;  // 5% are 404
    }
}
