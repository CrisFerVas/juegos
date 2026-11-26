// Persistencia del servidor con SQLite (módulo integrado en Node >= 22.5).
import { DatabaseSync } from 'node:sqlite';

export const SYNCED_STORES = ['projects', 'members', 'sheets', 'tasks', 'files', 'markups'];
export const ROLES = ['admin', 'miembro', 'seguidor'];

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    pass TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS memberships (
    project_id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS invitations (
    project_id TEXT NOT NULL,
    email TEXT NOT NULL,
    role TEXT NOT NULL,
    invited_by TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, email)
  );
  CREATE TABLE IF NOT EXISTS docs (
    store TEXT NOT NULL,
    id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    data TEXT,
    rev INTEGER NOT NULL DEFAULT 0,
    deleted INTEGER NOT NULL DEFAULT 0,
    seq INTEGER NOT NULL,
    updated_by TEXT,
    PRIMARY KEY (store, id)
  );
  CREATE INDEX IF NOT EXISTS docs_project_seq ON docs (project_id, seq);
`;

export function openStore(file) {
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  let seq = db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM docs').get().s;

  const q = {
    userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
    userById: db.prepare('SELECT id, email, name, created_at FROM users WHERE id = ?'),
    insertUser: db.prepare('INSERT INTO users (id, email, name, pass, created_at) VALUES (?, ?, ?, ?, ?)'),
    insertSession: db.prepare('INSERT INTO sessions (token, user_id, created_at, last_seen) VALUES (?, ?, ?, ?)'),
    session: db.prepare('SELECT * FROM sessions WHERE token = ?'),
    touchSession: db.prepare('UPDATE sessions SET last_seen = ? WHERE token = ?'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
    rolesOf: db.prepare('SELECT project_id, role FROM memberships WHERE user_id = ?'),
    role: db.prepare('SELECT role FROM memberships WHERE project_id = ? AND user_id = ?'),
    setMembership: db.prepare(`INSERT INTO memberships (project_id, user_id, role, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (project_id, user_id) DO UPDATE SET role = excluded.role`),
    deleteMembership: db.prepare('DELETE FROM memberships WHERE project_id = ? AND user_id = ?'),
    projectMembers: db.prepare(`SELECT u.id AS userId, u.name, u.email, m.role FROM memberships m
      JOIN users u ON u.id = m.user_id WHERE m.project_id = ? ORDER BY u.name`),
    adminCount: db.prepare(`SELECT COUNT(*) AS n FROM memberships WHERE project_id = ? AND role = 'admin'`),
    invitationsOf: db.prepare('SELECT email, role, created_at FROM invitations WHERE project_id = ? ORDER BY email'),
    invitationsForEmail: db.prepare('SELECT project_id, role FROM invitations WHERE email = ?'),
    setInvitation: db.prepare(`INSERT INTO invitations (project_id, email, role, invited_by, created_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (project_id, email) DO UPDATE SET role = excluded.role`),
    deleteInvitation: db.prepare('DELETE FROM invitations WHERE project_id = ? AND email = ?'),
    doc: db.prepare('SELECT * FROM docs WHERE store = ? AND id = ?'),
    projectKnown: db.prepare(`SELECT 1 FROM docs WHERE project_id = ? UNION SELECT 1 FROM memberships WHERE project_id = ? LIMIT 1`),
    upsertDoc: db.prepare(`INSERT INTO docs (store, id, project_id, data, rev, deleted, seq, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (store, id) DO UPDATE SET data = excluded.data, rev = excluded.rev, deleted = excluded.deleted,
      seq = excluded.seq, updated_by = excluded.updated_by`),
    changesSince: db.prepare('SELECT * FROM docs WHERE project_id = ? AND seq > ? ORDER BY seq'),
    taskNumberTaken: db.prepare(`SELECT 1 FROM docs WHERE store = 'tasks' AND project_id = ? AND deleted = 0 AND id <> ?
      AND json_extract(data, '$.number') = ? LIMIT 1`),
    maxTaskNumber: db.prepare(`SELECT COALESCE(MAX(json_extract(data, '$.number')), 0) AS n FROM docs
      WHERE store = 'tasks' AND project_id = ? AND deleted = 0`),
    deleteProjectDocs: db.prepare(`DELETE FROM docs WHERE project_id = ? AND store <> 'projects'`),
    deleteProjectMemberships: db.prepare('DELETE FROM memberships WHERE project_id = ?'),
    deleteProjectInvitations: db.prepare('DELETE FROM invitations WHERE project_id = ?'),
    deleteOldSessions: db.prepare('DELETE FROM sessions WHERE last_seen < ?'),
  };

  return {
    db,
    q,
    nextSeq: () => ++seq,
    currentSeq: () => seq,
    transaction(fn) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const out = fn();
        db.exec('COMMIT');
        return out;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    close: () => db.close(),
  };
}
