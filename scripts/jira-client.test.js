#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const {
  REQUEST_TIMEOUT_MS,
  TRANSITION_PAGE_LIMIT,
  EXIT_PARTIAL_UNKNOWN,
  apiRequest,
  buildCommentConfirmation,
  buildCommentPayload,
  buildCreateConfirmation,
  buildCreatePayload,
  buildTransitionConfirmation,
  normalizeIssueKey,
  normalizeSite,
  parseArgs,
  run,
  serializePayload,
} = require('./jira-client');

const BASE_ENV = Object.freeze({
  JIRA_SITE: 'Example-Tenant.atlassian.net',
  JIRA_EMAIL: 'api@example.org',
  JIRA_API_TOKEN: 'synthetic-token',
  JIRA_SERVICE_DESK_ID: '12',
  JIRA_REQUEST_TYPE_ID: '34',
});

function requestJson({
  issueKey = 'HELP-123',
  issueId = '10001',
  status = 'Open',
  epochMillis = 1000,
} = {}) {
  return {
    issueKey,
    issueId,
    currentStatus: {
      status,
      statusDate: { epochMillis },
    },
  };
}

function createdRequestJson({
  issueKey = 'HELP-123',
  issueId = '10001',
  serviceDeskId = '12',
  requestTypeId = '34',
  summary = 'Test',
  description = 'Description',
} = {}) {
  return {
    issueKey,
    issueId,
    serviceDeskId,
    requestTypeId,
    requestFieldValues: [
      { fieldId: 'summary', value: summary },
      { fieldId: 'description', value: description },
    ],
  };
}

function transitionPage(values, { start = 0, isLastPage = true, limit = TRANSITION_PAGE_LIMIT } = {}) {
  return {
    status: 200,
    json: {
      start,
      limit,
      size: values.length,
      isLastPage,
      values,
    },
  };
}

function queuedFetch(responses) {
  const calls = [];
  return {
    calls,
    fetch: async (cfg, method, apiPath, payload) => {
      calls.push({ cfg: { ...cfg }, method, apiPath, payload });
      if (!responses.length) throw new Error('Unexpected network call');
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return typeof next === 'function' ? next(calls.at(-1)) : next;
    },
    remaining: () => responses.length,
  };
}

async function invoke(argv, {
  env = BASE_ENV,
  fetch = async () => { throw new Error('Network tripwire fired'); },
  getCredentials,
} = {}) {
  const stdout = [];
  const stderr = [];
  let credentialCalls = 0;
  const credentialProvider = getCredentials || (() => {
    credentialCalls += 1;
    return { email: env.JIRA_EMAIL, token: env.JIRA_API_TOKEN };
  });
  const code = await run(argv, env, {
    fetch,
    getCredentials: async (...args) => {
      if (getCredentials) credentialCalls += 1;
      return credentialProvider(...args);
    },
    out: (message) => stdout.push(String(message)),
    err: (message) => stderr.push(String(message)),
  });
  return {
    code,
    stdout: stdout.join('\n'),
    stderr: stderr.join('\n'),
    credentialCalls,
  };
}

test('site validation accepts and canonicalizes one Atlassian tenant label', () => {
  assert.equal(normalizeSite('Example-1.atlassian.net'), 'example-1.atlassian.net');
  assert.equal(normalizeSite('a.atlassian.net'), 'a.atlassian.net');
});

test('site validation rejects schemes, paths, ports, userinfo, suffix tricks, and controls', () => {
  const invalid = [
    '',
    'atlassian.net',
    'https://example.atlassian.net',
    'example.atlassian.net/path',
    'example.atlassian.net:443',
    'user' + '@' + 'example.atlassian.net',
    'example.atlassian.net.',
    'example.atlassian.net.evil.invalid',
    'sub.example.atlassian.net',
    '127.0.0.1',
    'localhost',
    ' example.atlassian.net',
    'example.atlassian.net\n',
    '-example.atlassian.net',
    'example-.atlassian.net',
  ];
  for (const value of invalid) assert.throws(() => normalizeSite(value), /JIRA_SITE/);
});

test('direct apiRequest validates the destination before invoking the transport', () => {
  let transportCalls = 0;
  assert.throws(() => apiRequest(
    { site: 'https://evil.invalid', email: 'api@example.org', token: 'token' },
    'GET',
    '/rest/servicedeskapi/request/HELP-123',
    null,
    { request: () => { transportCalls += 1; } }
  ), /JIRA_SITE/);
  assert.equal(transportCalls, 0);
});

test('argument parser requires --confirm VALUE while execute/public remain bare booleans', () => {
  const parsed = parseArgs(['comment', '--issue', 'HELP-123', '--body', 'x', '--public', '--execute', '--confirm', 'EXACT VALUE']);
  assert.equal(parsed.public, true);
  assert.equal(parsed.execute, true);
  assert.equal(parsed.confirm, 'EXACT VALUE');
  assert.throws(() => parseArgs(['create', '--confirm']), /requires a value/);
  assert.throws(() => parseArgs(['create', '--confirm=anything']), /separate arguments/);
  assert.throws(() => parseArgs(['create', '--execute', 'false']), /accepts no value/);
  assert.throws(() => parseArgs(['comment', '--public', 'false']), /accepts no value/);
});

test('argument parser rejects duplicate, malformed, and unknown flags', () => {
  assert.throws(() => parseArgs(['get', '--execute', '--execute']), /Duplicate flag/);
  assert.throws(() => parseArgs(['get', '---execute']), /Malformed flag/);
  assert.throws(() => parseArgs(['get', '--unsafe']), /Unknown flag/);
});

test('issue keys are normalized but paths and placeholder text are rejected', () => {
  assert.equal(normalizeIssueKey('help-123'), 'HELP-123');
  for (const invalid of ['[JIRA-###]', 'HELP-0', 'HELP/123', ' HELP-123', 'HELP-123\n']) {
    assert.throws(() => normalizeIssueKey(invalid), /--issue/);
  }
});

test('create payload is exact, numeric-id-bound, and deterministically serialized', () => {
  const payload = buildCreatePayload({
    serviceDeskId: 12,
    requestTypeId: 34,
    summary: 'Mailbox full',
    description: 'User [UPN] is over quota',
    raiseOnBehalfOf: 'account-id',
  });
  assert.deepEqual(payload, {
    serviceDeskId: '12',
    requestTypeId: '34',
    requestFieldValues: {
      summary: 'Mailbox full',
      description: 'User [UPN] is over quota',
    },
    raiseOnBehalfOf: 'account-id',
  });
  assert.equal(serializePayload(payload), JSON.stringify(payload));
  assert.throws(() => buildCreatePayload({ serviceDeskId: 'all', requestTypeId: '34', summary: 'x' }), /numeric id/);
});

test('create confirmation contains a full SHA-256 and changes with every material field', () => {
  const base = buildCreatePayload({ serviceDeskId: '12', requestTypeId: '34', summary: 'A', description: 'B' });
  const confirmation = buildCreateConfirmation('example.atlassian.net', base);
  assert.match(confirmation, /^CREATE JSM REQUEST ON example\.atlassian\.net DESK 12 TYPE 34 PAYLOAD SHA256 [0-9a-f]{64}$/);
  const variants = [
    buildCreatePayload({ serviceDeskId: '13', requestTypeId: '34', summary: 'A', description: 'B' }),
    buildCreatePayload({ serviceDeskId: '12', requestTypeId: '35', summary: 'A', description: 'B' }),
    buildCreatePayload({ serviceDeskId: '12', requestTypeId: '34', summary: 'changed', description: 'B' }),
    buildCreatePayload({ serviceDeskId: '12', requestTypeId: '34', summary: 'A', description: 'changed' }),
    buildCreatePayload({ serviceDeskId: '12', requestTypeId: '34', summary: 'A', description: 'B', raiseOnBehalfOf: 'reporter' }),
  ];
  for (const variant of variants) assert.notEqual(buildCreateConfirmation('example.atlassian.net', variant), confirmation);
  assert.notEqual(buildCreateConfirmation('other.atlassian.net', base), confirmation);
});

test('create dry run and missing/wrong confirmations use zero credentials and zero network', async () => {
  const payload = buildCreatePayload({ serviceDeskId: '12', requestTypeId: '34', summary: 'Test', description: 'Description' });
  const exact = buildCreateConfirmation('example-tenant.atlassian.net', payload);
  const base = ['create', '--summary', 'Test', '--description', 'Description'];
  const cases = [
    base,
    [...base, '--execute'],
    [...base, '--execute', '--confirm', 'wrong'],
    [...base, '--execute', '--confirm', exact.toLowerCase()],
    [...base, '--execute', '--confirm', ` ${exact}`],
    [...base, '--execute', '--confirm', `${exact} `],
  ];
  for (const argv of cases) {
    let fetchCalls = 0;
    const result = await invoke(argv, {
      fetch: async () => { fetchCalls += 1; throw new Error('network'); },
      getCredentials: () => { throw new Error('credentials loaded before gate'); },
    });
    assert.equal(fetchCalls, 0);
    assert.equal(result.credentialCalls, 0);
    if (argv.includes('--execute')) assert.equal(result.code, 1);
    else {
      assert.equal(result.code, 0);
      assert.match(result.stdout, new RegExp(exact));
    }
  }
});

test('exact create confirmation sends one bound POST then verifies identity, type, and fields by GET', async () => {
  const payload = buildCreatePayload({ serviceDeskId: '12', requestTypeId: '34', summary: 'Test', description: 'Description' });
  const exact = buildCreateConfirmation('example-tenant.atlassian.net', payload);
  const queue = queuedFetch([
    { status: 201, json: { issueKey: 'HELP-123', issueId: '10001' } },
    { status: 200, json: createdRequestJson() },
  ]);
  const result = await invoke([
    'create', '--summary', 'Test', '--description', 'Description', '--execute', '--confirm', exact,
  ], { fetch: queue.fetch });
  assert.equal(result.code, 0);
  assert.equal(result.credentialCalls, 1);
  assert.equal(queue.calls.length, 2);
  assert.equal(queue.calls[0].method, 'POST');
  assert.equal(queue.calls[0].apiPath, '/rest/servicedeskapi/request');
  assert.deepEqual(queue.calls[0].payload, payload);
  assert.equal(queue.calls[0].cfg.site, 'example-tenant.atlassian.net');
  assert.equal(queue.calls[1].method, 'GET');
  assert.equal(queue.calls[1].apiPath, '/rest/servicedeskapi/request/HELP-123');
  assert.match(result.stdout, /independent GET read-back verified/);
});

test('create receipt/read-back failure or mismatch is partial/unknown and is never retried', async t => {
  const payload = buildCreatePayload({ serviceDeskId: '12', requestTypeId: '34', summary: 'Test', description: 'Description' });
  const exact = buildCreateConfirmation('example-tenant.atlassian.net', payload);
  const cases = [
    [{ status: 201, json: { issueKey: 'HELP-123' } }],
    [{ status: 201, json: { issueKey: 'HELP-123', issueId: '10001' } }, { status: 503, json: null }],
    [{ status: 201, json: { issueKey: 'HELP-123', issueId: '10001' } }, { status: 200, json: createdRequestJson({ requestTypeId: '35' }) }],
    [{ status: 201, json: { issueKey: 'HELP-123', issueId: '10001' } }, { status: 200, json: createdRequestJson({ summary: 'drifted' }) }],
  ];
  for (const [index, responses] of cases.entries()) {
    await t.test(`case ${index + 1}`, async () => {
      const queue = queuedFetch(responses);
      const result = await invoke([
        'create', '--summary', 'Test', '--description', 'Description', '--execute', '--confirm', exact,
      ], { fetch: queue.fetch });
      assert.equal(result.code, EXIT_PARTIAL_UNKNOWN);
      assert.equal(queue.calls.filter(call => call.method === 'POST').length, 1);
      assert.ok(queue.calls.length <= 2);
      assert.match(result.stderr, /UNKNOWN\/possibly changed/);
    });
  }
});

test('invalid create destination fails before credentials/network and is not echoed', async () => {
  const env = { ...BASE_ENV, JIRA_SITE: 'https://attacker.invalid/path', JIRA_API_TOKEN: 'do-not-echo' };
  let fetchCalls = 0;
  const result = await invoke(['create', '--summary', 'Test'], {
    env,
    fetch: async () => { fetchCalls += 1; },
    getCredentials: () => { throw new Error('credentials should not load'); },
  });
  assert.equal(result.code, 1);
  assert.equal(fetchCalls, 0);
  assert.equal(result.credentialCalls, 0);
  assert.doesNotMatch(result.stderr, /attacker|do-not-echo/);
});

test('comment confirmations bind issue, visibility, site, and full payload digest', () => {
  const internal = buildCommentPayload({ body: 'note' });
  const publicPayload = buildCommentPayload({ body: 'note', isPublic: true });
  const internalPhrase = buildCommentConfirmation('example.atlassian.net', 'HELP-123', internal);
  const publicPhrase = buildCommentConfirmation('example.atlassian.net', 'HELP-123', publicPayload);
  assert.match(internalPhrase, /^POST INTERNAL JSM COMMENT ON example\.atlassian\.net ISSUE HELP-123 PAYLOAD SHA256 [0-9a-f]{64}$/);
  assert.match(publicPhrase, /^POST PUBLIC JSM COMMENT ON example\.atlassian\.net ISSUE HELP-123 PAYLOAD SHA256 [0-9a-f]{64}$/);
  assert.notEqual(publicPhrase, internalPhrase);
  assert.notEqual(buildCommentConfirmation('example.atlassian.net', 'HELP-124', internal), internalPhrase);
  assert.notEqual(buildCommentConfirmation('other.atlassian.net', 'HELP-123', internal), internalPhrase);
  assert.notEqual(buildCommentConfirmation('example.atlassian.net', 'HELP-123', buildCommentPayload({ body: 'changed' })), internalPhrase);
});

test('comment missing/wrong confirmation is inert for both INTERNAL and PUBLIC modes', async () => {
  for (const publicFlag of [[], ['--public']]) {
    for (const confirm of [[], ['--confirm', 'wrong']]) {
      let fetchCalls = 0;
      const result = await invoke([
        'comment', '--issue', 'HELP-123', '--body', 'note', ...publicFlag, '--execute', ...confirm,
      ], {
        fetch: async () => { fetchCalls += 1; },
        getCredentials: () => { throw new Error('credentials should not load'); },
      });
      assert.equal(result.code, 1);
      assert.equal(result.credentialCalls, 0);
      assert.equal(fetchCalls, 0);
    }
  }
});

test('exact INTERNAL and PUBLIC confirmations send the requested visibility only', async () => {
  for (const isPublic of [false, true]) {
    const payload = buildCommentPayload({ body: 'note', isPublic });
    const exact = buildCommentConfirmation('example-tenant.atlassian.net', 'HELP-123', payload);
    const receipt = { id: '7001', body: 'note', public: isPublic };
    const queue = queuedFetch([
      { status: 201, json: receipt },
      { status: 200, json: receipt },
    ]);
    const result = await invoke([
      'comment', '--issue', 'HELP-123', '--body', 'note', ...(isPublic ? ['--public'] : []),
      '--execute', '--confirm', exact,
    ], { fetch: queue.fetch });
    assert.equal(result.code, 0);
    assert.equal(queue.calls.length, 2);
    assert.equal(queue.calls[0].apiPath, '/rest/servicedeskapi/request/HELP-123/comment');
    assert.deepEqual(queue.calls[0].payload, payload);
    assert.equal(queue.calls[1].method, 'GET');
    assert.equal(queue.calls[1].apiPath, '/rest/servicedeskapi/request/HELP-123/comment/7001');
    assert.match(result.stdout, /verified by independent GET read-back/);
  }
});

test('comment receipt/read-back failure or mismatch is partial/unknown and is never retried', async t => {
  const payload = buildCommentPayload({ body: 'note' });
  const exact = buildCommentConfirmation('example-tenant.atlassian.net', 'HELP-123', payload);
  const cases = [
    [{ status: 201, json: {} }],
    [{ status: 201, json: { id: '7001' } }, { status: 503, json: null }],
    [{ status: 201, json: { id: '7001' } }, { status: 200, json: { id: '7001', body: 'drifted', public: false } }],
    [{ status: 201, json: { id: '7001' } }, { status: 200, json: { id: '7001', body: 'note', public: true } }],
  ];
  for (const [index, responses] of cases.entries()) {
    await t.test(`case ${index + 1}`, async () => {
      const queue = queuedFetch(responses);
      const result = await invoke([
        'comment', '--issue', 'HELP-123', '--body', 'note', '--execute', '--confirm', exact,
      ], { fetch: queue.fetch });
      assert.equal(result.code, EXIT_PARTIAL_UNKNOWN);
      assert.equal(queue.calls.filter(call => call.method === 'POST').length, 1);
      assert.ok(queue.calls.length <= 2);
      assert.match(result.stderr, /UNKNOWN\/possibly changed/);
    });
  }
});

test('an attempted comment with a non-201 result is partial/unknown and is never retried', async () => {
  const payload = buildCommentPayload({ body: 'note' });
  const exact = buildCommentConfirmation('example-tenant.atlassian.net', 'HELP-123', payload);
  const queue = queuedFetch([{ status: 503, body: 'withheld', json: null }]);
  const result = await invoke([
    'comment', '--issue', 'HELP-123', '--body', 'note', '--execute', '--confirm', exact,
  ], { fetch: queue.fetch });
  assert.equal(result.code, EXIT_PARTIAL_UNKNOWN);
  assert.equal(queue.calls.length, 1);
  assert.doesNotMatch(result.stdout + result.stderr, /withheld/);
});

test('transition local preview calls neither credentials nor Jira', async () => {
  let fetchCalls = 0;
  const result = await invoke(['transition', '--issue', 'HELP-123', '--to', 'Resolve'], {
    fetch: async () => { fetchCalls += 1; },
    getCredentials: () => { throw new Error('credentials should not load'); },
  });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /No API call was made/);
  assert.equal(result.credentialCalls, 0);
  assert.equal(fetchCalls, 0);
});

test('transition --execute performs paginated read-only preflight and prints immutable confirmation', async () => {
  const queue = queuedFetch([
    { status: 200, json: requestJson() },
    transitionPage([{ id: '10', name: 'Escalate' }], { start: 0, isLastPage: false }),
    transitionPage([{ id: '20', name: 'Resolve' }], { start: 1, isLastPage: true }),
  ]);
  const result = await invoke([
    'transition', '--issue', 'HELP-123', '--to', 'Resolve', '--execute',
  ], { fetch: queue.fetch });
  const expected = buildTransitionConfirmation(
    'example-tenant.atlassian.net',
    { issueKey: 'HELP-123', issueId: '10001', currentStatus: 'Open', statusVersion: '1000' },
    { id: '20', name: 'Resolve' }
  );
  assert.equal(result.code, 0);
  assert.match(result.stdout, new RegExp(expected));
  assert.equal(queue.calls.length, 3);
  assert.deepEqual(queue.calls.map((call) => call.method), ['GET', 'GET', 'GET']);
  assert.match(queue.calls[1].apiPath, /start=0&limit=50$/);
  assert.match(queue.calls[2].apiPath, /start=1&limit=50$/);
});

test('wrong transition confirmation performs only the necessary read preflight and no POST', async () => {
  const queue = queuedFetch([
    { status: 200, json: requestJson() },
    transitionPage([{ id: '20', name: 'Resolve' }]),
  ]);
  const result = await invoke([
    'transition', '--issue', 'HELP-123', '--to', 'Resolve', '--execute', '--confirm', 'wrong',
  ], { fetch: queue.fetch });
  assert.equal(result.code, 1);
  assert.deepEqual(queue.calls.map((call) => call.method), ['GET', 'GET']);
});

test('transition preflight rejects duplicate names, duplicate ids, no match, and malformed pagination without POST', async (t) => {
  const cases = [
    {
      name: 'duplicate selected names',
      responses: [
        { status: 200, json: requestJson() },
        transitionPage([{ id: '1', name: 'Resolve' }, { id: '2', name: 'resolve' }]),
      ],
      to: 'Resolve',
    },
    {
      name: 'duplicate ids across pages',
      responses: [
        { status: 200, json: requestJson() },
        transitionPage([{ id: '1', name: 'One' }], { isLastPage: false }),
        transitionPage([{ id: '1', name: 'Two' }], { start: 1 }),
      ],
      to: '1',
    },
    {
      name: 'no match',
      responses: [
        { status: 200, json: requestJson() },
        transitionPage([{ id: '1', name: 'Escalate' }]),
      ],
      to: 'Resolve',
    },
    {
      name: 'non-progressing page',
      responses: [
        { status: 200, json: requestJson() },
        transitionPage([], { isLastPage: false }),
      ],
      to: 'Resolve',
    },
    {
      name: 'wrong page start',
      responses: [
        { status: 200, json: requestJson() },
        transitionPage([{ id: '1', name: 'Resolve' }], { start: 4 }),
      ],
      to: 'Resolve',
    },
    {
      name: 'missing current-state version',
      responses: [
        {
          status: 200,
          json: { issueKey: 'HELP-123', issueId: '10001', currentStatus: { status: 'Open' } },
        },
      ],
      to: 'Resolve',
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const queue = queuedFetch([...entry.responses]);
      const result = await invoke([
        'transition', '--issue', 'HELP-123', '--to', entry.to, '--execute',
      ], { fetch: queue.fetch });
      assert.equal(result.code, 2);
      assert.equal(queue.calls.some((call) => call.method === 'POST'), false);
    });
  }
});

test('exact transition repeats preflight, POSTs once, and verifies changed state by immutable id', async () => {
  const before = requestJson();
  const after = requestJson({ status: 'Resolved', epochMillis: 2000 });
  const transition = { id: '20', name: 'Resolve' };
  const exact = buildTransitionConfirmation(
    'example-tenant.atlassian.net',
    { issueKey: 'HELP-123', issueId: '10001', currentStatus: 'Open', statusVersion: '1000' },
    transition
  );
  const queue = queuedFetch([
    { status: 200, json: before }, transitionPage([transition]),
    { status: 200, json: before }, transitionPage([transition]),
    { status: 204, json: null },
    { status: 200, json: after },
  ]);
  const result = await invoke([
    'transition', '--issue', 'HELP-123', '--to', 'Resolve', '--execute', '--confirm', exact,
  ], { fetch: queue.fetch });
  assert.equal(result.code, 0);
  assert.deepEqual(queue.calls.map((call) => call.method), ['GET', 'GET', 'GET', 'GET', 'POST', 'GET']);
  assert.deepEqual(queue.calls[4].payload, { id: '20' });
  assert.match(result.stdout, /Transition verified/);
  assert.equal(queue.remaining(), 0);
});

test('state drift between repeated preflights invalidates an otherwise exact phrase and makes zero POSTs', async () => {
  const transition = { id: '20', name: 'Resolve' };
  const exact = buildTransitionConfirmation(
    'example-tenant.atlassian.net',
    { issueKey: 'HELP-123', issueId: '10001', currentStatus: 'Open', statusVersion: '1000' },
    transition
  );
  const queue = queuedFetch([
    { status: 200, json: requestJson({ epochMillis: 1000 }) }, transitionPage([transition]),
    { status: 200, json: requestJson({ epochMillis: 1001 }) }, transitionPage([transition]),
  ]);
  const result = await invoke([
    'transition', '--issue', 'HELP-123', '--to', 'Resolve', '--execute', '--confirm', exact,
  ], { fetch: queue.fetch });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /drift/i);
  assert.equal(queue.calls.some((call) => call.method === 'POST'), false);
});

test('POST acceptance followed by unchanged state reports partial/unknown and never retries', async () => {
  const transition = { id: '20', name: 'Resolve' };
  const exact = buildTransitionConfirmation(
    'example-tenant.atlassian.net',
    { issueKey: 'HELP-123', issueId: '10001', currentStatus: 'Open', statusVersion: '1000' },
    transition
  );
  const before = requestJson();
  const queue = queuedFetch([
    { status: 200, json: before }, transitionPage([transition]),
    { status: 200, json: before }, transitionPage([transition]),
    { status: 204, json: null },
    { status: 200, json: before },
  ]);
  const result = await invoke([
    'transition', '--issue', 'HELP-123', '--to', 'Resolve', '--execute', '--confirm', exact,
  ], { fetch: queue.fetch });
  assert.equal(result.code, EXIT_PARTIAL_UNKNOWN);
  assert.match(result.stderr, /UNKNOWN\/possibly changed/);
  assert.deepEqual(queue.calls.map((call) => call.method), ['GET', 'GET', 'GET', 'GET', 'POST', 'GET']);
});

test('POST transport ambiguity and read-back failure both report partial/unknown without retry', async (t) => {
  const transition = { id: '20', name: 'Resolve' };
  const exact = buildTransitionConfirmation(
    'example-tenant.atlassian.net',
    { issueKey: 'HELP-123', issueId: '10001', currentStatus: 'Open', statusVersion: '1000' },
    transition
  );
  const prefix = [
    { status: 200, json: requestJson() }, transitionPage([transition]),
    { status: 200, json: requestJson() }, transitionPage([transition]),
  ];

  await t.test('POST transport error', async () => {
    const queue = queuedFetch([...prefix, new Error('ambiguous transport result')]);
    const result = await invoke([
      'transition', '--issue', 'HELP-123', '--to', 'Resolve', '--execute', '--confirm', exact,
    ], { fetch: queue.fetch });
    assert.equal(result.code, EXIT_PARTIAL_UNKNOWN);
    assert.deepEqual(queue.calls.map((call) => call.method), ['GET', 'GET', 'GET', 'GET', 'POST']);
  });

  await t.test('read-back failure', async () => {
    const queue = queuedFetch([...prefix, { status: 204, json: null }, { status: 503, json: null }]);
    const result = await invoke([
      'transition', '--issue', 'HELP-123', '--to', 'Resolve', '--execute', '--confirm', exact,
    ], { fetch: queue.fetch });
    assert.equal(result.code, EXIT_PARTIAL_UNKNOWN);
    assert.deepEqual(queue.calls.map((call) => call.method), ['GET', 'GET', 'GET', 'GET', 'POST', 'GET']);
  });
});

test('API failures with bodies fail closed and never disclose response content', async () => {
  const sensitive = 'synthetic-sensitive-response';
  const queue = queuedFetch([{ status: 302, body: sensitive, json: null }]);
  const result = await invoke(['get', '--issue', 'HELP-123', '--execute'], { fetch: queue.fetch });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /HTTP 302/);
  assert.doesNotMatch(result.stdout, new RegExp(sensitive));
  assert.doesNotMatch(result.stderr, new RegExp(sensitive));
});

test('apiRequest timeout is finite, destroys the request, and rejects', async () => {
  assert.ok(Number.isFinite(REQUEST_TIMEOUT_MS) && REQUEST_TIMEOUT_MS > 0);
  let destroyed = false;
  let transportCalls = 0;
  const request = () => {
    transportCalls += 1;
    const emitter = new EventEmitter();
    emitter.write = () => {};
    emitter.end = () => {};
    emitter.destroy = (error) => {
      destroyed = true;
      if (error) emitter.emit('error', error);
    };
    return emitter;
  };
  await assert.rejects(apiRequest(
    { site: 'example.atlassian.net', email: 'api@example.org', token: 'token' },
    'GET',
    '/rest/servicedeskapi/request/HELP-123',
    null,
    { timeoutMs: 10, request }
  ), /timed out after 10ms/);
  assert.equal(transportCalls, 1);
  assert.equal(destroyed, true);
});
