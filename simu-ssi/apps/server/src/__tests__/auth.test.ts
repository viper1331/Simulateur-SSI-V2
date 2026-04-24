import {
  authenticateToken,
  authorizeRequest,
  extractBearerToken,
  getAllowedRoles,
  getAuthConfig,
  hashToken,
  parseTokenRecords,
  type AuthConfig,
} from '../auth';

const config: AuthConfig = {
  enabled: true,
  tokens: [
    { role: 'ADMIN', tokenHash: hashToken('admin-token'), label: 'admin' },
    { role: 'TRAINER', tokenHash: hashToken('trainer-token'), label: 'trainer' },
    { role: 'TRAINEE', tokenHash: hashToken('trainee-token'), label: 'trainee' },
  ],
};

describe('API auth foundation', () => {
  it('keeps auth disabled when no token is configured and auth is not required', () => {
    expect(getAuthConfig({}).enabled).toBe(false);
  });

  it('enables auth when a legacy admin token is configured', () => {
    const authConfig = getAuthConfig({ SIMU_SSI_API_TOKEN: 'secret' });
    expect(authConfig.enabled).toBe(true);
    expect(authConfig.tokens).toHaveLength(1);
    expect(authenticateToken('secret', authConfig)?.role).toBe('ADMIN');
  });

  it('parses multiple role-scoped API tokens', () => {
    const records = parseTokenRecords('ADMIN:admin-token,TRAINER:trainer-token,TRAINEE:trainee-token');
    expect(records.map((record) => record.role)).toEqual(['ADMIN', 'TRAINER', 'TRAINEE']);
    expect(records.every((record) => record.tokenHash.length === 64)).toBe(true);
  });

  it('extracts bearer tokens from Authorization headers', () => {
    expect(extractBearerToken('Bearer abc123')).toBe('abc123');
    expect(extractBearerToken('bearer token-value')).toBe('token-value');
    expect(extractBearerToken('Basic abc123')).toBeNull();
  });

  it('allows admin tokens on every protected API scope', () => {
    const decision = authorizeRequest(
      { method: 'PUT', path: '/api/access/codes/2', token: 'admin-token' },
      config,
    );
    expect(decision.ok).toBe(true);
  });

  it('blocks trainer tokens from admin-only access-code management', () => {
    const decision = authorizeRequest(
      { method: 'PUT', path: '/api/access/codes/2', token: 'trainer-token' },
      config,
    );
    expect(decision).toEqual({ ok: false, status: 403, error: 'AUTH_FORBIDDEN' });
  });

  it('allows trainer tokens to operate simulation endpoints', () => {
    const decision = authorizeRequest(
      { method: 'POST', path: '/api/evac/manual/start', token: 'trainer-token' },
      config,
    );
    expect(decision.ok).toBe(true);
  });

  it('blocks trainee tokens from simulation command endpoints', () => {
    const decision = authorizeRequest(
      { method: 'POST', path: '/api/system/reset', token: 'trainee-token' },
      config,
    );
    expect(decision).toEqual({ ok: false, status: 403, error: 'AUTH_FORBIDDEN' });
  });

  it('allows trainee tokens on read-only session endpoints', () => {
    const decision = authorizeRequest(
      { method: 'GET', path: '/api/sessions/active', token: 'trainee-token' },
      config,
    );
    expect(decision.ok).toBe(true);
  });

  it('requires a token when auth is enabled', () => {
    const decision = authorizeRequest({ method: 'GET', path: '/api/sessions', token: null }, config);
    expect(decision).toEqual({ ok: false, status: 401, error: 'AUTH_REQUIRED' });
  });

  it('documents role mapping for critical routes', () => {
    expect(getAllowedRoles('GET', '/api/sessions')).toEqual(['ADMIN', 'TRAINER', 'TRAINEE']);
    expect(getAllowedRoles('POST', '/api/sessions')).toEqual(['ADMIN', 'TRAINER']);
    expect(getAllowedRoles('PUT', '/api/config/site')).toEqual(['ADMIN']);
    expect(getAllowedRoles('PUT', '/api/access/codes/2')).toEqual(['ADMIN']);
  });
});
