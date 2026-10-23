using System.Diagnostics;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
namespace PanelTech.Agent;
public sealed class Worker(AgentConfig config,bool enableQos,string? enrollmentFile,ILogger<Worker> logger,
 IAgentExecutor? executor=null,AgentRuntime? runtime=null,IHostApplicationLifetime? lifetime=null):BackgroundService {
 protected override async Task ExecuteAsync(CancellationToken stoppingToken){
  try{await Run(stoppingToken);}
  catch(OperationCanceledException)when(stoppingToken.IsCancellationRequested){}
  catch(Exception){Environment.ExitCode=1;logger.LogCritical("agent_stopped: state/startup failure; preserve state and inspect locally. No credential values logged.");}
  finally{lifetime?.StopApplication();}
 }
 private async Task Run(CancellationToken stoppingToken){
  var clock=runtime??new AgentRuntime();var qos=executor??new Qos(config.StateDirectory,enableQos);
  config.Validate();Directory.CreateDirectory(config.StateDirectory);
  using var processLock=new FileStream(Path.Combine(config.StateDirectory,"agent.lock"),FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.None);
  var identityPath=Path.Combine(config.StateDirectory,"identity.json");var receiptPath=Path.Combine(config.StateDirectory,"receipts.json");
  // Missing/corrupt journals must never silently become an empty execution history.
  var identity=Disk.Read<Identity>(identityPath);var receipts=Disk.Read<List<Receipt>>(receiptPath);
  if(identity is null&&receipts is not null||identity is not null&&identity.DeviceToken!=""&&receipts is null)throw new InvalidDataException("missing_state");
  identity??=new Identity();receipts??=[];
  if(!Guid.TryParse(identity.DeviceId,out _)||identity.DeviceToken is null||identity.DeviceToken!=""&&!System.Text.RegularExpressions.Regex.IsMatch(identity.DeviceToken,"^[a-fA-F0-9]{64}$"))throw new InvalidDataException("invalid_identity");
  if(receipts.Any(r=>r is null||r.Job is null||!Guid.TryParse(r.Job.Id,out _)||r.Job.DeviceId!=identity.DeviceId||string.IsNullOrEmpty(r.Job.BootId)||r.Delivered&&r.Result is null||r.Result is not null&&(r.Result.Rules is null||r.Result.BootId!=r.Job.BootId||!new[]{"succeeded","failed","unknown"}.Contains(r.Result.State)))||receipts.Select(r=>r.Job.Id).Distinct().Count()!=receipts.Count)throw new InvalidDataException("invalid_receipts");
  Disk.Write(receiptPath,receipts);Disk.Write(identityPath,identity);
  using var http=new HttpClient{BaseAddress=new Uri(config.ServerUrl),Timeout=TimeSpan.FromSeconds(10)};
  var bootId=await clock.BootId(stoppingToken);
  if(identity.DeviceToken==""){
   if(enrollmentFile is null)throw new InvalidDataException("enrollment_file_required");
   var enrollmentToken=(await File.ReadAllTextAsync(enrollmentFile,stoppingToken)).Trim();
   using var response=await http.PostAsJsonAsync("/api/agent/register",new{enrollmentToken,deviceId=identity.DeviceId,name=config.Name,bootId},stoppingToken);response.EnsureSuccessStatusCode();
   using var json=JsonDocument.Parse(await response.Content.ReadAsStringAsync(stoppingToken));identity.DeviceToken=json.RootElement.GetProperty("deviceToken").GetString()!;Disk.Write(identityPath,identity);logger.LogInformation("Agent registered; remove the enrollment file securely.");
  }
  http.DefaultRequestHeaders.Authorization=new AuthenticationHeaderValue("Bearer",identity.DeviceToken);
  var failures=0;
  while(!stoppingToken.IsCancellationRequested){try{
   foreach(var r in receipts.Where(r=>!r.Delivered)){
    // Keep historical receipt on boot change; do not fabricate a delivery acknowledgement.
    if(r.Job.BootId!=bootId)continue;
    r.Result??=new Result(bootId,enableQos?"unknown":"failed",enableQos?"process_interrupted":"dry_run","Процесс прервался; повторное изменение запрещено. Нужна инспекция.",[],null,!enableQos);Disk.Write(receiptPath,receipts);
    using var sent=await http.PostAsJsonAsync("/api/agent/results/"+r.Job.Id,r.Result,Contracts.Json,stoppingToken);sent.EnsureSuccessStatusCode();r.Delivered=true;Disk.Write(receiptPath,receipts);
   }
   var rules=await qos.Inspect(bootId,stoppingToken);var pollStarted=Stopwatch.GetTimestamp();
   using var poll=await http.PostAsJsonAsync("/api/agent/poll",new{bootId,rules,inspectionVerified=enableQos},stoppingToken);poll.EnsureSuccessStatusCode();
   using var document=JsonDocument.Parse(await poll.Content.ReadAsStringAsync(stoppingToken));var root=document.RootElement;
   if(root.GetProperty("job").ValueKind!=JsonValueKind.Null){var job=root.GetProperty("job").Deserialize<Job>(Contracts.Json)??throw new InvalidDataException("invalid_job");var allowed=root.GetProperty("allowedVariants").Deserialize<int[]>()??throw new InvalidDataException("invalid_variants");
    var serverTime=root.GetProperty("serverTime").GetInt64();
    // A stale delivery must not poison this boot's durable journal with a mismatched result.
    if(job.BootId!=bootId)throw new InvalidDataException("boot_changed");
    var old=receipts.FirstOrDefault(r=>r.Job.Id==job.Id);
    if(old is not null){old.Delivered=false;Disk.Write(receiptPath,receipts);}else{
     var receipt=new Receipt{Job=job};receipts.Add(receipt);Disk.Write(receiptPath,receipts);
     await clock.Checkpoint("receipt_saved",stoppingToken);
     try{
      // Conservative deadline: the server timestamp plus all elapsed poll/receipt time.
      var serverNow=checked(serverTime+(long)Stopwatch.GetElapsedTime(pollStarted).TotalMilliseconds);
      if(serverTime<=0||Math.Abs((double)clock.Now-serverNow)>60000)throw new InvalidDataException("clock_skew");
      Contracts.Validate(job,identity.DeviceId,bootId,allowed,Math.Max(clock.Now,serverNow));
      receipt.Result=await qos.Execute(job,stoppingToken);await clock.Checkpoint("executed",stoppingToken);
     }
     catch(InvalidDataException e){receipt.Result=new Result(bootId,"failed",e.Message,"Задание отклонено локальной валидацией.",rules,null,!enableQos);}
     Disk.Write(receiptPath,receipts);await clock.Checkpoint("result_saved",stoppingToken);
    }
   }
   if(receipts.Count>512){receipts=receipts.Where(r=>!r.Delivered||r.Job.Expires>clock.Now).Concat(receipts.Where(r=>r.Delivered&&r.Job.Expires<=clock.Now).TakeLast(256)).ToList();Disk.Write(receiptPath,receipts);}
   failures=0;await clock.Delay(TimeSpan.FromSeconds(2),stoppingToken);
  }catch(OperationCanceledException)when(stoppingToken.IsCancellationRequested){break;}
   catch(HttpRequestException e)when(e.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden){
    Environment.ExitCode=1;logger.LogError("agent_access_denied: HTTP {Status}; stopped. Receipt/outbox retained; no automatic enrollment.",(int)e.StatusCode.Value);return;
   }
   catch(Exception e){failures++;logger.LogWarning("Agent communication/inspection failed ({Type}, HTTP {Status}), retry {Attempt}. No credential values logged.",e.GetType().Name,(e as HttpRequestException)?.StatusCode,Math.Min(failures,5));if(failures>=5){logger.LogWarning("Five attempts exhausted; cooling down 60 seconds before a new attempt cycle.");failures=0;await clock.Delay(TimeSpan.FromSeconds(60),stoppingToken);}else{await clock.Delay(TimeSpan.FromSeconds(Math.Pow(2,failures)),stoppingToken);}}
  }
 }
}
