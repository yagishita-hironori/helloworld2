var builder = WebApplication.CreateBuilder(args);

builder.Services.AddControllers();

var app = builder.Build();

// ヘルスチェック (ALB 用)
app.MapGet("/health", () => Results.Ok("ok"));

// Hello World API
app.MapGet("/api/hello", () => Results.Ok(new { message = "Hello World from ASP.NET Core!", version = "2.0" }));

app.MapControllers();

app.Run();
