export interface Env {
  DB: D1Database;
  IMAGES: R2Bucket;
  OWNER_EMAIL: string;
  OWNER_PASSWORD: string;
  SESSION_SECRET?: string;
}

export interface AuthUser {
  id: string;
  username: string;
  role: 'owner' | 'staff';
}

export interface SessionData {
  userId: string;
  username: string;
  role: 'owner' | 'staff';
  sessionId: string;
}
