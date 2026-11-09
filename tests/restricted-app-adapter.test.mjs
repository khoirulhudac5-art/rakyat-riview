import test from 'node:test';
import assert from 'node:assert/strict';
import restrictedBuyer, { restrictedStatus, restrictedAdminReset, restrictedAdminUnsupported } from '../lib/restricted-app-adapter.mjs';
import { sessionCookie } from '../lib/admin-session.mjs';

const TARGET = 'https://svuagnobufhfpgzmsyxx.supabase.co';
const RUN = '11111111-2222-4333-8444-555555555555';
const CARD = 'T'.repeat(24);
const REVIEW = 'https://search.google.com/local/writereview?placeid=ChISyntheticPlace';
const ORIGIN = 'http://127.0.0.1:4189';
const response = () => ({ code: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(n) { this.code = n; return this; }, json(v) { this.data = v; return this; } });
const request = (action = 'cards', body, extra = {}) => ({
  method: body ? 'POST' : 'GET', query: { action }, body: body ? { ...body, action } : undefined,
  headers: { host: '127.0.0.1:4189', origin: ORIGIN, 'content-type': 'application/json', 'x-buyer-request': '1', 'sec-fetch-site': 'same-origin', cookie: 'rr_buyer_a=real-session-verified-by-auth', ...extra }
});
const call = async (req, handler = restrictedBuyer) => { const res = response(); await handler(req, res); return res; };
async function fixture(run) {
  const saved = { ...process.env }, oldFetch = globalThis.fetch;
  Object.assign(process.env, {
    BUYER_RESTRICTED_APP: 'true', RR_TEST_RUN_ID: RUN, BUYER_INTEGRATION_ENABLED: 'true',
    BUYER_LOCAL_HTTP: '1', BUYER_APP_ORIGIN: ORIGIN, SUPABASE_URL: TARGET,
    SUPABASE_PUBLISHABLE_KEY: 'test-only-public-key', SUPABASE_SECRET_KEY: 'test-only-server-key',
    ADMIN_SESSION_SECRET: 'test-only-admin-session-secret-32-characters'
  });
  delete process.env.RR_TEST_APP_WRITES;
  delete process.env.ADMIN_V2_RESET_ENABLED;
  const calls = [];
  let result = { success: true, cards: [] }, identity = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', identities: [{ provider: 'google' }] };
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options, body: options.body ? JSON.parse(options.body) : undefined });
    assert.ok(url === TARGET + '/auth/v1/user' || url === TARGET + '/rest/v1/rpc/buyer_test_action' || url === TARGET + '/rest/v1/rpc/admin_test_reset', 'only installed scoped RPCs and verified Auth may be used');
    return { ok: true, status: 200, json: async () => url.endsWith('/auth/v1/user') ? identity : result };
  };
  try { await run({ calls, result(value) { result = value; }, identity(value) { identity = value; } }); }
  finally {
    globalThis.fetch = oldFetch;
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

test('restricted adapter: disabled, foreign targets and non-loopback deployment always fail closed', async () => fixture(async ({ calls }) => {
  for (const [key, value] of [
    ['BUYER_RESTRICTED_APP', 'false'], ['RR_TEST_RUN_ID', 'not-a-run'], ['RR_TEST_RUN_ID', '00000000-0000-0000-0000-000000000000'],
    ['SUPABASE_URL', 'https://other.supabase.co'], ['SUPABASE_URL', TARGET + '/unexpected'], ['SUPABASE_URL', TARGET + '?redirect=other'],
    ['BUYER_APP_ORIGIN', 'https://production.example'], ['BUYER_APP_ORIGIN', 'http://192.168.1.10:4189'], ['BUYER_LOCAL_HTTP', '0'],
    ['SUPABASE_PUBLISHABLE_KEY', 'sb_secret_cannot-be-public']
  ]) {
    const old = process.env[key]; process.env[key] = value;
    assert.equal((await call(request())).code, 503, key); process.env[key] = old;
  }
  assert.equal((await call(request('cards', undefined, { host: 'production.example' }))).code, 503);
  assert.equal(calls.length, 0);
}));

test('restricted adapter: verify Google identity with Auth; missing, invalid, expired and non-Google sessions cannot reach RPCs', async () => fixture(async ({ calls, identity }) => {
  assert.equal((await call(request('cards', undefined, { cookie: '' }))).code, 401);
  assert.equal((await call(request('cards', undefined, { cookie: 'rr_buyer_a=one; rr_buyer_a=two' }))).code, 401);
  assert.equal(calls.length, 0);
  identity({ id: 'verified-email-user', identities: [{ provider: 'email' }] });
  assert.equal((await call(request())).code, 403);
  assert.equal(calls.length, 1);
  for (const status of [401, 403]) {
    globalThis.fetch = async url => { assert.equal(url, TARGET + '/auth/v1/user'); return { ok: false, status, json: async () => ({ message: 'expired or invalid token' }) }; };
    assert.equal((await call(request('cards', undefined, { cookie: 'rr_buyer_a=synthetic-session' }))).code, 401);
  }
}));

test('restricted adapter: list is scoped by verified JWT and database run; statistics remain explicitly unavailable', async () => fixture(async ({ calls, result }) => {
  result({ success: true, cards: [{ card_code: CARD, active: true, business_name: 'Fixture' }] });
  const listing = await call(request());
  assert.equal(listing.code, 200); assert.equal(listing.data.cards[0].card_code, CARD);
  assert.equal(listing.data.mode, 'restricted'); assert.equal(listing.data.statistics.available, false);
  assert.equal(listing.data.statistics.visits, null); assert.deepEqual(listing.data.statistics.series, []);
  assert.equal(calls[0].url, TARGET + '/auth/v1/user');
  assert.equal(calls[1].url, TARGET + '/rest/v1/rpc/buyer_test_action');
  assert.deepEqual(calls[1].body, { p_run: RUN, p_op: 'list' });
  assert.equal(calls[1].options.headers.Authorization, 'Bearer real-session-verified-by-auth');
  assert.equal(calls[1].options.headers.apikey, 'test-only-public-key');
  assert.ok(!JSON.stringify(listing.data).includes('test-only-server-key'));
  calls.length = 0;
  assert.equal((await call(request('statistics'))).data.statistics.redirects, null);
  assert.equal(calls.length, 1, 'unavailable statistics never call a nonexistent RPC');
}));

test('restricted adapter: only restricted status is exposed and requires a verified Google session', async () => fixture(async ({ calls, result }) => {
  result({ success: true, status: { code: CARD, activation_state: 'new_unowned', claim_allowed: true } });
  const req = request('status'); req.query.card = CARD;
  const status = await call(req, restrictedStatus);
  assert.equal(status.code, 200); assert.equal(status.data.code, CARD);
  assert.deepEqual(calls.at(-1).body, { p_run: RUN, p_op: 'status', p_card_code: CARD });
  const invalid = request('status'); invalid.query.card = 'V1';
  assert.equal((await call(invalid, restrictedStatus)).code, 400);
  assert.equal((await call({ ...req, method: 'POST' }, restrictedStatus)).code, 405);
  result({ success: false, code: 'test_denied' });
  assert.equal((await call(req, restrictedStatus)).code, 403);
}));

test('restricted adapter: mutations require separate opt-in, same-origin request and canonical review URL', async () => fixture(async ({ calls }) => {
  const fields = { card_code: CARD, business_name: 'Fixture', review_url: REVIEW };
  assert.equal((await call(request('first-claim', fields))).code, 503); assert.equal(calls.length, 0);
  process.env.RR_TEST_APP_WRITES = 'true';
  for (const patch of [{ origin: 'https://other.example' }, { 'x-buyer-request': '' }, { 'sec-fetch-site': 'cross-site' }, { 'content-type': 'text/plain' }]) {
    assert.equal((await call(request('first-claim', fields, patch))).code, 403);
  }
  assert.equal(calls.length, 0);
  for (const patch of [{ pin: null }, { activation_code: 'legacy' }, { card_code: 'V1' }, { review_url: 'https://maps.app.goo.gl/example' }, { review_url: REVIEW + '&extra=value' }, { business_name: ' ' }]) {
    assert.equal((await call(request('first-claim', { ...fields, ...patch }))).code, 400);
  }
  assert.equal(calls.filter(c => c.url.includes('/rpc/')).length, 0);
}));

test('restricted adapter: claim/update call wrappers only and cannot forge account, run or operation', async () => fixture(async ({ calls, result }) => {
  process.env.RR_TEST_APP_WRITES = 'true'; result({ success: true, code: 'claimed' });
  const fields = { card_code: CARD, business_name: '  Fixture  ', review_url: REVIEW, user_id: 'forged-user', p_run: 'forged-run', p_op: 'reset' };
  assert.equal((await call(request('first-claim', fields))).code, 200);
  assert.deepEqual(calls.at(-1).body, { p_run: RUN, p_op: 'claim', p_card_code: CARD, p_business_name: 'Fixture', p_review_url: REVIEW });
  assert.equal((await call(request('update', fields))).code, 200); assert.equal(calls.at(-1).body.p_op, 'update');
  for (const action of ['activate', 'claim', 'signup', 'signin', 'admin_reset_v2_activation']) assert.equal((await call(request(action, fields))).code, 400);
  for (const [payload, expected] of [[{ success: false, code: 'test_denied' }, 403], [{ success: false, code: 'already_claimed' }, 409], [{ success: false, code: 'not_ready' }, 409], [{ success: false, code: 'rate_limited' }, 429], [true, 502]]) {
    result(payload); const res = await call(request('first-claim', fields)); assert.equal(res.code, expected);
    if (expected === 429) assert.equal(res.headers['Retry-After'], '900');
  }
}));

test('restricted adapter: denied/closed wrappers and network failure never fall back to originals or mock data', async () => fixture(async ({ calls, result }) => {
  result({ success: false, code: 'test_denied' });
  const denied = await call(request()); assert.equal(denied.code, 403); assert.equal(denied.data.cards, undefined);
  globalThis.fetch = async url => {
    calls.push({ url });
    if (url.endsWith('/auth/v1/user')) return { ok: true, json: async () => ({ id: 'verified-google', identities: [{ provider: 'google' }] }) };
    throw Error('private network diagnostic');
  };
  const failure = await call(request()); assert.equal(failure.code, 502);
  assert.ok(!JSON.stringify(failure.data).includes('private network diagnostic')); assert.equal(failure.data.cards, undefined);
  assert.ok(calls.every(c => !/buyer_(list_cards|first_claim|update_card|public_card_status)$/.test(c.url)));
}));

test('restricted Admin reset: session, origin, explicit flags and confirmation/revision are required before wrapper invocation', async () => fixture(async ({ calls, result }) => {
  process.env.RR_TEST_APP_WRITES = 'true'; process.env.ADMIN_V2_RESET_ENABLED = 'true'; result(true);
  const fields = { card_code: CARD, confirmation: CARD, expected_revision: 2, acknowledged: true, reason: 'Documented synthetic reset request', actor: 'forged' };
  const req = request('reset', fields, { 'x-admin-request': '1' });
  assert.equal((await call(req, restrictedAdminReset)).code, 401);
  req.headers.cookie = sessionCookie().split(';')[0];
  for (const [key, value] of [['RR_TEST_APP_WRITES', 'false'], ['ADMIN_V2_RESET_ENABLED', 'false']]) {
    const old = process.env[key]; process.env[key] = value;
    assert.equal((await call(req, restrictedAdminReset)).code, 503); process.env[key] = old;
  }
  for (const patch of [{ confirmation: 'wrong' }, { acknowledged: false }, { expected_revision: -1 }, { expected_revision: 1e20 }, { reason: 'short' }, { card_code: 'V1' }]) {
    assert.equal((await call({ ...req, body: { ...req.body, ...patch } }, restrictedAdminReset)).code, 400);
  }
  for (const patch of [{ origin: 'https://other.example' }, { 'x-admin-request': '' }, { 'sec-fetch-site': 'cross-site' }, { 'content-type': 'text/plain' }]) {
    assert.equal((await call({ ...req, headers: { ...req.headers, ...patch } }, restrictedAdminReset)).code, 403);
  }
  assert.equal(calls.length, 0);
  const reset = await call(req, restrictedAdminReset); assert.equal(reset.code, 200);
  assert.equal(calls.length, 1); assert.equal(calls[0].url, TARGET + '/rest/v1/rpc/admin_test_reset');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-only-server-key');
  assert.equal(calls[0].body.p_run, RUN); assert.equal(calls[0].body.p_expected_revision, 2);
  assert.match(calls[0].body.p_actor, /^admin-session:[0-9a-f]{24}$/); assert.notEqual(calls[0].body.p_actor, 'forged');
  assert.equal(calls[0].body.p_reason, fields.reason); assert.ok(!JSON.stringify(reset.data).includes('test-only-server-key'));
  result(false); assert.equal((await call(req, restrictedAdminReset)).code, 409);
  calls.length = 0;
  assert.equal((await call(req, restrictedAdminUnsupported)).code, 503); assert.equal(calls.length, 0);
}));
