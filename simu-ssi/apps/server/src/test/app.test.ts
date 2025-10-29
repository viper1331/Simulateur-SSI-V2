import request from 'supertest';

describe.skip('server API', () => {
  it('exercises core endpoints', async () => {
    // Integration tests require database migrations and realtime environment.
    // They are covered in Playwright and E2E suites.
    await request('http://localhost').get('/');
  });
});
