// ==UserScript==
// @name         音频转录并获取答案 (v2.4 - 带时间轴/锚定/可配置API)
// @namespace    http://tampermonkey.net/
// @version      2.4
// @description  转录/获取答案 (带听力)/获取答案 (不带听力)。转录结果带时间轴, 自动锚定工具栏, 带API配置。
// @author       lpmon (modified by Gemini)
// @match        *://ucontent.unipus.cn/*
// @include      *://ucontent.unipus.cn/*
// @grant        GM.xmlHttpRequest
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// ==/UserScript==

(function () {
    'use strict';

    // --- (新增) API 动态配置与存储 ---
    const API_STORAGE_KEY = 'http://127.0.0.1:28955';
    let API_BASE_URL = GM_getValue(API_STORAGE_KEY, 'http://127.0.0.1:28955');

    const ENDPOINT_TRANSCRIBE = '/dtranscribe/';
    const ENDPOINT_VIDEO = '/transcribe_from_video/';
    const ENDPOINT_LLM = '/get_answers/';
    const ENDPOINT_LLM_ONLY = '/get_answers_only/';

    let API_URL = API_BASE_URL + ENDPOINT_TRANSCRIBE;
    let VIDEO_API_URL = API_BASE_URL + ENDPOINT_VIDEO;
    let LLM_API_URL = API_BASE_URL + ENDPOINT_LLM;
    let LLM_ONLY_API_URL = API_BASE_URL + ENDPOINT_LLM_ONLY;

    // --- 必填配置 (媒体源XPath, 多路径回退增强稳定性) ---
    const AUDIO_XPATHS = [
        '//audio[contains(@class, "unipus-audio")]/@src',
        '//*[@id="main-content"]//audio/@src',
        '//audio/@src',
        '//audio/source/@src',
        '//audio[contains(@class, "unipus-audio")]/@title' // 应对Unipus将地址放置在title属性的情况
    ];
    const VIDEO_XPATHS = [
        '//video[contains(@id, "vjs_video") or contains(@class, "vjs-tech")]/source/@src',
        '//video[contains(@id, "vjs_video") or contains(@class, "vjs-tech")]/@src',
        '//*[@id="main-content"]//video/source/@src',
        '//*[@id="main-content"]//video/@src',
        '//video/source/@src',
        '//video/@src'
    ];
    const API_JSON_PAYLOAD_KEY = 'file_url';
    const LLM_ANSWER_KEY = 'answer';
    const QUESTION_CONTAINER_SELECTOR = '#main-content > div > div > div';


    // --- API 更新函数 ---
    function updateApiUrls(newBaseUrl) {
        if (newBaseUrl.endsWith('/')) {
            newBaseUrl = newBaseUrl.slice(0, -1);
        }
        API_BASE_URL = newBaseUrl;
        API_URL = API_BASE_URL + ENDPOINT_TRANSCRIBE;
        VIDEO_API_URL = API_BASE_URL + ENDPOINT_VIDEO;
        LLM_API_URL = API_BASE_URL + ENDPOINT_LLM;
        LLM_ONLY_API_URL = API_BASE_URL + ENDPOINT_LLM_ONLY;
        GM_setValue(API_STORAGE_KEY, API_BASE_URL);
        alert(`API 基础地址已更新为: ${API_BASE_URL}`);
        console.log(`API URLs updated: \n${API_URL}\n${VIDEO_API_URL}\n${LLM_API_URL}\n${LLM_ONLY_API_URL}`);
    }

    // --- 脚本全局变量 ---
    let currentTranscript = ""; // 存储转录文本 (纯文本, 用于 LLM)

    // --- 构建全新 UI 结构 (现代化窗口) ---
    const appWindow = document.createElement('div');
    appWindow.id = 'gemini-app-window';
    appWindow.setAttribute('data-theme', 'apple'); // 默认 Apple 主题

    // 1. Header (拖拽手柄 + 主题切换 + 最小化)
    const header = document.createElement('div');
    header.id = 'gemini-header';
    
    const titleBar = document.createElement('div');
    titleBar.className = 'gemini-title';
    titleBar.innerHTML = '🤖 Unipus Assistant';

    const themeSelect = document.createElement('select');
    themeSelect.id = 'gemini-theme-select';
    themeSelect.innerHTML = `
        <option value="apple">Apple Style</option>
        <option value="native">Web Native</option>
        <option value="bw">Black & White</option>
        <option value="cyan">Cyan Fresh</option>
    `;
    themeSelect.addEventListener('change', (e) => {
        appWindow.setAttribute('data-theme', e.target.value);
    });

    const minimizeBtn = document.createElement('button');
    minimizeBtn.id = 'gemini-minimize-btn';
    minimizeBtn.innerHTML = '—';
    let isMinimized = false;
    minimizeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        isMinimized = !isMinimized;
        appWindow.classList.toggle('minimized', isMinimized);
        minimizeBtn.innerHTML = isMinimized ? '+' : '—';
    });

    header.appendChild(titleBar);
    header.appendChild(themeSelect);
    header.appendChild(minimizeBtn);

    // 2. Action Bar (按钮区)
    const actionBar = document.createElement('div');
    actionBar.id = 'gemini-actions';

    const triggerButton = document.createElement('button');
    triggerButton.className = 'gemini-btn gemini-btn-primary';
    triggerButton.innerHTML = '🎙️ 转录';
    triggerButton.addEventListener('click', runTranscription);

    const llmButton = document.createElement('button');
    llmButton.className = 'gemini-btn gemini-btn-success';
    llmButton.innerHTML = '🤖 答案(带听力)';
    llmButton.addEventListener('click', getAnswersWithTranscript);
    llmButton.style.display = 'none';

    const llmOnlyButton = document.createElement('button');
    llmOnlyButton.className = 'gemini-btn gemini-btn-warning';
    llmOnlyButton.innerHTML = '📝 答案(仅题目)';
    llmOnlyButton.addEventListener('click', getAnswersOnly);

    actionBar.appendChild(triggerButton);
    actionBar.appendChild(llmButton);
    actionBar.appendChild(llmOnlyButton);

    // 3. 内容区 (日志区)
    const contentArea = document.createElement('div');
    contentArea.id = 'gemini-content';

    const transcribeLogWrapper = document.createElement('div');
    transcribeLogWrapper.className = 'gemini-log-wrapper';
    const transcribeLogTitle = document.createElement('div');
    transcribeLogTitle.className = 'gemini-log-title';
    transcribeLogTitle.innerText = '转录结果';
    const transcribeContentArea = document.createElement('div');
    transcribeContentArea.id = 'gemini-transcribe-log';
    transcribeLogWrapper.appendChild(transcribeLogTitle);
    transcribeLogWrapper.appendChild(transcribeContentArea);

    const llmLogWrapper = document.createElement('div');
    llmLogWrapper.className = 'gemini-log-wrapper';
    const llmLogTitle = document.createElement('div');
    llmLogTitle.className = 'gemini-log-title';
    llmLogTitle.innerText = 'LLM 答案';
    const llmContentArea = document.createElement('div');
    llmContentArea.id = 'gemini-llm-log';
    llmLogWrapper.appendChild(llmLogTitle);
    llmLogWrapper.appendChild(llmContentArea);

    contentArea.appendChild(transcribeLogWrapper);
    contentArea.appendChild(llmLogWrapper);

    // 4. API 配置区 (底部)
    const footerArea = document.createElement('div');
    footerArea.id = 'gemini-footer';
    
    const apiLabel = document.createElement('span');
    apiLabel.innerText = 'API URL:';
    const apiInput = document.createElement('input');
    apiInput.type = 'text';
    apiInput.id = 'gemini-api-input';
    apiInput.value = API_BASE_URL;
    
    const apiSaveBtn = document.createElement('button');
    apiSaveBtn.className = 'gemini-btn gemini-btn-sm';
    apiSaveBtn.innerText = '保存';
    apiSaveBtn.addEventListener('click', () => {
        const val = apiInput.value.trim();
        if (val && val !== API_BASE_URL) {
            updateApiUrls(val);
        }
    });

    footerArea.appendChild(apiLabel);
    footerArea.appendChild(apiInput);
    footerArea.appendChild(apiSaveBtn);

    // 5. 缩放手柄 (右下角)
    const resizeHandle = document.createElement('div');
    resizeHandle.id = 'gemini-resizer';
    
    // 组装并挂载
    appWindow.appendChild(header);
    appWindow.appendChild(actionBar);
    appWindow.appendChild(contentArea);
    appWindow.appendChild(footerArea);
    appWindow.appendChild(resizeHandle);
    document.body.appendChild(appWindow);

    // --- 现代化样式定义 ---
    GM_addStyle(`
        :root {
            /* 主题变量占位, 靠 [data-theme] 覆盖生效 */
        }
        
        #gemini-app-window[data-theme="apple"] {
            --bg: rgba(255, 255, 255, 0.7);
            --border: 1px solid rgba(255, 255, 255, 0.5);
            --text: #1d1d1f;
            --radius: 16px;
            --shadow: 0 10px 40px rgba(0, 0, 0, 0.1), inset 0 0 0 1px rgba(255,255,255,0.4);
            --backdrop: blur(20px) saturate(180%);
            --header-bg: rgba(255, 255, 255, 0.5);
            --btn-radius: 8px;
            --log-bg: rgba(255, 255, 255, 0.6);
            --primary: #0071e3; --success: #34c759; --warning: #ff9f0a;
            --btn-text: #fff;
        }

        #gemini-app-window[data-theme="native"] {
            --bg: #f9f9f9; --border: 1px solid #ccc; --text: #333;
            --radius: 4px; --shadow: 0 4px 10px rgba(0,0,0,0.1);
            --backdrop: none; --header-bg: #e0e0e0;
            --btn-radius: 4px; --log-bg: #fff;
            --primary: #007bff; --success: #28a745; --warning: #ffc107;
            --btn-text: #fff;
        }

        #gemini-app-window[data-theme="bw"] {
            --bg: #fff; --border: 2px solid #000; --text: #000;
            --radius: 0px; --shadow: 8px 8px 0px rgba(0,0,0,1);
            --backdrop: none; --header-bg: #fff;
            --btn-radius: 0px; --log-bg: #fff;
            --primary: #000; --success: #000; --warning: #555;
            --btn-text: #fff;
        }

        #gemini-app-window[data-theme="cyan"] {
            --bg: rgba(240, 255, 255, 0.95); --border: 1px solid #00bcd4; --text: #006064;
            --radius: 12px; --shadow: 0 4px 20px rgba(0,188,212,0.3);
            --backdrop: blur(10px); --header-bg: rgba(224, 247, 250, 0.8);
            --btn-radius: 20px; --log-bg: rgba(255,255,255,0.8);
            --primary: #00bcd4; --success: #4caf50; --warning: #ffb300;
            --btn-text: #fff;
        }

        /* 结构样式 */
        #gemini-app-window {
            position: fixed;
            bottom: 30px; left: 30px;
            width: 380px; height: 500px;
            min-width: 250px; min-height: 200px;
            background: var(--bg);
            border: var(--border);
            border-radius: var(--radius);
            box-shadow: var(--shadow);
            backdrop-filter: var(--backdrop);
            -webkit-backdrop-filter: var(--backdrop);
            z-index: 2147483647;
            display: flex; flex-direction: column;
            color: var(--text);
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            box-sizing: border-box;
            /* 禁用默认的动画效果防止拖拽卡顿 */
        }

        #gemini-app-window.minimized {
            height: 45px !important;
            min-height: 45px !important;
            overflow: hidden;
            resize: none !important;
        }

        #gemini-header {
            display: flex; align-items: center; justify-content: space-between;
            padding: 10px 15px;
            background: var(--header-bg);
            border-bottom: var(--border);
            border-radius: var(--radius) var(--radius) 0 0;
            cursor: move;
            user-select: none;
            flex-shrink: 0;
        }

        .gemini-title { font-weight: 600; font-size: 14px; }

        #gemini-theme-select {
            margin-left: auto; margin-right: 15px;
            padding: 2px 8px; font-size: 12px;
            border-radius: 4px; border: 1px solid #ccc;
            outline: none; background: #fff; color: #333;
        }

        #gemini-minimize-btn {
            background: transparent; border: none; font-size: 18px; font-weight: bold;
            color: var(--text); cursor: pointer; padding: 0 5px; line-height: 1;
        }

        #gemini-actions {
            display: flex; gap: 8px; padding: 12px 15px;
            border-bottom: var(--border); flex-wrap: wrap; flex-shrink: 0;
        }

        .gemini-btn {
            padding: 8px 14px; font-size: 13px; font-weight: 500;
            color: var(--btn-text); border: none;
            border-radius: var(--btn-radius);
            cursor: pointer; transition: opacity 0.2s, transform 0.1s;
        }
        .gemini-btn:hover { opacity: 0.85; }
        .gemini-btn:active { transform: scale(0.96); }
        .gemini-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        
        .gemini-btn-primary { background: var(--primary); }
        .gemini-btn-success { background: var(--success); }
        .gemini-btn-warning { background: var(--warning); color: #000; }
        .gemini-btn-sm { padding: 5px 12px; font-size: 12px; background: var(--primary); }
        #gemini-app-window[data-theme="native"] .gemini-btn-warning { color: #212529; }
        #gemini-app-window[data-theme="bw"] .gemini-btn-warning { color: #fff; }

        #gemini-content {
            flex-grow: 1; display: flex; flex-direction: column;
            padding: 12px 15px; gap: 12px; overflow-y: auto;
        }

        .gemini-log-wrapper {
            display: flex; flex-direction: column; flex-grow: 1; min-height: 100px;
        }

        .gemini-log-title {
            font-size: 12px; font-weight: bold; margin-bottom: 6px; opacity: 0.8;
            letter-spacing: 0.5px;
        }

        #gemini-transcribe-log, #gemini-llm-log {
            flex-grow: 1;
            background: var(--log-bg); border: var(--border); border-radius: var(--btn-radius);
            padding: 10px; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px;
            line-height: 1.5; overflow-y: auto; white-space: pre-wrap;
            box-shadow: inset 0 1px 3px rgba(0,0,0,0.05); user-select: text; cursor: text;
        }

        #gemini-footer {
            display: flex; align-items: center; padding: 10px 15px;
            background: var(--header-bg); border-top: var(--border);
            border-radius: 0 0 var(--radius) var(--radius);
            font-size: 12px; flex-shrink: 0;
        }

        #gemini-api-input {
            margin: 0 8px; flex-grow: 1; padding: 5px 8px;
            border: 1px solid #ccc; border-radius: 4px; outline: none; font-family: monospace;
            background: #fff; color: #333;
        }

        #gemini-resizer {
            position: absolute; bottom: 0; right: 0;
            width: 15px; height: 15px; cursor: nwse-resize;
            background: linear-gradient(135deg, transparent 50%, rgba(0,0,0,0.15) 50%);
            border-bottom-right-radius: var(--radius);
            z-index: 10;
        }
    \`);

// --- (关键修改) 主执行函数 (转录) ---
    async function runTranscription() {
        triggerButton.disabled = true;
        triggerButton.innerHTML = '🎙️ 转录中...';
        updateStatus('开始转录...', 'loading');

        llmButton.style.display = 'none';
        answerBox.style.display = 'none';
        currentTranscript = ""; // (纯文本)
        let formattedTranscript = ""; // (带时间轴的文本)

        try {
            updateStatus('1. 正在通过XPath查找媒体链接...');
            let xpathResult = null;
            let is_audio = false; // 默认先假设有视频

            // 1. 优先查找是否存在视频
            for (let xpath of VIDEO_XPATHS) {
                xpathResult = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                if (xpathResult && xpathResult.singleNodeValue && xpathResult.singleNodeValue.textContent.trim()) break;
            }

            // 2. 如果没找到视频，再查找音频
            if (!xpathResult || !xpathResult.singleNodeValue || !xpathResult.singleNodeValue.textContent.trim()) {
                is_audio = true;
                for (let xpath of AUDIO_XPATHS) {
                    xpathResult = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                    if (xpathResult && xpathResult.singleNodeValue && xpathResult.singleNodeValue.textContent.trim()) break;
                }
                
                // 3. 全都没找到则报错
                if (!xpathResult || !xpathResult.singleNodeValue || !xpathResult.singleNodeValue.textContent.trim()) {
                    throw new Error(`XPath 未找到包含有效链接的媒体元素。\nAudio XPaths: ${AUDIO_XPATHS.join(', ')}\nVideo XPaths: ${VIDEO_XPATHS.join(', ')}`);
                }
            }
            let audioUrl = xpathResult.singleNodeValue.textContent;
            let absoluteAudioUrl = new URL(audioUrl, window.location.href).href;
            updateStatus(`2. 找到链接: ${absoluteAudioUrl.substring(0, 100)}...`);

            updateStatus('3. 正在发送音频链接到 API...');
            const apiResponseText = await sendToApi(absoluteAudioUrl, is_audio);
            updateStatus('4. API 响应已收到。正在解析...');

            let responseJson;
            try { responseJson = JSON.parse(apiResponseText); } catch (e) {
                // API 返回的不是 JSON, 可能是纯文本
                currentTranscript = apiResponseText;
                formattedTranscript = apiResponseText; // 显示的文本也设为这个
                console.log('API 返回的不是 JSON，作为纯文本处理。');
            }

            // (修改) 检查 JSON 格式是否符合预期
            if (responseJson && responseJson.transcription && Array.isArray(responseJson.transcription)) {

                // (新增) 辅助函数：格式化时间 (秒 -> HH:MM:SS.ms)
                const formatTime = (seconds) => {
                    if (typeof seconds !== 'number' || seconds < 0) {
                        return '??:??.??';
                    }
                    const h = Math.floor(seconds / 3600);
                    const m = Math.floor((seconds % 3600) / 60);
                    const s = Math.floor(seconds % 60);
                    const ms = Math.floor((seconds - Math.floor(seconds)) * 1000);

                    const pad = (num, length = 2) => String(num).padStart(length, '0');

                    let timeStr = `${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
                    if (h > 0) {
                        timeStr = `${pad(h)}:${timeStr}`;
                    }
                    return timeStr;
                };

                // 1. (修改) 生成带时间轴的 (用于显示)
                formattedTranscript = responseJson.transcription.map(s => {
                    if (s && typeof s.text !== 'undefined') {
                        // 假设 JSON 格式为 { start: 1.23, end: 4.56, text: "..." }
                        // (我假设您给的 "start": segment.end 是笔误)
                        const startTime = formatTime(s.start);
                        const endTime = formatTime(s.end);
                        return `[${startTime} -> ${endTime}] ${s.text.trim()}`;
                    }
                    return '';
                }).join('\n'); // (修改) 用换行符连接

                // 2. (保留) 生成纯文本 (用于 LLM)
                currentTranscript = responseJson.transcription.map(s => s.text ? s.text.trim() : '').join(' ');

            } else if (apiResponseText && !formattedTranscript) {
                // API 返回的是 JSON 但格式不认识, 或者是纯文本 (已在 catch 中处理)
                currentTranscript = apiResponseText;
                formattedTranscript = apiResponseText;
            }

            if (formattedTranscript) {
                // (修改) 显示带时间轴的
                updateStatus(`转录成功:\n\n${formattedTranscript}`, 'success');
                llmButton.style.display = 'inline-block';
            } else {
                updateStatus('转录成功，但未返回任何文本内容。', 'success');
            }
        } catch (error) {
            console.error('音频转录脚本出错:', error);
            updateStatus(`错误:\n${error.message}`, 'error');
        } finally {
            triggerButton.disabled = false;
            triggerButton.innerHTML = '🎙️ 重新转录';
        }
    }

    // 8. 主执行函数 (获取答案 - 带听力)
    async function getAnswersWithTranscript() {
        llmButton.disabled = true;
        llmButton.innerHTML = '🤖 思考中...';
        showAnswerBox('正在准备数据 (带听力)...', 'loading');

        try {
            updateAnswerStatus('1. 正在抓取题目...');
            const questionsText = scrapeQuestions();

            if (!currentTranscript) { // (注意：这里使用的是纯文本的 currentTranscript)
                throw new Error('听力文本 (currentTranscript) 为空。请先运行“开始转录”。');
            }
            updateAnswerStatus('2. 听力文本已就绪。正在发送到 LLM API...');

            const llmResponseText = await sendToLlmApi(questionsText, currentTranscript);
            updateAnswerStatus('3. LLM API 响应已收到。正在解析...');

            let responseJson;
            try { responseJson = JSON.parse(llmResponseText); } catch (e) {
                throw new Error(`LLM API 返回的不是有效的 JSON：\n${llmResponseText.substring(0, 200)}...`);
            }
            const answerData = responseJson[LLM_ANSWER_KEY];
            if (typeof answerData === 'undefined') {
                throw new Error(`无法在 LLM JSON 响应中找到键 "${LLM_ANSWER_KEY}"。`);
            }

            const displayText = typeof answerData === 'object' ? JSON.stringify(answerData, null, 2) : answerData;
            updateAnswerStatus(`LLM 答案 (带听力)：\n\n${displayText}`, 'success');

            // --- 新增: 自动填充执行 ---
            autoFillAnswer(answerData);

        } catch (error) {
            console.error('获取答案(带听力)脚本出错:', error);
            updateAnswerStatus(`错误:\n${error.message}`, 'error');
        } finally {
            llmButton.disabled = false;
            llmButton.innerHTML = '🤖 重新获取 (带听力)';
        }
    }

    // 9. 主执行函数 (获取答案 - 仅题目)
    async function getAnswersOnly() {
        llmOnlyButton.disabled = true;
        llmOnlyButton.innerHTML = '📝 思考中...';
        showAnswerBox('正在准备数据 (仅题目)...', 'loading');

        try {
            updateAnswerStatus('1. 正在抓取题目...');
            const questionsText = scrapeQuestions();
            updateAnswerStatus('2. 题目已抓取。正在发送到 LLM API (仅题目)...');

            const llmResponseText = await sendToLlmOnlyApi(questionsText);
            updateAnswerStatus('3. LLM API 响应已收到。正在解析...');

            let responseJson;
            try { responseJson = JSON.parse(llmResponseText); } catch (e) {
                throw new Error(`LLM API 返回的不是有效的 JSON：\n${llmResponseText.substring(0, 200)}...`);
            }

            const answerData = responseJson[LLM_ANSWER_KEY];
            if (typeof answerData === 'undefined') {
                throw new Error(`无法在 LLM JSON 响应中找到键 "${LLM_ANSWER_KEY}"。`);
            }
            const displayText = typeof answerData === 'object' ? JSON.stringify(answerData, null, 2) : answerData;
            updateAnswerStatus(`LLM 答案 (仅题目)：\n\n${displayText}`, 'success');

            // --- 新增: 自动填充执行 ---
            autoFillAnswer(answerData);

        } catch (error) {
            console.error('获取答案(仅题目)脚本出错:', error);
            updateAnswerStatus(`错误:\n${error.message}`, 'error');
        } finally {
            llmOnlyButton.disabled = false;
            llmOnlyButton.innerHTML = '📝 重新获取 (仅题目)';
        }
    }

    // --- 辅助函数 ---

    function updateStatus(message, type = 'loading') {
        const color = type === 'error' ? '#d93025' : (type === 'success' ? '#188038' : 'inherit');
        transcribeContentArea.style.color = color;
        transcribeContentArea.innerText = message;
        transcribeContentArea.scrollTop = transcribeContentArea.scrollHeight;
    }

    function updateAnswerStatus(message, type = 'loading') {
        const color = type === 'error' ? '#d93025' : (type === 'success' ? '#1a73e8' : 'inherit');
        llmContentArea.style.color = color;
        llmContentArea.innerText = message;
        llmContentArea.scrollTop = llmContentArea.scrollHeight;
    }

    function scrapeQuestions() {
        const questionElement = document.querySelector(QUESTION_CONTAINER_SELECTOR);
        if (!questionElement) {
            throw new Error(`未找到题目容器。\n请检查您的 CSS 选择器 (Selector)：\n${QUESTION_CONTAINER_SELECTOR}`);
        }
        let text = questionElement.innerText;
        if (!text || text.trim().length === 0) {
            throw new Error('抓取到的题目文本为空。请检查 CSS 选择器。');
        }

        // --- 本地题型预判断辅助 ---
        let clsStr = questionElement.className || "";
        const allElements = questionElement.querySelectorAll('*');
        for (let i = 0; i < allElements.length; i++) {
            if (allElements[i].className && typeof allElements[i].className === 'string') {
                clsStr += " " + allElements[i].className;
            }
        }
        clsStr = clsStr.toLowerCase();

        let localHint = "";
        if (clsStr.includes('discussion')) {
            localHint = "OPEN_DISCUSSION";
        } else if (clsStr.includes('fill-blank') || clsStr.includes('inputbox')) {
            localHint = "FILL_IN_BLANK";
        } else if (clsStr.includes('choice')) {
            localHint = "SINGLE 或 MULTIPLE (请结合题干判断)";
        } else if (clsStr.includes('score_layout')) {
            if (clsStr.includes('oral-personal') || clsStr.includes('p-oral') || clsStr.includes('free')) {
                localHint = "SPK_FREE";
            } else {
                localHint = "SPK_REPETE";
            }
        } else if (clsStr.includes('dub')) {
            localHint = "SPK_REPETE";
        }

        if (localHint) {
            text = `[系统向大模型提供的界面线索：这道题很可能是类似 ${localHint} 的形式,请利用此线索并结合实际题目内容输出正确的type]\n\n` + text;
        }

        return text;
    }

    // --- API 调用函数 ---
    function sendToApi(audioUrl, is_audio) {
        return new Promise((resolve, reject) => {
            let a_url = API_URL;
            if (!is_audio) { a_url = VIDEO_API_URL; }
            const payload = {};
            payload[API_JSON_PAYLOAD_KEY] = audioUrl;

            GM.xmlHttpRequest({
                method: 'POST', url: a_url,
                data: JSON.stringify(payload),
                headers: { 'Content-Type': 'application/json' },
                onload: (response) => {
                    if (response.status >= 200 && response.status < 300) { resolve(response.responseText); }
                    else { reject(new Error(`API 错误: ${response.status} ${response.statusText}\n${response.responseText.substring(0, 100)}...`)); }
                },
                onerror: (error) => { reject(new Error(`API 网络错误 (GM.xmlHttpRequest): ${error.statusText || '无法连接'}`)); }
            });
        });
    }

    function sendToLlmApi(questionsText, transcriptText) {
        return new Promise((resolve, reject) => {
            const payload = {
                questions: questionsText,
                transcript: transcriptText // (发送纯文本)
            };
            GM.xmlHttpRequest({
                method: 'POST', url: LLM_API_URL,
                data: JSON.stringify(payload),
                headers: { 'Content-Type': 'application/json' },
                onload: (response) => {
                    if (response.status >= 200 && response.status < 300) { resolve(response.responseText); }
                    else { reject(new Error(`LLM API 错误: ${response.status} ${response.statusText}\n${response.responseText.substring(0, 100)}...`)); }
                },
                onerror: (error) => { reject(new Error(`LLM API 网络错误: ${error.statusText || '无法连接'}`)); }
            });
        });
    }

    function sendToLlmOnlyApi(questionsText) {
        return new Promise((resolve, reject) => {
            const payload = {
                questions: questionsText,
                transcript: ''
            };
            GM.xmlHttpRequest({
                method: 'POST',
                url: LLM_ONLY_API_URL,
                data: JSON.stringify(payload),
                headers: { 'Content-Type': 'application/json' },
                onload: function (response) {
                    if (response.status >= 200 && response.status < 300) {
                        resolve(response.responseText);
                    } else {
                        reject(new Error(`LLM(仅题目) API 错误: ${response.status} ${response.statusText}\n${response.responseText.substring(0, 100)}...`));
                    }
                },
                onerror: function (error) {
                    reject(new Error(`LLM(仅题目) API 网络错误: ${error.statusText || '无法连接'}`));
                }
            });
        });
    }

    // --- 自动填充核心逻辑 ---
    // 兼容 React/Vue 的输入框赋值辅助函数
    function setNativeValue(element, value) {
        const valueSetter = Object.getOwnPropertyDescriptor(element, 'value').set;
        const prototype = Object.getPrototypeOf(element);
        const prototypeValueSetter = Object.getOwnPropertyDescriptor(prototype, 'value').set;

        if (valueSetter && valueSetter !== prototypeValueSetter) {
            prototypeValueSetter.call(element, value);
        } else {
            valueSetter.call(element, value);
        }
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function autoFillAnswer(answerData) {
        try {
            if (!answerData || typeof answerData !== 'object') {
                console.log("无法自动填充：大模型返回的结果不是有效的 JSON 对象。");
                return;
            }
            
            const type = answerData.type;
            const answer = answerData.answer;
            const container = document.querySelector(QUESTION_CONTAINER_SELECTOR);
            if (!container) return;

            if (type === 'SINGLE' || type === 'MULTIPLE') {
                // 如果页面上有多个 .option-wrap，说明有多道选择题。我们将逐个对应。
                const wraps = container.querySelectorAll('.option-wrap');
                if (wraps.length === 0) {
                    console.log("未找到任何 .option-wrap 题面容器");
                    return;
                }

                let answerItems = [];
                if (Array.isArray(answer)) {
                    answerItems = answer;
                } else if (typeof answer === 'string') {
                    if (wraps.length === 1) {
                        answerItems = [answer]; // 如果页面只有一道题，那就把整个字符串当做这道题的答案
                    } else {
                        // 如果页面有多道题但模型却吐出了字符串(旧格式)，尝试分割 (比如 A, B, C)
                        answerItems = answer.split(/[,\s]+/).filter(x => x.trim().length > 0);
                    }
                }

                for (let i = 0; i < Math.min(wraps.length, answerItems.length); i++) {
                    const wrap = wraps[i];
                    const ansStr = String(answerItems[i]).toUpperCase();
                    // 当前题目需要的点击字母
                    const charsToClick = ansStr.match(/[A-Z]/g) || [];
                    
                    const options = wrap.querySelectorAll('.option');
                    options.forEach(opt => {
                        const captionEl = opt.querySelector('.caption');
                        if (captionEl) {
                            const captionText = captionEl.innerText.trim().toUpperCase();
                            if (charsToClick.includes(captionText)) {
                                opt.click();
                                console.log(`自动填充: 题目 ${i+1} 点击选项 ${captionText}`);
                            }
                        }
                    });
                }
            } else if (type === 'FILL_IN_BLANK') {
                // 寻找非隐藏，且不是选择框的输入框或文本域
                const inputs = container.querySelectorAll('input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]), textarea');
                let answerArr = [];
                if (Array.isArray(answer)) {
                    answerArr = answer;
                } else if (typeof answer === 'string') {
                    answerArr = answer.split(/[|]|,/).map(a => a.trim());
                }

                for (let i = 0; i < Math.min(inputs.length, answerArr.length); i++) {
                    const inputEl = inputs[i];
                    // 赋值并触发 React/Vue 数据双向绑定事件
                    setNativeValue(inputEl, answerArr[i]);
                    console.log(`自动填充: 填空栏 ${i + 1} 注入 ${answerArr[i]}`);
                }
            } else if (type === 'OPEN_DISCUSSION' || type === 'SPK_FREE' || type === 'SPK_REPETE') {
                // 主观题主要填写对应的 answer (大模型生成的作答文本)，如果没有则回退填写 reply
                const textareas = container.querySelectorAll('textarea');
                let answerText = "";
                if (typeof answer === 'string' && answer.trim().length > 0) {
                    answerText = answer;
                } else if (answerData.reply && typeof answerData.reply === 'string' && answerData.reply.trim().length > 0) {
                    answerText = answerData.reply;
                } else {
                    answerText = String(answer || "");
                }
                
                if (textareas.length > 0) {
                    const ta = textareas[0];
                    setNativeValue(ta, answerText);
                    console.log("自动填充: 文本框注入主观题答案");
                } else {
                    const inputs = container.querySelectorAll('input[type="text"]');
                    if (inputs.length > 0) {
                        setNativeValue(inputs[0], answerText);
                        console.log("自动填充: Input 注入主观题答案");
                    }
                }
            }
        } catch (e) {
            console.error("自动填充执行时发生异常：", e);
        }
    }

    // --- 拖拽与缩放逻辑 (现代化大窗口) ---
    function makeAppWindowDraggableAndResizable() {
        // Dragging
        let isDragging = false, dragOffsetX, dragOffsetY;
        header.addEventListener('mousedown', (e) => {
            if (e.target.closest('#gemini-theme-select') || e.target.closest('#gemini-minimize-btn')) return;
            isDragging = true;
            const rect = appWindow.getBoundingClientRect();
            dragOffsetX = e.clientX - rect.left;
            dragOffsetY = e.clientY - rect.top;
            header.style.cursor = 'grabbing';
            document.body.style.userSelect = 'none';
            appWindow.style.bottom = 'auto'; // Disable bottom CSS
            appWindow.style.right = 'auto';  // Disable right CSS
            appWindow.style.transition = 'none'; // Prevent jitter
            e.preventDefault();
        });

        // Resizing
        let isResizing = false, startW, startH, startX, startY;
        resizeHandle.addEventListener('mousedown', (e) => {
            isResizing = true;
            const rect = appWindow.getBoundingClientRect();
            startW = rect.width;
            startH = rect.height;
            startX = e.clientX;
            startY = e.clientY;
            document.body.style.userSelect = 'none';
            appWindow.style.transition = 'none';
            e.preventDefault();
            e.stopPropagation();
        });

        document.addEventListener('mousemove', (e) => {
            if (isDragging) {
                appWindow.style.left = (e.clientX - dragOffsetX) + 'px';
                appWindow.style.top = (e.clientY - dragOffsetY) + 'px';
            }
            if (isResizing && !appWindow.classList.contains('minimized')) {
                appWindow.style.width = (startW + e.clientX - startX) + 'px';
                appWindow.style.height = (startH + e.clientY - startY) + 'px';
            }
        });

        document.addEventListener('mouseup', () => {
            if (isDragging) {
                isDragging = false;
                header.style.cursor = 'move';
                document.body.style.userSelect = 'auto';
                appWindow.style.transition = 'height 0.3s ease, width 0.3s ease';
            }
            if (isResizing) {
                isResizing = false;
                document.body.style.userSelect = 'auto';
                appWindow.style.transition = 'height 0.3s ease, width 0.3s ease';
            }
        });
    }

    makeAppWindowDraggableAndResizable();

    console.log('音频转录(v2.4)按钮已加载。');
    console.log(`当前 API 基础地址: ${GM_getValue(API_STORAGE_KEY, 'http://127.0.0.1:1050')}`);

})();