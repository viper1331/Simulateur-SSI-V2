import type { NextFunction, Request, Response } from 'express';
import type { Socket } from 'socket.io';
import { createHash, timingSafeEqual } from 'node:crypto';

export const AUTH_ROLES = ['ADMIN', 'TRAINER', 'TRAINEE'] as const;
export type AuthRole = (typeof AUTH_ROLES)[number];

export interface AuthIdentity {
  role: AuthRole;
  tokenLabel: string;
}

export interface AuthTokenRecord {
  role: AuthRole;
  tokenHash: string;
  label: string;
}

export interface AuthConfig {
  enabled: boolean;
  tokens: AuthTokenRecord[];
}

export interface RequestLike {
  method: string;
  path: string;
  token?: string | null;
}

export type AuthDecision =
  | { ok: true; identity: AuthIdentity | null }
  | { ok: false; status: 401 | 403; error: 'AUTH_REQUIRED' | 'AUTH_FORBIDDEN' | 'AUTH_NOT_CONFIGURED' };

const ROLE_WEIGHT: Record<AuthRole, number> = {
  TRAINEE: 1,
  TRAINER: 2,
  ADMIN: 3,
};

const DEFAULT_READ_ROLES: AuthRole[] = ['ADMIN', 'TRAINER', 'TRAINEE'];
const TRAINER_ROLES: AuthRole[] = ['ADMIN', 'TRAINER'];
const ADMIN_ROLES: AuthRole[] = ['ADMIN'];

export function getAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const configuredTokens = parseTokenRecords(env.SIMU_SSI_API_TOKENS);
  const legacyAdminToken = env.SIMU_SSI_API_TOKEN?.trim();

  if (legacyAdminToken) {
    configuredTokens.push({
      role: 'ADMIN',
      tokenHash: hashToken(legacyAdminToken),
      label: 'SIMU_SSI_API_TOKEN',
    });
  }

  const authRequired = env.SIMU_SSI_AUTH_REQUIRED === 'true';
  return {
    enabled: authRequired || configuredTokens.length > 0,
    tokens: configuredTokens,
  };
}

export function parseTokenRecords(raw?: string): AuthTokenRecord[] {
  if (!raw?.trim()) {
    return [];
  }

  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .flatMap((entry, index) => {
      const [rawRole, ...tokenParts] = entry.split(':');
      const role = normalizeRole(rawRole);
      const token = tokenParts.join(':').trim();
      if (!role || !token) {
        return [];
      }
      return [
        {
          role,
          tokenHash: hashToken(token),
          label: `SIMU_SSI_API_TOKENS[${index}]`,
        },
      ];
    });
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function extractBearerToken(headerValue?: string | string[] | null): string | null {
  const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (!raw) {
    return null;
  }
  const trimmed = raw.trim();
  const match = /^Bearer\s+(.+)$/i.exec(trimmed);
  return match?.[1]?.trim() || null;
}

export function resolveTokenFromRequest(req: Pick<Request, 'headers'>): string | null {
  return extractBearerToken(req.headers.authorization) ?? resolveHeaderToken(req.headers['x-api-key']);
}

export function resolveTokenFromSocket(socket: Socket): string | null {
  const authToken = socket.handshake.auth?.token;
  if (typeof authToken === 'string' && authToken.trim()) {
    return authToken.trim();
  }
  const apiKey = socket.handshake.headers['x-api-key'];
  const bearer = extractBearerToken(socket.handshake.headers.authorization);
  return bearer ?? resolveHeaderToken(apiKey);
}

export function authorizeRequest(request: RequestLike, config: AuthConfig = getAuthConfig()): AuthDecision {
  if (!config.enabled) {
    return { ok: true, identity: null };
  }

  if (config.tokens.length === 0) {
    return { ok: false, status: 401, error: 'AUTH_NOT_CONFIGURED' };
  }

  const token = request.token?.trim();
  if (!token) {
    return { ok: false, status: 401, error: 'AUTH_REQUIRED' };
  }

  const identity = authenticateToken(token, config);
  if (!identity) {
    return { ok: false, status: 401, error: 'AUTH_REQUIRED' };
  }

  const allowedRoles = getAllowedRoles(request.method, request.path);
  if (!allowedRoles.some((role) => roleAllows(identity.role, role))) {
    return { ok: false, status: 403, error: 'AUTH_FORBIDDEN' };
  }

  return { ok: true, identity };
}

export function authenticateToken(token: string, config: AuthConfig = getAuthConfig()): AuthIdentity | null {
  const providedHash = hashToken(token.trim());
  for (const record of config.tokens) {
    if (constantTimeEqual(providedHash, record.tokenHash)) {
      return { role: record.role, tokenLabel: record.label };
    }
  }
  return null;
}

export function getAllowedRoles(method: string, path: string): AuthRole[] {
  const normalizedMethod = method.toUpperCase();
  const normalizedPath = normalizePath(path);

  if (normalizedPath === '/api/access/verify') {
    return DEFAULT_READ_ROLES;
  }

  if (normalizedPath.startsWith('/api/access/codes')) {
    return ADMIN_ROLES;
  }

  if (normalizedPath.startsWith('/api/users')) {
    return normalizedMethod === 'GET' ? TRAINER_ROLES : ADMIN_ROLES;
  }

  if (normalizedPath.startsWith('/api/config')) {
    return normalizedMethod === 'GET' ? TRAINER_ROLES : ADMIN_ROLES;
  }

  if (normalizedPath.startsWith('/api/topology')) {
    return normalizedMethod === 'GET' ? DEFAULT_READ_ROLES : TRAINER_ROLES;
  }

  if (normalizedPath.startsWith('/api/sessions')) {
    return normalizedMethod === 'GET' ? DEFAULT_READ_ROLES : TRAINER_ROLES;
  }

  if (normalizedPath.startsWith('/api/scenarios')) {
    return normalizedMethod === 'GET' ? DEFAULT_READ_ROLES : TRAINER_ROLES;
  }

  if (
    normalizedPath.startsWith('/api/evac') ||
    normalizedPath.startsWith('/api/process') ||
    normalizedPath.startsWith('/api/uga') ||
    normalizedPath.startsWith('/api/sdi') ||
    normalizedPath.startsWith('/api/devices') ||
    normalizedPath.startsWith('/api/zones') ||
    normalizedPath.startsWith('/api/system')
  ) {
    return TRAINER_ROLES;
  }

  return normalizedMethod === 'GET' ? DEFAULT_READ_ROLES : TRAINER_ROLES;
}

export function createApiAuthMiddleware(config: AuthConfig = getAuthConfig()) {
  return (req: Request, res: Response, next: NextFunction) => {
    const decision = authorizeRequest(
      {
        method: req.method,
        path: req.path,
        token: resolveTokenFromRequest(req),
      },
      config,
    );

    if (!decision.ok) {
      return res.status(decision.status).json({ error: decision.error });
    }

    res.locals.auth = decision.identity;
    return next();
  };
}

export function createSocketAuthMiddleware(config: AuthConfig = getAuthConfig()) {
  return (socket: Socket, next: (error?: Error) => void) => {
    const decision = authorizeRequest(
      {
        method: 'GET',
        path: '/socket.io',
        token: resolveTokenFromSocket(socket),
      },
      config,
    );

    if (!decision.ok) {
      const error = new Error(decision.error);
      error.name = decision.error;
      return next(error);
    }

    socket.data.auth = decision.identity;
    return next();
  };
}

function resolveHeaderToken(headerValue?: string | string[] | null): string | null {
  const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  return raw?.trim() || null;
}

function normalizeRole(value?: string): AuthRole | null {
  const normalized = value?.trim().toUpperCase();
  return AUTH_ROLES.includes(normalized as AuthRole) ? (normalized as AuthRole) : null;
}

function roleAllows(actual: AuthRole, required: AuthRole): boolean {
  return ROLE_WEIGHT[actual] >= ROLE_WEIGHT[required];
}

function normalizePath(path: string): string {
  const [withoutQuery] = path.split('?');
  return withoutQuery.replace(/\/+$/, '') || '/';
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}
