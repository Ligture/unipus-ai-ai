// ==UserScript==
// @name         Unipus-ai-ai(u校园ai版ai版)
// @namespace    http://tampermonkey.net/
// @version      1.8
// @description  本脚本能对音频/视频转录为文本,并调用LLM模型生成答案并自动填充，口语题目可自动生成音频替换完成。
// @author       lpmon
// @match        *://ucontent.unipus.cn/*
// @include      *://ucontent.unipus.cn/*
// @grant        GM.xmlHttpRequest
// @grant        GM_setClipboard
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // === getUserMedia 拦截 (TTS音频替换) ===
    // 使用 unsafeWindow 操作页面上下文, 避免Tampermonkey沙箱隔离
    const _pageNavigator = unsafeWindow.navigator.mediaDevices;
    const _origGetUserMedia = _pageNavigator.getUserMedia.bind(_pageNavigator);
    let _ua_audioBlob = null;       // 当前TTS音频Blob
    let _ua_audioReplace = false;   // 拦截开关
    let _ua_audioDuration = 0;      // 音频时长(秒)

    _pageNavigator.getUserMedia = async function (constraints) {
        if (!_ua_audioReplace || !constraints?.audio || !_ua_audioBlob) {
            return _origGetUserMedia(constraints);
        }
        try {
            const AudioCtx = unsafeWindow.AudioContext || unsafeWindow.webkitAudioContext;
            const ctx = new AudioCtx();
            const buf = await _ua_audioBlob.arrayBuffer();
            const audioBuf = await ctx.decodeAudioData(buf);
            _ua_audioDuration = audioBuf.duration;
            // 在音频前拼接800ms静音, 给MediaRecorder准备时间
            const padFrames = Math.ceil(audioBuf.sampleRate * 0.8);
            const paddedBuf = ctx.createBuffer(audioBuf.numberOfChannels, audioBuf.length + padFrames, audioBuf.sampleRate);
            for (let ch = 0; ch < audioBuf.numberOfChannels; ch++) {
                paddedBuf.getChannelData(ch).set(audioBuf.getChannelData(ch), padFrames);
            }
            _ua_audioDuration = paddedBuf.duration;

            const src = ctx.createBufferSource();
            src.buffer = paddedBuf;
            const dest = ctx.createMediaStreamDestination();
            src.connect(dest);
            src.start();
            return dest.stream;
        } catch (e) {
            console.error('[Unipus AI] getUserMedia拦截失败, 回退到真实麦克风:', e);
            _ua_audioReplace = false;
            return _origGetUserMedia(constraints);
        }
    };

    // --- API 动态配置与存储 ---
    const API_STORAGE_KEY = 'unipus_api_base_url';
    let API_BASE_URL = GM_getValue(API_STORAGE_KEY, 'http://127.0.0.1:28955');

    // --- Endpoint 路径 (动态获取 + 兜底默认值) ---
    const ENDPOINT_DEFAULTS = {
        transcribe: '/api/transcribe/audio',
        video: '/api/transcribe/video',
        llm: '/api/llm/answer',
        text: '/api/llm/text',
        tts: '/api/tts/generate',
        audio_files: '/api/audio',
    };
    const ENDPOINT_CACHE_KEY = 'unipus_endpoints';
    let _endpoints = GM_getValue(ENDPOINT_CACHE_KEY, { ...ENDPOINT_DEFAULTS });

    let ENDPOINT_TRANSCRIBE = _endpoints.transcribe;
    let ENDPOINT_VIDEO = _endpoints.video;
    let ENDPOINT_LLM = _endpoints.llm;
    let ENDPOINT_LLM_ONLY = _endpoints.text;
    let ENDPOINT_TTS = _endpoints.tts;
    let ENDPOINT_AUDIO_FILES = _endpoints.audio_files;

    let transcriptionCacheVersion = null;
    let endpointConfigReady = Promise.resolve();
    // 启动时向后端请求最新 endpoint 配置
    function fetchEndpointConfig() {
        transcriptionCacheVersion = null;
        const base = API_BASE_URL;
        endpointConfigReady = new Promise((resolve) => {
            GM.xmlHttpRequest({
                method: 'GET',
                url: API_BASE_URL + '/api/config/endpoints',
                timeout: 5000,
                onload: (resp) => {
                    if (resp.status >= 200 && resp.status < 300) {
                        try {
                            const remote = JSON.parse(resp.responseText);
                            if (base !== API_BASE_URL) { resolve(); return; }
                            transcriptionCacheVersion = remote.transcription_cache?.enabled &&
                                typeof remote.transcription_cache.version === 'string'
                                ? remote.transcription_cache.version : null;
                            _endpoints = { ...ENDPOINT_DEFAULTS, ...remote };
                            GM_setValue(ENDPOINT_CACHE_KEY, _endpoints);
                            ENDPOINT_TRANSCRIBE = _endpoints.transcribe;
                            ENDPOINT_VIDEO = _endpoints.video;
                            ENDPOINT_LLM = _endpoints.llm;
                            ENDPOINT_LLM_ONLY = _endpoints.text;
                            ENDPOINT_TTS = _endpoints.tts;
                            ENDPOINT_AUDIO_FILES = _endpoints.audio_files;
                            console.log('[Unipus AI] Endpoint 配置已从后端更新');
                        } catch (e) {
                            console.warn('[Unipus AI] Endpoint 配置解析失败，使用缓存/默认值');
                        }
                    }
                    resolve();
                },
                onerror: () => {
                    console.warn('[Unipus AI] Endpoint 配置请求失败，使用缓存/默认值');
                    resolve();
                },
                ontimeout: () => {
                    console.warn('[Unipus AI] Endpoint 配置请求超时，使用缓存/默认值');
                    resolve();
                }
            });
        });
        return endpointConfigReady;
    }

    // 等待DOM就绪后再构建UI
    function _ua_initUI() {
    let API_URL = API_BASE_URL + ENDPOINT_TRANSCRIBE;
    let VIDEO_API_URL = API_BASE_URL + ENDPOINT_VIDEO;
    let LLM_API_URL = API_BASE_URL + ENDPOINT_LLM;
    let LLM_ONLY_API_URL = API_BASE_URL + ENDPOINT_LLM_ONLY;
    let TTS_API_URL = API_BASE_URL + ENDPOINT_TTS;

    // --- 必填配置 (媒体源XPath, 多路径回退增强稳定性) ---
    const AUDIO_XPATHS = [
        '//audio[contains(@class, "unipus-audio")]/@src',
        '//*[@id="main-content"]//audio/@src',
        '//audio/@src',
        '//audio/source/@src',
        '//audio[contains(@class, "unipus-audio")]/@title'
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
        TTS_API_URL = API_BASE_URL + ENDPOINT_TTS;
        GM_setValue(API_STORAGE_KEY, API_BASE_URL);
        // 重新获取 endpoint 配置
        fetchEndpointConfig().then(() => {
            API_URL = API_BASE_URL + ENDPOINT_TRANSCRIBE;
            VIDEO_API_URL = API_BASE_URL + ENDPOINT_VIDEO;
            LLM_API_URL = API_BASE_URL + ENDPOINT_LLM;
            LLM_ONLY_API_URL = API_BASE_URL + ENDPOINT_LLM_ONLY;
            TTS_API_URL = API_BASE_URL + ENDPOINT_TTS;
        });
        showToast('API 地址已更新', 'success');
    }

    // --- 脚本全局变量 ---
    let currentTranscript = "";
    let transcriptCopyText = "";
    let answerCopyText = "";
    const TRANSCRIPT_CACHE_KEY = 'unipus_transcript_cache_v2';
    const TRANSCRIPT_CACHE_TTL = 7 * 86400 * 1000;
    const TRANSCRIPT_CACHE_LIMIT = 100;
    const pendingTranscripts = new Map();
    const TTS_RATE_KEY = 'unipus_tts_rate';
    let ttsLengthScale = GM_getValue(TTS_RATE_KEY, 1.0);
    // 兼容旧版pyttsx3的rate值(80-250), 重置为Piper的length_scale(0.5-2.0)
    if (ttsLengthScale > 10) { ttsLengthScale = 1.0; GM_setValue(TTS_RATE_KEY, 1.0); }

    // --- SVG 图标 ---
    const ICONS = {
        mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>',
        brain: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z"/><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z"/></svg>',
        edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
        settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
        close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
        minimize: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>',
        maximize: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>',
        check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
        alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
        chevronLeft: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>',
        tts: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>'
    };

    // --- 构建全新 UI 结构 ---
    const appWindow = document.createElement('div');
    appWindow.id = 'ua-app';

    // 1. Header
    const header = document.createElement('div');
    header.id = 'ua-header';

    const headerLeft = document.createElement('div');
    headerLeft.className = 'ua-header-left';

    const logo = document.createElement('div');
    logo.className = 'ua-logo';
    logo.innerHTML = '<span class="ua-logo-icon">U</span><span class="ua-logo-text">Unipus AI</span>';

    const statusBar = document.createElement('div');
    statusBar.className = 'ua-status';
    statusBar.innerHTML = '<span class="ua-status-dot"></span><span class="ua-status-text">就绪</span>';

    headerLeft.appendChild(logo);
    headerLeft.appendChild(statusBar);

    const headerRight = document.createElement('div');
    headerRight.className = 'ua-header-right';

    const settingsBtn = document.createElement('button');
    settingsBtn.className = 'ua-icon-btn';
    settingsBtn.innerHTML = ICONS.settings;
    settingsBtn.title = '设置';

    const minimizeBtn = document.createElement('button');
    minimizeBtn.className = 'ua-icon-btn';
    minimizeBtn.innerHTML = ICONS.minimize;
    minimizeBtn.title = '最小化';

    headerRight.appendChild(settingsBtn);
    headerRight.appendChild(minimizeBtn);

    header.appendChild(headerLeft);
    header.appendChild(headerRight);

    // 2. Action Bar
    const actionBar = document.createElement('div');
    actionBar.id = 'ua-actions';

    const triggerButton = document.createElement('button');
    triggerButton.className = 'ua-btn ua-btn-primary';
    triggerButton.innerHTML = `<span class="ua-btn-icon">${ICONS.mic}</span><span class="ua-btn-text">转录</span>`;
    triggerButton.addEventListener('click', runTranscription);

    const llmButton = document.createElement('button');
    llmButton.className = 'ua-btn ua-btn-success';
    llmButton.innerHTML = `<span class="ua-btn-icon">${ICONS.brain}</span><span class="ua-btn-text">答案(带听力)</span>`;
    llmButton.addEventListener('click', getAnswersWithTranscript);
    llmButton.style.display = 'none';

    const llmOnlyButton = document.createElement('button');
    llmOnlyButton.className = 'ua-btn ua-btn-accent';
    llmOnlyButton.innerHTML = `<span class="ua-btn-icon">${ICONS.edit}</span><span class="ua-btn-text">答案(仅题目)</span>`;
    llmOnlyButton.addEventListener('click', getAnswersOnly);

    actionBar.appendChild(triggerButton);
    actionBar.appendChild(llmButton);
    actionBar.appendChild(llmOnlyButton);

    // 3. Content Area
    const contentArea = document.createElement('div');
    contentArea.id = 'ua-content';

    // Tab 切换
    const tabBar = document.createElement('div');
    tabBar.className = 'ua-tabs';

    const tabTranscribe = document.createElement('button');
    tabTranscribe.className = 'ua-tab ua-tab-active';
    tabTranscribe.textContent = '转录结果';
    tabTranscribe.dataset.tab = 'transcribe';

    const tabLLM = document.createElement('button');
    tabLLM.className = 'ua-tab';
    tabLLM.textContent = 'LLM 答案';
    tabLLM.dataset.tab = 'llm';

    tabBar.appendChild(tabTranscribe);
    tabBar.appendChild(tabLLM);

    // 内容面板
    const panelsWrapper = document.createElement('div');
    panelsWrapper.className = 'ua-panels';

    const transcribePanel = document.createElement('div');
    transcribePanel.className = 'ua-panel ua-panel-active';
    transcribePanel.dataset.panel = 'transcribe';
    const transcribeContent = document.createElement('div');
    transcribeContent.id = 'ua-transcribe-content';
    transcribeContent.className = 'ua-panel-content';
    const copyTranscriptButton = createCopyButton('复制转录', () => transcriptCopyText);
    transcribePanel.appendChild(copyTranscriptButton);
    const refreshTranscriptButton = document.createElement('button');
    refreshTranscriptButton.type = 'button';
    refreshTranscriptButton.className = 'ua-btn ua-btn-primary ua-copy-btn';
    refreshTranscriptButton.textContent = '重新转录';
    refreshTranscriptButton.addEventListener('click', () => runTranscription(true));
    transcribePanel.appendChild(refreshTranscriptButton);
    transcribePanel.appendChild(transcribeContent);

    const llmPanel = document.createElement('div');
    llmPanel.className = 'ua-panel';
    llmPanel.dataset.panel = 'llm';
    const llmContent = document.createElement('div');
    llmContent.id = 'ua-llm-content';
    llmContent.className = 'ua-panel-content';
    const copyAnswerButton = createCopyButton('复制答案', () => answerCopyText);
    llmPanel.appendChild(copyAnswerButton);
    llmPanel.appendChild(llmContent);

    panelsWrapper.appendChild(transcribePanel);
    panelsWrapper.appendChild(llmPanel);

    contentArea.appendChild(tabBar);
    contentArea.appendChild(panelsWrapper);

    // 从脚本保存的原始字符串复制，不读取页面选区或触发网站 copy 事件。
    function createCopyButton(label, getText) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'ua-btn ua-btn-primary ua-copy-btn';
        button.textContent = label;
        button.disabled = true;
        button.addEventListener('click', async (event) => {
            event.preventDefault();
            event.stopPropagation();
            const text = getText();
            if (!text.trim()) {
                showToast('暂无可复制的结果', 'error');
                return;
            }
            button.disabled = true;
            try {
                await new Promise((resolve, reject) => {
                    if (typeof GM_setClipboard !== 'function') {
                        reject(new Error('请更新油猴脚本并启用剪贴板权限'));
                        return;
                    }
                    GM_setClipboard(text, 'text', resolve);
                });
                showToast(label + '成功', 'success');
            } catch (error) {
                showToast('复制失败：' + error.message, 'error');
            } finally {
                button.disabled = !getText().trim();
            }
        });
        return button;
    }

    // Tab 切换逻辑
    tabTranscribe.addEventListener('click', () => switchTab('transcribe'));
    tabLLM.addEventListener('click', () => switchTab('llm'));

    function switchTab(tabName) {
        document.querySelectorAll('.ua-tab').forEach(t => t.classList.remove('ua-tab-active'));
        document.querySelectorAll('.ua-panel').forEach(p => p.classList.remove('ua-panel-active'));
        document.querySelector(`.ua-tab[data-tab="${tabName}"]`).classList.add('ua-tab-active');
        document.querySelector(`.ua-panel[data-panel="${tabName}"]`).classList.add('ua-panel-active');
    }

    // 4. Settings Panel (二级菜单)
    const settingsPanel = document.createElement('div');
    settingsPanel.id = 'ua-settings';
    settingsPanel.className = 'ua-settings-panel';

    const settingsHeader = document.createElement('div');
    settingsHeader.className = 'ua-settings-header';

    const settingsBack = document.createElement('button');
    settingsBack.className = 'ua-icon-btn';
    settingsBack.innerHTML = ICONS.chevronLeft;

    const settingsTitle = document.createElement('span');
    settingsTitle.textContent = '设置';
    settingsTitle.className = 'ua-settings-title';

    settingsHeader.appendChild(settingsBack);
    settingsHeader.appendChild(settingsTitle);

    const settingsBody = document.createElement('div');
    settingsBody.className = 'ua-settings-body';

    // API URL 设置
    const apiGroup = document.createElement('div');
    apiGroup.className = 'ua-setting-group';
    apiGroup.innerHTML = `
        <label class="ua-setting-label">API 服务器地址</label>
        <div class="ua-setting-input-wrap">
            <input type="text" id="ua-api-input" class="ua-setting-input" value="${API_BASE_URL}" placeholder="http://127.0.0.1:28955">
            <button id="ua-api-save" class="ua-setting-save">保存</button>
        </div>
        <p class="ua-setting-hint">修改后需重新转录才能生效</p>
    `;

    settingsBody.appendChild(apiGroup);

    // TTS 设置
    const ttsGroup = document.createElement('div');
    ttsGroup.className = 'ua-setting-group';
    ttsGroup.innerHTML = `
        <label class="ua-setting-label">TTS 语速</label>
        <div class="ua-setting-input-wrap">
            <input type="range" id="ua-tts-rate" class="ua-setting-input" min="0.5" max="2.0" value="${ttsLengthScale}" step="0.1" style="flex:1">
            <span id="ua-tts-rate-val" style="min-width:40px;text-align:center;font-size:13px;color:var(--ua-text-secondary)">${ttsLengthScale}</span>
        </div>
        <p class="ua-setting-hint">值越小语速越快 (0.5=2倍速, 1.0=正常, 2.0=半速)</p>
    `;

    settingsBody.appendChild(ttsGroup);
    settingsPanel.appendChild(settingsHeader);
    settingsPanel.appendChild(settingsBody);

    // TTS rate slider 事件
    const ttsRateSlider = ttsGroup.querySelector('#ua-tts-rate');
    const ttsRateVal = ttsGroup.querySelector('#ua-tts-rate-val');
    ttsRateSlider.addEventListener('input', () => {
        ttsRateVal.textContent = ttsRateSlider.value;
    });
    ttsRateSlider.addEventListener('change', () => {
        ttsLengthScale = parseFloat(ttsRateSlider.value);
        GM_setValue(TTS_RATE_KEY, ttsLengthScale);
        showToast(`TTS语速已设置为 ${ttsLengthScale}`, 'success');
    });

    // 5. Resize handles (四边 + 四角)
    const resizeHandles = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map(dir => {
        const handle = document.createElement('div');
        handle.className = `ua-resize ua-resize-${dir}`;
        handle.dataset.dir = dir;
        return handle;
    });

    // 组装
    appWindow.appendChild(header);
    appWindow.appendChild(actionBar);
    appWindow.appendChild(contentArea);
    appWindow.appendChild(settingsPanel);
    resizeHandles.forEach(h => appWindow.appendChild(h));
    document.body.appendChild(appWindow);

    // 最小化浮动按钮
    const fabBtn = document.createElement('div');
    fabBtn.id = 'ua-fab';
    fabBtn.innerHTML = ICONS.maximize;
    fabBtn.style.cssText = `
        display: none;
        position: fixed;
        bottom: 30px;
        left: 30px;
        width: 44px;
        height: 44px;
        background: linear-gradient(135deg, #6366f1, #4f46e5);
        border-radius: 50%;
        box-shadow: 0 4px 20px rgba(99, 102, 241, 0.4);
        cursor: pointer;
        z-index: 2147483647;
        align-items: center;
        justify-content: center;
        color: white;
        transition: transform 0.2s ease, box-shadow 0.2s ease;
    `;
    fabBtn.querySelector('svg').style.cssText = 'width:20px;height:20px;';
    document.body.appendChild(fabBtn);

    fabBtn.addEventListener('mouseenter', () => {
        fabBtn.style.transform = 'scale(1.1)';
        fabBtn.style.boxShadow = '0 6px 28px rgba(99, 102, 241, 0.6)';
    });
    fabBtn.addEventListener('mouseleave', () => {
        fabBtn.style.transform = 'scale(1)';
        fabBtn.style.boxShadow = '0 4px 20px rgba(99, 102, 241, 0.4)';
    });
    fabBtn.addEventListener('click', () => {
        isMinimized = false;
        appWindow.style.display = 'flex';
        fabBtn.style.display = 'none';
        minimizeBtn.innerHTML = ICONS.minimize;
    });

    // 设置面板事件
    settingsBtn.addEventListener('click', () => {
        appWindow.classList.toggle('ua-settings-open');
    });
    settingsBack.addEventListener('click', () => {
        appWindow.classList.remove('ua-settings-open');
    });

    // API 保存事件
    const apiInput = document.getElementById('ua-api-input');
    const apiSaveBtn = document.getElementById('ua-api-save');
    apiSaveBtn.addEventListener('click', () => {
        const val = apiInput.value.trim();
        if (val && val !== API_BASE_URL) {
            updateApiUrls(val);
        }
    });

    // 最小化
    let isMinimized = false;
    minimizeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        isMinimized = true;
        appWindow.style.display = 'none';
        fabBtn.style.display = 'flex';
    });

    // --- Toast 通知 ---
    function showToast(message, type = 'info') {
        const toast = document.createElement('div');
        toast.className = `ua-toast ua-toast-${type}`;
        toast.innerHTML = `<span class="ua-toast-icon">${type === 'success' ? ICONS.check : ICONS.alert}</span><span>${message}</span>`;
        document.body.appendChild(toast);
        requestAnimationFrame(() => toast.classList.add('ua-toast-show'));
        setTimeout(() => {
            toast.classList.remove('ua-toast-show');
            setTimeout(() => toast.remove(), 300);
        }, 2500);
    }

    // --- 现代化样式 ---
    GM_addStyle(`
        /* ===== Unipus AI v3.0 ===== */
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');

        /* 主窗口 */
        #ua-app {
            --ua-bg: rgba(255, 255, 255, 0.85);
            --ua-bg-solid: #ffffff;
            --ua-border: rgba(0, 0, 0, 0.08);
            --ua-text: #1a1a2e;
            --ua-text-secondary: #6b7280;
            --ua-primary: #6366f1;
            --ua-primary-light: #818cf8;
            --ua-primary-dark: #4f46e5;
            --ua-success: #10b981;
            --ua-success-light: #34d399;
            --ua-accent: #f59e0b;
            --ua-accent-light: #fbbf24;
            --ua-danger: #ef4444;
            --ua-radius: 16px;
            --ua-radius-sm: 10px;
            --ua-radius-xs: 6px;
            --ua-shadow: 0 20px 60px rgba(0, 0, 0, 0.15), 0 0 0 1px rgba(255, 255, 255, 0.5) inset;
            --ua-backdrop: blur(24px) saturate(180%);
            --ua-transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);

            position: fixed;
            bottom: 30px;
            left: 30px;
            width: 420px;
            height: 560px;
            min-width: 320px;
            min-height: 400px;
            background: var(--ua-bg);
            border: 1px solid var(--ua-border);
            border-radius: var(--ua-radius);
            box-shadow: var(--ua-shadow);
            backdrop-filter: var(--ua-backdrop);
            -webkit-backdrop-filter: var(--ua-backdrop);
            z-index: 2147483647;
            display: flex;
            flex-direction: column;
            color: var(--ua-text);
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            box-sizing: border-box;
            overflow: hidden;
            transition: var(--ua-transition);
        }

        /* Header */
        #ua-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 12px 16px;
            background: linear-gradient(135deg, var(--ua-primary), var(--ua-primary-dark));
            color: white;
            cursor: move;
            user-select: none;
            flex-shrink: 0;
            border-radius: var(--ua-radius) var(--ua-radius) 0 0;
            position: relative;
            z-index: 10;
        }

        .ua-header-left {
            display: flex;
            align-items: center;
            gap: 12px;
        }

        .ua-logo {
            display: flex;
            align-items: center;
            gap: 8px;
            font-weight: 700;
            font-size: 15px;
            letter-spacing: -0.3px;
        }

        .ua-logo-icon {
            width: 28px;
            height: 28px;
            background: rgba(255, 255, 255, 0.2);
            border-radius: 8px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 16px;
            font-weight: 800;
            backdrop-filter: blur(10px);
        }

        .ua-status {
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 12px;
            opacity: 0.9;
            background: rgba(255, 255, 255, 0.15);
            padding: 4px 10px;
            border-radius: 20px;
            backdrop-filter: blur(10px);
        }

        .ua-status-dot {
            width: 6px;
            height: 6px;
            background: #4ade80;
            border-radius: 50%;
            animation: ua-pulse 2s ease-in-out infinite;
        }

        @keyframes ua-pulse {
            0%, 100% { opacity: 1; transform: scale(1); }
            50% { opacity: 0.5; transform: scale(0.8); }
        }

        .ua-header-right {
            display: flex;
            align-items: center;
            gap: 4px;
        }

        .ua-icon-btn {
            width: 32px;
            height: 32px;
            border: none;
            background: rgba(255, 255, 255, 0.15);
            color: white;
            border-radius: 8px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: var(--ua-transition);
            backdrop-filter: blur(10px);
        }

        .ua-icon-btn:hover {
            background: rgba(255, 255, 255, 0.25);
            transform: scale(1.05);
        }

        .ua-icon-btn:active {
            transform: scale(0.95);
        }

        .ua-icon-btn svg {
            width: 16px;
            height: 16px;
        }

        /* Actions */
        #ua-actions {
            display: flex;
            gap: 6px;
            padding: 10px 12px;
            background: var(--ua-bg-solid);
            border-bottom: 1px solid var(--ua-border);
            flex-shrink: 0;
            align-items: stretch;
        }

        .ua-btn {
            flex: 1;
            min-width: 0;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 5px;
            padding: 8px 10px;
            font-size: 12px;
            font-weight: 500;
            color: white;
            border: none;
            border-radius: var(--ua-radius-xs);
            cursor: pointer;
            transition: background 0.15s ease, opacity 0.15s ease;
            font-family: inherit;
            white-space: nowrap;
            line-height: 1;
        }

        .ua-btn:hover {
            opacity: 0.85;
        }

        .ua-btn:active {
            opacity: 0.7;
        }

        .ua-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }

        .ua-btn-icon {
            width: 14px;
            height: 14px;
            flex-shrink: 0;
        }

        .ua-btn-icon svg {
            width: 100%;
            height: 100%;
        }

        .ua-btn-primary { background: var(--ua-primary); }
        .ua-btn-success { background: var(--ua-success); }
        .ua-btn-accent { background: var(--ua-accent); }

        /* Content */
        #ua-content {
            flex: 1;
            display: flex;
            flex-direction: column;
            background: var(--ua-bg-solid);
            overflow: hidden;
        }

        .ua-tabs {
            display: flex;
            padding: 0 16px;
            background: var(--ua-bg-solid);
            border-bottom: 1px solid var(--ua-border);
            flex-shrink: 0;
        }

        .ua-tab {
            padding: 10px 16px;
            font-size: 13px;
            font-weight: 500;
            color: var(--ua-text-secondary);
            background: none;
            border: none;
            cursor: pointer;
            position: relative;
            transition: var(--ua-transition);
            font-family: inherit;
        }

        .ua-tab::after {
            content: '';
            position: absolute;
            bottom: 0;
            left: 50%;
            transform: translateX(-50%);
            width: 0;
            height: 2px;
            background: var(--ua-primary);
            border-radius: 1px;
            transition: var(--ua-transition);
        }

        .ua-tab:hover {
            color: var(--ua-text);
        }

        .ua-tab-active {
            color: var(--ua-primary);
            font-weight: 600;
        }

        .ua-tab-active::after {
            width: 24px;
        }

        .ua-panels {
            flex: 1;
            position: relative;
            overflow: hidden;
        }

        .ua-panel {
            display: flex;
            flex-direction: column;
            position: absolute;
            inset: 0;
            opacity: 0;
            visibility: hidden;
            transform: translateX(10px);
            transition: var(--ua-transition);
        }

        .ua-copy-btn {
            align-self: flex-end;
            flex: 0 0 auto;
            margin: 10px 16px 0;
            padding: 6px 12px;
            font-size: 12px;
        }

        .ua-panel-active {
            opacity: 1;
            visibility: visible;
            transform: translateX(0);
        }

        .ua-panel-content {
            flex: 1;
            min-height: 0;
            padding: 16px;
            overflow-y: auto;
            font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
            font-size: 12px;
            line-height: 1.7;
            white-space: pre-wrap;
            word-break: break-all;
            color: var(--ua-text);
        }

        .ua-panel-content::-webkit-scrollbar {
            width: 6px;
        }

        .ua-panel-content::-webkit-scrollbar-track {
            background: transparent;
        }

        .ua-panel-content::-webkit-scrollbar-thumb {
            background: var(--ua-border);
            border-radius: 3px;
        }

        .ua-panel-content::-webkit-scrollbar-thumb:hover {
            background: var(--ua-text-secondary);
        }

        /* Settings Panel */
        .ua-settings-panel {
            position: absolute;
            top: 0;
            right: 0;
            width: 100%;
            height: 100%;
            background: var(--ua-bg-solid);
            z-index: 20;
            transform: translateX(100%);
            transition: transform 0.35s cubic-bezier(0.4, 0, 0.2, 1);
            display: flex;
            flex-direction: column;
        }

        #ua-app.ua-settings-open .ua-settings-panel {
            transform: translateX(0);
        }

        .ua-settings-header {
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 12px 16px;
            background: linear-gradient(135deg, var(--ua-primary), var(--ua-primary-dark));
            color: white;
            flex-shrink: 0;
        }

        .ua-settings-header .ua-icon-btn {
            background: rgba(255, 255, 255, 0.15);
        }

        .ua-settings-title {
            font-size: 15px;
            font-weight: 600;
        }

        .ua-settings-body {
            flex: 1;
            padding: 20px 16px;
            overflow-y: auto;
        }

        .ua-setting-group {
            margin-bottom: 20px;
        }

        .ua-setting-label {
            display: block;
            font-size: 13px;
            font-weight: 600;
            color: var(--ua-text);
            margin-bottom: 8px;
        }

        .ua-setting-input-wrap {
            display: flex;
            gap: 8px;
        }

        .ua-setting-input {
            flex: 1;
            padding: 10px 12px;
            font-size: 13px;
            font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
            border: 1px solid var(--ua-border);
            border-radius: var(--ua-radius-xs);
            background: var(--ua-bg);
            color: var(--ua-text);
            outline: none;
            transition: var(--ua-transition);
        }

        .ua-setting-input:focus {
            border-color: var(--ua-primary);
            box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.1);
        }

        .ua-setting-save {
            padding: 10px 16px;
            font-size: 13px;
            font-weight: 600;
            color: white;
            background: var(--ua-primary);
            border: none;
            border-radius: var(--ua-radius-xs);
            cursor: pointer;
            transition: var(--ua-transition);
            font-family: inherit;
        }

        .ua-setting-save:hover {
            background: var(--ua-primary-dark);
        }

        .ua-setting-hint {
            margin-top: 8px;
            font-size: 12px;
            color: var(--ua-text-secondary);
        }

        /* Resize Handles */
        .ua-resize {
            position: absolute;
            z-index: 5;
        }

        .ua-resize-n { top: -4px; left: 10px; right: 10px; height: 8px; cursor: n-resize; }
        .ua-resize-s { bottom: -4px; left: 10px; right: 10px; height: 8px; cursor: s-resize; }
        .ua-resize-e { right: -4px; top: 10px; bottom: 10px; width: 8px; cursor: e-resize; }
        .ua-resize-w { left: -4px; top: 10px; bottom: 10px; width: 8px; cursor: w-resize; }
        .ua-resize-ne { top: -4px; right: -4px; width: 16px; height: 16px; cursor: ne-resize; }
        .ua-resize-nw { top: -4px; left: -4px; width: 16px; height: 16px; cursor: nw-resize; }
        .ua-resize-se { bottom: -4px; right: -4px; width: 16px; height: 16px; cursor: se-resize; }
        .ua-resize-sw { bottom: -4px; left: -4px; width: 16px; height: 16px; cursor: sw-resize; }

        /* Toast */
        .ua-toast {
            position: fixed;
            top: 20px;
            right: 20px;
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 12px 20px;
            background: var(--ua-bg-solid);
            border: 1px solid var(--ua-border);
            border-radius: var(--ua-radius-sm);
            box-shadow: 0 10px 40px rgba(0, 0, 0, 0.15);
            backdrop-filter: blur(20px);
            z-index: 2147483647;
            font-family: 'Inter', sans-serif;
            font-size: 13px;
            font-weight: 500;
            color: var(--ua-text);
            transform: translateX(120%);
            opacity: 0;
            transition: all 0.35s cubic-bezier(0.4, 0, 0.2, 1);
        }

        .ua-toast-show {
            transform: translateX(0);
            opacity: 1;
        }

        .ua-toast-icon {
            width: 20px;
            height: 20px;
            flex-shrink: 0;
        }

        .ua-toast-icon svg {
            width: 100%;
            height: 100%;
        }

        .ua-toast-success .ua-toast-icon { color: var(--ua-success); }
        .ua-toast-error .ua-toast-icon { color: var(--ua-danger); }

        /* Status Colors */
        .ua-status-loading { color: var(--ua-text-secondary); }
        .ua-status-success { color: var(--ua-success); }
        .ua-status-error { color: var(--ua-danger); }

        /* Loading Spinner */
        @keyframes ua-spin {
            to { transform: rotate(360deg); }
        }

        .ua-loading::after {
            content: '';
            display: inline-block;
            width: 14px;
            height: 14px;
            border: 2px solid var(--ua-border);
            border-top-color: var(--ua-primary);
            border-radius: 50%;
            animation: ua-spin 0.8s linear infinite;
            margin-left: 8px;
            vertical-align: middle;
        }
    `);

    // --- 拖拽与缩放逻辑 ---
    function makeAppWindowDraggableAndResizable() {
        let isDragging = false, dragOffsetX, dragOffsetY;

        header.addEventListener('mousedown', (e) => {
            if (e.target.closest('.ua-icon-btn')) return;
            isDragging = true;
            const rect = appWindow.getBoundingClientRect();
            dragOffsetX = e.clientX - rect.left;
            dragOffsetY = e.clientY - rect.top;
            header.style.cursor = 'grabbing';
            document.body.style.userSelect = 'none';
            appWindow.style.transition = 'none';
            e.preventDefault();
        });

        // 多方向缩放
        let isResizing = false, resizeDir = '', startW, startH, startX, startY, startLeft, startTop;

        resizeHandles.forEach(handle => {
            handle.addEventListener('mousedown', (e) => {
                isResizing = true;
                resizeDir = handle.dataset.dir;
                const rect = appWindow.getBoundingClientRect();
                startW = rect.width;
                startH = rect.height;
                startX = e.clientX;
                startY = e.clientY;
                startLeft = rect.left;
                startTop = rect.top;
                document.body.style.userSelect = 'none';
                appWindow.style.transition = 'none';
                e.preventDefault();
                e.stopPropagation();
            });
        });

        document.addEventListener('mousemove', (e) => {
            if (isDragging) {
                const newLeft = e.clientX - dragOffsetX;
                const newTop = e.clientY - dragOffsetY;
                appWindow.style.left = newLeft + 'px';
                appWindow.style.top = newTop + 'px';
                appWindow.style.bottom = 'auto';
                appWindow.style.right = 'auto';
            }
            if (isResizing && !appWindow.classList.contains('ua-minimized')) {
                const dx = e.clientX - startX;
                const dy = e.clientY - startY;
                let newW = startW, newH = startH, newL = startLeft, newT = startTop;

                if (resizeDir.includes('e')) newW = Math.max(320, startW + dx);
                if (resizeDir.includes('w')) {
                    newW = Math.max(320, startW - dx);
                    newL = startLeft + (startW - newW);
                }
                if (resizeDir.includes('s')) newH = Math.max(400, startH + dy);
                if (resizeDir.includes('n')) {
                    newH = Math.max(400, startH - dy);
                    newT = startTop + (startH - newH);
                }

                appWindow.style.width = newW + 'px';
                appWindow.style.height = newH + 'px';
                if (resizeDir.includes('w') || resizeDir.includes('n')) {
                    appWindow.style.left = newL + 'px';
                    appWindow.style.top = newT + 'px';
                    appWindow.style.bottom = 'auto';
                    appWindow.style.right = 'auto';
                }
            }
        });

        document.addEventListener('mouseup', () => {
            if (isDragging) {
                isDragging = false;
                header.style.cursor = 'move';
                document.body.style.userSelect = 'auto';
                appWindow.style.transition = 'var(--ua-transition)';
            }
            if (isResizing) {
                isResizing = false;
                document.body.style.userSelect = 'auto';
                appWindow.style.transition = 'var(--ua-transition)';
            }
        });
    }

    makeAppWindowDraggableAndResizable();

    // --- 辅助函数 ---
    function updateStatus(message, type = 'loading', copyText = '') {
        transcriptCopyText = type === 'success' ? String(copyText) : '';
        copyTranscriptButton.disabled = !transcriptCopyText.trim();
        const statusText = document.querySelector('.ua-status-text');
        const statusDot = document.querySelector('.ua-status-dot');
        statusText.textContent = type === 'loading' ? '处理中...' : (type === 'success' ? '就绪' : '错误');
        statusDot.style.background = type === 'error' ? 'var(--ua-danger)' : (type === 'success' ? '#4ade80' : 'var(--ua-accent)');
        transcribeContent.className = `ua-panel-content ua-status-${type}`;
        transcribeContent.textContent = message;
        transcribeContent.scrollTop = transcribeContent.scrollHeight;
    }

    function updateAnswerStatus(message, type = 'loading') {
        answerCopyText = type === 'success' ? String(message ?? '') : '';
        copyAnswerButton.disabled = !answerCopyText.trim();
        llmContent.className = `ua-panel-content ua-status-${type}`;
        llmContent.textContent = message;
        llmContent.scrollTop = llmContent.scrollHeight;
        // 自动切换到 LLM 答案 tab
        if (type !== 'loading') {
            switchTab('llm');
        }
    }

    function showAnswerBox(message, type = 'loading') {
        llmButton.style.display = 'inline-flex';
        updateAnswerStatus(message, type);
    }

    function scrapeQuestions() {
        const questionElement = document.querySelector(QUESTION_CONTAINER_SELECTOR);
        if (!questionElement) {
            throw new Error(`未找到题目容器。\n请检查 CSS 选择器：\n${QUESTION_CONTAINER_SELECTOR}`);
        }
        let text = questionElement.innerText;
        if (!text || text.trim().length === 0) {
            throw new Error('抓取到的题目文本为空。');
        }

        // 收集所有CSS类名
        let clsStr = questionElement.className || "";
        const allElements = questionElement.querySelectorAll('*');
        for (let i = 0; i < allElements.length; i++) {
            if (allElements[i].className && typeof allElements[i].className === 'string') {
                clsStr += " " + allElements[i].className;
            }
        }
        clsStr = clsStr.toLowerCase();

        // DOM结构特征检测 (更可靠的题型判断)
        const hasRecordBtn = !!questionElement.querySelector('.ucomp-recorder');
        const hasRecordIcon = !!questionElement.querySelector('.record-icon.button-record');
        const hasScoreLayout = !!questionElement.querySelector('.score_layout');
        const hasSentenceBlock = !!questionElement.querySelector('.oral-study-sentence');
        const hasPersonalState = !!questionElement.querySelector('.p-oral-personal-state');
        const hasAudioOrigin = !!questionElement.querySelector('.audio-origin');
        const hasAudioReplay = !!questionElement.querySelector('.audio-replay');
        const hasRecordButtonGroup = !!questionElement.querySelector('.record-button-group');
        const hasOperate = !!questionElement.querySelector('.operate');
        const hasDubClass = clsStr.includes('dub') || clsStr.includes('video-dub');
        const hasErrorCorrection = !!questionElement.querySelector('.question-revise-mistake, .mistake-atom, .mistake-marker, .revise-mistake-reply-content');

        let localHint = "";
        const sequence = questionElement.querySelector('.sequence-view');

        // 优先用DOM结构判断 (比CSS类名更可靠)
        if (sequence) {
            localHint = "SEQUENCE";
            const prompts = [...sequence.querySelectorAll('.sortable-list-question-no')].map(el => el.innerText.trim());
            const options = [...sequence.querySelectorAll('.sortable-list-wrapper .sequence-reply-view-item-text')].map(el => el.innerText.trim());
            text = `${questionElement.querySelector('.abs-direction')?.innerText || ''}\n题干（按位置对应答案）：\n${prompts.join('\n')}\n选项池（字母是固定标识，不是当前位置）：\n${options.join('\n')}\n返回 type=SEQUENCE，answer 为最终从上到下的选项字母数组，每个选项恰好出现一次。`;
        } else if (hasSentenceBlock && hasRecordBtn && hasScoreLayout) {
            localHint = "SPK_REPETE";
        } else if (hasPersonalState && hasRecordBtn && hasScoreLayout) {
            localHint = "SPK_FREE";
        } else if (hasErrorCorrection) {
            localHint = "ERROR_CORRECTION";
        } else if (questionElement.querySelectorAll('.question-inputbox textarea').length > 1) {
            localHint = "FILL_IN_BLANK";
            text += `\n[逐题回答：共有 ${questionElement.querySelectorAll('.question-inputbox textarea').length} 个独立答题框，answer 必须为等长字符串数组，每个元素回答对应题目。]`;
        } else if (hasDubClass && hasRecordBtn) {
            // 视频配音题 (.question-video-dub-pc + .operate)
            localHint = "SPK_REPETE";
        } else if (hasRecordBtn && hasScoreLayout) {
            localHint = clsStr.includes('free') ? "SPK_FREE" : "SPK_REPETE";
        } else {
            // 回退到CSS类名判断
            if (clsStr.includes('discussion')) {
                localHint = "OPEN_DISCUSSION";
            } else if (clsStr.includes('question-revise-mistake') || clsStr.includes('mistake-atom') || clsStr.includes('revise-mistake')) {
                localHint = "ERROR_CORRECTION";
            } else if (clsStr.includes('fill-blank') || clsStr.includes('inputbox')) {
                localHint = "FILL_IN_BLANK";
            } else if (clsStr.includes('choice')) {
                localHint = "SINGLE 或 MULTIPLE";
            } else if (clsStr.includes('score_layout')) {
                localHint = clsStr.includes('oral-personal') || clsStr.includes('p-oral') || clsStr.includes('free')
                    ? "SPK_FREE" : "SPK_REPETE";
            } else if (clsStr.includes('dub')) {
                localHint = "SPK_REPETE";
            }
        }

        // 附加DOM特征信息帮助LLM更准确判断
        const features = [];
        if (hasRecordButtonGroup) features.push("有录音按钮组");
        if (hasScoreLayout) features.push("有评分区域");
        if (hasAudioOrigin) features.push("有原音播放");
        if (hasSentenceBlock) features.push("有跟读句子块");
        if (hasPersonalState) features.push("有自由回复区域");
        if (hasDubClass) features.push("有视频配音");
        if (hasOperate) features.push("有操作按钮区");
        if (hasErrorCorrection) features.push("有改错区域");

        if (localHint) {
            const featureStr = features.length > 0 ? ` [特征: ${features.join(", ")}]` : '';
            text = `[系统线索：题型可能是 ${localHint}${featureStr}]\n\n` + text;
        }
        return text;
    }

    // --- API 调用函数 ---
    // --- 转录缓存：只保存合法且非空的完整响应 ---
    function transcriptText(raw) {
        const body = JSON.parse(raw);
        if (!Array.isArray(body.transcription) ||
            !body.transcription.every(s => s && typeof s.text === 'string')) {
            throw new Error('转录响应格式无效');
        }
        return body.transcription.map(s => s.text.trim()).join(' ').trim();
    }

    function readTranscriptCache() {
        try {
            const records = GM_getValue(TRANSCRIPT_CACHE_KEY, []);
            if (!Array.isArray(records)) return [];
            return records.filter(r => {
                try {
                    return typeof r.key === 'string' && Number.isFinite(r.created) &&
                        Number.isFinite(r.used) && Date.now() - r.created < TRANSCRIPT_CACHE_TTL &&
                        !!transcriptText(r.text);
                } catch (_) { return false; }
            });
        } catch (error) {
            console.warn('[Unipus AI] 转录缓存读取失败', error);
            return [];
        }
    }

    function writeTranscriptCache(records) {
        try {
            records.sort((a, b) => b.used - a.used);
            GM_setValue(TRANSCRIPT_CACHE_KEY, records.slice(0, TRANSCRIPT_CACHE_LIMIT));
        } catch (error) { console.warn('[Unipus AI] 转录缓存写入失败', error); }
    }

    async function getTranscript(url, isAudio, forceRefresh = false) {
        await endpointConfigReady;
        const endpoint = isAudio ? API_URL : VIDEO_API_URL;
        const version = transcriptionCacheVersion;
        const key = JSON.stringify([endpoint, isAudio ? 'audio' : 'video', url, version]);
        const pending = pendingTranscripts.get(key);
        if (pending) {
            const result = await pending.promise;
            if (!forceRefresh || pending.refresh) return result;
            return getTranscript(url, isAudio, true);
        }
        const promise = (async () => {
            const records = readTranscriptCache();
            const found = version && !forceRefresh && records.find(r => r.key === key);
            if (found) {
                found.used = Date.now();
                writeTranscriptCache(records);
                return { text: found.text, cache: '前端' };
            }
            const result = await sendToApi(url, isAudio, forceRefresh, endpoint);
            const text = transcriptText(result.text);
            if (version && text) {
                const latest = readTranscriptCache().filter(r => r.key !== key);
                latest.push({ key, text: result.text, created: Date.now(), used: Date.now() });
                writeTranscriptCache(latest);
            }
            return result;
        })();
        pendingTranscripts.set(key, { promise, refresh: forceRefresh });
        try { return await promise; }
        finally { pendingTranscripts.delete(key); }
    }

    function sendToApi(audioUrl, is_audio, forceRefresh = false, apiEndpoint = null) {
        return new Promise((resolve, reject) => {
            let a_url = apiEndpoint || (is_audio ? API_URL : VIDEO_API_URL);
            const payload = {};
            payload[API_JSON_PAYLOAD_KEY] = audioUrl;
            payload.force_refresh = forceRefresh;

            GM.xmlHttpRequest({
                method: 'POST',
                url: a_url,
                data: JSON.stringify(payload),
                headers: { 'Content-Type': 'application/json' },
                onload: (response) => {
                    if (response.status >= 200 && response.status < 300) {
                        resolve({ text: response.responseText, cache:
                            /^X-Transcript-Cache:\s*hit\s*$/im.test(response.responseHeaders || '') ? '后端' : null });
                    } else {
                        let errorMsg = `API 错误: ${response.status}`;
                        try {
                            const errData = JSON.parse(response.responseText);
                            if (errData.message) errorMsg += ` - ${errData.message}`;
                        } catch (e) {
                            if (response.responseText) errorMsg += ` - ${response.responseText.substring(0, 200)}`;
                        }
                        reject(new Error(errorMsg));
                    }
                },
                onerror: (error) => {
                    reject(new Error(`网络错误: 无法连接到 ${a_url}`));
                }
            });
        });
    }

    function sendToLlmApi(questionsText, transcriptText) {
        return new Promise((resolve, reject) => {
            GM.xmlHttpRequest({
                method: 'POST',
                url: LLM_API_URL,
                data: JSON.stringify({ questions: questionsText, transcript: transcriptText }),
                headers: { 'Content-Type': 'application/json' },
                onload: (response) => {
                    if (response.status >= 200 && response.status < 300) {
                        resolve(response.responseText);
                    } else {
                        reject(new Error(`LLM API 错误: ${response.status}`));
                    }
                },
                onerror: () => reject(new Error('网络错误: 无法连接到 LLM API'))
            });
        });
    }

    function sendToLlmOnlyApi(questionsText) {
        return new Promise((resolve, reject) => {
            GM.xmlHttpRequest({
                method: 'POST',
                url: LLM_ONLY_API_URL,
                data: JSON.stringify({ questions: questionsText, transcript: '' }),
                headers: { 'Content-Type': 'application/json' },
                onload: (response) => {
                    if (response.status >= 200 && response.status < 300) {
                        resolve(response.responseText);
                    } else {
                        reject(new Error(`LLM API 错误: ${response.status}`));
                    }
                },
                onerror: () => reject(new Error('网络错误: 无法连接到 LLM API'))
            });
        });
    }

    // --- TTS 相关函数 ---
    function prepareTTSText(text) {
        // 只清理行首题号；分隔符后是数字时保留小数和日期。
        return text.replace(/^[ \t]*(?:[0-9０-９]+[.．、)）]|[(（][0-9０-９]+[)）])(?:[ \t]+|(?=[A-Za-z\u4e00-\u9fff])|$)/gm, '').trim();
    }

    function sendToTTSApi(text, lengthScale) {
        return new Promise((resolve, reject) => {
            text = prepareTTSText(text);
            if (!text) {
                reject(new Error('去除题号后文本为空'));
                return;
            }
            GM.xmlHttpRequest({
                method: 'POST',
                url: TTS_API_URL,
                data: JSON.stringify({ text, length_scale: lengthScale || ttsLengthScale }),
                headers: { 'Content-Type': 'application/json' },
                onload: (response) => {
                    if (response.status >= 200 && response.status < 300) {
                        resolve(JSON.parse(response.responseText));
                    } else {
                        reject(new Error(`TTS API 错误: ${response.status}`));
                    }
                },
                onerror: () => reject(new Error('网络错误: 无法连接到 TTS API'))
            });
        });
    }

    function downloadAudioBlob(relativeUrl) {
        return new Promise((resolve, reject) => {
            const fullUrl = relativeUrl.startsWith('http') ? relativeUrl : API_BASE_URL + relativeUrl;
            GM.xmlHttpRequest({
                method: 'GET',
                url: fullUrl,
                responseType: 'blob',
                onload: (response) => {
                    if (response.status >= 200 && response.status < 300) {
                        resolve(response.response);
                    } else {
                        reject(new Error(`音频下载失败: ${response.status}`));
                    }
                },
                onerror: () => reject(new Error('网络错误: 无法下载音频文件'))
            });
        });
    }

    function createTTSButton(onClick) {
        const btnWrap = document.createElement('div');
        btnWrap.className = 'ua-tts-btn';
        btnWrap.style.cssText = 'margin-right:12px;font-size:35px;color:#6366f1;display:flex;align-items:center;cursor:pointer;';

        const btn = document.createElement('span');
        btn.className = 'audio-control-box';
        btn.style.cssText = 'display:flex;cursor:pointer;color:#6366f1;position:relative;width:35px;height:35px;';
        btn.innerHTML = ICONS.tts;
        btn.title = 'TTS自动录音';
        btn.querySelector('svg').style.cssText = 'width:28px;height:28px;';

        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            onClick();
        });

        btnWrap.appendChild(btn);
        return btnWrap;
    }

    function injectTTSButtons() {
        // 类型1: .record-button-group (跟读/自由回复)
        document.querySelectorAll('.record-button-group:not(.ua-tts-injected)').forEach((group, index) => {
            group.classList.add('ua-tts-injected');
            group.appendChild(createTTSButton(() => autoTTSRecord(index, group)));
        });

        // 类型2: .operate 容器 (视频配音等嵌入口语题, 无 .record-button-group)
        document.querySelectorAll('.operate:not(.ua-tts-injected)').forEach((operate, index) => {
            if (!operate.querySelector('.ucomp-recorder')) return;
            operate.classList.add('ua-tts-injected');
            const item = operate.closest('.item');
            operate.appendChild(createTTSButton(() => autoDubRecord(index, item || operate)));
        });
    }

    // 缓存React根容器
    let _reactRoot = null;
    function getReactRoot() {
        if (_reactRoot) return _reactRoot;
        const allEls = document.querySelectorAll('*');
        for (const el of allEls) {
            if (Object.keys(el).some(k => k.startsWith('__reactContainer$'))) {
                _reactRoot = el;
                return el;
            }
        }
        return document.body;
    }

    // 通过React事件委托系统触发点击
    function simulateFullClick(el) {
        const root = getReactRoot();
        const rect = el.getBoundingClientRect();
        const evtOpts = {
            bubbles: true, cancelable: true, view: unsafeWindow,
            clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
            screenX: rect.left + rect.width / 2, screenY: rect.top + rect.height / 2,
            button: 0, buttons: 1, pointerId: 1, isPrimary: true
        };
        ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(evtType => {
            const EvtClass = evtType.startsWith('pointer') ? PointerEvent : MouseEvent;
            const evt = new EvtClass(evtType, evtOpts);
            Object.defineProperty(evt, 'target', { value: el, writable: false });
            root.dispatchEvent(evt);
        });
    }

    async function autoTTSRecord(index, recordGroup) {
        // 1. 检测题型 (基于页面DOM特征)
        const sentenceBlocks = document.querySelectorAll('.oral-study-sentence');
        const freeBlocks = document.querySelectorAll('.p-oral-personal-state');
        const hasRecordBtn = !!recordGroup.querySelector('.ucomp-recorder');
        const hasScoreLayout = !!recordGroup.querySelector('.score_layout');

        // 判断题型: .oral-study-sentence = 跟读(SPK_REPETE), .p-oral-personal-state = 自由回复(SPK_FREE)
        const isRepeatType = !!sentenceBlocks[index];
        const isFreeType = !isRepeatType && !!freeBlocks[index];

        // 2. 提取文本 (只取英文部分，跳过中文翻译)
        let ttsText = '';
        if (isRepeatType) {
            const firstView = sentenceBlocks[index].querySelector('.sentence-html-container .component-htmlview');
            if (firstView) ttsText = firstView.innerText.trim();
        } else if (isFreeType) {
            const firstView = freeBlocks[index]?.querySelector('.component-htmlview');
            if (firstView) ttsText = firstView.innerText.trim();
        }

        if (!ttsText) {
            showToast('未找到文本', 'error');
            return;
        }

        // 3. 自由回复题型: 需要先经过LLM生成回复文本
        if (isFreeType) {
            showToast('正在生成LLM回复...', 'info');
            updateStatus('正在生成LLM回复...', 'loading');
            try {
                // 构造题型提示, 确保LLM将朗读文本放在answer字段
                const typeHint = `[系统线索：题型是 SPK_FREE (听力自由回答)]\n\n`;
                const llmRespText = await sendToLlmOnlyApi(typeHint + ttsText);
                const llmResp = JSON.parse(llmRespText);
                const answerData = llmResp.answer;
                // 优先取 answer 字段 (实际朗读文本)
                if (typeof answerData === 'object' && !Array.isArray(answerData)) {
                    if (typeof answerData.answer === 'string' && answerData.answer.trim()) {
                        ttsText = answerData.answer.trim();
                    } else if (Array.isArray(answerData.answer) && answerData.answer.length > 0) {
                        ttsText = String(answerData.answer[0]).trim();
                    } else if (typeof answerData.reply === 'string' && answerData.reply.trim()) {
                        ttsText = answerData.reply.trim();
                    } else {
                        ttsText = JSON.stringify(answerData);
                    }
                } else if (Array.isArray(answerData) && answerData.length > 0) {
                    ttsText = String(answerData[0]).trim();
                } else if (typeof answerData === 'string' && answerData.trim()) {
                    ttsText = answerData.trim();
                }
                showToast('LLM回复已生成', 'success');
            } catch (e) {
                showToast(`LLM请求失败: ${e.message}`, 'error');
                updateStatus('LLM请求失败', 'error');
                return;
            }
        }

        // 3. 请求后端生成TTS音频
        showToast('正在生成TTS音频...', 'info');
        updateStatus('正在生成TTS音频...', 'loading');
        let audioUrl;
        try {
            const ttsResp = await sendToTTSApi(ttsText);
            audioUrl = ttsResp.audio_url;
        } catch (e) {
            showToast(`TTS生成失败: ${e.message}`, 'error');
            updateStatus('TTS生成失败', 'error');
            return;
        }

        // 4. 下载音频Blob
        try {
            _ua_audioBlob = await downloadAudioBlob(audioUrl);
        } catch (e) {
            showToast(`音频下载失败: ${e.message}`, 'error');
            updateStatus('音频下载失败', 'error');
            return;
        }

        // 5. 找到录音按钮
        const recordBtn = recordGroup.querySelector('.ucomp-recorder');
        if (!recordBtn) {
            showToast('未找到录音按钮', 'error');
            return;
        }

        // 6. 设置拦截标志
        _ua_audioReplace = true;
        _ua_audioDuration = 0;
        showToast('开始TTS录音...', 'info');
        updateStatus('TTS录音中...', 'loading');

        // 7. 延迟后自动开始录音
        await new Promise(r => setTimeout(r, 500));
        const innerBtn = recordGroup.querySelector('.record-icon.button-record') || recordBtn;
        simulateFullClick(innerBtn);

        // 8. 等待获取音频时长后自动停止
        const waitForDuration = async () => {
            for (let i = 0; i < 50; i++) {
                if (_ua_audioDuration > 0) break;
                await new Promise(r => setTimeout(r, 100));
            }
            if (_ua_audioDuration <= 0) _ua_audioDuration = 8;
            const stopDelay = (_ua_audioDuration + 1.5) * 1000;
            setTimeout(() => {
                simulateFullClick(innerBtn);
                _ua_audioReplace = false;
                _ua_audioBlob = null;
                showToast('TTS录音完成', 'success');
                updateStatus('TTS录音完成', 'success');
            }, stopDelay);
        };
        waitForDuration();
    }

    // 视频配音等嵌入口语题 (.operate 容器, 无 .record-button-group)
    async function autoDubRecord(index, itemEl) {
        // 1. 提取文本: .item 内的 .component-htmlview > p
        const textEl = itemEl.querySelector('.component-htmlview p');
        if (!textEl) {
            showToast('未找到文本', 'error');
            return;
        }
        const ttsText = textEl.innerText.trim();
        if (!ttsText) {
            showToast('文本为空', 'error');
            return;
        }

        // 2. 生成TTS音频
        showToast('正在生成TTS音频...', 'info');
        updateStatus('正在生成TTS音频...', 'loading');
        let audioUrl;
        try {
            const ttsResp = await sendToTTSApi(ttsText);
            audioUrl = ttsResp.audio_url;
        } catch (e) {
            showToast(`TTS生成失败: ${e.message}`, 'error');
            updateStatus('TTS生成失败', 'error');
            return;
        }

        // 3. 下载音频Blob
        try {
            _ua_audioBlob = await downloadAudioBlob(audioUrl);
        } catch (e) {
            showToast(`音频下载失败: ${e.message}`, 'error');
            updateStatus('音频下载失败', 'error');
            return;
        }

        // 4. 找到录音按钮
        const recordBtn = itemEl.querySelector('.ucomp-recorder');
        if (!recordBtn) {
            showToast('未找到录音按钮', 'error');
            return;
        }

        // 5. 设置拦截并开始录音
        _ua_audioReplace = true;
        _ua_audioDuration = 0;
        showToast('开始TTS录音...', 'info');
        updateStatus('TTS录音中...', 'loading');

        await new Promise(r => setTimeout(r, 500));
        const innerBtn = itemEl.querySelector('.record-icon.button-record') || recordBtn;
        simulateFullClick(innerBtn);

        // 6. 等待音频播放完自动停止
        const waitForDuration = async () => {
            for (let i = 0; i < 50; i++) {
                if (_ua_audioDuration > 0) break;
                await new Promise(r => setTimeout(r, 100));
            }
            if (_ua_audioDuration <= 0) _ua_audioDuration = 8;
            const stopDelay = (_ua_audioDuration + 1.5) * 1000;
            setTimeout(() => {
                simulateFullClick(innerBtn);
                _ua_audioReplace = false;
                _ua_audioBlob = null;
                showToast('TTS录音完成', 'success');
                updateStatus('TTS录音完成', 'success');
            }, stopDelay);
        };
        waitForDuration();
    }

    // --- 主执行函数 ---
    async function runTranscription(forceRefresh = false) {
        forceRefresh = forceRefresh === true;
        refreshTranscriptButton.disabled = true;
        triggerButton.disabled = true;
        triggerButton.querySelector('.ua-btn-text').textContent = '转录中...';
        triggerButton.classList.add('ua-loading');
        updateStatus('正在查找媒体链接...', 'loading');

        llmButton.style.display = 'none';
        currentTranscript = "";
        let formattedTranscript = "";

        try {
            updateStatus('1. 正在通过 XPath 查找媒体链接...');
            let xpathResult = null;
            let is_audio = false;

            for (let xpath of VIDEO_XPATHS) {
                xpathResult = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                if (xpathResult?.singleNodeValue?.textContent.trim()) break;
            }

            if (!xpathResult?.singleNodeValue?.textContent.trim()) {
                is_audio = true;
                for (let xpath of AUDIO_XPATHS) {
                    xpathResult = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                    if (xpathResult?.singleNodeValue?.textContent.trim()) break;
                }
                if (!xpathResult?.singleNodeValue?.textContent.trim()) {
                    throw new Error('未找到有效的媒体链接');
                }
            }

            let audioUrl = xpathResult.singleNodeValue.textContent;
            let absoluteAudioUrl = new URL(audioUrl, window.location.href).href;
            updateStatus(`2. 找到链接: ${absoluteAudioUrl.substring(0, 80)}...`);

            updateStatus('3. 正在发送到 API...');
            const result = await getTranscript(absoluteAudioUrl, is_audio, forceRefresh);
            const apiResponseText = result.text;
            if (result.cache) showToast(`使用${result.cache}缓存`, 'success');
            updateStatus('4. 正在解析结果...');

            let responseJson;
            try { responseJson = JSON.parse(apiResponseText); } catch (e) {
                currentTranscript = apiResponseText;
                formattedTranscript = apiResponseText;
            }

            if (responseJson?.transcription && Array.isArray(responseJson.transcription)) {
                const formatTime = (seconds) => {
                    if (typeof seconds !== 'number' || seconds < 0) return '??:??.??';
                    const h = Math.floor(seconds / 3600);
                    const m = Math.floor((seconds % 3600) / 60);
                    const s = Math.floor(seconds % 60);
                    const ms = Math.floor((seconds - Math.floor(seconds)) * 1000);
                    const pad = (num, len = 2) => String(num).padStart(len, '0');
                    let timeStr = `${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
                    if (h > 0) timeStr = `${pad(h)}:${timeStr}`;
                    return timeStr;
                };

                formattedTranscript = responseJson.transcription.map(s => {
                    if (s && typeof s.text !== 'undefined') {
                        return `[${formatTime(s.start)} → ${formatTime(s.end)}] ${s.text.trim()}`;
                    }
                    return '';
                }).join('\n');

                currentTranscript = responseJson.transcription.map(s => s.text ? s.text.trim() : '').join(' ');
            } else if (apiResponseText && !formattedTranscript) {
                currentTranscript = apiResponseText;
                formattedTranscript = apiResponseText;
            }

            if (formattedTranscript) {
                updateStatus(formattedTranscript, 'success', formattedTranscript);
                llmButton.style.display = 'inline-flex';
                showToast('转录完成', 'success');
            } else {
                updateStatus('转录成功，但未返回文本内容', 'success');
            }
        } catch (error) {
            console.error('转录出错:', error);
            updateStatus(`错误: ${error.message}`, 'error');
            showToast('转录失败', 'error');
        } finally {
            refreshTranscriptButton.disabled = false;
            triggerButton.disabled = false;
            triggerButton.querySelector('.ua-btn-text').textContent = '转录';
            triggerButton.classList.remove('ua-loading');
        }
    }

    async function getAnswersWithTranscript() {
        llmButton.disabled = true;
        llmButton.querySelector('.ua-btn-text').textContent = '思考中...';
        llmButton.classList.add('ua-loading');
        showAnswerBox('正在准备数据...', 'loading');

        try {
            updateAnswerStatus('1. 正在抓取题目...');
            const questionsText = scrapeQuestions();

            if (!currentTranscript) {
                throw new Error('请先运行转录');
            }
            updateAnswerStatus('2. 正在发送到 LLM...');

            const llmResponseText = await sendToLlmApi(questionsText, currentTranscript);
            updateAnswerStatus('3. 正在解析结果...');

            let responseJson;
            try { responseJson = JSON.parse(llmResponseText); } catch (e) {
                throw new Error(`LLM 返回无效 JSON`);
            }

            const answerData = responseJson[LLM_ANSWER_KEY];
            if (typeof answerData === 'undefined') {
                throw new Error(`响应中缺少 "${LLM_ANSWER_KEY}" 字段`);
            }

            const displayText = typeof answerData === 'object' ? JSON.stringify(answerData, null, 2) : answerData;
            updateAnswerStatus(displayText, 'success');
            await autoFillAnswer(answerData);
            showToast('答案获取成功', 'success');

        } catch (error) {
            console.error('获取答案出错:', error);
            updateAnswerStatus(`错误: ${error.message}`, 'error');
            showToast('获取答案失败', 'error');
        } finally {
            llmButton.disabled = false;
            llmButton.querySelector('.ua-btn-text').textContent = '重新获取';
            llmButton.classList.remove('ua-loading');
        }
    }

    async function getAnswersOnly() {
        llmOnlyButton.disabled = true;
        llmOnlyButton.querySelector('.ua-btn-text').textContent = '思考中...';
        llmOnlyButton.classList.add('ua-loading');
        showAnswerBox('正在准备数据...', 'loading');

        try {
            updateAnswerStatus('1. 正在抓取题目...');
            const questionsText = scrapeQuestions();
            updateAnswerStatus('2. 正在发送到 LLM...');

            const llmResponseText = await sendToLlmOnlyApi(questionsText);
            updateAnswerStatus('3. 正在解析结果...');

            let responseJson;
            try { responseJson = JSON.parse(llmResponseText); } catch (e) {
                throw new Error(`LLM 返回无效 JSON`);
            }

            const answerData = responseJson[LLM_ANSWER_KEY];
            if (typeof answerData === 'undefined') {
                throw new Error(`响应中缺少 "${LLM_ANSWER_KEY}" 字段`);
            }

            const displayText = typeof answerData === 'object' ? JSON.stringify(answerData, null, 2) : answerData;
            updateAnswerStatus(displayText, 'success');
            await autoFillAnswer(answerData);
            showToast('答案获取成功', 'success');

        } catch (error) {
            console.error('获取答案出错:', error);
            updateAnswerStatus(`错误: ${error.message}`, 'error');
            showToast('获取答案失败', 'error');
        } finally {
            llmOnlyButton.disabled = false;
            llmOnlyButton.querySelector('.ua-btn-text').textContent = '重新获取';
            llmOnlyButton.classList.remove('ua-loading');
        }
    }

    // --- 自动填充逻辑 ---
    function setNativeValue(element, value) {
        const view = element.ownerDocument.defaultView;
        const prototype = element.tagName === 'TEXTAREA' ? view.HTMLTextAreaElement.prototype
            : element.tagName === 'SELECT' ? view.HTMLSelectElement.prototype : view.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
        if (!setter) throw new Error('当前控件不支持填充');
        setter.call(element, value);
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
    }

    async function fillSequence(container, answer) {
        const selector = '.sortable-list-wrapper .sequence-reply-view-item-text';
        const items = () => [...container.querySelectorAll(selector)].filter(el => el.style.position !== 'fixed');
        const label = el => el.querySelector('span')?.textContent.trim().replace(/[.．]$/, '').toUpperCase();
        const original = items().map(label);
        const target = (Array.isArray(answer) ? answer : typeof answer === 'string' ? answer.split(/[\s,，;；|→>\-]+/).filter(Boolean) : [])
            .map(value => String(value).trim().replace(/[.．]$/, '').toUpperCase());
        if (!original.length) throw new Error('未找到可拖动的排序选项（可能处于答案回顾模式）');
        if (target.length !== original.length || new Set(target).size !== original.length || target.some(value => !original.includes(value))) {
            throw new Error('排序答案必须包含所有选项字母，且每个字母仅出现一次');
        }
        const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
        const alreadyOrdered = original.every((value, index) => value === target[index]);
        for (let index = 0; index < target.length; index++) {
            const current = items();
            const from = current.findIndex(el => label(el) === target[index]);
            // An untouched list has no saved answer even when its default order is correct.
            if (from === index && !(alreadyOrdered && index === 0)) continue;
            const source = current[from];
            const destination = current[index];
            source.scrollIntoView({block: 'nearest'});
            destination.scrollIntoView({block: 'nearest'});
            const sourceRect = source.getBoundingClientRect();
            const destinationRect = destination.getBoundingClientRect();
            const view = container.ownerDocument.defaultView;
            const fire = (node, type, rect, buttons) => node.dispatchEvent(new view.MouseEvent(type, {
                bubbles: true, cancelable: true, button: 0, buttons,
                clientX: rect.left + Math.min(30, rect.width / 2), clientY: rect.top + rect.height / 2,
            }));
            // react-sortable-hoc listens on the item for press, then on window for move/release.
            fire(source, 'mousedown', sourceRect, 1);
            try {
                await pause(30);
                fire(view, 'mousemove', destinationRect, 1);
                await pause(120);
            } finally {
                fire(view, 'mouseup', destinationRect, 0);
            }
            await pause(150);
            if (items()[index] && label(items()[index]) === target[index]) continue;
            throw new Error(`排序选项 ${target[index]} 未移动到第 ${index + 1} 位，请检查页面是否允许拖动`);
        }
    }

    async function autoFillAnswer(answerData) {
        try {
            if (!answerData || typeof answerData !== 'object') return;

            const type = answerData.type;
            const answer = answerData.answer;
            const container = document.querySelector(QUESTION_CONTAINER_SELECTOR);
            if (!container) return;

            if (['SEQUENCE', 'SORT', 'SORTING', 'ORDERING', 'MATCHING', 'MATCH'].includes(type) && container.querySelector('.sequence-view')) {
                await fillSequence(container, answer);
            } else if (type === 'SINGLE' || type === 'MULTIPLE') {
                const wraps = container.querySelectorAll('.option-wrap');
                if (wraps.length === 0) return;

                let answerItems = [];
                if (Array.isArray(answer)) {
                    answerItems = answer;
                } else if (typeof answer === 'string') {
                    if (wraps.length === 1) {
                        answerItems = [answer];
                    } else {
                        answerItems = answer.split(/[,\s]+/).filter(x => x.trim().length > 0);
                    }
                }

                for (let i = 0; i < Math.min(wraps.length, answerItems.length); i++) {
                    const wrap = wraps[i];
                    const ansStr = String(answerItems[i]).toUpperCase();
                    const charsToClick = ansStr.match(/[A-Z]/g) || [];

                    wrap.querySelectorAll('.option').forEach(opt => {
                        const captionEl = opt.querySelector('.caption');
                        if (captionEl) {
                            const captionText = captionEl.innerText.trim().toUpperCase();
                            if (charsToClick.includes(captionText)) {
                                opt.click();
                            }
                        }
                    });
                }
            } else if (type === 'FILL_IN_BLANK') {
                const inputs = container.querySelectorAll('input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]), textarea');
                let answerArr = [];
                if (Array.isArray(answer)) {
                    answerArr = answer;
                } else if (typeof answer === 'string') {
                    answerArr = inputs.length === 1 ? [answer] : answer.split('|').map(a => a.trim());
                }
                if (!inputs.length || answerArr.length !== inputs.length) throw new Error('填空答案数量与答题框数量不一致');
                for (let i = 0; i < inputs.length; i++) {
                    setNativeValue(inputs[i], answerArr[i]);
                }
            } else if (type === 'ERROR_CORRECTION') {
                // 改错题: answer 为二维数组 [["需改正的单词", "改正后的单词"], ...]
                // DOM结构: mistake-marker > comp-revise-mistake-reply > mistake-item > mistake-atom.word > mistake-atom-text
                // 交互: 点击单词 → 出现 edit-form-input → 输入修正 → 提交
                if (Array.isArray(answer) && answer.length > 0) {
                    const markers = container.querySelectorAll('.mistake-marker');
                    if (markers.length === 0) {
                        console.warn('[Unipus AI] 未找到 .mistake-marker 元素');
                        return;
                    }
                    for (let i = 0; i < Math.min(markers.length, answer.length); i++) {
                        const pair = answer[i];
                        const wrongWord = Array.isArray(pair) && pair.length >= 1 ? String(pair[0]).trim() : '';
                        const correctedWord = Array.isArray(pair) && pair.length >= 2 ? String(pair[1]).trim() : String(pair).trim();
                        if (!wrongWord || !correctedWord) continue;
                        // 在当前句子中查找错误单词
                        const wordAtoms = markers[i].querySelectorAll('.mistake-atom.word');
                        let targetAtom = null;
                        for (const atom of wordAtoms) {
                            const textEl = atom.querySelector('.mistake-atom-text');
                            if (textEl && textEl.textContent.trim() === wrongWord) {
                                targetAtom = atom;
                                break;
                            }
                        }
                        if (!targetAtom) {
                            console.warn(`[Unipus AI] 句子${i+1}中未找到单词: "${wrongWord}"`);
                            continue;
                        }
                        // 1. 点击单词触发编辑模式
                        targetAtom.click();
                        await new Promise(r => setTimeout(r, 300));
                        // 2. 查找编辑输入框
                        const editForm = markers[i].querySelector('.mistake-item-edit-form .edit-form-input');
                        if (editForm) {
                            setNativeValue(editForm, correctedWord);
                            editForm.dispatchEvent(new Event('blur', { bubbles: true }));
                        } else {
                            // 备选: 尝试直接在句子区域查找新出现的input
                            const newInput = markers[i].querySelector('input:not([type="hidden"])');
                            if (newInput) {
                                setNativeValue(newInput, correctedWord);
                                newInput.dispatchEvent(new Event('blur', { bubbles: true }));
                            }
                        }
                        await new Promise(r => setTimeout(r, 200));
                    }
                }
            } else if (type === 'OPEN_DISCUSSION' || type === 'SPK_FREE' || type === 'SPK_REPETE') {
                const textareas = container.querySelectorAll('textarea');
                if (textareas.length > 1) {
                    if (!Array.isArray(answer) || answer.length !== textareas.length) throw new Error('多个答题框需要逐题返回等长答案数组');
                    for (let i = 0; i < textareas.length; i++) setNativeValue(textareas[i], String(answer[i]));
                    return;
                }
                let answerText = "";
                // 优先取 answer 字段 (实际回答文本), reply 是解题思路
                if (typeof answer === 'string' && answer.trim().length > 0) {
                    answerText = answer;
                } else if (Array.isArray(answer) && answer.length > 0) {
                    answerText = String(answer[0]).trim();
                } else if (typeof answer === 'object' && answer !== null) {
                    if (typeof answer.answer === 'string' && answer.answer.trim()) {
                        answerText = answer.answer.trim();
                    } else if (typeof answer.reply === 'string' && answer.reply.trim()) {
                        answerText = answer.reply.trim();
                    }
                } else if (answerData.reply && typeof answerData.reply === 'string' && answerData.reply.trim().length > 0) {
                    answerText = answerData.reply;
                }

                if (textareas.length > 0) {
                    setNativeValue(textareas[0], answerText);
                } else {
                    const inputs = container.querySelectorAll('input[type="text"]');
                    if (inputs.length > 0) {
                        setNativeValue(inputs[0], answerText);
                    }
                }
            }
        } catch (e) {
            console.error("自动填充异常:", e);
            throw e;
        }
    }

    // --- TTS 按钮注入 ---
    function tryInjectTTSButtons() {
        const hasGroups = document.querySelectorAll('.record-button-group:not(.ua-tts-injected)').length > 0;
        const hasOperates = document.querySelectorAll('.operate:not(.ua-tts-injected) .ucomp-recorder').length > 0;
        if (hasGroups || hasOperates) injectTTSButtons();
    }

    // 多次尝试注入 (页面内容可能延迟加载)
    [500, 2000, 5000].forEach(d => setTimeout(tryInjectTTSButtons, d));

    // MutationObserver 监听动态加载的录音组件
    new MutationObserver(() => {
        const needsInject = document.querySelector('.record-button-group:not(.ua-tts-injected)')
            || document.querySelector('.operate:not(.ua-tts-injected) .ucomp-recorder');
        if (needsInject) tryInjectTTSButtons();
    }).observe(document.documentElement, { childList: true, subtree: true });

    } // end _ua_initUI

    // 等待DOM就绪后初始化UI (先获取 endpoint 配置)
    function _ua_boot() {
        fetchEndpointConfig().then(() => _ua_initUI());
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', _ua_boot);
    } else {
        _ua_boot();
    }

})();
