namespace PanelTech.Agent;
public static class SelfTest {
 public static void Run(){int count=0;var j=new Job{Id=Guid.NewGuid().ToString(),DeviceId="pc1",BootId="boot1",GameId="fortnite",Operation="apply_marking",Exes=["EpicWebHelper.exe"],Variant=36,AllowedVariants=[36,40],Expires=2000};
 void Validate()=>Contracts.Validate(j,"pc1","boot1",[36,40],1000);
 void Reject(Action change,Action reset){change();try{Validate();throw new Exception("Expected rejection");}catch(InvalidDataException){count++;}finally{reset();}}
 Validate();count++;
 Reject(()=>j.Exes=["x.exe; Remove-Item C:\\*"],()=>j.Exes=["EpicWebHelper.exe"]);
 Reject(()=>j.Exes=["C:\\x.exe"],()=>j.Exes=["EpicWebHelper.exe"]);
 Reject(()=>j.Exes=["x.exe","X.exe"],()=>j.Exes=["EpicWebHelper.exe"]);
 Reject(()=>j.Variant=41,()=>j.Variant=36);
 Reject(()=>j.Variant=64,()=>j.Variant=36);
 Reject(()=>j.AllowedVariants=[40],()=>j.AllowedVariants=[36,40]);
 Reject(()=>j.BootId="boot2",()=>j.BootId="boot1");
 Reject(()=>j.Expires=999,()=>j.Expires=2000);
 Reject(()=>j.DeviceId="pc2",()=>j.DeviceId="pc1");
 Reject(()=>j.Operation="shell",()=>j.Operation="apply_marking");
 Reject(()=>j.GameId="*",()=>j.GameId="fortnite");
 Reject(()=>j.Exes=[],()=>j.Exes=["EpicWebHelper.exe"]);
 var q=new Qos(Path.GetTempPath(),false);var r=q.Execute(j,CancellationToken.None).GetAwaiter().GetResult();if(!r.DryRun||r.State=="succeeded")throw new Exception("dry-run claimed success");count++;
 try{new AgentConfig{ServerUrl="http://example.org"}.Validate();throw new Exception("HTTP allowed");}catch(InvalidDataException){count++;}
 new AgentConfig{ServerUrl="http://127.0.0.1:3000"}.Validate();count++;
 var path=Path.Combine(Path.GetTempPath(),"paneltech-self-"+Guid.NewGuid()+".json");var receipt=new Receipt{Job=j,Result=r,Delivered=false};Disk.Write(path,new[]{receipt});if(Disk.Read<Receipt[]>(path)![0].Job.Id!=j.Id)throw new Exception("receipt persistence");File.Delete(path);count++;
 void Invalid(Action action){try{action();throw new Exception("Expected protocol rejection");}catch(InvalidDataException){count++;}}
 using(var json=System.Text.Json.JsonDocument.Parse("{\"deviceToken\":null,\"clubId\":\"club\"}"))Invalid(()=>Contracts.RegistrationToken(json.RootElement));
 using(var json=System.Text.Json.JsonDocument.Parse("{\"deviceToken\":\"bad\",\"clubId\":\"club\"}"))Invalid(()=>Contracts.RegistrationToken(json.RootElement));
 using(var json=System.Text.Json.JsonDocument.Parse(System.Text.Json.JsonSerializer.Serialize(new{deviceToken=new string('a',64),clubId="club"}))){if(Contracts.RegistrationToken(json.RootElement).Length!=64)throw new Exception("registration");count++;}
 using(var json=System.Text.Json.JsonDocument.Parse("{\"accepted\":true}"))Invalid(()=>Contracts.ValidateAcknowledgement(json.RootElement,j));
 using(var json=System.Text.Json.JsonDocument.Parse(System.Text.Json.JsonSerializer.Serialize(new{id=j.Id,deviceId=j.DeviceId,bootId=j.BootId,state="running"})))Invalid(()=>Contracts.ValidateAcknowledgement(json.RootElement,j));
 using(var json=System.Text.Json.JsonDocument.Parse(System.Text.Json.JsonSerializer.Serialize(new{id=j.Id,deviceId=j.DeviceId,bootId=j.BootId,state="failed"}))){Contracts.ValidateAcknowledgement(json.RootElement,j);count++;}
 if(Contracts.ValidExecutionResult(null,j.BootId)||Contracts.ValidExecutionResult(r with{Rules=null!},j.BootId))throw new Exception("invalid executor result");count++;
 var accessDirectory=Path.Combine(Path.GetTempPath(),"paneltech-access-self-"+Guid.NewGuid());Directory.CreateDirectory(accessDirectory);
 try{
  var state=Path.Combine(accessDirectory,"state");Directory.CreateDirectory(state);
  var config=new AgentConfig{ServerUrl="http://127.0.0.1:3098",StateDirectory=state};
  var grant=new RecoveryGrant{Format="paneltech-agent-recovery",FormatVersion=1,DeviceId=Guid.NewGuid().ToString(),RecoveryToken=AgentAccess.NewToken(),Expires=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()+60000,ServerOrigin=AgentAccess.Origin(config)};
  var grantPath=Path.Combine(accessDirectory,"recovery.json");Disk.Write(grantPath,grant);
  var candidate=AgentAccess.NewToken();if(!AgentAccess.ValidToken(candidate)||candidate==AgentAccess.NewToken())throw new Exception("token generation");count++;
  File.WriteAllText(Path.Combine(state,"identity.json"),"{invalid-preserved");
  Invalid(()=>AgentRecovery.Prepare(config,grantPath,false));
  grant.ServerOrigin="http://127.0.0.1:3097";Disk.Write(grantPath,grant);Invalid(()=>AgentRecovery.Prepare(config,grantPath,true));grant.ServerOrigin=AgentAccess.Origin(config);Disk.Write(grantPath,grant);
  using(var held=new FileStream(Path.Combine(state,"agent.lock"),FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.None)){
   try{AgentRecovery.Prepare(config,grantPath,true);throw new Exception("running agent was reset");}catch(IOException){count++;}
  }
  File.WriteAllText(Path.Combine(state,"ownership.json"),"old-manifest-preserved");
  AgentRecovery.Prepare(config,grantPath,true);var prepared=Disk.Read<Identity>(Path.Combine(state,"identity.json"))!;
  var quarantine=Directory.GetDirectories(state,"quarantine-*").Single();
  if(prepared.DeviceId!=grant.DeviceId||!AgentAccess.ValidToken(prepared.DeviceToken)||File.Exists(Path.Combine(state,"ownership.json"))||File.ReadAllText(Path.Combine(quarantine,"ownership.json"))!="old-manifest-preserved"||File.ReadAllText(Path.Combine(quarantine,"identity.json"))!="{invalid-preserved")throw new Exception("unsafe local recovery");count++;
  AgentRecovery.Prepare(config,grantPath,true);if(Disk.Read<Identity>(Path.Combine(state,"identity.json"))!.DeviceToken!=prepared.DeviceToken||Directory.GetDirectories(state,"quarantine-*").Length!=1)throw new Exception("repeated prepare changed identity");count++;
  // Resume an interrupted archive phase with the same durable candidate.
  grant.RecoveryToken=AgentAccess.NewToken();Disk.Write(grantPath,grant);
  var plan=new RecoveryPlan{Origin=AgentAccess.Origin(config),Grant=grant,Candidate=candidate,Quarantine="quarantine-"+Guid.NewGuid(),Phase="archive"};
  Directory.CreateDirectory(Path.Combine(state,plan.Quarantine));File.Move(Path.Combine(state,"identity.json"),Path.Combine(state,plan.Quarantine,"identity.json"));
  Disk.Write(Path.Combine(state,"recovery-plan.json"),plan);AgentRecovery.Prepare(config,grantPath,true);
  if(Disk.Read<Identity>(Path.Combine(state,"identity.json"))!.DeviceToken!=candidate||File.Exists(Path.Combine(state,"recovery-plan.json")))throw new Exception("recovery plan did not resume");count++;
 }finally{Directory.Delete(accessDirectory,true);}
 Console.WriteLine($"PASS {count} agent contract/dry-run checks (no Windows QoS executed)");}
}
