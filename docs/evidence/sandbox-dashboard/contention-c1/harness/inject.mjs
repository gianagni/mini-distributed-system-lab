// Controlled SQLITE_BUSY injection on a REAL database: for chosen BEGIN IMMEDIATE ordinals,
// a second real connection holds the write lock, so SQLite really waits busy_timeout and throws.
import { DatabaseSync } from 'node:sqlite';
export function busyInjector(db, path, busyOnBegin = [], ioerrOnBegin = []) {
  const locker = new DatabaseSync(path);
  locker.exec('PRAGMA busy_timeout = 2000;');
  let begins = 0;
  const log = [];
  const wrapper = {
    exec(sql) {
      if (/^BEGIN IMMEDIATE/.test(sql)) {
        begins += 1;
        if (ioerrOnBegin.includes(begins)) {
          // Non-BUSY database failure (e.g. disk I/O). Same shape node:sqlite uses: errcode + message.
          const e = Object.assign(new Error('disk I/O error'), { code: 'ERR_SQLITE_ERROR', errcode: 10, errstr: 'disk I/O error' });
          log.push({ begin: begins, errcode: 10, message: e.message, injected: 'IOERR' });
          throw e;
        }
        if (busyOnBegin.includes(begins)) {
          locker.exec('BEGIN IMMEDIATE');
          try { return db.exec(sql); } catch (e) { log.push({ begin: begins, errcode: e.errcode, message: e.message }); throw e; }
          finally { locker.exec('ROLLBACK'); }
        }
      }
      return db.exec(sql);
    },
    prepare: (sql) => db.prepare(sql),
    close: () => { locker.close(); db.close(); },
  };
  return { db: wrapper, log, begins: () => begins };
}
