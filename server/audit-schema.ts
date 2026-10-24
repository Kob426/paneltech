export const AUDIT_TRIGGERS=[
 `CREATE TRIGGER audit_no_insert_replace BEFORE INSERT ON records WHEN (NEW.kind='audit' AND EXISTS(SELECT 1 FROM records WHERE kind='audit' AND id=NEW.id)) OR EXISTS(SELECT 1 FROM records WHERE kind='audit' AND rowid=NEW.rowid) BEGIN SELECT RAISE(ABORT,'audit_immutable'); END`,
 `CREATE TRIGGER audit_no_update BEFORE UPDATE ON records WHEN OLD.kind='audit' OR NEW.kind='audit' OR EXISTS(SELECT 1 FROM records WHERE kind='audit' AND rowid=NEW.rowid) BEGIN SELECT RAISE(ABORT,'audit_immutable'); END`,
 `CREATE TRIGGER audit_no_delete BEFORE DELETE ON records WHEN OLD.kind='audit' BEGIN SELECT RAISE(ABORT,'audit_immutable'); END`
];
export const AUDIT_SQL=AUDIT_TRIGGERS.join(';')+`;CREATE INDEX audit_created ON records(json_extract(data,'$.at') DESC) WHERE kind='audit';`;
