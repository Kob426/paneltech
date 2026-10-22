using System.Text.Json;
using System.Text.RegularExpressions;
namespace PanelTech.Agent;
public sealed record Rule(string Name,string GameId,string Exe,int Dscp,bool Owned);
public sealed class Job {
 public string Id {get;set;}="";
 public string DeviceId {get;set;}="";
 public string GameId {get;set;}="";
 public string Operation {get;set;}="";
 public string BootId {get;set;}="";
 public string[] Exes {get;set;}=[];
 public int? Variant {get;set;}
 public int[] AllowedVariants {get;set;}=[];
 public long Expires {get;set;}
}
public sealed record Result(string BootId,string State,string Code,string Message,Rule[] Rules,string? Rollback,bool DryRun);
public static class Contracts {
 public static readonly JsonSerializerOptions Json=new(JsonSerializerDefaults.Web){WriteIndented=true};
 public static void Validate(Job j,string deviceId,string bootId,int[] allowed,long now){
  if(!Guid.TryParse(j.Id,out _))throw new InvalidDataException("invalid_job_id");
  if(j.DeviceId!=deviceId)throw new InvalidDataException("wrong_device");
  if(j.BootId!=bootId)throw new InvalidDataException("boot_changed");
  if(j.Expires<=now)throw new InvalidDataException("expired");
  if(!Regex.IsMatch(j.GameId,"^[a-zA-Z0-9-]{1,80}$"))throw new InvalidDataException("invalid_game");
  if(!new[]{"health","inspect_rules","apply_marking","remove_marking"}.Contains(j.Operation))throw new InvalidDataException("invalid_operation");
  if(j.Exes.Length>30||j.Exes.Any(e=>!Regex.IsMatch(e,@"^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}\.exe$",RegexOptions.IgnoreCase))||j.Exes.Distinct(StringComparer.OrdinalIgnoreCase).Count()!=j.Exes.Length)throw new InvalidDataException("invalid_exe");
  if(j.Operation is "apply_marking" or "remove_marking" && j.Exes.Length==0)throw new InvalidDataException("empty_exes");
  if(j.Operation=="apply_marking"&&(j.Variant is null or <0 or >63||!allowed.Contains(j.Variant.Value)||!j.AllowedVariants.Contains(j.Variant.Value)))throw new InvalidDataException("variant_unavailable");
 }
}
public sealed class AgentConfig {
 public string ServerUrl {get;set;}="http://127.0.0.1:3000";
 public string StateDirectory {get;set;}="agent-state";
 public string Name {get;set;}=Environment.MachineName;
 public void Validate(){var u=new Uri(ServerUrl);if(u.Scheme!="https"&&!(u.Scheme=="http"&&u.IsLoopback))throw new InvalidDataException("HTTPS required outside loopback");if(u.UserInfo!=""||u.Query!=""||u.Fragment!=""||u.AbsolutePath!="/")throw new InvalidDataException("Server URL must be an origin");}
}
public sealed class Identity {public string DeviceId {get;set;}=Guid.NewGuid().ToString();public string DeviceToken {get;set;}="";}
public sealed class Receipt {public required Job Job {get;set;} public Result? Result {get;set;} public bool Delivered {get;set;}}
public static class Disk {
 public static T? Read<T>(string p)=>File.Exists(p)?JsonSerializer.Deserialize<T>(File.ReadAllText(p),Contracts.Json):default;
 public static void Write<T>(string p,T value){Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(p))!);var tmp=p+".tmp";File.WriteAllText(tmp,JsonSerializer.Serialize(value,Contracts.Json));if(!OperatingSystem.IsWindows())File.SetUnixFileMode(tmp,UnixFileMode.UserRead|UnixFileMode.UserWrite);File.Move(tmp,p,true);}
}
