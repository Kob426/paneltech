import type {Store} from '../server/store';
import {editVersion} from '../server/audit';
// Existing non-concurrency fixtures act as clients that have just read the current record.
// Concurrency tests deliberately send their own captured versions without this helper.
export function withCurrentVersion(store:Store,path:string,body:unknown){
 if(!body||typeof body!=='object'||Object.hasOwn(body,'expectedVersion'))return body;
 const match=/^\/admin\/(games|clubs|users)\/([^/]+)(?:\/password)?$/.exec(path)??/^\/jobs\/([^/]+)\/(feedback)$/.exec(path);
 if(!match)return body;
 const feedback=path.startsWith('/jobs/'),kind=feedback?'job':({games:'game',clubs:'club',users:'user'} as Record<string,string>)[match[1]],id=feedback?match[1]:match[2];
 const record=store.get(kind,id);return record?{...body,expectedVersion:editVersion(kind,record)}:body;
}
