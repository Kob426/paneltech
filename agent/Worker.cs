using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
namespace PanelTech.Agent;
public sealed class Worker(AgentConfig config,bool enableQos,string? enrollmentFile,ILogger<Worker> logger):BackgroundService {
 protected override async Task ExecuteAsync(CancellationToken stoppingToken){
  config.Validate();Directory.CreateDirectory(config.StateDirectory);
  // Exclusive process lock prevents console/service instances mutating the same machine together.
  using var processLock=new FileStream(Path.Combine(config.StateDirectory,"agent.lock"),FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.None);
  var identityPath=Path.Combine(config.StateDirectory,"identity.json");var identity=Disk.Read<Identity>(identityPath)??new Identity();Disk.Write(identityPath,identity);
  var receiptPath=Path.Combine(config.StateDirectory,"receipts.json");var receipts=Disk.Read<List<Receipt>>(receiptPath)??[];
  using var http=new HttpClient{BaseAddress=new Uri(config.ServerUrl),Timeout=TimeSpan.FromSeconds(10)};
  var qos=new Qos(config.StateDirectory,enableQos);var bootId=await Qos.BootId(stoppingToken);
  if(identity.DeviceToken==""){
   if(enrollmentFile is null)throw new InvalidDataException("Use --enrollment-file for first registration; never place tokens in command line");
   var enrollmentToken=(await File.ReadAllTextAsync(enrollmentFile,stoppingToken)).Trim();
   using var response=await http.PostAsJsonAsync("/api/agent/register",new{enrollmentToken,deviceId=identity.DeviceId,name=config.Name,bootId},stoppingToken);response.EnsureSuccessStatusCode();
   using var json=JsonDocument.Parse(await response.Content.ReadAsStringAsync(stoppingToken));identity.DeviceToken=json.RootElement.GetProperty("deviceToken").GetString()!;Disk.Write(identityPath,identity);logger.LogInformation("Agent registered; remove the enrollment file securely.");
  }
  http.DefaultRequestHeaders.Authorization=new AuthenticationHeaderValue("Bearer",identity.DeviceToken);
  var failures=0;
  while(!stoppingToken.IsCancellationRequested){try{
   foreach(var r in receipts.Where(r=>!r.Delivered)){
    if(r.Job.BootId!=bootId){r.Delivered=true;Disk.Write(receiptPath,receipts);continue;}
    r.Result??=new Result(bootId,enableQos?"unknown":"failed",enableQos?"process_interrupted":"dry_run","Процесс прервался; повторное изменение запрещено. Нужна инспекция.",[],null,!enableQos);Disk.Write(receiptPath,receipts);
    using var sent=await http.PostAsJsonAsync("/api/agent/results/"+r.Job.Id,r.Result,Contracts.Json,stoppingToken);sent.EnsureSuccessStatusCode();r.Delivered=true;Disk.Write(receiptPath,receipts);
   }
   var rules=await qos.Inspect(bootId,stoppingToken);using var poll=await http.PostAsJsonAsync("/api/agent/poll",new{bootId,rules,inspectionVerified=enableQos},stoppingToken);poll.EnsureSuccessStatusCode();
   using var document=JsonDocument.Parse(await poll.Content.ReadAsStringAsync(stoppingToken));var root=document.RootElement;
   if(root.GetProperty("job").ValueKind!=JsonValueKind.Null){var job=root.GetProperty("job").Deserialize<Job>(Contracts.Json)!;var allowed=root.GetProperty("allowedVariants").Deserialize<int[]>()!;
    var old=receipts.FirstOrDefault(r=>r.Job.Id==job.Id);
    if(old is not null){old.Delivered=false;Disk.Write(receiptPath,receipts);}else{
     var receipt=new Receipt{Job=job};receipts.Add(receipt);Disk.Write(receiptPath,receipts); // write BEFORE execution
     try{Contracts.Validate(job,identity.DeviceId,bootId,allowed,DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());receipt.Result=await qos.Execute(job,stoppingToken);}
     catch(InvalidDataException e){receipt.Result=new Result(bootId,"failed",e.Message,"Задание отклонено локальной валидацией.",rules,null,!enableQos);}
     Disk.Write(receiptPath,receipts);
    }
   }
   // Never forget undelivered work; expired job IDs cannot be executed even after cache trimming.
   if(receipts.Count>512){receipts=receipts.Where(r=>!r.Delivered||r.Job.Expires>DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()).Concat(receipts.Where(r=>r.Delivered&&r.Job.Expires<=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()).TakeLast(256)).ToList();Disk.Write(receiptPath,receipts);}
   failures=0;await Task.Delay(2000,stoppingToken);
  }catch(OperationCanceledException)when(stoppingToken.IsCancellationRequested){break;}catch(Exception e){failures++;logger.LogWarning("Agent communication/inspection failed ({Type}, HTTP {Status}), retry {Attempt}. No credential values logged.",e.GetType().Name,(e as HttpRequestException)?.StatusCode,Math.Min(failures,5));if(failures>=5){logger.LogWarning("Five attempts exhausted; cooling down 60 seconds before a new attempt cycle.");failures=0;await Task.Delay(TimeSpan.FromSeconds(60),stoppingToken);}else{await Task.Delay(TimeSpan.FromSeconds(Math.Pow(2,failures)),stoppingToken);}}}
 }
}
