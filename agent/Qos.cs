using System.Diagnostics;
using System.Text;
using System.Text.Json;
namespace PanelTech.Agent;
public sealed class Qos(string stateDirectory,bool enabled) {
 public async Task<Result> Execute(Job job,CancellationToken ct){
  if(!enabled)return new(job.BootId,"failed","dry_run","DRY-RUN: параметры проверены, система не изменена.",[],null,true);
  if(!OperatingSystem.IsWindows())return new(job.BootId,"failed","platform","Для QoS необходим Windows.",[],null,false);
  try{return await Invoke(job,ct);}catch(OperationCanceledException){return new(job.BootId,"unknown","timeout","Таймаут PowerShell. Возможны остаточные изменения; нужна инспекция.",[],"unknown",false);}catch(Exception){return new(job.BootId,"unknown","powershell","Не удалось прочитать результат PowerShell; требуется инспекция.",[],"unknown",false);}
 }
 public async Task<Rule[]> Inspect(string bootId,CancellationToken ct){if(!enabled)return [];var r=await Execute(new Job{Operation="inspect_rules",BootId=bootId},ct);if(r.State!="succeeded")throw new IOException(r.Code);return r.Rules;}
 async Task<Result> Invoke(Job job,CancellationToken ct){
  var psi=new ProcessStartInfo("powershell.exe"){UseShellExecute=false,RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true,CreateNoWindow=true,StandardOutputEncoding=Encoding.UTF8};
  foreach(var a in new[]{"-NoLogo","-NoProfile","-NonInteractive","-File",Path.Combine(AppContext.BaseDirectory,"qos.ps1")})psi.ArgumentList.Add(a);
  using var process=Process.Start(psi)??throw new IOException("powershell_start");
  using var timeout=CancellationTokenSource.CreateLinkedTokenSource(ct);timeout.CancelAfter(TimeSpan.FromSeconds(20));
  var stdout=process.StandardOutput.ReadToEndAsync(timeout.Token);var stderr=process.StandardError.ReadToEndAsync(timeout.Token);
  await process.StandardInput.WriteAsync(JsonSerializer.Serialize(new{job,manifestPath=Path.Combine(stateDirectory,"ownership.json"),snapshotPath=Path.Combine(stateDirectory,"rollback.json")},Contracts.Json));process.StandardInput.Close();
  try{await process.WaitForExitAsync(timeout.Token);var output=await stdout;await stderr;return JsonSerializer.Deserialize<Result>(output,Contracts.Json)??throw new IOException("invalid_output");}catch{if(!process.HasExited)process.Kill(true);throw;}
 }
 public static async Task<string> BootId(CancellationToken ct){if(!OperatingSystem.IsWindows())return File.ReadAllText("/proc/sys/kernel/random/boot_id").Trim();
  var p=new ProcessStartInfo("powershell.exe"){UseShellExecute=false,RedirectStandardOutput=true,RedirectStandardError=true,CreateNoWindow=true};foreach(var a in new[]{"-NoProfile","-NonInteractive","-Command","(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().Ticks"})p.ArgumentList.Add(a);
  using var process=Process.Start(p)??throw new IOException("boot_id");using var deadline=CancellationTokenSource.CreateLinkedTokenSource(ct);deadline.CancelAfter(10000);try{var text=await process.StandardOutput.ReadToEndAsync(deadline.Token);await process.WaitForExitAsync(deadline.Token);if(process.ExitCode!=0||!long.TryParse(text.Trim(),out _))throw new IOException("boot_id");return text.Trim();}catch{if(!process.HasExited)process.Kill(true);throw;}}
}
