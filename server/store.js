import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

export const hash = value => createHash('sha256').update(value).digest('hex');
export class Store {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS partners (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, expires_at INTEGER,
        daily_limit INTEGER NOT NULL, rpm INTEGER NOT NULL, origins TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, partner_id TEXT NOT NULL REFERENCES partners(id), expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY, partner_id TEXT NOT NULL REFERENCES partners(id), kind TEXT NOT NULL,
        started_at INTEGER NOT NULL, status TEXT NOT NULL, input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0, duration_ms INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS request_usage ON requests(partner_id, started_at);
      CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, action TEXT NOT NULL, partner_id TEXT, at INTEGER NOT NULL);`);
  }
  audit(action, id) { this.db.prepare('INSERT INTO audit(action,partner_id,at) VALUES(?,?,?)').run(action,id,Date.now()); }
  create({ name, dailyLimit, rpm, origins, expiresAt }) {
    const apiKey = `db_live_${randomBytes(32).toString('base64url')}`;
    const id = randomUUID();
    this.db.prepare('INSERT INTO partners(id,name,key_hash,prefix,created_at,expires_at,daily_limit,rpm,origins) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id,name,hash(apiKey),apiKey.slice(0,16),Date.now(),expiresAt || null,dailyLimit,rpm,JSON.stringify(origins));
    this.audit('partner.created',id);
    return { partner: this.publicPartner(this.get(id)), apiKey };
  }
  get(id) { return this.db.prepare('SELECT * FROM partners WHERE id=?').get(id); }
  valid(p) { return p && p.active === 1 && (!p.expires_at || p.expires_at > Date.now()); }
  authenticate(secret, sessionOnly = false) {
    if (typeof secret !== 'string' || secret.length > 256) return null;
    const p = sessionOnly
      ? this.db.prepare('SELECT p.* FROM partners p JOIN sessions s ON s.partner_id=p.id WHERE s.hash=? AND s.expires_at>?').get(hash(secret),Date.now())
      : this.db.prepare('SELECT * FROM partners WHERE key_hash=?').get(hash(secret));
    return this.valid(p) ? p : null;
  }
  session(id) {
    const token = `db_session_${randomBytes(32).toString('base64url')}`;
    const expiresAt = Date.now()+3600000;
    this.db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(Date.now());
    this.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash(token),id,expiresAt);
    return { token, expiresAt };
  }
  revoke(id) {
    this.db.prepare('UPDATE partners SET active=0 WHERE id=?').run(id);
    this.db.prepare('DELETE FROM sessions WHERE partner_id=?').run(id);
    this.audit('partner.revoked',id);
  }
  rotate(id) {
    const apiKey = `db_live_${randomBytes(32).toString('base64url')}`;
    this.db.prepare('UPDATE partners SET key_hash=?,prefix=?,active=1 WHERE id=?').run(hash(apiKey),apiKey.slice(0,16),id);
    this.db.prepare('DELETE FROM sessions WHERE partner_id=?').run(id);
    this.audit('partner.rotated',id);
    return { partner: this.publicPartner(this.get(id)), apiKey };
  }
  publicPartner(p) {
    const midnight = new Date(); midnight.setUTCHours(0,0,0,0);
    const usage = this.db.prepare('SELECT COUNT(*) AS requests, COALESCE(SUM(input_tokens+output_tokens),0) AS tokens FROM requests WHERE partner_id=? AND started_at>=?').get(p.id,midnight.getTime());
    return { id:p.id,name:p.name,prefix:p.prefix,active:!!p.active,createdAt:p.created_at,expiresAt:p.expires_at,dailyLimit:p.daily_limit,rpm:p.rpm,origins:JSON.parse(p.origins), ...usage };
  }
  list() { return this.db.prepare('SELECT * FROM partners ORDER BY created_at DESC').all().map(p=>this.publicPartner(p)); }
  reserve(p, kind) {
    const id = randomUUID(), now = Date.now();
    const midnight = new Date(); midnight.setUTCHours(0,0,0,0);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const day = this.db.prepare('SELECT COUNT(*) AS n FROM requests WHERE partner_id=? AND started_at>=?').get(p.id,midnight.getTime()).n;
      const minute = this.db.prepare('SELECT COUNT(*) AS n FROM requests WHERE partner_id=? AND started_at>=?').get(p.id,now-60000).n;
      if (day >= p.daily_limit) throw new Error('Daily request limit reached. Contact your administrator.');
      if (minute >= p.rpm) throw new Error('Too many requests. Please try again in a minute.');
      this.db.prepare('INSERT INTO requests(id,partner_id,kind,started_at,status) VALUES(?,?,?,?,?)').run(id,p.id,kind,now,'processing');
      this.db.exec('COMMIT'); return id;
    } catch(e) { this.db.exec('ROLLBACK'); throw e; }
  }
  finish(id,status,usage={}) {
    this.db.prepare('UPDATE requests SET status=?, input_tokens=?, output_tokens=?, duration_ms=?-started_at WHERE id=?')
      .run(status,usage.input_tokens||0,usage.output_tokens||0,Date.now(),id);
  }
  close() { this.db.close(); }
}
