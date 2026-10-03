const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const source = fs.readFileSync(require('node:path').join(__dirname, '../script.js'), 'utf8');
const functions = source.slice(source.indexOf('    function transcriptText('), source.indexOf('    function sendToApi('));
const body = text => JSON.stringify({ transcription: [{ start: 0, end: 1, text }] });
function setup(store = new Map()) {
    const calls = [];
    const context = vm.createContext({
        console: { warn() {} },
        GM_getValue: (key, fallback) => structuredClone(store.get(key) ?? fallback),
        GM_setValue: (key, value) => store.set(key, structuredClone(value)),
        sendToApi: async (...args) => { calls.push(args); return { text: body('hello') }; },
    });
    vm.runInContext(`const TRANSCRIPT_CACHE_KEY='cache';
        const TRANSCRIPT_CACHE_TTL=7*86400*1000;
        const TRANSCRIPT_CACHE_LIMIT=100;
        const pendingTranscripts=new Map();
        let API_URL='server/audio', VIDEO_API_URL='server/video';
        let transcriptionCacheVersion='v1', endpointConfigReady=Promise.resolve();
        ${functions}`, context);
    return { context, store, calls, run: (url='a', audio=true, refresh=false) =>
        context.getTranscript(url, audio, refresh) };
}

test('A B A, reload, type, URL params, endpoint and version isolation', async () => {
    const s = setup();
    for (const url of ['a', 'b', 'a']) await s.run(url);
    assert.equal(s.calls.length, 2);
    const next = setup(s.store);
    assert.equal((await next.run()).cache, '前端');
    await next.run('a', false);
    await next.run('a?token=1');
    vm.runInContext("API_URL='other/audio'", next.context);
    await next.run();
    vm.runInContext("transcriptionCacheVersion='v2'", next.context);
    await next.run();
    assert.equal(next.calls.length, 4);
});

test('refresh bypasses cache and concurrent requests share a promise', async () => {
    const s = setup();
    await Promise.all([s.run(), s.run(), s.run()]);
    assert.equal(s.calls.length, 1);
    await s.run('a', true, true);
    assert.equal(s.calls.length, 2);
    assert.equal(s.calls[1][2], true);
    await Promise.all([s.run('b'), s.run('b', true, true)]);
    assert.equal(s.calls.length, 4);
});

test('waits for config and bypasses frontend cache when config fails', async () => {
    const s = setup();
    await s.run();
    let ready;
    s.context.configPromise = new Promise(resolve => { ready = resolve; });
    vm.runInContext('endpointConfigReady=configPromise; transcriptionCacheVersion=null', s.context);
    const pending = s.run();
    await Promise.resolve();
    assert.equal(s.calls.length, 1);
    ready();
    await pending;
    await s.run();
    assert.equal(s.calls.length, 3);
});

test('expiry, corruption, empty results and storage failures are recoverable', async () => {
    const s = setup();
    await s.run();
    const saved = s.store.get('cache');
    saved[0].created -= 8 * 86400 * 1000;
    saved.push(null, { key: 'broken', text: 'invalid' });
    await s.run();
    assert.equal(s.calls.length, 2);
    s.context.sendToApi = async () => ({ text: body(' ') });
    await s.run('empty');
    assert.equal(s.store.get('cache').length, 1);
    s.context.sendToApi = async () => { throw new Error('network'); };
    await assert.rejects(s.run('failure'), /network/);
    s.context.GM_getValue = () => { throw new Error('storage'); };
    s.context.GM_setValue = () => { throw new Error('storage'); };
    s.context.sendToApi = async () => ({ text: body('recovered') });
    assert.equal((await s.run()).text, body('recovered'));
});

test('LRU keeps a recently reused entry when capacity is reached', async () => {
    const s = setup();
    let clock = 1;
    vm.runInContext('Date.now = () => globalThis.clock', s.context);
    for (let i = 0; i < 100; i++) { s.context.clock = clock++; await s.run(String(i)); }
    s.context.clock = clock++;
    await s.run('0');
    s.context.clock = clock++;
    await s.run('100');
    assert.equal(s.store.get('cache').length, 100);
    assert.equal((await s.run('0')).cache, '前端');
    await s.run('1');
    assert.equal(s.calls.length, 102);
});

test('HTTP adapter sends refresh and recognizes backend cache headers', async () => {
    const s = setup();
    const adapter = source.slice(source.indexOf('    function sendToApi('), source.indexOf('    function sendToLlmApi('));
    let request;
    s.context.GM = { xmlHttpRequest: options => {
        request = options;
        options.onload({ status: 200, responseText: body('hello'), responseHeaders: 'X-Transcript-Cache: hit\r\n' });
    } };
    vm.runInContext(`const API_JSON_PAYLOAD_KEY='file_url'; ${adapter}`, s.context);
    const result = await s.context.sendToApi('a', true, true);
    assert.equal(result.cache, '后端');
    assert.deepEqual(JSON.parse(request.data), { file_url: 'a', force_refresh: true });
});
