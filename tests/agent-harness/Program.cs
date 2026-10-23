using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using PanelTech.Agent;
// Separate executable: never deployed with the Windows agent, never calls PowerShell.
var config=JsonSerializer.Deserialize<AgentConfig>(File.ReadAllText(args[0]),Contracts.Json)!;
if(new Uri(config.ServerUrl).Host!="127.0.0.1"||config.Name!="TEST SIMULATION")throw new InvalidDataException("Harness requires explicit loopback test configuration");
using(var probe=new HttpClient{BaseAddress=new Uri(config.ServerUrl),Timeout=TimeSpan.FromSeconds(2)}){
 if(await probe.GetStringAsync("/__paneltech_test_stub__")!="PANELTECH FILE SIMULATION ONLY")throw new InvalidDataException("Not a test stub; refusing to send simulated inspections");
}
var runtime=new TestRuntime(config.StateDirectory,args.ElementAtOrDefault(1)??"",long.Parse(args.ElementAtOrDefault(2)??"0"),args.ElementAtOrDefault(3)??"test-boot");
await Host.CreateDefaultBuilder().ConfigureLogging(l=>l.ClearProviders().AddSimpleConsole()).ConfigureServices(s=>s.AddHostedService(p=>new Worker(config,true,null,p.GetRequiredService<ILogger<Worker>>(),new FakeExecutor(config.StateDirectory),runtime,p.GetRequiredService<IHostApplicationLifetime>()))).Build().RunAsync();
sealed class TestRuntime(string directory,string barrier,long offset,string boot):AgentRuntime {
 public override long Now=>base.Now+offset;
 public override Task<string> BootId(CancellationToken ct)=>Task.FromResult(boot);
 public override Task Delay(TimeSpan duration,CancellationToken ct)=>Task.Delay(30,ct);
 public override async Task Checkpoint(string name,CancellationToken ct){if(name!=barrier)return;File.WriteAllText(Path.Combine(directory,"barrier"),name);while(!File.Exists(Path.Combine(directory,"continue")))await Task.Delay(10,ct);}
}
sealed class FakeExecutor(string directory):IAgentExecutor {
 public Task<Rule[]> Inspect(string bootId,CancellationToken ct)=>Task.FromResult(Disk.Read<Rule[]>(Path.Combine(directory,"fake-rules.json"))??[]);
 public Task<Result> Execute(Job j,CancellationToken ct){
  File.AppendAllText(Path.Combine(directory,"fake-executions.txt"),j.Id+Environment.NewLine);
  Rule[] rules=j.Operation=="apply_marking"?j.Exes.Select(e=>new Rule("TEST-"+e,j.GameId,e,j.Variant!.Value,true)).ToArray():[];
  Disk.Write(Path.Combine(directory,"fake-rules.json"),rules);
  return Task.FromResult(new Result(j.BootId,"succeeded","test_simulation","TEST SIMULATION: no Windows or QoS",rules,null,false));
 }
}
