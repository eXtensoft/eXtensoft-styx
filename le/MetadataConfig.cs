namespace LogExplorer.Models
{
    public class MetadataConfig
    {
        public int Version { get; set; } = 2;
        public List<LogSource> LogSources { get; set; } = new();
    }

    // A flat, tag-style record: one IIS log folder described by free-form facets.
    // No nested hierarchy — grouping (by application, stage, server, ...) happens at query time.
    public class LogSource
    {
        public string Id { get; set; } = "";
        public string Application { get; set; } = "";
        public string Type { get; set; } = "";
        public string Stage { get; set; } = "";
        public string Server { get; set; } = "";
        public string Instance { get; set; } = "";
        public string LogPath { get; set; } = "";
        public List<string> Tags { get; set; } = new();
    }
}
