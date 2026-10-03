const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(require('node:path').join(__dirname, '../script.js'), 'utf8');
function setup(clipboard) {
    const toasts = [];
    const content = () => ({ style: {}, scrollHeight: 0 });
    const context = vm.createContext({
        document: {
            createElement: () => ({ addEventListener(name, handler) { this[name] = handler; } }),
            querySelector: () => content(),
        },
        GM_setClipboard: clipboard,
        showToast: (...args) => toasts.push(args),
        switchTab: () => {},
        transcribeContent: content(),
        llmContent: content(),
    });
    const buttonFunction = source.slice(source.indexOf('    function createCopyButton('), source.indexOf('    // Tab 切换逻辑'));
    const statusFunctions = source.slice(source.indexOf('    function updateStatus('), source.indexOf('    function showAnswerBox('));
    vm.runInContext(`let transcriptCopyText = ''; let answerCopyText = '';
        ${buttonFunction}
        const copyTranscriptButton = createCopyButton('复制转录', () => transcriptCopyText);
        const copyAnswerButton = createCopyButton('复制答案', () => answerCopyText);
        ${statusFunctions}
        globalThis.buttons = [copyTranscriptButton, copyAnswerButton];`, context);
    const click = (button) => button.click({ preventDefault() {}, stopPropagation() {} });
    return { context, toasts, click };
}

test('copies original transcript and answer even when page text is corrupted', async () => {
    const writes = [];
    const { context, click, toasts } = setup((text, type, done) => { writes.push([text, type]); done(); });
    assert.ok(context.buttons.every(button => button.disabled));
    context.result = '[00:01.000 → 00:02.000] 中文 & English\n第二行';
    vm.runInContext("updateStatus(result, 'success', result); transcribeContent.textContent = 'encrypted';", context);
    await click(context.buttons[0]);
    assert.deepEqual(writes[0], [context.result, 'text']);
    context.result = '{\n  "answer": ["A", "中文"]\n}';
    vm.runInContext("updateAnswerStatus(result, 'success'); llmContent.textContent = 'encrypted';", context);
    await click(context.buttons[1]);
    assert.deepEqual(writes[1], [context.result, 'text']);
    assert.equal(toasts.length, 2);
    vm.runInContext("updateStatus('处理中'); updateAnswerStatus('失败', 'error');", context);
    assert.ok(context.buttons.every(button => button.disabled));
    await click(context.buttons[0]);
    assert.equal(writes.length, 2);
    vm.runInContext("updateStatus('TTS录音完成', 'success');", context);
    assert.ok(context.buttons[0].disabled);
});

test('reports clipboard failures without false success and allows retry', async () => {
    for (const clipboard of [undefined, () => { throw new Error('denied'); }]) {
        const { context, click, toasts } = setup(clipboard);
        vm.runInContext("updateAnswerStatus('answer', 'success');", context);
        await click(context.buttons[1]);
        assert.equal(toasts[0][1], 'error');
        assert.match(toasts[0][0], /复制失败/);
        assert.equal(context.buttons[1].disabled, false);
    }
});

test('a result cleared during clipboard completion stays disabled', async () => {
    let complete;
    const { context, click } = setup((text, type, done) => { complete = done; });
    vm.runInContext("updateAnswerStatus('answer', 'success');", context);
    const pending = click(context.buttons[1]);
    assert.ok(context.buttons[1].disabled);
    vm.runInContext("updateAnswerStatus('正在重新生成');", context);
    complete();
    await pending;
    assert.ok(context.buttons[1].disabled);
});
