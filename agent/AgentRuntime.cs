namespace PanelTech.Agent;

public interface IAgentExecutor {
 Task<Rule[]> Inspect(string bootId,CancellationToken ct);
 Task<Result> Execute(Job job,CancellationToken ct);
}

// Injection seam for the separate process-test harness. Production has no test flags.
public class AgentRuntime {
 public virtual long Now => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
 public virtual Task<string> BootId(CancellationToken ct) => Qos.BootId(ct);
 public virtual Task Checkpoint(string name,CancellationToken ct) => Task.CompletedTask;
 public virtual Task Delay(TimeSpan duration,CancellationToken ct) => Task.Delay(duration,ct);
}
