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
 Console.WriteLine($"PASS {count} agent contract/dry-run checks (no Windows QoS executed)");}
}
