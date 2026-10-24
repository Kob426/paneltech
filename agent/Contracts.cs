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
 public static void ValidateVariants(int[]? variants){if(variants is null||variants.Length>64||variants.Any(v=>v is <0 or >63)||variants.Distinct().Count()!=variants.Length)throw new InvalidDataException("invalid_variants");}
 public static void ValidateAcknowledgement(JsonElement ack,Job job){
  if(ack.ValueKind!=JsonValueKind.Object||!ack.TryGetProperty("id",out var id)||id.ValueKind!=JsonValueKind.String||id.GetString()!=job.Id||!ack.TryGetProperty("deviceId",out var device)||device.ValueKind!=JsonValueKind.String||device.GetString()!=job.DeviceId||!ack.TryGetProperty("bootId",out var boot)||boot.ValueKind!=JsonValueKind.String||boot.GetString()!=job.BootId||!ack.TryGetProperty("state",out var state)||state.ValueKind!=JsonValueKind.String||!new[]{"succeeded","failed","expired","unknown"}.Contains(state.GetString()))throw new InvalidDataException("invalid_acknowledgement");
 }
 public static string RegistrationToken(JsonElement root){
  if(root.ValueKind!=JsonValueKind.Object||!root.TryGetProperty("deviceToken",out var token)||token.ValueKind!=JsonValueKind.String||!Regex.IsMatch(token.GetString()??"","^[a-fA-F0-9]{64}$")||!root.TryGetProperty("clubId",out var club)||club.ValueKind!=JsonValueKind.String||string.IsNullOrWhiteSpace(club.GetString())||club.GetString()!.Length>100)throw new InvalidDataException("invalid_registration");
  return token.GetString()!;
 }
 public static bool ValidExecutionResult(Result? result,string bootId)=>result is not null&&result.BootId==bootId&&new[]{"succeeded","failed","unknown"}.Contains(result.State)&&result.Code is {Length:>0 and <=80}&&result.Message is {Length:<=2000}&&result.Rollback is not {Length:>2000}&&result.Rules is {Length:<=500}&&result.Rules.All(r=>r is not null&&r.Name is {Length:<=220}&&r.GameId is {Length:<=80}&&r.Exe is {Length:<=1024}&&r.Dscp is >=0 and <=63);
 public static void Validate(Job j,string deviceId,string bootId,int[] allowed,long now){
  if(!Guid.TryParse(j.Id,out _))throw new InvalidDataException("invalid_job_id");
  if(j.DeviceId!=deviceId)throw new InvalidDataException("wrong_device");
  if(j.BootId!=bootId)throw new InvalidDataException("boot_changed");
  if(j.Expires<=now)throw new InvalidDataException("expired");
  ValidateVariants(allowed);ValidateVariants(j.AllowedVariants);
  if(j.GameId is null||!Regex.IsMatch(j.GameId,"^[a-zA-Z0-9-]{1,80}$"))throw new InvalidDataException("invalid_game");
  if(!new[]{"health","inspect_rules","apply_marking","remove_marking"}.Contains(j.Operation))throw new InvalidDataException("invalid_operation");
  if(j.Exes is null||j.Exes.Length>30||j.Exes.Any(e=>e is null||!Regex.IsMatch(e,@"^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}\.exe$",RegexOptions.IgnoreCase))||j.Exes.Distinct(StringComparer.OrdinalIgnoreCase).Count()!=j.Exes.Length)throw new InvalidDataException("invalid_exe");
  if(j.Operation is "apply_marking" or "remove_marking" && j.Exes.Length==0)throw new InvalidDataException("empty_exes");
  if(j.Operation=="apply_marking"&&(j.Variant is null or <0 or >63||allowed is null||j.AllowedVariants is null||!allowed.Contains(j.Variant.Value)||!j.AllowedVariants.Contains(j.Variant.Value)))throw new InvalidDataException("variant_unavailable");
 }
}
public sealed class AgentConfig {
 public string ServerUrl {get;set;}="http://127.0.0.1:3000";
 public string StateDirectory {get;set;}="agent-state";
 public string Name {get;set;}=Environment.MachineName;
 public void Validate(){var u=new Uri(ServerUrl);if(u.Scheme!="https"&&!(u.Scheme=="http"&&u.IsLoopback))throw new InvalidDataException("HTTPS required outside loopback");if(u.UserInfo!=""||u.Query!=""||u.Fragment!=""||u.AbsolutePath!="/")throw new InvalidDataException("Server URL must be an origin");}
}
public sealed class Identity {
 [System.Text.Json.Serialization.JsonRequired]public string DeviceId {get;set;}=Guid.NewGuid().ToString();
 [System.Text.Json.Serialization.JsonRequired]public string DeviceToken {get;set;}="";
 public string? ServerOrigin {get;set;}
 public bool RegistrationPending {get;set;}
 public string? PendingToken {get;set;}
 public string? RecoveryToken {get;set;}
 public string? RecoveryGrantHash {get;set;}
}
public sealed class Receipt {public required Job Job {get;set;} public Result? Result {get;set;} public bool Delivered {get;set;}}
public static class Disk {
 public static T? Read<T>(string p){
  if(!File.Exists(p)){if(File.Exists(p+".tmp"))throw new InvalidDataException("incomplete_state");return default;}
  try{return JsonSerializer.Deserialize<T>(File.ReadAllText(p),Contracts.Json)??throw new InvalidDataException("null_state");}
  catch(JsonException){throw new InvalidDataException("invalid_state_json");}
 }
 public static void Write<T>(string p,T value){
  try{
  Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(p))!);var tmp=p+".tmp";
  using(var stream=new FileStream(tmp,FileMode.Create,FileAccess.Write,FileShare.None)){
   if(!OperatingSystem.IsWindows())File.SetUnixFileMode(tmp,UnixFileMode.UserRead|UnixFileMode.UserWrite);
   JsonSerializer.Serialize(stream,value,Contracts.Json);stream.Flush(true);
  }
  File.Move(tmp,p,true);
  }catch(Exception e)when(e is IOException or UnauthorizedAccessException or JsonException){throw new StateWriteException();}
 }
}
public sealed class StateWriteException:IOException {public StateWriteException():base("state_write_failed"){} }
