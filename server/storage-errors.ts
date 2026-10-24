// SQLite extended codes carry the primary result in the low byte. Never expose SQL/data.
export class StorageUnavailable extends Error {
 constructor(){super('Хранилище недоступно. Операции приостановлены; проверьте диск и перезапустите сервер.');}
}
export function isStorageError(error:unknown){
 const e=error as {code?:string;errcode?:number};
 return e?.code==='ERR_SQLITE_ERROR'&&[5,6,8,10,11,13,14,26].includes((e.errcode??0)&255);
}
