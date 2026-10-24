// Test fixtures only: reconstruct the old unversioned layout from logical records.
import type {DatabaseSync} from 'node:sqlite';
import {decodeRecord} from '../server/snapshots';
export function makeLegacy(db:DatabaseSync){
 for(const name of ['queue_device_active','queue_deadline','devices_club','devices_token'])db.exec('DROP INDEX IF EXISTS '+name);
 db.exec('DROP TRIGGER IF EXISTS audit_no_insert_replace;DROP TRIGGER IF EXISTS audit_no_update;DROP TRIGGER IF EXISTS audit_no_delete;DROP INDEX IF EXISTS audit_created');
 if(db.prepare("SELECT name FROM sqlite_master WHERE name='snapshots'").get()){
  for(const row of db.prepare('SELECT rowid,data FROM records').all())db.prepare('UPDATE records SET data=? WHERE rowid=?').run(JSON.stringify(decodeRecord(db,String(row.data))),row.rowid!);
  db.exec('DROP TABLE snapshots');
 }
 db.exec('DROP TABLE schema_migrations;PRAGMA user_version=0');
}
