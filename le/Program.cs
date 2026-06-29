using LogExplorer.Services;
using Microsoft.AspNetCore.Authentication.Negotiate;
using Microsoft.AspNetCore.Authorization;

namespace LogExplorer
{
    public class Program
    {
        public static void Main(string[] args)
        {
            var builder = WebApplication.CreateBuilder(args);

            // Add services to the container.
            builder.Services.AddControllersWithViews();
            builder.Services.AddSingleton<MetadataStore>();
            builder.Services.AddSingleton<LogFileScanner>();
            builder.Services.AddSingleton<LogReader>();
            builder.Services.AddSingleton<LogDayCache>();
            builder.Services.AddSingleton<ScanTotalCache>();
            builder.Services.AddSingleton<HotspotsService>();
            builder.Services.AddSingleton<PathGuard>();
            builder.Services.Configure<ScaleOptions>(builder.Configuration.GetSection("Scale"));
            builder.Services.Configure<HotspotsOptions>(builder.Configuration.GetSection("Hotspots"));
            builder.Services.Configure<SecurityOptions>(builder.Configuration.GetSection("Security"));

            // Windows Authentication (Negotiate/AD). Every endpoint requires an authenticated
            // user; if Security:AllowedGroups is set, membership in one of those AD groups too.
            builder.Services.AddAuthentication(NegotiateDefaults.AuthenticationScheme).AddNegotiate();
            var allowedGroups = builder.Configuration.GetSection("Security:AllowedGroups").Get<string[]>() ?? Array.Empty<string>();
            builder.Services.AddAuthorization(options =>
            {
                var policy = new AuthorizationPolicyBuilder().RequireAuthenticatedUser();
                if (allowedGroups.Length > 0) policy.RequireRole(allowedGroups);
                options.FallbackPolicy = policy.Build();
            });

            var app = builder.Build();

            if (!app.Services.GetRequiredService<PathGuard>().Restricted)
                app.Logger.LogWarning("Security:AllowedRoots is not configured — log sources may read any path the process can access. Set allowed roots before exposing this app.");

            // Configure the HTTP request pipeline.
            if (!app.Environment.IsDevelopment())
            {
                app.UseExceptionHandler("/Home/Error");
                // The default HSTS value is 30 days. You may want to change this for production scenarios, see https://aka.ms/aspnetcore-hsts.
                app.UseHsts();
            }

            app.UseHttpsRedirection();
            app.UseStaticFiles();

            app.UseRouting();

            app.UseAuthentication();
            app.UseAuthorization();

            app.MapControllers();

            app.MapControllerRoute(
                name: "default",
                pattern: "{controller=Home}/{action=Index}/{id?}");

            app.Run();
        }
    }
}
