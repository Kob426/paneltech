export interface BackupSummary {
 id:string; createdAt:string; bytes:number; verifiedAt:number;
 drill:{checkedAt:number; expired:number; unknown:number; revoked:number};
}
export interface BackupState {
 phase:'idle'|'running'|'error'; lastAttempt:number|null; lastSuccess:number|null;
 error:'backup_failed'|'backup_locked'|'worker_failed'|'status_invalid'|null;
 latest:BackupSummary|null; count:number; bytes:number; skipped:number; budgetExceeded:boolean;
}
export interface OperationsStatus {
 database:{state:'ready'|'paused'; mainBytes:number|null; walBytes:number|null; freeBytes:number|null};
 runtime:{uptimeSeconds:number; rssBytes:number};
 backup:BackupState & {enabled:boolean; intervalMinutes:number; keep:number; maxBytes:number; nextAt:number|null};
}
