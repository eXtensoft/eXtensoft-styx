using System.Text.Json;
using LogExplorer.Models;

namespace LogExplorer.Services
{
    public class MetadataStore
    {
        private static readonly JsonSerializerOptions JsonOptions = new()
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            WriteIndented = true
        };

        private readonly string _filePath;
        private readonly SemaphoreSlim _gate = new(1, 1);

        public MetadataStore(IWebHostEnvironment env)
        {
            var dir = Path.Combine(env.ContentRootPath, "App_Data");
            Directory.CreateDirectory(dir);
            _filePath = Path.Combine(dir, "sources.json");
        }

        public async Task<MetadataConfig> LoadAsync()
        {
            await _gate.WaitAsync();
            try
            {
                if (!File.Exists(_filePath))
                    return new MetadataConfig();

                await using var stream = File.OpenRead(_filePath);
                return await JsonSerializer.DeserializeAsync<MetadataConfig>(stream, JsonOptions)
                       ?? new MetadataConfig();
            }
            finally
            {
                _gate.Release();
            }
        }

        public async Task SaveAsync(MetadataConfig config)
        {
            await _gate.WaitAsync();
            try
            {
                var tmp = _filePath + ".tmp";
                await using (var stream = File.Create(tmp))
                {
                    await JsonSerializer.SerializeAsync(stream, config, JsonOptions);
                }
                File.Move(tmp, _filePath, overwrite: true);
            }
            finally
            {
                _gate.Release();
            }
        }
    }
}
