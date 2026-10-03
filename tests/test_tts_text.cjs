const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const source = fs.readFileSync(require('node:path').join(__dirname, '../script.js'), 'utf8');
const ttsFunctions = source.slice(source.indexOf('    // --- TTS 相关函数 ---'), source.indexOf('    function downloadAudioBlob('));

function setup(status = 200) {
    const requests = [];
    const context = vm.createContext({
        TTS_API_URL: 'http://localhost/api/tts/generate', ttsLengthScale: 1.1,
        GM: { xmlHttpRequest(options) {
            requests.push(JSON.parse(options.data));
            options.onload({ status, responseText: JSON.stringify({ audio_url: '/audio.wav' }) });
        } },
    });
    vm.runInContext(ttsFunctions, context);
    return { context, requests };
}

test('TTS payload excludes leading question numbers across multiple lines', async () => {
    const { context, requests } = setup();
    for (const [text, expected] of [
        ['1. Hello.\n2. How are you?\n3. Goodbye.', 'Hello.\nHow are you?\nGoodbye.'],
        ['  1.Hello.', 'Hello.'],
        ['1.\nHello.', 'Hello.'],
        ['2) Good morning.', 'Good morning.'],
        ['（３） Good evening.', 'Good evening.'],
        ['4、Good night.', 'Good night.'],
        ['５． Hello.', 'Hello.'],
    ]) {
        await context.sendToTTSApi(text, 0.8);
        assert.equal(requests.at(-1).text, expected);
        assert.equal(requests.at(-1).length_scale, 0.8);
    }
});

test('spoken numbers, decimals, dates and numbers inside sentences are preserved', async () => {
    const { context, requests } = setup();
    for (const text of ['I have 2 apples and 3.5 liters.', '3.14 is pi.',
        '2026.10.03 is a date.', '1 in 3 people agree.', 'Call 123.',
        'There are steps 1. 2. 3. in this exercise.']) {
        await context.sendToTTSApi(text);
        assert.equal(requests.at(-1).text, text);
    }
});

test('empty numbered text is rejected before issuing a TTS request', async () => {
    const { context, requests } = setup();
    await assert.rejects(context.sendToTTSApi('1.\n2.\n3.'), /文本为空/);
    assert.equal(requests.length, 0);
});

test('repeat, LLM free response and video dubbing all sanitize the real TTS payload', async () => {
    // Fail synthesis after capturing the real request so no microphone is used.
    const { context, requests } = setup(500);
    context.showToast = () => {};
    context.updateStatus = () => {};
    const repeat = { querySelector: () => ({ innerText: '1. Repeat this sentence.' }) };
    const free = { querySelector: () => ({ innerText: '2. What do you like?' }) };
    context.document = { querySelectorAll: selector => selector === '.oral-study-sentence' ? [repeat] : [free, free] };
    context.sendToLlmOnlyTextApi = async () => JSON.stringify({ answer: { answer: '3. I like reading.' } });
    context.sendToLlmOnlyApi = context.sendToLlmOnlyTextApi;
    const recording = source.slice(source.indexOf('    async function autoTTSRecord('), source.indexOf('    // --- 媒体URL抓取函数 ---') === -1
        ? source.indexOf('    // --- 主执行函数 ---') : source.indexOf('    // --- 媒体URL抓取函数 ---'));
    vm.runInContext(recording, context);
    const group = { querySelector: () => null };
    await context.autoTTSRecord(0, group);
    await context.autoTTSRecord(1, group);
    await context.autoDubRecord(0, { querySelector: () => ({ innerText: '4. Dub this sentence.' }) });
    assert.deepEqual(requests.map(r => r.text), ['Repeat this sentence.', 'I like reading.', 'Dub this sentence.']);
});
