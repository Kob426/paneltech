import test from 'node:test';
import assert from 'node:assert/strict';
import {batchCounts,filterDevices,recentAndUnresolved,type VisibleDevice} from '../web/src/workspace';
import type {Job} from '../shared/contracts';
const device=(id:string,name:string,online=true):VisibleDevice=>({id,name,clubId:'c',demo:true,bootId:'b',lastSeen:1,scenario:'success',rules:[],inspectedAt:null,online,fresh:false});
const job=(id:string,state:Job['state'],deviceId='a')=>({id,state,deviceId} as Job);

test('PC search ranks exact name and ID first, sorts numeric parts naturally and ignores case',()=>{
 const ds=[device('a','pubg1-pc10'),device('b','pubg1-pc1'),device('pubg1-pc1','other'),device('c','PUBG1-PC2')];
 assert.deepEqual(filterDevices(ds,[],' PUBG1-PC1 ','all').map(d=>d.id),['pubg1-pc1','b','a']);
 assert.deepEqual(filterDevices([device('z','10'),device('y','2'),device('x','1')],[],'','all').map(d=>d.name),['1','2','10']);
 assert.equal(filterDevices(ds,[],'absent','all').length,0);
});
test('availability, unresolved and unknown filters use stable device identity across games',()=>{
 const ds=[device('a','1'),device('b','1',false),device('c','63')],js=[job('x','unknown','a'),job('y','running','c')];
 assert.deepEqual(filterDevices(ds,js,'','offline').map(d=>d.id),['b']);
 assert.deepEqual(filterDevices(ds,js,'','online').map(d=>d.id),['a','c']);
 assert.deepEqual(filterDevices(ds,js,'','busy').map(d=>d.id),['a','c']);
 assert.deepEqual(filterDevices(ds,js,'','unknown').map(d=>d.id),['a']);
});
test('old unknown, running and queued operations survive the recent-results limit without duplicates',()=>{
 const js=[...Array.from({length:80},(_,i)=>job(String(i),'succeeded')),job('old-unknown','unknown'),job('old-running','running'),job('old-queued','queued'),job('old-failed','failed')];
 const rows=recentAndUnresolved(js);
 assert.equal(rows.length,63);assert.equal(new Set(rows.map(j=>j.id)).size,63);
 assert.deepEqual(rows.slice(-3).map(j=>j.id),['old-unknown','old-running','old-queued']);
});
test('mixed batch counts preserve uncertainty and pending work instead of a global success',()=>{
 assert.deepEqual(batchCounts(['succeeded','failed','expired','unknown','queued','running'].map((s,i)=>job(String(i),s as Job['state']))),{total:6,succeeded:1,failed:1,expired:1,unknown:1,pending:2});
});
