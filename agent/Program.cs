using System.Text.Json;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using PanelTech.Agent;
if(args.Contains("--self-test")){SelfTest.Run();return;}
string? Arg(string key){var i=Array.IndexOf(args,key);return i>=0&&i+1<args.Length?args[i+1]:null;}
if(Arg("--validate-job") is string jobPath){var job=JsonSerializer.Deserialize<Job>(File.ReadAllText(jobPath),Contracts.Json)!;try{Contracts.Validate(job,job.DeviceId,job.BootId,job.AllowedVariants,DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());Console.WriteLine(JsonSerializer.Serialize(new Result(job.BootId,"failed","dry_run","DRY-RUN: схема проверена, Windows и QoS не проверялись.",[],null,true),Contracts.Json));}catch(InvalidDataException e){Console.Error.WriteLine(e.Message);Environment.ExitCode=1;}return;}
var configPath=Arg("--config")??throw new ArgumentException("Provide --config <path>; see docs/AGENT.md");
var config=JsonSerializer.Deserialize<AgentConfig>(File.ReadAllText(configPath),Contracts.Json)!;config.Validate();config.StateDirectory=Path.GetFullPath(config.StateDirectory,Path.GetDirectoryName(Path.GetFullPath(configPath))!);
if(args.Contains("--enable-qos")&&!OperatingSystem.IsWindows())throw new PlatformNotSupportedException("QoS execution requires Windows");
if(Arg("--recover-file") is string recoveryFile){try{AgentRecovery.Prepare(config,recoveryFile,args.Contains("--confirm-state-reset"));Console.WriteLine("Local recovery prepared. Previous state quarantined; no Windows rules changed. Start the agent normally to exchange the recovery grant.");}catch{Console.Error.WriteLine("Recovery preparation failed. Stop the agent, check the grant/config/state permissions and preserve files. No credential values logged.");Environment.ExitCode=1;}return;}
await Host.CreateDefaultBuilder().UseWindowsService(o=>o.ServiceName="PanelTechAgent").ConfigureLogging(l=>l.ClearProviders().AddSimpleConsole()).ConfigureServices(s=>s.AddHostedService(p=>new Worker(config,args.Contains("--enable-qos"),Arg("--enrollment-file"),p.GetRequiredService<ILogger<Worker>>(),lifetime:p.GetRequiredService<IHostApplicationLifetime>()))).Build().RunAsync();
