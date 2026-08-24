#!/usr/bin/env node
/**
 * Verify the VoiceTranscriber BetterDiscord plugin in a mocked environment.
 *
 * The plugin is a standalone (ZeresPluginLibrary-free) BetterDiscord v4
 * plugin: module.exports = class { start/stop/getSettingsPanel }. This harness
 * loads it in plain Node with a stubbed DOM/BdApi/Window and exercises the
 * real load path: factory -> instantiate (settings load) -> start/onStart ->
 * Flux event dispatch -> error bus -> getSettingsPanel -> settings save ->
 * stop/onStop. It catches real runtime wiring errors, not just lint issues.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const assert = require('assert');

const PLUGIN = path.join(__dirname, '..', 'VoiceTranscriber.plugin.js');
const source = fs.readFileSync(PLUGIN, 'utf8');

// ── Tiny functional DOM mock ────────────────────────────────────────────────
class El {
    constructor(tag) {
        this.tagName = String(tag).toUpperCase();
        this.nodeType = 1;
        this.children = [];
        this.style = {};
        this.listeners = {};
        this.attrs = {};
        this.parentNode = null;
        this.className = '';
        this.classList = { add() {}, remove() {}, toggle() {}, contains() { return false; } };
        this.id = '';
        this._text = '';
        this._inner = '';
    }
    set textContent(v) { this._text = String(v); }
    get textContent() { return this._text; }
    set innerHTML(v) { this._inner = String(v); }
    get innerHTML() { return this._inner; }
    set scrollTop(v) { this._scrollTop = v; }
    get scrollTop() { return this._scrollTop || 0; }
    get scrollHeight() { return 100; }
    appendChild(c) {
        if (c && typeof c === 'object') { c.parentNode = this; this.children.push(c); }
        return c;
    }
    prepend(c) { if (c && typeof c === 'object') { c.parentNode = this; this.children.unshift(c); } return c; }
    append(...cs) { cs.forEach(c => this.appendChild(c)); return this; }
    remove() {
        if (this.parentNode) {
            const i = this.parentNode.children.indexOf(this);
            if (i >= 0) this.parentNode.children.splice(i, 1);
        }
        this.parentNode = null;
    }
    removeChild(c) {
        const i = this.children.indexOf(c);
        if (i >= 0) { this.children.splice(i, 1); c.parentNode = null; return c; }
        return null;
    }
    addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
    removeEventListener(t, f) {
        const a = this.listeners[t];
        if (!a) return;
        const i = a.indexOf(f);
        if (i >= 0) a.splice(i, 1);
    }
    dispatch(t, ev) { (this.listeners[t] || []).forEach(f => f(ev)); }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return this.attrs[k] || null; }
    getBoundingClientRect() { return { left: 0, top: 0, right: 100, bottom: 50, width: 100, height: 50 }; }
    _matches(sel) {
        sel = sel.trim();
        if (sel === '*') return true;
        if (sel.startsWith('#')) return this.id === sel.slice(1);
        if (sel.startsWith('.')) return (this.className || '').split(/\s+/).includes(sel.slice(1));
        return this.tagName === sel.toUpperCase();
    }
    querySelector(sel) {
        for (const c of this.children) {
            if (c._matches(sel)) return c;
            const r = c.querySelector(sel);
            if (r) return r;
        }
        return null;
    }
    querySelectorAll(sel) {
        const out = [];
        const walk = n => n.children.forEach(c => { if (c._matches(sel)) out.push(c); walk(c); });
        walk(this);
        return out;
    }
}

const docBody = new El('BODY');
const docHead = new El('HEAD');
const docListeners = {};
const documentMock = {
    createElement: t => new El(t),
    createTextNode: t => ({ textContent: String(t), nodeType: 3 }),
    body: docBody,
    head: docHead,
    addEventListener: (t, f) => { (docListeners[t] = docListeners[t] || []).push(f); },
    removeEventListener: (t, f) => {
        const a = docListeners[t];
        if (!a) return;
        const i = a.indexOf(f);
        if (i >= 0) a.splice(i, 1);
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    documentElement: new El('HTML')
};
const windowMock = {
    innerWidth: 1280,
    innerHeight: 720,
    addEventListener() { },
    removeEventListener() { },
    document: documentMock
};

// Expose bare globals the plugin references (Node 24 already supplies
// FormData / Blob / AbortSignal / fetch).
global.document = documentMock;
global.window = windowMock;
const fakeStream = {
    getAudioTracks: () => [{ stop() { } }],
    getVideoTracks: () => [],
    getTracks: () => [{ stop() { } }]
};
// Node 24 exposes a getter-only global `navigator`; attach mediaDevices to it.
try {
    Object.defineProperty(navigator, 'mediaDevices', {
        value: {
            getUserMedia: async () => fakeStream,
            enumerateDevices: async () => [
                { kind: 'audioinput', deviceId: 'VT-DEV-999', label: 'CABLE Output (VB-Audio Virtual Cable)' },
                { kind: 'audiooutput', deviceId: 'VT-SPK', label: 'Speakers' }
            ]
        },
        configurable: true,
        writable: true
    });
} catch (e) {
    console.warn('verify: could not stub navigator.mediaDevices:', e.message);
}

// ── Mock BetterDiscord API ──────────────────────────────────────────────────
const toasts = [];
const dataStore = {};                 // BdApi.Data backing store
let userInChannel = false;
const users = { U1: { id: 'U1', username: 'Alice', globalName: 'Alice' }, me: { id: 'me', username: 'CurrentUser' } };

const dispatcherHandlers = {};
const mockDispatcher = {
    subscribe: (t, h) => { (dispatcherHandlers[t] = dispatcherHandlers[t] || []).push(h); },
    unsubscribe: (t, h) => {
        const a = dispatcherHandlers[t];
        const i = a ? a.indexOf(h) : -1;
        if (i >= 0) a.splice(i, 1);
    },
    dispatch: (t, data) => { (dispatcherHandlers[t] || []).slice().forEach(h => h(data)); }
};

const webpackCandidates = [
    mockDispatcher, // FluxDispatcher (subscribe + dispatch)
    { // UserStore
        getUser: id => users[id] || null,
        getCurrentUser: () => users.me
    },
    { getVoiceChannelId: () => (userInChannel ? 'C1' : null) }, // SelectedChannelStore
    { getChannel: () => ({ id: 'C1', name: 'General' }) }        // ChannelStore
];

function makeBdApi() {
    return {
        Webpack: {
            getModule: pred => webpackCandidates.find(m => m && pred(m)) || undefined,
            getBulk: () => []
        },
        UI: { showToast: (msg, opts) => toasts.push({ msg, opts }) },
        Data: {
            load(name, key) { return dataStore[name] && dataStore[name][key]; },
            save(name, key, data) { dataStore[name] = dataStore[name] || {}; dataStore[name][key] = data; },
            delete(name) { delete dataStore[name]; },
            clear(name) { delete dataStore[name]; }
        },
        showConfirmationModal: () => { },
        ContextMenu: { patch: () => { }, buildItem: o => ({ props: o }) },
        Plugins: { folder: '/tmp/bd-plugins' },
        React: {},
        Menu: { buildItem: o => ({ props: o }) }
    };
}

function loadPlugin() {
    delete require.cache[require.resolve(PLUGIN)];
    return require(PLUGIN);
}

const results = [];
async function check(name, fn) {
    try {
        await fn();
        results.push({ name, ok: true });
    } catch (e) {
        results.push({ name, ok: false, error: e.message });
        console.error(`  ✗ ${name}:\n    ${e.stack ? e.stack.split('\n').slice(0, 4).join('\n    ') : e.message}`);
    }
}

// ── Run ─────────────────────────────────────────────────────────────────────
(async () => {
    console.log('VoiceTranscriber plugin verification (standalone BD v4)\n');

    await check('node --check passes', () => {
        const { spawnSync } = require('child_process');
        const r = spawnSync(process.execPath, ['--check', PLUGIN], { encoding: 'utf8' });
        assert.strictEqual(r.status, 0, `node --check failed: ${r.stderr}`);
    });
    await check('BD metadata header present', () => {
        const head = source.slice(0, 400);
        ['@name', '@description', '@version', '@authorId'].forEach(k =>
            assert.ok(new RegExp(k + '\\s').test(head), `missing ${k}`));
    });
    await check('no ZeresPluginLibrary dependency', () => {
        assert.ok(!/ZeresPluginLibrary|buildPlugin|extends Plugin/.test(source), 'plugin still depends on ZeresPluginLibrary');
    });

    let plugin;
    await check('plugin loads and exports a standalone plugin class', () => {
        global.BdApi = makeBdApi();
        plugin = loadPlugin();
        assert.strictEqual(typeof plugin, 'function');
        ['start', 'stop', 'load', 'getName', 'getVersion', 'getDescription', 'getAuthor', 'getSettingsPanel'].forEach(m =>
            assert.ok(plugin.prototype[m] && typeof plugin.prototype[m] === 'function', `method ${m} missing`));
    });

    let inst;
    await check('instantiation applies default settings', () => {
        inst = new plugin();
        assert.strictEqual(inst.settings.outputDir, './transcripts', 'default outputDir wrong');
        assert.strictEqual(inst.settings.chunkDuration, 30, 'default chunkDuration wrong');
        assert.strictEqual(inst.settings.silenceThreshold, 1500, 'default silenceThreshold wrong');
        assert.strictEqual(inst.settings.backend, 0, 'default backend wrong');
        assert.ok(inst.globalErrorHandler && typeof inst.globalErrorHandler.emit === 'function', 'error handler missing');
    });

    await check('settings persist through BdApi.Data across instances', () => {
        inst.settings.apiKey = 'sk-test-abc';
        inst.settings.outputDir = 'C:/tmp/out';
        inst.saveSettings();
        const reloaded = new plugin();          // simulates a fresh load reading saved settings
        assert.strictEqual(reloaded.settings.apiKey, 'sk-test-abc', 'apiKey not persisted');
        assert.strictEqual(reloaded.settings.outputDir, 'C:/tmp/out', 'outputDir not persisted');
        // reset for later tests
        dataStore['VoiceTranscriber'] = undefined;
        inst.settings = Object.assign({}, inst.settings, { backend: 0, localServerUrl: 'http://localhost:9000' });
    });

    await check('getSettingsPanel builds a DOM panel without throwing', () => {
        const panel = inst.getSettingsPanel();
        assert.ok(panel && panel.appendChild, 'panel is not a DOM element');
        assert.ok(panel.querySelectorAll('*').length > 0, 'panel has no settings controls');
    });

    await check('start()/onStart() runs without throwing', async () => {
        await inst.onStart();
        assert.ok(inst.sessionController && typeof inst.sessionController.startRecording === 'function', 'sessionController not wired');
        assert.ok(inst.voiceTracker, 'voiceTracker not initialized');
        assert.ok(inst._FluxDispatcher, 'FluxDispatcher not resolved');
        assert.ok(inst.uiOverlay && typeof inst.uiOverlay.setToggleHandler === 'function', 'overlay control not wired');
        assert.strictEqual(typeof inst._toggleRecording, 'function', 'toggleRecording not wired');
    });
    await check('Flux events subscribed', () => {
        assert.ok((dispatcherHandlers['SPEAKING'] || []).length >= 1, 'SPEAKING not subscribed');
        assert.ok((dispatcherHandlers['VOICE_STATE_UPDATES'] || []).length >= 1, 'VOICE_STATE_UPDATES not subscribed');
    });

    await check('participant tracked on VOICE_STATE_UPDATES', () => {
        userInChannel = true;
        mockDispatcher.dispatch('VOICE_STATE_UPDATES', { voiceStates: [{ userId: 'U1', channelId: 'C1' }] });
        assert.ok(inst.voiceTracker.getParticipants().has('U1'), 'U1 not added as participant');
    });
    await check('speaking indicator flips on SPEAKING', () => {
        mockDispatcher.dispatch('SPEAKING', { userId: 'U1', speaking: true });
        const p = inst.voiceTracker.getParticipants().get('U1');
        assert.ok(p && p.isSpeaking === true, 'isSpeaking not true');
        mockDispatcher.dispatch('SPEAKING', { userId: 'U1', speaking: false });
        assert.strictEqual(inst.voiceTracker.getParticipants().get('U1').isSpeaking, false, 'isSpeaking not reset');
    });

    await check('mixed-stream chunks attribute to the speaking participant', async () => {
        const sc = inst.sessionController;
        sc.recordSpeaking('U1', 'Alice', true);
        await new Promise(r => setTimeout(r, 15));   // produce a real (non-zero-length) segment
        sc.recordSpeaking('U1', 'Alice', false);
        const attrib = sc._attributeSpeaker(Date.now() - 1000, Date.now() + 1000);
        assert.ok(attrib && attrib.userId === 'U1', 'attribution did not pick U1');
        assert.ok(attrib && attrib.username === 'Alice', 'attribution lost the username');
    });

    await check('error bus routes to session error log', () => {
        const before = inst.sessionController._errorLog.length;
        inst.globalErrorHandler.emit('network_error', 'boom', {});
        assert.ok(inst.sessionController._errorLog.length > before, 'session error log not fed');
        const last = inst.sessionController._errorLog[inst.sessionController._errorLog.length - 1];
        assert.strictEqual(last.type, 'network_error', 'wrong error type routed');
        assert.strictEqual(last.message, 'boom', 'wrong error message routed');
        assert.ok(toasts.some(t => /boom/.test(t.msg)), 'no toast emitted for error');
    });

    await check('captures the selected loopback + mic as two separate streams', async () => {
        const ac = inst.audioCapture;
        assert.strictEqual(typeof ac.setDevice, 'function', 'setDevice missing');
        ac.setDevice('VT-DEV-999');
        const ok = await ac.start('C1');
        assert.strictEqual(ok, true, 'audio capture start returned false');
        const streams = ac.getActiveStreams();
        assert.strictEqual(streams.size, 2, 'expected TWO streams (call mix + mic)');
        assert.ok(streams.has('call_audio'), 'missing the call/group stream key');
        assert.ok(streams.has('me'), 'missing the local-user mic stream key');
        assert.strictEqual(ac.isFallbackMode(), true, 'expected fallback mode');
    });

    await check('auto-detects a virtual-cable loopback when no device chosen', async () => {
        const ac = inst.audioCapture;
        ac.stop();
        ac.setDevice('');          // no manual choice -> autodetect cable
        const ok = await ac.start('C1');
        assert.strictEqual(ok, true, 'autodetect capture start returned false');
        assert.strictEqual(ac.getActiveStreams().size, 2, 'expected two streams from autodetect');
    });

    await check('onStop() cleans up', () => {
        assert.doesNotThrow(() => inst.stop());   // BD entry point
        inst.onStop();
        assert.strictEqual(inst._recordButton, null, 'record button not removed');
        assert.strictEqual(inst._dispatcherUnsubscribes.length, 0, 'dispatcher unsubscribes not drained');
    });

    // Restore
    delete global.BdApi;

    // ── Report ──────────────────────────────────────────────────────────────
    const pass = results.filter(r => r.ok).length;
    const fail = results.filter(r => !r.ok);
    for (const r of results) {
        if (r.ok) console.log(`  ✓ ${r.name}`);
        else console.log(`  ✗ ${r.name}  [${r.error}]`);
    }
    console.log(`\n${pass}/${results.length} checks passed.`);
    if (fail.length) { console.error(`\nFAILED: ${fail.length} check(s).`); process.exitCode = 1; }
    else { console.log('ALL CHECKS PASSED.'); }
})();