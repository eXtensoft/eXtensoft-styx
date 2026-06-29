using Microsoft.Extensions.Options;

namespace LogExplorer.Services
{
    public class SecurityOptions
    {
        // Directories a log source is permitted to read from. Empty = unrestricted (opt-in).
        public string[] AllowedRoots { get; set; } = Array.Empty<string>();

        // Windows/AD groups permitted to use the app. Empty = any authenticated user.
        public string[] AllowedGroups { get; set; } = Array.Empty<string>();
    }

    /// <summary>
    /// Restricts which directories a log source may read, closing the arbitrary-file-read hole:
    /// a <c>logPath</c> must resolve (after collapsing <c>..</c>) to inside one of the configured
    /// allowed roots. When no roots are configured, all paths are allowed (with a startup warning).
    /// </summary>
    public class PathGuard
    {
        private readonly string[] _roots;

        public PathGuard(IOptions<SecurityOptions> options)
        {
            _roots = (options.Value.AllowedRoots ?? Array.Empty<string>())
                .Where(r => !string.IsNullOrWhiteSpace(r))
                .Select(Normalize)
                .ToArray();
        }

        public bool Restricted => _roots.Length > 0;

        public bool IsAllowed(string path)
        {
            if (_roots.Length == 0) return true;
            if (string.IsNullOrWhiteSpace(path)) return false;

            string full;
            try { full = Normalize(path); }
            catch { return false; }

            foreach (var root in _roots)
            {
                if (full.Equals(root, StringComparison.OrdinalIgnoreCase)) return true;
                if (full.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) return true;
            }
            return false;
        }

        private static string Normalize(string p) => Path.TrimEndingDirectorySeparator(Path.GetFullPath(p));
    }
}
