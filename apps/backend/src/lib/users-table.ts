import bcrypt from 'bcryptjs';
import { prisma } from './prisma';

export interface ReportPortalUser {
  id: string; // BIGINT from users table, cast to string
  login: string;
  email: string;
  name: string; // full_name ?? login
  avatar: string | null; // attachment column
  role: string;
  isActive: boolean;
  isExpired: boolean;
}

type RawUserRow = {
  id: bigint;
  login: string;
  email: string;
  full_name: string | null;
  attachment: string | null;
  role: string;
  active: boolean | null;
  expired: boolean;
};

function mapRow(row: RawUserRow): ReportPortalUser {
  return {
    id: String(row.id),
    login: row.login,
    email: row.email,
    name: row.full_name ?? row.login,
    avatar: row.attachment ?? null,
    role: row.role,
    isActive: row.active ?? false,
    isExpired: row.expired,
  };
}

export async function getUserByLogin(login: string): Promise<ReportPortalUser | null> {
  const rows = await prisma.$queryRawUnsafe<RawUserRow[]>(
    `SELECT id, login, email, full_name, attachment, role, active, expired
     FROM users
     WHERE login = $1
     LIMIT 1`,
    login,
  );
  if (!rows.length) return null;
  return mapRow(rows[0]!);
}

export async function getUserByEmail(email: string): Promise<ReportPortalUser | null> {
  const rows = await prisma.$queryRawUnsafe<RawUserRow[]>(
    `SELECT id, login, email, full_name, attachment, role, active, expired
     FROM users
     WHERE email = $1
     LIMIT 1`,
    email,
  );
  if (!rows.length) return null;
  return mapRow(rows[0]!);
}

/** Derive a unique login slug from an email address. */
async function uniqueLogin(email: string): Promise<string> {
  const base = email
    .split('@')[0]!
    .replace(/[^a-zA-Z0-9_.-]/g, '')
    .toLowerCase();
  let login = base;
  let n = 1;
  while (await getUserByLogin(login)) {
    login = `${base}${n++}`;
  }
  return login;
}

/**
 * Create a new user in the `users` table.
 * password is optional — omit for OAuth/Google users.
 * avatar is stored in the `attachment` column.
 * googleId is stored in `metadata` for future lookups.
 */
export async function createUser(data: {
  name: string;
  email: string;
  password?: string;
  avatar?: string;
  googleId?: string;
}): Promise<ReportPortalUser> {
  const hashedPassword = data.password ? await bcrypt.hash(data.password, 10) : null;
  const login = await uniqueLogin(data.email);
  const metadata = data.googleId ? JSON.stringify({ googleId: data.googleId }) : null;

  type InsertedRow = RawUserRow & { id: bigint };
  const rows = await prisma.$queryRawUnsafe<InsertedRow[]>(
    `INSERT INTO users (login, password, email, full_name, attachment, role, type, expired, metadata)
     VALUES ($1, $2, $3, $4, $5, 'USER', 'INTERNAL', false, $6::jsonb)
     RETURNING id, login, email, full_name, attachment, role, active, expired`,
    login,
    hashedPassword,
    data.email,
    data.name,
    data.avatar ?? null,
    metadata,
  );

  if (!rows.length) throw new Error('Failed to create user');
  return mapRow(rows[0]!);
}

/** Find a user whose metadata JSONB contains the given Google ID. */
export async function getUserByGoogleId(googleId: string): Promise<ReportPortalUser | null> {
  const rows = await prisma.$queryRawUnsafe<RawUserRow[]>(
    `SELECT id, login, email, full_name, attachment, role, active, expired
     FROM users
     WHERE metadata->>'googleId' = $1
     LIMIT 1`,
    googleId,
  );
  if (!rows.length) return null;
  return mapRow(rows[0]!);
}

export async function getUserById(id: string): Promise<ReportPortalUser | null> {
  const rows = await prisma.$queryRawUnsafe<RawUserRow[]>(
    `SELECT id, login, email, full_name, attachment, role, active, expired
     FROM users
     WHERE id = $1::bigint
     LIMIT 1`,
    id,
  );
  if (!rows.length) return null;
  return mapRow(rows[0]!);
}
