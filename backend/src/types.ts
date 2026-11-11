export interface Env {
  DB: D1Database;
  IMAGES: R2Bucket;
  AI: any;             // Cloudflare Workers AI binding (Llama 3.2 Vision + BGE-small)
  VECTORIZE: any;      // Cloudflare Vectorize binding (jewelry-embeddings index, 384-dim cosine)
  VECTORIZE_DINO?: any; // On-device DINOv2 vectors (jewelry-dinov2-384 index, 384-dim cosine) — separate feature
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
