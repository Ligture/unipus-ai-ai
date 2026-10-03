// Run against the project's already-open ChromeDriver session. No submission/navigation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../script.js'), 'utf8');
const session = JSON.parse(fs.readFileSync(path.join(__dirname, '../.asr-runtime/browser-control/session.json'), 'utf8'));
async function command(route, body) {
    const response = await fetch(`${session.baseUrl}/session/${session.sessionId}/${route}`, body ? {
        method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body),
    } : {});
    const {value} = await response.json();
    if (value?.error) throw new Error(JSON.stringify(value));
    return value;
}
async function main() {
    const handles = await command('window/handles');
    for (const handle of handles) {
        await command('window', {handle});
        if (await command('execute/sync', {script: 'return !!document.querySelector("#main-content")', args: []})) break;
    }
    await command('timeouts', {script: 30000});
    const start = source.indexOf('    function setNativeValue(');
    const end = source.indexOf('\n    }', source.indexOf('    async function autoFillAnswer(')) + 6;
    const functions = source.slice(start, end);
    const scraping = source.slice(source.indexOf('    function scrapeQuestions('), source.indexOf('    // --- API 调用函数 ---'));
    const script = `const done = arguments[arguments.length - 1];
        const QUESTION_CONTAINER_SELECTOR = '#main-content > div > div > div';
        ${functions}
        ${scraping}
        (async () => {
            if (!document.querySelector('.sequence-view')) {
                const fields = () => [...document.querySelectorAll('#main-content input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]), #main-content textarea')];
                const initial = fields().map(e => e.value);
                const target = fields().map((_, i) => 'Answer ' + i + ', with punctuation');
                try {
                    await autoFillAnswer({type:'FILL_IN_BLANK',answer:target});
                    const filled = fields().map(e => e.value);
                    if (fields().every(e=>e.tagName === 'TEXTAREA')) await autoFillAnswer({type:'OPEN_DISCUSSION',answer:target});
                    const discussed = fields().map(e => e.value);
                    await autoFillAnswer({type:'FILL_IN_BLANK',answer:initial});
                    done({mode:'text',target,filled,discussed,initial,restored:fields().map(e=>e.value),scraped:scrapeQuestions()});
                } catch(e) { done({error:e.message}); }
                return;
            }
            const items = () => [...document.querySelectorAll('.sortable-list-wrapper .sequence-reply-view-item-text')];
            const labels = () => items().map(e => e.querySelector('span').textContent.trim().replace(/[.．]$/, ''));
            const saved = () => {
                const node = document.querySelector('.sequence-view');
                let fiber = node[Object.keys(node).find(key => key.startsWith('__reactFiber'))];
                while (fiber && !fiber.stateNode?.onSortEnd) fiber = fiber.return;
                return fiber?.stateNode?.props.userAnswer.getAll().map(item=>item.value[0]);
            };
            const initial = labels();
            try {
                const target = [...initial].reverse();
                await autoFillAnswer({type: 'SEQUENCE', answer: target});
                const reordered = labels();
                const savedOrder = saved();
                await autoFillAnswer({type: 'SEQUENCE', answer: initial});
                const restored = labels();
                await autoFillAnswer({type: 'SEQUENCE', answer: initial});
                const savedIdentity = saved();
                let rejected = false;
                try { await autoFillAnswer({type:'SEQUENCE', answer:initial.map(()=>initial[0])}); } catch (_) { rejected = true; }
                const unchanged = labels();
                const input = document.createElement('input');
                const textarea = document.createElement('textarea');
                let inputs = 0;
                input.addEventListener('input', () => inputs++);
                setNativeValue(input, 'test'); setNativeValue(textarea, 'one,two');
                done({initial,target,reordered,savedOrder,savedIdentity,restored,rejected,unchanged,scraped:scrapeQuestions(),input:input.value,textarea:textarea.value,inputs});
            } catch(e) { done({error:e.message}); }
        })();`;
    const result = await command('execute/async', {script, args: []});
    assert.ok(!result.error, result.error);
    if (result.mode === 'text') {
        assert.deepEqual(result.filled, result.target);
        assert.deepEqual(result.discussed, result.target);
        assert.deepEqual(result.restored, result.initial);
        assert.match(result.scraped, /FILL_IN_BLANK/);
        console.log('PASS: live multi-question textareas, discussion arrays, punctuation, restoration, type detection');
        return;
    }
    assert.ok(result.initial.length > 1, 'Open an editable sequence question first');
    assert.deepEqual(result.reordered, result.target);
    assert.deepEqual(result.savedOrder, result.target);
    assert.deepEqual(result.savedIdentity, result.initial);
    assert.deepEqual(result.restored, result.initial);
    assert.equal(result.rejected, true);
    assert.deepEqual(result.unchanged, result.initial);
    assert.match(result.scraped, /SEQUENCE/);
    assert.match(result.scraped, /选项池/);
    assert.equal(result.input, 'test');
    assert.equal(result.textarea, 'one,two');
    assert.equal(result.inputs, 1);
    console.log('PASS: live sequence reorder, restoration, invalid-answer guard, structured scrape, native input/textarea events');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
