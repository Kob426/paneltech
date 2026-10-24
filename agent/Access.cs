using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
namespace PanelTech.Agent;

public static class AgentAccess {
 public static string NewToken()=>Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
 public static bool ValidToken(string? value)=>value is not null&&Regex.IsMatch(value,"^[a-f0-9]{64}$");
 public static string Origin(AgentConfig config)=>new Uri(config.ServerUrl).GetLeftPart(UriPartial.Authority);
 private static void Authorize(HttpClient http,string token)=>http.DefaultRequestHeaders.Authorization=new AuthenticationHeaderValue("Bearer",token);
 public static async Task<int?> Confirm(HttpClient http,Identity identity,string token,CancellationToken ct){
  Authorize(http,token);using var response=await http.GetAsync("/api/agent/access",ct);
  if(response.StatusCode==HttpStatusCode.Unauthorized)return null;
  response.EnsureSuccessStatusCode();using var doc=JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));var root=doc.RootElement;
  if(root.GetProperty("deviceId").GetString()!=identity.DeviceId||root.GetProperty("accessVersion").GetInt32()<1)throw new InvalidDataException("invalid_access_identity");
  return root.GetProperty("accessVersion").GetInt32();
 }
 public static async Task Bootstrap(HttpClient http,Identity identity,string path,string? enrollmentFile,string name,string bootId,CancellationToken ct){
  if(identity.DeviceToken==""){identity.DeviceToken=NewToken();identity.RegistrationPending=true;Disk.Write(path,identity);}
  if(!identity.RegistrationPending&&identity.RecoveryToken is null)return;
  // A durable candidate authenticates even after a lost response and expired grant.
  if(await Confirm(http,identity,identity.DeviceToken,ct) is null){
   HttpResponseMessage response;
   if(identity.RecoveryToken is not null){
    if(!ValidToken(identity.RecoveryToken))throw new InvalidDataException("invalid_recovery_state");
    response=await http.PostAsJsonAsync("/api/agent/recover",new{recoveryToken=identity.RecoveryToken,deviceId=identity.DeviceId,deviceToken=identity.DeviceToken,bootId},ct);
   }else{
    if(enrollmentFile is null)throw new InvalidDataException("enrollment_file_required");
    var code=(await File.ReadAllTextAsync(enrollmentFile,ct)).Trim();if(!ValidToken(code))throw new InvalidDataException("invalid_enrollment");
    response=await http.PostAsJsonAsync("/api/agent/register",new{enrollmentToken=code,deviceId=identity.DeviceId,deviceToken=identity.DeviceToken,name,bootId},ct);
   }
   using(response){response.EnsureSuccessStatusCode();using var json=JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));if(Contracts.RegistrationToken(json.RootElement)!=identity.DeviceToken||json.RootElement.GetProperty("deviceId").GetString()!=identity.DeviceId)throw new InvalidDataException("invalid_registration_identity");}
  }
  identity.RegistrationPending=false;identity.RecoveryToken=null;Disk.Write(path,identity);Authorize(http,identity.DeviceToken);
 }
 public static async Task Rotate(HttpClient http,Identity identity,string path,CancellationToken ct){
  if(identity.PendingToken is null){identity.PendingToken=NewToken();Disk.Write(path,identity);}
  if(!ValidToken(identity.PendingToken)||identity.PendingToken==identity.DeviceToken)throw new InvalidDataException("invalid_pending_token");
  if(await Confirm(http,identity,identity.PendingToken,ct) is null){
   var version=await Confirm(http,identity,identity.DeviceToken,ct)??throw new HttpRequestException("access_denied",null,HttpStatusCode.Unauthorized);
   using var response=await http.PostAsJsonAsync("/api/agent/access/rotate",new{newToken=identity.PendingToken,expectedAccessVersion=version},ct);response.EnsureSuccessStatusCode();
   using var doc=JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));
   if(Contracts.RegistrationToken(doc.RootElement)!=identity.PendingToken||doc.RootElement.GetProperty("deviceId").GetString()!=identity.DeviceId)throw new InvalidDataException("invalid_rotation_identity");
  }
  identity.DeviceToken=identity.PendingToken;identity.PendingToken=null;Disk.Write(path,identity);Authorize(http,identity.DeviceToken);
 }
}

public sealed class RecoveryGrant {
 public string Format {get;set;}="";
 public int FormatVersion {get;set;}
 public string DeviceId {get;set;}="";
 public string RecoveryToken {get;set;}="";
 public long Expires {get;set;}
 public string ServerOrigin {get;set;}="";
}
public sealed class RecoveryPlan {
 public string Origin {get;set;}="";
 public required RecoveryGrant Grant {get;set;}
 public string Candidate {get;set;}="";
 public string Quarantine {get;set;}="";
 public string Phase {get;set;}="archive";
}
public static class AgentRecovery {
 public static void Prepare(AgentConfig config,string file,bool confirmed){
  if(!confirmed)throw new InvalidDataException("explicit_state_reset_required");
  config.Validate();var grant=Disk.Read<RecoveryGrant>(file)??throw new InvalidDataException("missing_recovery_file");
  if(grant.Format!="paneltech-agent-recovery"||grant.FormatVersion!=1||!Guid.TryParse(grant.DeviceId,out _)||!AgentAccess.ValidToken(grant.RecoveryToken)||grant.Expires<=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()||grant.ServerOrigin!=AgentAccess.Origin(config))throw new InvalidDataException("invalid_recovery_file");
  Directory.CreateDirectory(config.StateDirectory);
  using var processLock=new FileStream(Path.Combine(config.StateDirectory,"agent.lock"),FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.None);
  var path=Path.Combine(config.StateDirectory,"recovery-plan.json");
  var plan=Disk.Read<RecoveryPlan>(path);
  var grantHash=Convert.ToHexString(SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(grant.RecoveryToken)));
  if(plan is null){
   Identity? previous=null;try{previous=Disk.Read<Identity>(Path.Combine(config.StateDirectory,"identity.json"));}catch(InvalidDataException){}
   if(previous?.RecoveryGrantHash==grantHash){
    if(previous.DeviceId!=grant.DeviceId||previous.ServerOrigin!=AgentAccess.Origin(config)||!AgentAccess.ValidToken(previous.DeviceToken)||Disk.Read<List<Receipt>>(Path.Combine(config.StateDirectory,"receipts.json")) is null)throw new InvalidDataException("recovery_already_used_state_missing");
    return;
   }
  }
  if(plan is null){plan=new RecoveryPlan{Grant=grant,Origin=AgentAccess.Origin(config),Candidate=AgentAccess.NewToken(),Quarantine="quarantine-"+Guid.NewGuid()};Disk.Write(path,plan);}
  if(plan.Origin!=AgentAccess.Origin(config)||plan.Grant.DeviceId!=grant.DeviceId||plan.Grant.RecoveryToken!=grant.RecoveryToken||!AgentAccess.ValidToken(plan.Candidate)||!Regex.IsMatch(plan.Quarantine,"^quarantine-[a-f0-9-]{36}$")||!new[]{"archive","initialize"}.Contains(plan.Phase))throw new InvalidDataException("recovery_plan_mismatch");
  var quarantine=Path.Combine(config.StateDirectory,plan.Quarantine);Directory.CreateDirectory(quarantine);
  if(!OperatingSystem.IsWindows())File.SetUnixFileMode(quarantine,UnixFileMode.UserRead|UnixFileMode.UserWrite|UnixFileMode.UserExecute);
  if(plan.Phase=="archive"){
   foreach(var name in new[]{"identity.json","receipts.json","ownership.json","rollback.json"})foreach(var suffix in new[]{"",".tmp"}){
    var source=Path.Combine(config.StateDirectory,name+suffix);if(Directory.Exists(source))throw new InvalidDataException("state_path_is_directory");if(File.Exists(source))File.Move(source,Path.Combine(quarantine,name+suffix),false);
   }
   plan.Phase="initialize";Disk.Write(path,plan);
  }
  Disk.Write(Path.Combine(config.StateDirectory,"receipts.json"),new List<Receipt>());
  Disk.Write(Path.Combine(config.StateDirectory,"identity.json"),new Identity{DeviceId=grant.DeviceId,DeviceToken=plan.Candidate,RecoveryToken=grant.RecoveryToken,ServerOrigin=plan.Origin,RecoveryGrantHash=grantHash});
  File.Delete(path);
 }
}
