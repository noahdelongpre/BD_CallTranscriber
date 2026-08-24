/**
 * @name VoiceTranscriber
 * @version 0.1.0
 * @description Transcribes voice call audio per-user to text files.
 * @author Killerishere
 * @authorId 0
 * @source https://github.com/noahdelongpre/BD_CallTranscriber
 */

/*@cc_on @*/
/*@if (@_jscript_version >= 10)@*/

module.exports = (() => {
    // Flat default settings (persisted per-plugin via BdApi.Data; no library dependency).
    const DEFAULTS = {
        outputDir: "./transcripts",
        apiKey: "",
        backend: 0,                    // 0 = OpenAI Whisper API, 1 = Local Whisper Server
        localServerUrl: "http://localhost:9000",
        outputFormat: 0,               // 0 = txt, 1 = md, 2 = json
        chunkDuration: 30,
        silenceThreshold: 1500,
        minChunkDuration: 1,           // earliest flush (seconds) once trailing silence is hit
        flushSilenceMs: 2000,          // quiet period that ends a chunk early
        audioInputDeviceId: ""         // capture device (e.g. VB-Cable loopback); "" = default input
    };
    const PLUGIN_NAME = "VoiceTranscriber";
    const PLUGIN_VERSION = "0.1.0";

    // Stream key for the loopback/group mix (Discord's call output). The user's own
    // microphone is captured as a SEPARATE stream keyed to the local user id, so both
    // the caller's voice and the rest of the call can be transcribed without routing
    // the mic through the cable (which would cause echo/feedback).
    const MIXED_CALL_STREAM_KEY = 'call_audio';

            // VoiceStateTracker: maintains a Map of voice channel participants
            class VoiceStateTracker {
                constructor() {
                    this.participants = new Map();
                }

                addParticipant(userId, username, displayName) {
                    if (!this.participants.has(userId)) {
                        this.participants.set(userId, {
                            userId,
                            username,
                            displayName,
                            isSpeaking: false,
                            speakingStartedAt: null,
                            joinedAt: Date.now()
                        });
                    }
                }

                removeParticipant(userId) {
                    this.participants.delete(userId);
                }

                setSpeaking(userId, speaking) {
                    const participant = this.participants.get(userId);
                    if (participant) {
                        participant.isSpeaking = speaking;
                        participant.speakingStartedAt = speaking ? Date.now() : null;
                    }
                }

                getParticipants() {
                    return this.participants;
                }

                clear() {
                    this.participants.clear();
                }
            }

            // AudioCaptureEngine: captures per-user audio streams via WebRTC
            class AudioCaptureEngine {
                constructor() {
                    this._capturing = false;
                    this._fallbackMode = false;
                    this._channelId = null;
                    this._streams = new Map();           // userId -> MediaStream
                    this._voiceConnection = null;
                    this._peerConnection = null;
                    this._mediaEngine = null;
                    this._ssrcToUserMap = null;           // module with ssrc-to-user mapping
                    this._localStream = null;
                    this._localUserId = null;
                    this._trackCleanup = [];              // cleanup callbacks
                    this._pollInterval = null;
                    this._deviceId = '';                  // selected capture device
                }

                // --- Discord internal module resolution ---

                _findVoiceConnection() {
                    // Strategy A: look for a module with getVoiceConnection or voiceConnections
                    try {
                        const voiceMod = BdApi.Webpack.getModule(
                            m => m && (typeof m.getVoiceConnection === 'function' || m.voiceConnections instanceof Map)
                        );
                        if (voiceMod) {
                            console.log('[VoiceTranscriber] AudioCapture: found voice connection module (strategy A)');
                            if (typeof voiceMod.getVoiceConnection === 'function') {
                                const conn = voiceMod.getVoiceConnection(this._channelId);
                                if (conn) return conn;
                            }
                            if (voiceMod.voiceConnections instanceof Map) {
                                const conn = voiceMod.voiceConnections.get(this._channelId)
                                    || voiceMod.voiceConnections.values().next().value;
                                if (conn) return conn;
                            }
                        }
                    } catch (e) {
                        console.warn('[VoiceTranscriber] AudioCapture: strategy A failed:', e.message);
                    }

                    // Strategy B: look for MediaEngine or mediaEngine
                    try {
                        const mediaMod = BdApi.Webpack.getModule(
                            m => m && (m.MediaEngine || m.mediaEngine || typeof m.getMediaEngine === 'function')
                        );
                        if (mediaMod) {
                            console.log('[VoiceTranscriber] AudioCapture: found media engine module (strategy B)');
                            const engine = mediaMod.MediaEngine || mediaMod.mediaEngine
                                || (typeof mediaMod.getMediaEngine === 'function' ? mediaMod.getMediaEngine() : null);
                            if (engine) {
                                this._mediaEngine = engine;
                                // Try to get the voice connection from the media engine
                                if (typeof engine.getVoiceConnection === 'function') {
                                    const conn = engine.getVoiceConnection(this._channelId);
                                    if (conn) return conn;
                                }
                                // Try accessing connection via internal properties
                                if (engine.connection) return engine.connection;
                                if (engine._connection) return engine._connection;
                            }
                        }
                    } catch (e) {
                        console.warn('[VoiceTranscriber] AudioCapture: strategy B failed:', e.message);
                    }

                    // Strategy C: look for a module exporting a voice connection store / map
                    try {
                        const connStore = BdApi.Webpack.getModule(
                            m => m && typeof m.get === 'function' && m.constructor && m.constructor.name === 'VoiceConnectionStore'
                        );
                        if (connStore) {
                            console.log('[VoiceTranscriber] AudioCapture: found VoiceConnectionStore (strategy C)');
                            const conn = connStore.get(this._channelId) || connStore.get(Object.keys(connStore)[0]);
                            if (conn) return conn;
                        }
                    } catch (e) {
                        console.warn('[VoiceTranscriber] AudioCapture: strategy C failed:', e.message);
                    }

                    return null;
                }

                _findPeerConnection(voiceConn) {
                    // Walk known property paths to find the RTCPeerConnection
                    const candidates = [
                        voiceConn.peerConnection,
                        voiceConn._peerConnection,
                        voiceConn.pc,
                        voiceConn.connection && voiceConn.connection.peerConnection,
                        voiceConn.transport && voiceConn.transport.peerConnection,
                        voiceConn.rtcConnection,
                        voiceConn._rtcConnection,
                        voiceConn.voiceConnection && voiceConn.voiceConnection.peerConnection
                    ];
                    for (const candidate of candidates) {
                        if (candidate && typeof candidate.getReceivers === 'function') {
                            return candidate;
                        }
                    }
                    return null;
                }

                _findSSRCMapping() {
                    // Try to find a module that maps SSRC -> userId
                    try {
                        const ssrcMod = BdApi.Webpack.getModule(
                            m => m && (typeof m.ssrcToUserId === 'function' || typeof m.getUserId === 'function' || m.ssrcMap)
                        );
                        if (ssrcMod) {
                            console.log('[VoiceTranscriber] AudioCapture: found SSRC mapping module');
                            return ssrcMod;
                        }
                    } catch (e) {
                        console.warn('[VoiceTranscriber] AudioCapture: SSRC module lookup failed:', e.message);
                    }

                    // Try to get the mapping from the voice connection itself
                    if (this._voiceConnection) {
                        const vc = this._voiceConnection;
                        const candidates = [
                            vc.ssrcToUserId, vc._ssrcMap, vc.ssrcMap,
                            vc.voiceState && vc.voiceState.ssrcMap,
                            vc.members
                        ];
                        for (const c of candidates) {
                            if (c) return c;
                        }
                    }
                    return null;
                }

                _resolveUserIdFromSSRC(ssrc) {
                    if (!this._ssrcToUserMap) return null;
                    const mapper = this._ssrcToUserMap;

                    // If it's a function
                    if (typeof mapper.ssrcToUserId === 'function') {
                        return mapper.ssrcToUserId(ssrc);
                    }
                    if (typeof mapper.getUserId === 'function') {
                        return mapper.getUserId(ssrc);
                    }
                    // If it's a Map or plain object
                    if (mapper instanceof Map) {
                        return mapper.get(ssrc) || mapper.get(String(ssrc));
                    }
                    if (typeof mapper === 'object') {
                        return mapper[ssrc] || mapper[String(ssrc)];
                    }
                    return null;
                }

                // --- Remote user audio capture ---

                _captureRemoteTracks() {
                    if (!this._peerConnection) {
                        console.warn('[VoiceTranscriber] AudioCapture: no peer connection for remote tracks');
                        return false;
                    }

                    try {
                        const receivers = this._peerConnection.getReceivers();
                        let captured = 0;

                        for (const receiver of receivers) {
                            const track = receiver.track;
                            if (!track || track.kind !== 'audio') continue;

                            // Try to determine the userId for this track
                            let userId = null;

                            // Check the track's ssrc via receiver stats or mid
                            if (track.id) {
                                // Try SSRC mapping
                                const ssrc = this._extractSSRCFromReceiver(receiver);
                                if (ssrc !== null) {
                                    userId = this._resolveUserIdFromSSRC(ssrc);
                                }
                            }

                            // Fallback: use track label or id as key
                            const streamKey = userId || `track_${track.id || captured}`;

                            // Create a MediaStream wrapping this single audio track
                            const stream = new MediaStream([track]);
                            this._streams.set(streamKey, stream);
                            captured++;

                            // Track cleanup
                            this._trackCleanup.push(() => {
                                try { stream.getTracks().forEach(t => { /* don't stop remote tracks */ }); } catch (e) {}
                            });
                        }

                        console.log(`[VoiceTranscriber] AudioCapture: captured ${captured} remote audio tracks`);
                        return captured > 0;
                    } catch (e) {
                        console.error('[VoiceTranscriber] AudioCapture: error capturing remote tracks:', e);
                        return false;
                    }
                }

                _extractSSRCFromReceiver(receiver) {
                    try {
                        // Check common Discord internal paths
                        if (receiver.ssrc) return receiver.ssrc;
                        if (receiver._ssrc) return receiver._ssrc;
                        if (receiver.track && receiver.track.ssrc) return receiver.track.ssrc;
                    } catch (e) {}
                    return null;
                }

                // --- Local user audio capture ---

                async _captureLocalAudio() {
                    // Strategy 1: get local audio track from Discord's media engine
                    try {
                        if (this._mediaEngine) {
                            const me = this._mediaEngine;
                            let localTrack = null;

                            if (typeof me.getLocalAudioTrack === 'function') {
                                localTrack = me.getLocalAudioTrack();
                            } else if (me.localAudioTrack) {
                                localTrack = me.localAudioTrack;
                            } else if (me._localAudioTrack) {
                                localTrack = me._localAudioTrack;
                            } else if (typeof me.getLocalStream === 'function') {
                                const stream = me.getLocalStream();
                                if (stream) {
                                    this._localStream = stream;
                                    // Get the local user ID
                                    this._localUserId = this._getLocalUserId();
                                    if (this._localUserId) {
                                        this._streams.set(this._localUserId, stream);
                                    }
                                    console.log('[VoiceTranscriber] AudioCapture: local audio via media engine getLocalStream');
                                    return true;
                                }
                            }

                            if (localTrack) {
                                const stream = new MediaStream([localTrack]);
                                this._localStream = stream;
                                this._localUserId = this._getLocalUserId();
                                if (this._localUserId) {
                                    this._streams.set(this._localUserId, stream);
                                }
                                this._trackCleanup.push(() => {
                                    try { stream.getTracks().forEach(t => { /* don't stop shared track */ }); } catch (e) {}
                                });
                                console.log('[VoiceTranscriber] AudioCapture: local audio via media engine track');
                                return true;
                            }
                        }

                        // Try from voice connection
                        if (this._voiceConnection) {
                            const vc = this._voiceConnection;
                            const localCandidates = [
                                vc.localAudioTrack, vc._localAudioTrack,
                                vc.audioTrack, vc._audioTrack,
                                vc.inputStream, vc._inputStream
                            ];
                            for (const candidate of localCandidates) {
                                if (candidate) {
                                    const stream = candidate instanceof MediaStream
                                        ? candidate
                                        : new MediaStream([candidate]);
                                    this._localStream = stream;
                                    this._localUserId = this._getLocalUserId();
                                    if (this._localUserId) {
                                        this._streams.set(this._localUserId, stream);
                                    }
                                    console.log('[VoiceTranscriber] AudioCapture: local audio via voice connection');
                                    return true;
                                }
                            }
                        }
                    } catch (e) {
                        console.warn('[VoiceTranscriber] AudioCapture: media engine local audio failed:', e.message);
                    }

                    // Strategy 2 (fallback): use navigator.mediaDevices.getUserMedia
                    try {
                        // Try to find Discord's selected audio input device
                        let deviceId = null;
                        try {
                            const audioSettingsMod = BdApi.Webpack.getModule(
                                m => m && typeof m.getInputDeviceId === 'function'
                            );
                            if (audioSettingsMod) {
                                deviceId = audioSettingsMod.getInputDeviceId();
                            }
                        } catch (e) {}

                        const constraints = deviceId
                            ? { audio: { deviceId: { exact: deviceId } } }
                            : { audio: true };

                        const stream = await navigator.mediaDevices.getUserMedia(constraints);
                        this._localStream = stream;
                        this._localUserId = this._getLocalUserId();
                        if (this._localUserId) {
                            this._streams.set(this._localUserId, stream);
                        }
                        this._trackCleanup.push(() => {
                            try { stream.getTracks().forEach(t => t.stop()); } catch (e) {}
                        });
                        console.log('[VoiceTranscriber] AudioCapture: local audio via getUserMedia fallback');
                        return true;
                    } catch (e) {
                        console.error('[VoiceTranscriber] AudioCapture: getUserMedia failed:', e.message);
                        return false;
                    }
                }

                _getLocalUserId() {
                    try {
                        const userStore = BdApi.Webpack.getModule(
                            m => m && m.getCurrentUser && typeof m.getCurrentUser === 'function'
                        );
                        if (userStore) {
                            const user = userStore.getCurrentUser();
                            if (user) return user.id;
                        }
                    } catch (e) {}
                    return 'local_user';
                }

                // --- Fallback: mixed output audio ---

                async _captureFallbackMixedAudio() {
                    try {
                        // Try getDisplayMedia with audio for system audio capture
                        const stream = await navigator.mediaDevices.getDisplayMedia({
                            video: true,  // required for getDisplayMedia
                            audio: true
                        });
                        // Remove video tracks, keep only audio
                        stream.getVideoTracks().forEach(t => t.stop());
                        const audioTracks = stream.getAudioTracks();
                        if (audioTracks.length > 0) {
                            const audioStream = new MediaStream(audioTracks);
                            this._streams.set('mixed_output', audioStream);
                            this._localStream = audioStream;
                            this._trackCleanup.push(() => {
                                try { audioStream.getTracks().forEach(t => t.stop()); } catch (e) {}
                            });
                            console.log('[VoiceTranscriber] AudioCapture: fallback mixed audio via getDisplayMedia');
                            return true;
                        }
                    } catch (e) {
                        console.warn('[VoiceTranscriber] AudioCapture: getDisplayMedia fallback failed:', e.message);
                    }

                    // Last resort: getUserMedia for local mic only
                    try {
                        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                        this._streams.set('local_only', stream);
                        this._localStream = stream;
                        this._trackCleanup.push(() => {
                            try { stream.getTracks().forEach(t => t.stop()); } catch (e) {}
                        });
                        console.log('[VoiceTranscriber] AudioCapture: last-resort local mic capture');
                        return true;
                    } catch (e) {
                        console.error('[VoiceTranscriber] AudioCapture: all fallback capture failed:', e.message);
                        return false;
                    }
                }

                // --- Track changes on the peer connection ---

                _setupTrackListeners() {
                    if (!this._peerConnection) return;

                    try {
                        this._peerConnection.addEventListener('track', (event) => {
                            try {
                                if (event.track && event.track.kind === 'audio') {
                                    console.log('[VoiceTranscriber] AudioCapture: new remote audio track added');
                                    // Re-capture remote tracks on changes
                                    this._captureRemoteTracks();
                                }
                            } catch (e) {
                                console.error('[VoiceTranscriber] AudioCapture: track event handler error:', e);
                            }
                        });
                    } catch (e) {
                        console.warn('[VoiceTranscriber] AudioCapture: could not add track listener:', e.message);
                    }
                }

                // --- Public API ---

                async start(channelId) {
                    if (this._capturing) {
                        console.warn('[VoiceTranscriber] AudioCapture: already capturing');
                        return true;
                    }

                    this._channelId = channelId;
                    this._fallbackMode = true;   // mixed single-stream capture
                    this._streams.clear();
                    this._trackCleanup = [];

                    // Capture TWO streams so both the user's own voice and the other participants
                    // get transcribed, WITHOUT routing the mic through the cable (which
                    // would echo/feed back into the headphones):
                    //   1. MIXED_CALL_STREAM_KEY = the loopback / call mix (Discord output)
                    //   2. localUserId           = the user's own microphone
                    try {
                        const deviceId = await this._pickInputDevice();
                        const localUserId = this._getLocalUserId() || 'local_user';
                        this._localUserId = localUserId;

                        // --- Stream 1: the call/group mix (loopback) ---
                        // Use an EXACT deviceId constraint so the requested loopback is actually
                        // opened — a bare {deviceId} is an "ideal" constraint Chromium is allowed
                        // to ignore in favour of the system default input (your mic), which
                        // produced the "only my own speech" symptom. Fall back to ideal, then
                        // default input, only if the exact request is truly rejected.
                        let callStream = null;
                        if (deviceId) {
                            try {
                                callStream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId } } });
                            } catch (e) {
                                console.warn(`[VoiceTranscriber] AudioCapture: exact device ${deviceId} rejected (${e.message}), retrying as ideal`);
                                try {
                                    callStream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId } });
                                } catch (e2) {
                                    console.warn(`[VoiceTranscriber] AudioCapture: device ${deviceId} unavailable (${e2.message}), falling back to default input`);
                                }
                            }
                        }
                        if (!callStream || callStream.getAudioTracks().length === 0) {
                            callStream = await navigator.mediaDevices.getUserMedia({ audio: true });
                        }
                        if (!callStream || callStream.getAudioTracks().length === 0) {
                            console.error('[VoiceTranscriber] AudioCapture: could not open any call audio input');
                            try { BdApi.UI.showToast('No call audio input available. Check mic/system permissions.', { type: 'error', timeout: 6000 }); } catch (err) {}
                            return false;
                        }
                        this._streams.set(MIXED_CALL_STREAM_KEY, callStream);
                        this._trackCleanup.push(() => {
                            try { callStream.getTracks().forEach(t => t.stop()); } catch (e) {}
                        });

                        // --- Stream 2: the user's own microphone (system default input) ---
                        // Optional: if it fails we still transcribe the group.
                        let micStream = null;
                        try {
                            micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
                        } catch (e) {
                            console.warn('[VoiceTranscriber] AudioCapture: microphone capture failed:', e.message);
                        }
                        if (micStream && micStream.getAudioTracks().length > 0) {
                            this._streams.set(localUserId, micStream);
                            this._localStream = micStream;
                            this._trackCleanup.push(() => {
                                try { micStream.getTracks().forEach(t => t.stop()); } catch (e) {}
                            });
                        }

                        this._capturing = true;
                        const trackLabel = (s) => {
                            try { const t = s && s.getAudioTracks()[0]; return (t && t.label) || '(none)'; } catch (e) { return '(none)'; }
                        };
                        console.log(`[VoiceTranscriber] AudioCapture: capturing call mix ${deviceId ? `(${deviceId})` : '(default)'} + mic as separate streams`);
                        console.log(`[VoiceTranscriber] AudioCapture: call stream label: "${trackLabel(callStream)}"; mic stream label: "${trackLabel(micStream)}"`);
                        return true;

                    } catch (e) {
                        console.error('[VoiceTranscriber] AudioCapture: failed to open audio input:', e);
                        try { BdApi.UI.showToast('Could not open audio input: ' + e.message, { type: 'error', timeout: 6000 }); } catch (err) {}
                        return false;
                    }
                }

                setDevice(deviceId) {
                    this._deviceId = deviceId || '';
                }

                // Resolve which input device to capture: an explicit choice wins,
                // otherwise auto-detect a virtual-cable loopback (VB-Cable /
                // VoiceMeeter) so the plugin just works when a cable is installed.
                async _pickInputDevice() {
                    if (this._deviceId) return this._deviceId;
                    try {
                        if (!navigator.mediaDevices || typeof navigator.mediaDevices.enumerateDevices !== 'function') return '';
                        const inputs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput');

                        // Rank loopback candidates so the actual VB-Cable "CABLE Output"
                        // wins over VoiceMeeter bus outputs. On setups where Discord's
                        // output is set to "CABLE Input", the full call mix (incl. other
                        // users) exits at "CABLE Output"; a VoiceMeeter output bus often
                        // carries only the local mic. A .find() on keyword matches is
                        // wrong here because VoiceMeeter labels also contain "vb-audio".
                        const score = (label) => {
                            const l = (label || '').toLowerCase();
                            let s = 0;
                            if (/\bcable output\b/.test(l)) s += 100;          // VB-Cable loopback, the expected tap point
                            if (/virtual audio cable/.test(l)) s += 80;        // raw VB-Cable family
                            if (/vb-audio voicemeeter/.test(l)) s += 20;       // VoiceMeeter engines
                            if (/voicemeeter/.test(l)) s += 10;                // any VoiceMeeter bus
                            return s;
                        };

                        let best = null;
                        let bestScore = 0;
                        for (const d of inputs) {
                            const s = score(d.label);
                            if (s > bestScore) { bestScore = s; best = d; }
                        }

                        if (best) {
                            console.log(`[VoiceTranscriber] AudioCapture: auto-selected loopback device "${best.label}"`);
                            return best.deviceId;
                        }
                    } catch (e) {
                        console.warn('[VoiceTranscriber] AudioCapture: autodetect failed:', e.message);
                    }
                    return '';   // caller falls back to the default input
                }

                static async enumerateInputDevices() {
                    try {
                        if (!navigator.mediaDevices || typeof navigator.mediaDevices.enumerateDevices !== 'function') return [];
                        const devices = await navigator.mediaDevices.enumerateDevices();
                        return devices.filter(d => d.kind === 'audioinput');
                    } catch (e) {
                        console.warn('[VoiceTranscriber] AudioCapture: enumerateDevices failed:', e.message);
                        return [];
                    }
                }

                stop() {
                    if (!this._capturing && this._streams.size === 0) return;

                    // Stop polling if active
                    if (this._pollInterval) {
                        clearInterval(this._pollInterval);
                        this._pollInterval = null;
                    }

                    // Run all cleanup callbacks
                    for (const cleanup of this._trackCleanup) {
                        try { cleanup(); } catch (e) {}
                    }
                    this._trackCleanup = [];

                    // Stop local stream tracks (we own these)
                    if (this._localStream) {
                        try {
                            this._localStream.getTracks().forEach(t => t.stop());
                        } catch (e) {}
                        this._localStream = null;
                    }

                    // Clear all streams (remote tracks are just references, stopping them is fine)
                    for (const [userId, stream] of this._streams) {
                        try {
                            stream.getTracks().forEach(t => {
                                // Only stop tracks we created (local), not remote shared tracks
                                if (userId === this._localUserId || userId === 'local_only' || userId === 'mixed_output' || userId === MIXED_CALL_STREAM_KEY) {
                                    t.stop();
                                }
                            });
                        } catch (e) {}
                    }
                    this._streams.clear();

                    // Clear references
                    this._voiceConnection = null;
                    this._peerConnection = null;
                    this._mediaEngine = null;
                    this._ssrcToUserMap = null;
                    this._localUserId = null;
                    this._channelId = null;
                    this._capturing = false;
                    this._fallbackMode = false;

                    console.log('[VoiceTranscriber] AudioCapture: stopped, all streams cleaned up');
                }

                getUserStream(userId) {
                    return this._streams.get(userId) || null;
                }

                getActiveStreams() {
                    return new Map(this._streams);
                }

                isCapturing() {
                    return this._capturing;
                }

                isFallbackMode() {
                    return this._fallbackMode;
                }
            }


            // ─── GlobalErrorHandler ───────────────────────────────────────────
            // Centralized error handling: wraps service calls, emits toasts, logs with prefix.
            class GlobalErrorHandler {
                constructor() {
                    this._listeners = new Map(); // errorType -> [callbacks]
                    this._errorCounts = new Map(); // errorType -> count (for throttling toasts)
                    this._lastToastTime = new Map(); // errorType -> timestamp
                    this._TOAST_COOLDOWN = 5000; // min ms between same-type toasts
                    this._PREFIX = '[VoiceTranscriber]';
                }

                /** Register a listener for a specific error type */
                onError(errorType, callback) {
                    if (!this._listeners.has(errorType)) {
                        this._listeners.set(errorType, []);
                    }
                    this._listeners.get(errorType).push(callback);
                    return () => {
                        // unsubscribe
                        const arr = this._listeners.get(errorType);
                        if (arr) {
                            const idx = arr.indexOf(callback);
                            if (idx !== -1) arr.splice(idx, 1);
                        }
                    };
                }

                /** Emit an error: log, toast (throttled), notify listeners */
                emit(errorType, message, details) {
                    const fullMessage = `${this._PREFIX} ${errorType}: ${message}`;
                    console.error(fullMessage, details || '');

                    // Increment count
                    const count = (this._errorCounts.get(errorType) || 0) + 1;
                    this._errorCounts.set(errorType, count);

                    // Throttled toast
                    const now = Date.now();
                    const lastToast = this._lastToastTime.get(errorType) || 0;
                    if (now - lastToast >= this._TOAST_COOLDOWN) {
                        this._lastToastTime.set(errorType, now);
                        try {
                            BdApi.UI.showToast(message, { type: 'error', timeout: 5000 });
                        } catch (e) { /* toast unavailable */ }
                    }

                    // Notify listeners
                    const listeners = this._listeners.get(errorType) || [];
                    for (const cb of listeners) {
                        try { cb({ type: errorType, message, details, count }); } catch (e) {
                            console.error(`${this._PREFIX} Error in error listener:`, e);
                        }
                    }

                    // Also notify wildcard listeners
                    const wildcardListeners = this._listeners.get('*') || [];
                    for (const cb of wildcardListeners) {
                        try { cb({ type: errorType, message, details, count }); } catch (e) {
                            console.error(`${this._PREFIX} Error in wildcard listener:`, e);
                        }
                    }
                }

                /** Wrap an async function with error handling */
                async wrapAsync(fn, errorType, fallbackValue) {
                    try {
                        return await fn();
                    } catch (e) {
                        this.emit(errorType, e.message || String(e), e);
                        return fallbackValue;
                    }
                }

                /** Wrap a sync function with error handling */
                wrapSync(fn, errorType, fallbackValue) {
                    try {
                        return fn();
                    } catch (e) {
                        this.emit(errorType, e.message || String(e), e);
                        return fallbackValue;
                    }
                }

                /** Wrap an event handler to prevent plugin crashes */
                wrapHandler(handlerName, handler) {
                    return (...args) => {
                        try {
                            return handler(...args);
                        } catch (e) {
                            this.emit('plugin_handler', `Handler '${handlerName}' crashed: ${e.message}`, e);
                        }
                    };
                }

                /** Reset error counts (e.g., on session start) */
                reset() {
                    this._errorCounts.clear();
                    this._lastToastTime.clear();
                }

                /** Get error summary */
                getSummary() {
                    const summary = {};
                    for (const [type, count] of this._errorCounts) {
                        summary[type] = count;
                    }
                    return summary;
                }
            }

            // AudioChunker: splits audio streams into timed chunks for transcription
            class AudioChunker {
                constructor(settings) {
                    this._settings = settings || {};
                    this._chunkDuration = (settings && settings.chunkDuration) || 30; // seconds
                    this._silenceThreshold = (settings && settings.silenceThreshold) != null ? settings.silenceThreshold : 1500;
                    this._minChunkDuration = (settings && settings.minChunkDuration) != null ? settings.minChunkDuration : 1; // seconds
                    this._flushSilenceMs = (settings && settings.flushSilenceMs) != null ? settings.flushSilenceMs : 2000;
                    this._running = false;
                    this._chunkers = new Map(); // userId -> { context, processor, source, chunks, interval }
                    this._onChunk = null; // callback(chunk)
                }

                setChunkCallback(callback) {
                    this._onChunk = callback;
                }

                start(userId, stream) {
                    if (this._chunkers.has(userId)) {
                        this.stop(userId);
                    }

                    try {
                        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
                        const source = audioContext.createMediaStreamSource(stream);
                        const processor = audioContext.createScriptProcessor(4096, 1, 1);
                        
                        const buffers = [];
                        const frames = [];            // { length, signal } per audio-process frame
                        let bufferSamples = 0;
                        let tailSilenceMs = 0;          // consecutive quiet since the last speech frame
                        let noiseFloor = this._silenceThreshold; // adaptive background-level estimate (int16 RMS)
                        const silenceThreshold = this._silenceThreshold;
                        const maxSamples = audioContext.sampleRate * this._chunkDuration;    // hard cap (30s)
                        const minSamples = audioContext.sampleRate * Math.max(0.2, this._minChunkDuration);
                        const flushSilenceMs = this._flushSilenceMs;

                        // Flush whatever has been accumulated: trim to the signal region and hand
                        // the audio to the transcription callback. Called either when the hard
                        // cap is hit OR as soon as the speaker has been quiet for flushSilenceMs
                        // (so a short utterance is transcribed without waiting out the full chunk).
                        const flush = () => {
                            if (bufferSamples === 0) return;

                            let startSample = 0, endSample = 0, firstSignal = -1, cum = 0;
                            for (let i = 0; i < frames.length; i++) {
                                const flen = frames[i].length;
                                if (frames[i].signal) {
                                    if (firstSignal < 0) { firstSignal = i; startSample = cum; }
                                    endSample = cum + flen;
                                }
                                cum += flen;
                            }
                            const totalSamples = bufferSamples;

                            // Build the full merged buffer BEFORE clearing.
                            const merged = new Float32Array(totalSamples);
                            let off = 0;
                            for (const buf of buffers) { merged.set(buf, off); off += buf.length; }

                            buffers.length = 0;
                            frames.length = 0;
                            bufferSamples = 0;
                            tailSilenceMs = 0;

                            // Pure hiss/silence while idle — drop it instead of transcribing dead air.
                            if (firstSignal < 0) {
                                console.log(`[VoiceTranscriber] AudioChunker: dropped silent chunk (noiseFloor=${Math.round(noiseFloor)}, gate=${Math.round(Math.max(silenceThreshold, noiseFloor * 1.6))})`);
                                return;
                            }

                            const keep = merged.subarray(startSample, endSample);
                            if (keep.length === 0) return;

                            const blob = this._floatToWav(keep, audioContext.sampleRate);
                            const now = Date.now();
                            const accumulatedMs = Math.round((totalSamples / audioContext.sampleRate) * 1000);
                            const keptSeconds = Math.max(1, Math.round(keep.length / audioContext.sampleRate));
                            const chunk = {
                                blob,
                                userId,
                                startTime: now - accumulatedMs,
                                endTime: now,
                                duration: keptSeconds
                            };

                            if (this._onChunk) {
                                try { this._onChunk(chunk); } catch (e) {
                                    console.error('[VoiceTranscriber] AudioChunker: chunk callback error:', e);
                                }
                            }
                        };

                        processor.onaudioprocess = (event) => {
                            if (!this._running) return;
                            const inputData = event.inputBuffer.getChannelData(0);
                            const frame = new Float32Array(inputData);
                            const rms = this._frameRmsInt16(frame);
                            buffers.push(frame);
                            bufferSamples += frame.length;

                            // Adaptive noise floor + live gate: track the quiet background level and
                            // treat only frames clearly louder than it as speech. A fixed threshold
                            // would let cable/preamp hiss through (Whisper repeats it 30-40x).
                            if (rms < noiseFloor) noiseFloor = 0.85 * noiseFloor + 0.15 * rms;
                            else noiseFloor = Math.min(1e9, noiseFloor + 0.5);
                            const gate = Math.max(silenceThreshold, noiseFloor * 1.6);
                            const signal = rms >= gate;
                            frames.push({ length: frame.length, signal });

                            if (signal) {
                                tailSilenceMs = 0;
                            } else {
                                tailSilenceMs += (frame.length / audioContext.sampleRate) * 1000;
                            }

                            const totalMs = (bufferSamples / audioContext.sampleRate) * 1000;
                            const quietEnough = tailSilenceMs >= flushSilenceMs && bufferSamples >= minSamples;
                            if (totalMs >= maxSamples || quietEnough) {
                                flush();
                            }
                        };

                        source.connect(processor);
                        processor.connect(audioContext.destination);

                        this._chunkers.set(userId, { audioContext, processor, source, buffers, bufferSamples: 0 });
                        console.log(`[VoiceTranscriber] AudioChunker: started for user ${userId}, chunk duration ${this._chunkDuration}s`);
                    } catch (e) {
                        console.error(`[VoiceTranscriber] AudioChunker: failed to start for user ${userId}:`, e);
                    }
                }

                stop(userId) {
                    const chunker = this._chunkers.get(userId);
                    if (!chunker) return;

                    try {
                        chunker.processor.disconnect();
                        chunker.source.disconnect();
                        chunker.audioContext.close();
                    } catch (e) {}
                    this._chunkers.delete(userId);
                }

                stopAll() {
                    for (const [userId] of this._chunkers) {
                        this.stop(userId);
                    }
                    this._running = false;
                }

                _frameRmsInt16(arr) {
                    let sum = 0;
                    const n = arr.length;
                    for (let i = 0; i < n; i++) {
                        const s = arr[i];
                        sum += s * s;
                    }
                    return Math.sqrt(sum / n) * 32768;
                }

                _floatToWav(float32Array, sampleRate) {
                    const numSamples = float32Array.length;
                    const buffer = new ArrayBuffer(44 + numSamples * 2);
                    const view = new DataView(buffer);

                    // WAV header
                    const writeString = (offset, string) => {
                        for (let i = 0; i < string.length; i++) {
                            view.setUint8(offset + i, string.charCodeAt(i));
                        }
                    };

                    writeString(0, 'RIFF');
                    view.setUint32(4, 36 + numSamples * 2, true);
                    writeString(8, 'WAVE');
                    writeString(12, 'fmt ');
                    view.setUint32(16, 16, true);
                    view.setUint16(20, 1, true); // PCM
                    view.setUint16(22, 1, true); // mono
                    view.setUint32(24, sampleRate, true);
                    view.setUint32(28, sampleRate * 2, true);
                    view.setUint16(32, 2, true);
                    view.setUint16(34, 16, true);
                    writeString(36, 'data');
                    view.setUint32(40, numSamples * 2, true);

                    // Write PCM samples
                    let offset = 44;
                    for (let i = 0; i < numSamples; i++) {
                        const s = Math.max(-1, Math.min(1, float32Array[i]));
                        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
                        offset += 2;
                    }

                    return new Blob([buffer], { type: 'audio/wav' });
                }

                isRunning() {
                    return this._running;
                }

                setChunkDuration(seconds) {
                    this._chunkDuration = seconds;
                }
            }

            // WhisperTranscriptionService: sends audio chunks to OpenAI Whisper API
            class WhisperTranscriptionService {
                constructor(settings) {
                    this._settings = settings;
                    this._running = false;
                    this._processing = false;
                    this._queue = [];               // array of chunk objects from AudioChunker
                    this._transcripts = new Map();   // userId -> array of transcript entries
                    this._userQueues = new Map();    // userId -> array of pending chunks (sequential per user)
                    this._processingUsers = new Set(); // users currently being transcribed
                    this._rateLimitUntil = 0;        // timestamp until which we should wait (429 backoff)
                    this._maxRetries = 3;
                    this._pollInterval = null;
                    this._API_URL = 'https://api.openai.com/v1/audio/transcriptions';
                    this._errorHandler = (settings && settings.errorHandler) || null;
                }

                // --- Centralized error reporting ---

                _emit(type, message, details) {
                    if (this._errorHandler) {
                        this._errorHandler.emit(type, message, details);
                        return;
                    }
                    console.error(`[VoiceTranscriber] ${type}: ${message}`, details || '');
                    try {
                        BdApi.UI.showToast(message, { type: 'error', timeout: 8000 });
                    } catch (e) { /* toast unavailable */ }
                }

                // --- Lifecycle ---

                startTranscription() {
                    if (this._running) {
                        console.warn('[VoiceTranscriber] WhisperTranscription: already running');
                        return true;
                    }
                    this._running = true;
                    this._processing = false;
                    this._transcripts.clear();
                    this._queue = [];
                    this._userQueues.clear();
                    this._processingUsers.clear();
                    this._rateLimitUntil = 0;

                    // Poll the queue every 500ms for new chunks
                    this._pollInterval = setInterval(() => {
                        this._processQueue();
                    }, 500);

                    console.log('[VoiceTranscriber] WhisperTranscription: started');
                    return true;
                }

                stopTranscription() {
                    if (!this._running) return;
                    this._running = false;

                    if (this._pollInterval) {
                        clearInterval(this._pollInterval);
                        this._pollInterval = null;
                    }

                    // Clear pending queues (but keep completed transcripts)
                    this._queue = [];
                    this._userQueues.clear();
                    this._processingUsers.clear();

                    console.log('[VoiceTranscriber] WhisperTranscription: stopped');
                }

                // --- Queue management ---

                enqueueChunk(chunk) {
                    // chunk: {blob, userId, startTime, endTime, duration}
                    if (!this._running) {
                        console.warn('[VoiceTranscriber] WhisperTranscription: not running, dropping chunk');
                        return;
                    }
                    this._queue.push(chunk);

                    // Also add to per-user queue for sequential processing
                    if (!this._userQueues.has(chunk.userId)) {
                        this._userQueues.set(chunk.userId, []);
                    }
                    this._userQueues.get(chunk.userId).push(chunk);
                }

                _processQueue() {
                    if (!this._running || this._queue.length === 0) return;

                    // Check rate limit cooldown
                    if (Date.now() < this._rateLimitUntil) {
                        return;
                    }

                    // Process one chunk per user that isn't currently being processed
                    for (const [userId, userQueue] of this._userQueues) {
                        if (userQueue.length === 0) continue;
                        if (this._processingUsers.has(userId)) continue;

                        this._processingUsers.add(userId);
                        const chunk = userQueue.shift();

                        // Process asynchronously, sequentially per user
                        this._processUserChunk(userId, chunk).finally(() => {
                            this._processingUsers.delete(userId);
                            // Clean up empty queues
                            if (userQueue.length === 0) {
                                this._userQueues.delete(userId);
                            }
                            // Remove from global queue
                            const idx = this._queue.indexOf(chunk);
                            if (idx !== -1) this._queue.splice(idx, 1);
                        });
                    }
                }

                async _processUserChunk(userId, chunk) {
                    let lastError = null;
                    for (let attempt = 0; attempt < this._maxRetries; attempt++) {
                        try {
                            // Wait if we're in rate limit cooldown
                            if (Date.now() < this._rateLimitUntil) {
                                const waitMs = this._rateLimitUntil - Date.now();
                                console.log(`[VoiceTranscriber] WhisperTranscription: rate limited, waiting ${Math.ceil(waitMs / 1000)}s`);
                                await new Promise(r => setTimeout(r, waitMs));
                            }

                            const result = await this.transcribeChunk(chunk);
                            if (result) {
                                // Store the result
                                if (!this._transcripts.has(userId)) {
                                    this._transcripts.set(userId, []);
                                }
                                this._transcripts.get(userId).push(result);
                                return;
                            }
                        } catch (err) {
                            lastError = err;

                            // Don't retry on auth errors (401)
                            if (err.status === 401) {
                                this._emit('auth_error', 'Invalid API key (401). Check your API key settings.', err);
                                return;
                            }

                            // Handle rate limiting (429)
                            if (err.status === 429) {
                                const retryAfter = err.retryAfter || Math.pow(2, attempt) * 2;
                                this._rateLimitUntil = Date.now() + (retryAfter * 1000);
                                console.warn(`[VoiceTranscriber] WhisperTranscription: rate limited, backing off ${retryAfter}s`);
                                try {
                                    BdApi.UI.showToast(`Transcription rate limited, retrying in ${retryAfter}s...`, { type: 'warning', timeout: 5000 });
                                } catch (e) {}
                                if (attempt < this._maxRetries - 1) {
                                    await new Promise(r => setTimeout(r, retryAfter * 1000));
                                    continue;
                                }
                            }

                            // Exponential backoff for other errors
                            if (attempt < this._maxRetries - 1) {
                                const backoffMs = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
                                console.warn(`[VoiceTranscriber] WhisperTranscription: attempt ${attempt + 1} failed, retrying in ${backoffMs / 1000}s... (${err.message})`);
                                await new Promise(r => setTimeout(r, backoffMs));
                            }
                        }
                    }

                    this._emit('transcription_error', `Failed after ${this._maxRetries} attempts: ${lastError ? lastError.message : 'unknown error'}`, lastError);
                }

                // --- Core transcription ---

                async transcribeChunk(chunk) {
                    // chunk: {blob, userId, startTime, endTime, duration}
                    const apiKey = this._settings.apiKey;
                    if (!apiKey) {
                        throw new Error('No API key configured');
                    }

                    // Build multipart/form-data
                    const formData = new FormData();
                    formData.append('file', chunk.blob, `audio_chunk_${chunk.startTime}.wav`);
                    formData.append('model', 'whisper-1');
                    formData.append('response_format', 'verbose_json');

                    let lastNetworkError = null;
                    const MAX_NETWORK_RETRIES = 5;
                    let networkRetryCount = 0;

                    while (networkRetryCount <= MAX_NETWORK_RETRIES) {
                        try {
                            const response = await fetch(this._API_URL, {
                                method: 'POST',
                                headers: {
                                    'Authorization': `Bearer ${apiKey}`
                                },
                                body: formData
                            });

                            // Handle HTTP errors
                            if (!response.ok) {
                                const error = new Error(`HTTP ${response.status}: ${response.statusText}`);
                                error.status = response.status;

                                if (response.status === 429) {
                                    // Extract Retry-After header if present
                                    const retryAfter = response.headers.get('Retry-After');
                                    error.retryAfter = retryAfter ? parseInt(retryAfter, 10) : null;
                                }

                                if (response.status === 401) {
                                    console.error('[VoiceTranscriber] WhisperTranscription: authentication failed - check your API key');
                                }

                                throw error;
                            }

                            const data = await response.json();

                            // Parse the verbose_json response
                            return {
                                text: data.text || '',
                                language: data.language || 'unknown',
                                duration: data.duration || chunk.duration || 0,
                                timestamp: Date.now(),
                                startTime: chunk.startTime,
                                endTime: chunk.endTime,
                                userId: chunk.userId
                            };
                        } catch (err) {
                            // If it's an HTTP error (has status), don't retry as network error
                            if (err.status) {
                                throw err;
                            }

                            // Network error (fetch failed, connection refused, etc.)
                            lastNetworkError = err;
                            networkRetryCount++;

                            if (networkRetryCount > MAX_NETWORK_RETRIES) {
                                this._emit('network_error', `Network error after ${MAX_NETWORK_RETRIES} retries: ${err.message}`, err);
                                throw new Error(`Network error after ${MAX_NETWORK_RETRIES} retries: ${err.message}`);
                            }

                            // Exponential backoff: 1s, 2s, 4s, 8s, 16s
                            const backoffMs = Math.pow(2, networkRetryCount - 1) * 1000;
                            console.warn(`[VoiceTranscriber] WhisperTranscription: network error, retry ${networkRetryCount}/${MAX_NETWORK_RETRIES} in ${backoffMs/1000}s...`);
                            try {
                                BdApi.UI.showToast('Network error, retrying...', { type: 'warning', timeout: 3000 });
                            } catch (e) {}
                            await new Promise(r => setTimeout(r, backoffMs));
                        }
                    }

                    // Should not reach here, but just in case
                    throw lastNetworkError || new Error('Network error');
                }

                // --- Accessors ---

                getTranscripts(userId) {
                    return this._transcripts.get(userId) || [];
                }

                getAllTranscripts() {
                    return new Map(this._transcripts);
                }

                getFullTranscript(userId) {
                    const entries = this._transcripts.get(userId);
                    if (!entries || entries.length === 0) return '';
                    return entries.map(e => e.text).join(' ');
                }

                isRunning() {
                    return this._running;
                }

                getQueueSize() {
                    return this._queue.length;
                }

                clearTranscripts() {
                    this._transcripts.clear();
                }
            }

            // LocalWhisperTranscriptionService: sends audio chunks to a locally-running Whisper server
            class LocalWhisperTranscriptionService {
                constructor(settings) {
                    this._settings = settings || {};
                    this._baseUrl = this._settings.localServerUrl || 'http://localhost:9000';
                    this._running = false;
                    this._detectedApiFormat = null;  // 'whisper-cpp' | 'faster-whisper' | 'openai-compatible' | null
                    this._endpointPath = null;       // resolved endpoint path after auto-detection
                    this._queues = new Map();        // userId -> array of pending chunks
                    this._processing = new Map();    // userId -> boolean (true if queue is being drained)
                    this._results = [];              // collected transcription results
                    this._abortController = null;
                    this._requestTimeout = 30000;    // 30 seconds per chunk
                    this._errorHandler = (settings && settings.errorHandler) || null;
                }

                // --- Centralized error reporting ---

                _emit(type, message, details) {
                    if (this._errorHandler) {
                        this._errorHandler.emit(type, message, details);
                        return;
                    }
                    console.error(`[VoiceTranscriber] ${type}: ${message}`, details || '');
                    try {
                        BdApi.UI.showToast(message, { type: 'error', timeout: 8000 });
                    } catch (e) { /* toast unavailable */ }
                }

                // --- CORS-free HTTP helpers ---
                // Browser fetch from Discord's https origin to a local http server is
                // blocked by CORS. Route through Node's http/https (Electron renderer
                // exposes require) which has no cross-origin restrictions.

                async _httpRequest(url, method = 'GET', headers = {}, body = null, timeoutMs = 5000) {
                    // Plain browser fetch now works because the reverse proxy in front
                    // of the whisper server sends Access-Control-Allow-Origin so
                    // Discord's renderer is no longer CORS-blocked. (Raw http/https
                    // aren't usable here: BD sandboxes require and Electron's net is
                    // main-process-only.)
                    const signal = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined;
                    const res = await fetch(url, {
                        method,
                        headers,
                        body: body || undefined,
                        signal
                    });
                    const hdrs = {};
                    if (res.headers && typeof res.headers.forEach === 'function') {
                        res.headers.forEach((v, k) => { hdrs[k] = v; });
                    }
                    const ab = await res.arrayBuffer();
                    return { status: res.status, headers: hdrs, body: Buffer.from(ab) };
                }

                async _formDataToMultipart(formData) {
                    const resp = new Response(formData);
                    const contentType = resp.headers.get('content-type');
                    const buf = Buffer.from(await resp.arrayBuffer());
                    return { contentType, body: buf };
                }

                // --- Connection health check ---

                async _checkServerReachable() {
                    const url = this._baseUrl;
                    try {
                        const res = await this._httpRequest(url, 'GET', {}, null, 5000);
                        // Any HTTP response means the server is reachable
                        console.log(`[VoiceTranscriber] LocalWhisper: server reachable (HTTP ${res.status}) at ${url}`);
                        return true;
                    } catch (e) {
                        const msg = e.message || String(e);
                        console.error(`[VoiceTranscriber] LocalWhisper: health check failed for ${url}:`, msg);
                        try { BdApi.UI.showToast(`Whisper server unreachable (${url}) — ${msg}`, { type: 'error', timeout: 8000 }); } catch (err) {}
                        return false;
                    }
                }

                // --- Auto-detection of server API format ---

                async _detectApiFormat() {
                    if (this._detectedApiFormat) return this._detectedApiFormat;

                    const candidates = [
                        {
                            path: '/v1/audio/transcriptions',
                            format: 'openai-compatible',
                            testMethod: 'POST'
                        },
                        {
                            path: '/inference',
                            format: 'whisper-cpp',
                            testMethod: 'POST'
                        },
                        {
                            path: '/transcribe',
                            format: 'faster-whisper',
                            testMethod: 'POST'
                        }
                    ];

                    // Try each endpoint with a small silent blob to see which responds
                    const testBlob = new Blob([new Uint8Array(44)], { type: 'audio/wav' });

                    for (const candidate of candidates) {
                        try {
                            const url = `${this._baseUrl}${candidate.path}`;
                            const formData = new FormData();
                            formData.append('file', testBlob, 'test.wav');
                            const { contentType, body } = await this._formDataToMultipart(formData);

                            const res = await this._httpRequest(url, candidate.testMethod, { 'Content-Type': contentType }, body, 8000);

                            // Endpoint matches on a real (non-404, non-5xx) response. A 404 means the
                            // route does not exist — do NOT treat it as a match.
                            if (res.status !== 404 && res.status < 500) {
                                this._detectedApiFormat = candidate.format;
                                this._endpointPath = candidate.path;
                                console.log(`[VoiceTranscriber] LocalWhisper: detected API format '${candidate.format}' at ${candidate.path}`);
                                return candidate.format;
                            }
                        } catch (e) {
                            // Try next candidate
                            continue;
                        }
                    }

                    // Fallback: try GET on each to check for route existence
                    for (const candidate of candidates) {
                        try {
                            const url = `${this._baseUrl}${candidate.path}`;
                            const res = await this._httpRequest(url, 'GET', {}, null, 5000);
                            if (res.status !== 404 && res.status < 500) {
                                this._detectedApiFormat = candidate.format;
                                this._endpointPath = candidate.path;
                                console.log(`[VoiceTranscriber] LocalWhisper: detected API format '${candidate.format}' at ${candidate.path} (via GET probe)`);
                                return candidate.format;
                            }
                        } catch (e) {
                            continue;
                        }
                    }

                    // Default to OpenAI-compatible format if detection fails
                    this._detectedApiFormat = 'openai-compatible';
                    this._endpointPath = '/v1/audio/transcriptions';
                    console.warn('[VoiceTranscriber] LocalWhisper: could not auto-detect API format, defaulting to openai-compatible');
                    return this._detectedApiFormat;
                }

                // --- Build request for a specific API format ---

                _buildRequest(chunk) {
                    const url = `${this._baseUrl}${this._endpointPath}`;
                    const blob = chunk.blob;

                    switch (this._detectedApiFormat) {
                        case 'whisper-cpp': {
                            // whisper.cpp server expects multipart with 'file' field
                            const formData = new FormData();
                            formData.append('file', blob, `chunk_${chunk.startTime}.wav`);
                            formData.append('response_format', 'json');
                            return { url, options: { method: 'POST', body: formData } };
                        }
                        case 'faster-whisper': {
                            // faster-whisper-server expects multipart with 'file' field
                            const formData = new FormData();
                            formData.append('file', blob, `chunk_${chunk.startTime}.wav`);
                            formData.append('response_format', 'json');
                            return { url, options: { method: 'POST', body: formData } };
                        }
                        case 'openai-compatible': {
                            // OpenAI-compatible /v1/audio/transcriptions
                            const formData = new FormData();
                            formData.append('file', blob, `chunk_${chunk.startTime}.wav`);
                            formData.append('model', 'whisper-1');
                            formData.append('response_format', 'json');
                            return { url, options: { method: 'POST', body: formData } };
                        }
                        default: {
                            // Fallback: generic multipart
                            const formData = new FormData();
                            formData.append('file', blob, `chunk_${chunk.startTime}.wav`);
                            return { url, options: { method: 'POST', body: formData } };
                        }
                    }
                }

                // --- Parse response based on API format ---

                _parseResponse(data) {
                    // All formats generally return JSON with text field
                    // whisper.cpp: { "text": "...", "language": "...", "duration": ... }
                    // faster-whisper: { "text": "...", "language": "...", "duration": ..., "segments": [...] }
                    // openai-compatible: { "text": "...", "language": "...", "duration": ..., "segments": [...] }

                    const result = {
                        text: '',
                        language: null,
                        duration: null
                    };

                    if (typeof data === 'string') {
                        // Some servers return plain text instead of JSON
                        result.text = data.trim();
                        return result;
                    }

                    if (typeof data === 'object' && data !== null) {
                        result.text = (data.text || data.transcription || data.result || '').trim();
                        result.language = data.language || null;
                        result.duration = data.duration || null;

                        // whisper.cpp may nest under 'transcription' array
                        if (!result.text && Array.isArray(data.transcription)) {
                            result.text = data.transcription
                                .map(seg => seg.text || '')
                                .join(' ')
                                .trim();
                        }

                        // Some formats use segments array
                        if (!result.text && Array.isArray(data.segments)) {
                            result.text = data.segments
                                .map(seg => seg.text || '')
                                .join(' ')
                                .trim();
                        }
                    }

                    return result;
                }

                // --- Transcribe a single chunk ---

                async transcribeChunk(chunk) {
                    if (!this._endpointPath) {
                        await this._detectApiFormat();
                    }

                    const { url, options } = this._buildRequest(chunk);

                    try {
                        // Serialize the multipart body (bypasses CORS via Node http)
                        const { contentType, body } = await this._formDataToMultipart(options.body);
                        const res = await this._httpRequest(url, options.method, { 'Content-Type': contentType }, body, this._requestTimeout);

                        if (res.status >= 400) {
                            const errorBody = res.body.toString('utf8').slice(0, 300);
                            console.error(`[VoiceTranscriber] LocalWhisper: server error HTTP ${res.status}: ${errorBody}`);
                            return null;
                        }

                        // Parse response
                        const raw = res.body.toString('utf8');
                        const serverCt = String(res.headers['content-type'] || '').toLowerCase();
                        let data;
                        if (serverCt.includes('application/json')) {
                            data = JSON.parse(raw);
                        } else {
                            try {
                                data = JSON.parse(raw);
                            } catch (e) {
                                data = raw;   // plain-text response
                            }
                        }

                        const parsed = this._parseResponse(data);

                        const result = {
                            text: parsed.text,
                            language: parsed.language,
                            duration: parsed.duration || chunk.duration,
                            timestamp: chunk.startTime,
                            userId: chunk.userId,
                            startTime: chunk.startTime,
                            endTime: chunk.endTime
                        };

                        return result;

                    } catch (e) {
                        const msg = e.message || '';
                        if (msg.includes('timeout')) {
                            console.error(`[VoiceTranscriber] LocalWhisper: transcription timed out for chunk at ${chunk.startTime}s`);
                        } else if (msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND')) {
                            console.error('[VoiceTranscriber] LocalWhisper: connection refused during transcription');
                        } else {
                            console.error('[VoiceTranscriber] LocalWhisper: transcription error:', msg || e);
                        }
                        return null;
                    }
                }

                // --- Queue-based processing: sequential per user ---

                async _processQueue(userId) {
                    if (this._processing.get(userId)) return; // already processing this user's queue
                    this._processing.set(userId, true);

                    const queue = this._queues.get(userId);
                    while (queue && queue.length > 0 && this._running) {
                        const chunk = queue.shift();
                        try {
                            const result = await this.transcribeChunk(chunk);
                            if (result && result.text) {
                                this._results.push(result);
                            }
                        } catch (e) {
                            console.error(`[VoiceTranscriber] LocalWhisper: queue processing error for user ${userId}:`, e.message);
                        }
                    }

                    this._processing.set(userId, false);
                }

                enqueueChunk(chunk) {
                    const userId = chunk.userId || 'unknown';
                    if (!this._queues.has(userId)) {
                        this._queues.set(userId, []);
                    }
                    this._queues.get(userId).push(chunk);

                    // Start processing if not already running for this user
                    if (!this._processing.get(userId) && this._running) {
                        this._processQueue(userId);
                    }
                }

                // --- Lifecycle methods ---

                async startTranscription() {
                    if (this._running) {
                        console.warn('[VoiceTranscriber] LocalWhisper: already running');
                        return true;
                    }

                    // Health check: verify server is reachable
                    const reachable = await this._checkServerReachable();
                    if (!reachable) {
                        console.error('[VoiceTranscriber] LocalWhisper: server is not reachable, cannot start transcription');
                        return false;
                    }

                    // Auto-detect API format
                    await this._detectApiFormat();

                    // Initialize state
                    this._running = true;
                    this._abortController = new AbortController();
                    this._results = [];
                    this._queues.clear();
                    this._processing.clear();

                    console.log(`[VoiceTranscriber] LocalWhisper: transcription started (format: ${this._detectedApiFormat}, endpoint: ${this._endpointPath})`);
                    return true;
                }

                stopTranscription() {
                    if (!this._running) return;

                    this._running = false;

                    // Abort any in-flight requests
                    if (this._abortController) {
                        this._abortController.abort();
                        this._abortController = null;
                    }

                    // Clear queues
                    this._queues.clear();
                    this._processing.clear();

                    console.log(`[VoiceTranscriber] LocalWhisper: transcription stopped, ${this._results.length} result(s) collected`);
                }

                // --- Accessors ---

                getResults() {
                    return [...this._results];
                }

                isRunning() {
                    return this._running;
                }

                getDetectedFormat() {
                    return this._detectedApiFormat;
                }
            }

            // TranscriptFileWriter: saves transcribed text to per-user files
            class TranscriptFileWriter {
                constructor(settings) {
                    this._settings = settings || {};
                    this._fs = null;
                    this._path = null;
                    this._sessionId = null;
                    this._sessionStartDate = null;
                    this._channelName = null;
                    this._outputDir = null;
                    this._pendingEntries = [];       // {userId, username, text, timestamp}
                    this._userFiles = new Map();     // userId -> {filePath, headerWritten, format, username, entries}
                    this._flushInterval = null;
                    this._sessionActive = false;

                    // Load Node.js modules (available in Electron renderer)
                    try {
                        this._fs = require('fs');
                        this._path = require('path');
                    } catch (e) {
                        console.error('[VoiceTranscriber] TranscriptFileWriter: failed to load fs/path modules:', e.message);
                    }
                }

                // Generate a timestamp-based unique session ID (e.g. 2026-08-23_153000)
                _generateSessionId() {
                    const now = new Date();
                    const yyyy = now.getFullYear();
                    const mm = String(now.getMonth() + 1).padStart(2, '0');
                    const dd = String(now.getDate()).padStart(2, '0');
                    const hh = String(now.getHours()).padStart(2, '0');
                    const min = String(now.getMinutes()).padStart(2, '0');
                    const ss = String(now.getSeconds()).padStart(2, '0');
                    return `${yyyy}-${mm}-${dd}_${hh}${min}${ss}`;
                }

                // Get the file extension based on output format setting
                _getFileExtension() {
                    const fmt = this._settings.outputFormat;
                    if (fmt === 1) return '.md';
                    if (fmt === 2) return '.json';
                    return '.txt';
                }

                // Get a human-readable format name
                _getFormatName() {
                    const fmt = this._settings.outputFormat;
                    if (fmt === 1) return 'Markdown';
                    if (fmt === 2) return 'JSON';
                    return 'Plain Text';
                }

                // Ensure the output directory exists
                _ensureOutputDir() {
                    if (!this._fs || !this._path) return false;
                    try {
                        const dir = this._outputDir;
                        if (!this._fs.existsSync(dir)) {
                            this._fs.mkdirSync(dir, { recursive: true });
                            console.log(`[VoiceTranscriber] TranscriptFileWriter: created output directory: ${dir}`);
                        }
                        return true;
                    } catch (e) {
                        if (e.code === 'EACCES' || e.code === 'EPERM') {
                            console.error('[VoiceTranscriber] TranscriptFileWriter: permission denied creating output directory:', e.message);
                        } else if (e.code === 'ENOSPC') {
                            console.error('[VoiceTranscriber] TranscriptFileWriter: disk full creating output directory:', e.message);
                        } else {
                            console.error('[VoiceTranscriber] TranscriptFileWriter: error creating output directory:', e.message);
                        }
                        return false;
                    }
                }

                // Build the file path for a given user
                _buildFilePath(username) {
                    const ext = this._getFileExtension();
                    const safeUsername = username.replace(/[^a-zA-Z0-9_\-]/g, '_');
                    const filename = `${safeUsername}_${this._sessionId}${ext}`;
                    return this._path.join(this._outputDir, filename);
                }

                // Format a timestamp as HH:MM:SS
                _formatTimestamp(timestamp) {
                    const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
                    const hh = String(date.getHours()).padStart(2, '0');
                    const mm = String(date.getMinutes()).padStart(2, '0');
                    const ss = String(date.getSeconds()).padStart(2, '0');
                    return `${hh}:${mm}:${ss}`;
                }

                // Format a date for the header
                _formatSessionDate(date) {
                    const yyyy = date.getFullYear();
                    const mm = String(date.getMonth() + 1).padStart(2, '0');
                    const dd = String(date.getDate()).padStart(2, '0');
                    return `${yyyy}-${mm}-${dd}`;
                }

                // Generate file header content for a user
                _generateHeader(username) {
                    const fmt = this._settings.outputFormat;
                    const dateStr = this._formatSessionDate(this._sessionStartDate);
                    const channel = this._channelName || 'Unknown';

                    if (fmt === 1) {
                        // Markdown format
                        return `# Voice Transcript\n\n` +
                            `**User:** ${username}  \n` +
                            `**Session:** ${dateStr}  \n` +
                            `**Channel:** ${channel}  \n` +
                            `**Session ID:** ${this._sessionId}\n\n` +
                            `| Timestamp | Text |\n` +
                            `|-----------|------|\n`;
                    } else if (fmt === 2) {
                        // JSON format - no text header; full JSON written at endSession
                        return '';
                    } else {
                        // Plain text format (default)
                        return `Voice Transcript — ${username} | Session: ${dateStr} | Channel: ${channel}\n` +
                            `${'='.repeat(60)}\n`;
                    }
                }

                // Get or create a user file entry
                _getOrCreateUserFile(userId, username) {
                    if (this._userFiles.has(userId)) {
                        return this._userFiles.get(userId);
                    }

                    const filePath = this._buildFilePath(username);
                    const entry = {
                        filePath,
                        headerWritten: false,
                        username,
                        format: this._settings.outputFormat,
                        entries: []  // for JSON format, accumulate entries in memory
                    };

                    // Write header immediately for text and markdown formats
                    if (this._settings.outputFormat !== 2) {
                        try {
                            const header = this._generateHeader(username);
                            this._fs.writeFileSync(filePath, header, 'utf8');
                            entry.headerWritten = true;
                        } catch (e) {
                            this._logWriteError(e, filePath);
                        }
                    }

                    this._userFiles.set(userId, entry);
                    return entry;
                }

                // Log a write error with appropriate classification
                _logWriteError(e, filePath) {
                    if (e.code === 'EACCES' || e.code === 'EPERM') {
                        console.error(`[VoiceTranscriber] TranscriptFileWriter: permission denied writing to ${filePath}:`, e.message);
                    } else if (e.code === 'ENOSPC') {
                        console.error(`[VoiceTranscriber] TranscriptFileWriter: disk full writing to ${filePath}:`, e.message);
                    } else {
                        console.error(`[VoiceTranscriber] TranscriptFileWriter: file write error for ${filePath}:`, e.message);
                    }
                }

                // Start a new transcription session
                startSession(channelName) {
                    if (this._sessionActive) {
                        console.warn('[VoiceTranscriber] TranscriptFileWriter: session already active, ending previous session');
                        this.endSession();
                    }

                    this._sessionId = this._generateSessionId();
                    this._sessionStartDate = new Date();
                    this._channelName = channelName || 'Unknown';
                    this._outputDir = this._settings.outputDir || './transcripts';
                    this._pendingEntries = [];
                    this._userFiles.clear();
                    this._sessionActive = true;

                    // Ensure output directory exists
                    if (!this._ensureOutputDir()) {
                        console.error('[VoiceTranscriber] TranscriptFileWriter: failed to create output directory, transcript writing disabled');
                        this._sessionActive = false;
                        return false;
                    }

                    // Start periodic flush interval (every 5 seconds)
                    this._flushInterval = setInterval(() => {
                        try {
                            this.flushToDisk();
                        } catch (e) {
                            console.error('[VoiceTranscriber] TranscriptFileWriter: periodic flush error:', e.message);
                        }
                    }, 5000);

                    console.log(`[VoiceTranscriber] TranscriptFileWriter: session started — ID: ${this._sessionId}, channel: ${this._channelName}, format: ${this._getFormatName()}`);
                    return true;
                }

                // End the current session: flush all pending writes and close files
                endSession() {
                    if (!this._sessionActive) return;

                    // Stop periodic flush
                    if (this._flushInterval) {
                        clearInterval(this._flushInterval);
                        this._flushInterval = null;
                    }

                    // Flush any remaining pending entries
                    try {
                        this.flushToDisk();
                    } catch (e) {
                        console.error('[VoiceTranscriber] TranscriptFileWriter: final flush error:', e.message);
                    }

                    // For JSON format, write the complete JSON files now
                    for (const [userId, fileEntry] of this._userFiles) {
                        if (fileEntry.format === 2 && fileEntry.entries.length > 0) {
                            try {
                                const jsonObj = {
                                    user: fileEntry.username,
                                    session: this._sessionId,
                                    channel: this._channelName,
                                    date: this._formatSessionDate(this._sessionStartDate),
                                    entries: fileEntry.entries
                                };
                                this._fs.writeFileSync(fileEntry.filePath, JSON.stringify(jsonObj, null, 2), 'utf8');
                            } catch (e) {
                                this._logWriteError(e, fileEntry.filePath);
                            }
                        }
                    }

                    console.log(`[VoiceTranscriber] TranscriptFileWriter: session ended — ID: ${this._sessionId}, files written: ${this._userFiles.size}`);

                    this._sessionActive = false;
                    this._userFiles.clear();
                    this._pendingEntries = [];
                    this._sessionId = null;
                    this._channelName = null;
                }

                // Queue a transcript entry for writing
                writeTranscript(userId, username, text, timestamp) {
                    if (!this._sessionActive) {
                        console.warn('[VoiceTranscriber] TranscriptFileWriter: no active session, cannot write transcript');
                        return;
                    }
                    if (!text || text.trim() === '') return;

                    const entry = {
                        userId,
                        username,
                        text: text.trim(),
                        timestamp: timestamp || Date.now()
                    };

                    this._pendingEntries.push(entry);
                }

                // Flush all pending transcript entries to disk
                flushToDisk() {
                    if (this._pendingEntries.length === 0) return;
                    if (!this._fs || !this._path) return;

                    const entries = this._pendingEntries.splice(0);
                    const fmt = this._settings.outputFormat;

                    for (const entry of entries) {
                        const fileEntry = this._getOrCreateUserFile(entry.userId, entry.username);
                        const timeStr = this._formatTimestamp(entry.timestamp);

                        try {
                            if (fmt === 2) {
                                // JSON format: accumulate entries in memory, write at endSession
                                fileEntry.entries.push({
                                    timestamp: timeStr,
                                    text: entry.text
                                });
                            } else if (fmt === 1) {
                                // Markdown format: table row
                                const escapedText = entry.text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
                                const line = `| ${timeStr} | ${escapedText} |\n`;
                                // Append via writeFileSync with the 'a' flag: the Electron
                                // renderer's fs shim sometimes lacks appendFileSync even
                                // though writeFileSync/existsSync/mkdirSync are present.
                                this._fs.writeFileSync(fileEntry.filePath, line, { encoding: 'utf8', flag: 'a' });
                            } else {
                                // Plain text format: [HH:MM:SS] text
                                const line = `[${timeStr}] ${entry.text}\n`;
                                this._fs.writeFileSync(fileEntry.filePath, line, { encoding: 'utf8', flag: 'a' });
                            }
                        } catch (e) {
                            this._logWriteError(e, fileEntry.filePath);
                        }
                    }
                }

                // Get current session metadata
                getSessionInfo() {
                    if (!this._sessionActive) {
                        return {
                            active: false,
                            sessionId: null,
                            channelName: null,
                            startDate: null,
                            format: null,
                            outputDir: null,
                            pendingEntries: 0,
                            userFiles: 0
                        };
                    }

                    return {
                        active: true,
                        sessionId: this._sessionId,
                        channelName: this._channelName,
                        startDate: this._sessionStartDate ? this._sessionStartDate.toISOString() : null,
                        format: this._getFormatName(),
                        outputDir: this._outputDir,
                        pendingEntries: this._pendingEntries.length,
                        userFiles: this._userFiles.size
                    };
                }

                // Check if a session is currently active
                isSessionActive() {
                    return this._sessionActive;
                }
            }

            // ─── TranscriptUIOverlay ───────────────────────────────────────────
            // Floating panel that shows real-time transcription status, speaking
            // indicators, transcript preview, and session stats.
            class TranscriptUIOverlay {
                constructor() {
                    this._panel = null;
                    this._styleEl = null;
                    this._isVisible = false;
                    this._isMinimized = false;
                    this._dragState = null;
                    this._resizeState = null;
                    this._transcriptLines = [];
                    this._speakingUsers = new Map();
                    this._stats = { elapsed: '00:00', chunks: 0, words: 0 };
                    this._statusDot = null;
                    this._statusText = null;
                    this._speakersContainer = null;
                    this._transcriptContainer = null;
                    this._statsContainer = null;
                    this._panelBody = null;
                    this._resizeHandle = null;
                    this._recordBtn = null;
                    this._boundMouseMove = null;
                    this._boundMouseUp = null;
                    this._onToggle = null;   // wired to start/stop recording
                    this._recording = false;
                }

                // ── CSS styles injected once ──────────────────────────────────
                _getCSS() {
                    return `
/* TranscriptUIOverlay styles */
.vt-overlay-panel {
    position: fixed;
    bottom: 20px;
    right: 20px;
    width: 300px;
    height: 400px;
    min-width: 220px;
    min-height: 180px;
    background: #36393f;
    border: 1px solid #202225;
    border-radius: 8px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.5);
    z-index: 9999;
    display: flex;
    flex-direction: column;
    font-family: 'gg sans', 'Segoe UI', Helvetica, Arial, sans-serif;
    color: #dcddde;
    overflow: hidden;
    user-select: none;
}
.vt-overlay-panel.vt-minimized {
    height: auto !important;
    min-height: unset !important;
}
.vt-overlay-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 10px;
    background: #2f3136;
    cursor: grab;
    border-radius: 8px 8px 0 0;
    flex-shrink: 0;
}
.vt-overlay-header:active { cursor: grabbing; }
.vt-overlay-title {
    font-size: 13px;
    font-weight: 600;
    color: #fff;
    display: flex;
    align-items: center;
    gap: 6px;
}
.vt-overlay-controls {
    display: flex;
    align-items: center;
    gap: 4px;
}
.vt-overlay-btn {
    background: none;
    border: none;
    color: #b9bbbe;
    cursor: pointer;
    font-size: 16px;
    line-height: 1;
    padding: 2px 4px;
    border-radius: 3px;
    transition: background 0.15s, color 0.15s;
}
.vt-overlay-btn:hover { background: rgba(255,255,255,0.1); color: #fff; }
.vt-overlay-body {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    padding: 8px 10px;
    gap: 8px;
}
.vt-overlay-panel.vt-minimized .vt-overlay-body { display: none; }
.vt-overlay-panel.vt-minimized .vt-resize-handle { display: none; }

/* Status row */
.vt-status-row {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    flex-shrink: 0;
}
.vt-status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #747f8d;
    flex-shrink: 0;
    transition: background 0.3s;
}
.vt-status-dot.vt-recording {
    background: #3ba55d;
    animation: vt-pulse 1.5s ease-in-out infinite;
}
@keyframes vt-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
}

/* Speaking indicators */
.vt-speakers-section {
    flex-shrink: 0;
    max-height: 80px;
    overflow-y: auto;
}
.vt-speakers-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: #72767d;
    margin-bottom: 4px;
    font-weight: 600;
}
.vt-speakers-list {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
}
.vt-speaker-tag {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    background: #40444b;
    color: #dcddde;
    padding: 2px 8px;
    border-radius: 10px;
    font-size: 11px;
    transition: background 0.2s, box-shadow 0.2s;
}
.vt-speaker-tag.vt-active {
    background: rgba(88,101,242,0.25);
    color: #fff;
    box-shadow: 0 0 0 1px #5865f2;
    animation: vt-speak-glow 0.8s ease-in-out infinite alternate;
}
@keyframes vt-speak-glow {
    0% { box-shadow: 0 0 0 1px #5865f2; }
    100% { box-shadow: 0 0 6px 2px rgba(88,101,242,0.5); }
}

/* Transcript preview */
.vt-transcript-section {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
}
.vt-transcript-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: #72767d;
    margin-bottom: 4px;
    font-weight: 600;
    flex-shrink: 0;
}
.vt-transcript-list {
    flex: 1;
    overflow-y: auto;
    font-size: 12px;
    line-height: 1.5;
    padding-right: 4px;
}
.vt-transcript-list::-webkit-scrollbar { width: 4px; }
.vt-transcript-list::-webkit-scrollbar-track { background: transparent; }
.vt-transcript-list::-webkit-scrollbar-thumb { background: #202225; border-radius: 2px; }
.vt-transcript-line {
    padding: 2px 0;
    word-break: break-word;
}
.vt-transcript-user {
    color: #5865f2;
    font-weight: 600;
}
.vt-transcript-text { color: #dcddde; }

/* Stats bar */
.vt-stats-bar {
    display: flex;
    justify-content: space-between;
    font-size: 10px;
    color: #72767d;
    padding-top: 4px;
    border-top: 1px solid rgba(255,255,255,0.04);
    flex-shrink: 0;
}

/* Resize handle */
.vt-resize-handle {
    position: absolute;
    bottom: 0;
    right: 0;
    width: 14px;
    height: 14px;
    cursor: nwse-resize;
    opacity: 0.3;
    transition: opacity 0.2s;
}
.vt-resize-handle:hover { opacity: 0.7; }
.vt-resize-handle::after {
    content: '';
    position: absolute;
    bottom: 3px;
    right: 3px;
    width: 8px;
    height: 8px;
    border-right: 2px solid #72767d;
    border-bottom: 2px solid #72767d;
}

/* Record / stop toggle */
.vt-overlay-btn.vt-record-btn {
    width: 28px;
    height: 22px;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
}
.vt-record-ind {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: #ed4245;
    transition: all 0.2s;
}
.vt-record-btn.vt-recording .vt-record-ind {
    border-radius: 2px;
    background: #3ba55d;
}
`;
                }

                // ── Build DOM ─────────────────────────────────────────────────
                _buildPanel() {
                    const panel = document.createElement('div');
                    panel.className = 'vt-overlay-panel';

                    // Header
                    const header = document.createElement('div');
                    header.className = 'vt-overlay-header';

                    const title = document.createElement('div');
                    title.className = 'vt-overlay-title';
                    title.textContent = '🎙️ Voice Transcriber';

                    const controls = document.createElement('div');
                    controls.className = 'vt-overlay-controls';

                    const recordBtn = document.createElement('button');
                    recordBtn.className = 'vt-overlay-btn vt-record-btn';
                    recordBtn.title = 'Start recording';
                    const recordInd = document.createElement('span');
                    recordInd.className = 'vt-record-ind';
                    recordBtn.appendChild(recordInd);
                    recordBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        if (this._onToggle) this._onToggle();
                    });
                    this._recordBtn = recordBtn;

                    const minimizeBtn = document.createElement('button');
                    minimizeBtn.className = 'vt-overlay-btn';
                    minimizeBtn.textContent = '−';
                    minimizeBtn.title = 'Minimize / Maximize';
                    minimizeBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        this._toggleMinimize();
                    });

                    const closeBtn = document.createElement('button');
                    closeBtn.className = 'vt-overlay-btn';
                    closeBtn.textContent = '✕';
                    closeBtn.title = 'Hide panel';
                    closeBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        this.hidePanel();
                    });

                    controls.appendChild(recordBtn);
                    controls.appendChild(minimizeBtn);
                    controls.appendChild(closeBtn);
                    header.appendChild(title);
                    header.appendChild(controls);

                    // Body
                    const body = document.createElement('div');
                    body.className = 'vt-overlay-body';
                    this._panelBody = body;

                    // Status row
                    const statusRow = document.createElement('div');
                    statusRow.className = 'vt-status-row';
                    const statusDot = document.createElement('div');
                    statusDot.className = 'vt-status-dot';
                    this._statusDot = statusDot;
                    const statusText = document.createElement('span');
                    statusText.textContent = 'Idle';
                    this._statusText = statusText;
                    statusRow.appendChild(statusDot);
                    statusRow.appendChild(statusText);

                    // Speaking indicators
                    const speakersSection = document.createElement('div');
                    speakersSection.className = 'vt-speakers-section';
                    const speakersLabel = document.createElement('div');
                    speakersLabel.className = 'vt-speakers-label';
                    speakersLabel.textContent = 'Speaking';
                    const speakersList = document.createElement('div');
                    speakersList.className = 'vt-speakers-list';
                    this._speakersContainer = speakersList;
                    speakersSection.appendChild(speakersLabel);
                    speakersSection.appendChild(speakersList);

                    // Transcript preview
                    const transcriptSection = document.createElement('div');
                    transcriptSection.className = 'vt-transcript-section';
                    const transcriptLabel = document.createElement('div');
                    transcriptLabel.className = 'vt-transcript-label';
                    transcriptLabel.textContent = 'Transcript';
                    const transcriptList = document.createElement('div');
                    transcriptList.className = 'vt-transcript-list';
                    this._transcriptContainer = transcriptList;
                    transcriptSection.appendChild(transcriptLabel);
                    transcriptSection.appendChild(transcriptList);

                    // Stats bar
                    const statsBar = document.createElement('div');
                    statsBar.className = 'vt-stats-bar';
                    this._statsContainer = statsBar;
                    this._renderStats();

                    body.appendChild(statusRow);
                    body.appendChild(speakersSection);
                    body.appendChild(transcriptSection);
                    body.appendChild(statsBar);

                    // Resize handle
                    const resizeHandle = document.createElement('div');
                    resizeHandle.className = 'vt-resize-handle';
                    this._resizeHandle = resizeHandle;

                    panel.appendChild(header);
                    panel.appendChild(body);
                    panel.appendChild(resizeHandle);

                    this._panel = panel;

                    // Dragging
                    this._setupDrag(header);
                    // Resizing
                    this._setupResize(resizeHandle);
                }

                // ── Drag logic ────────────────────────────────────────────────
                _setupDrag(header) {
                    header.addEventListener('mousedown', (e) => {
                        if (e.target.closest('.vt-overlay-btn')) return;
                        e.preventDefault();
                        const rect = this._panel.getBoundingClientRect();
                        this._dragState = {
                            startX: e.clientX,
                            startY: e.clientY,
                            origLeft: rect.left,
                            origTop: rect.top
                        };
                        this._boundMouseMove = this._onDragMove.bind(this);
                        this._boundMouseUp = this._onDragEnd.bind(this);
                        document.addEventListener('mousemove', this._boundMouseMove);
                        document.addEventListener('mouseup', this._boundMouseUp);
                    });
                }

                _onDragMove(e) {
                    if (!this._dragState || !this._panel) return;
                    const dx = e.clientX - this._dragState.startX;
                    const dy = e.clientY - this._dragState.startY;
                    const newLeft = this._dragState.origLeft + dx;
                    const newTop = this._dragState.origTop + dy;
                    this._panel.style.left = newLeft + 'px';
                    this._panel.style.top = newTop + 'px';
                    this._panel.style.right = 'auto';
                    this._panel.style.bottom = 'auto';
                }

                _onDragEnd() {
                    this._dragState = null;
                    document.removeEventListener('mousemove', this._boundMouseMove);
                    document.removeEventListener('mouseup', this._boundMouseUp);
                }

                // ── Resize logic ──────────────────────────────────────────────
                _setupResize(handle) {
                    handle.addEventListener('mousedown', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        const rect = this._panel.getBoundingClientRect();
                        this._resizeState = {
                            startX: e.clientX,
                            startY: e.clientY,
                            origW: rect.width,
                            origH: rect.height
                        };
                        this._boundMouseMove = this._onResizeMove.bind(this);
                        this._boundMouseUp = this._onResizeEnd.bind(this);
                        document.addEventListener('mousemove', this._boundMouseMove);
                        document.addEventListener('mouseup', this._boundMouseUp);
                    });
                }

                _onResizeMove(e) {
                    if (!this._resizeState || !this._panel) return;
                    const dx = e.clientX - this._resizeState.startX;
                    const dy = e.clientY - this._resizeState.startY;
                    const newW = Math.max(220, this._resizeState.origW + dx);
                    const newH = Math.max(180, this._resizeState.origH + dy);
                    this._panel.style.width = newW + 'px';
                    this._panel.style.height = newH + 'px';
                }

                _onResizeEnd() {
                    this._resizeState = null;
                    document.removeEventListener('mousemove', this._boundMouseMove);
                    document.removeEventListener('mouseup', this._boundMouseUp);
                }

                // ── Minimize toggle ───────────────────────────────────────────
                _toggleMinimize() {
                    this._isMinimized = !this._isMinimized;
                    if (this._panel) {
                        this._panel.classList.toggle('vt-minimized', this._isMinimized);
                    }
                }

                // ── Inject / remove styles ────────────────────────────────────
                _injectStyles() {
                    if (this._styleEl) return;
                    this._styleEl = document.createElement('style');
                    this._styleEl.textContent = this._getCSS();
                    document.head.appendChild(this._styleEl);
                }

                _removeStyles() {
                    if (this._styleEl && this._styleEl.parentNode) {
                        this._styleEl.parentNode.removeChild(this._styleEl);
                        this._styleEl = null;
                    }
                }

                // ── Render helpers ────────────────────────────────────────────
                _renderStats() {
                    if (!this._statsContainer) return;
                    this._statsContainer.innerHTML = '';
                    const s = this._stats;
                    const items = [
                        `⏱ ${s.elapsed}`,
                        `📦 ${s.chunks} chunks`,
                        `📝 ${s.words} words`
                    ];
                    for (const item of items) {
                        const span = document.createElement('span');
                        span.textContent = item;
                        this._statsContainer.appendChild(span);
                    }
                }

                _renderSpeakers() {
                    if (!this._speakersContainer) return;
                    this._speakersContainer.innerHTML = '';
                    this._speakingUsers.forEach((isSpeaking, username) => {
                        const tag = document.createElement('span');
                        tag.className = 'vt-speaker-tag' + (isSpeaking ? ' vt-active' : '');
                        tag.textContent = username;
                        this._speakersContainer.appendChild(tag);
                    });
                }

                _renderTranscript() {
                    if (!this._transcriptContainer) return;
                    this._transcriptContainer.innerHTML = '';
                    // Show last 10 lines
                    const lines = this._transcriptLines.slice(-10);
                    for (const line of lines) {
                        const div = document.createElement('div');
                        div.className = 'vt-transcript-line';
                        const userSpan = document.createElement('span');
                        userSpan.className = 'vt-transcript-user';
                        userSpan.textContent = `[${line.username}]: `;
                        const textSpan = document.createElement('span');
                        textSpan.className = 'vt-transcript-text';
                        textSpan.textContent = line.text;
                        div.appendChild(userSpan);
                        div.appendChild(textSpan);
                        this._transcriptContainer.appendChild(div);
                    }
                    // Auto-scroll to bottom
                    this._transcriptContainer.scrollTop = this._transcriptContainer.scrollHeight;
                }

                // ── Public API ────────────────────────────────────────────────

                /** Show the overlay panel. Creates DOM if needed. */
                showPanel() {
                    this._injectStyles();
                    if (!this._panel) {
                        this._buildPanel();
                    }
                    if (!this._panel.parentNode) {
                        document.body.appendChild(this._panel);
                    }
                    this._panel.style.display = 'flex';
                    this._isVisible = true;
                }

                /** Hide the overlay panel (does not destroy it). */
                hidePanel() {
                    if (this._panel) {
                        this._panel.style.display = 'none';
                    }
                    this._isVisible = false;
                }

                /** Fully destroy the panel and styles. */
                destroy() {
                    // Clean up drag/resize listeners
                    if (this._boundMouseMove) {
                        document.removeEventListener('mousemove', this._boundMouseMove);
                    }
                    if (this._boundMouseUp) {
                        document.removeEventListener('mouseup', this._boundMouseUp);
                    }
                    if (this._panel && this._panel.parentNode) {
                        this._panel.parentNode.removeChild(this._panel);
                    }
                    this._panel = null;
                    this._removeStyles();
                    this._isVisible = false;
                    this._isMinimized = false;
                    this._transcriptLines = [];
                    this._speakingUsers.clear();
                }

                /**
                 * Update the list of currently speaking users.
                 * @param {Array<{username: string, isSpeaking: boolean}>} users
                 */
                updateSpeakingUsers(users) {
                    this._speakingUsers.clear();
                    if (Array.isArray(users)) {
                        for (const u of users) {
                            this._speakingUsers.set(u.username, !!u.isSpeaking);
                        }
                    }
                    this._renderSpeakers();
                }

                /** Set the handler invoked when the record/stop button is clicked. */
                setToggleHandler(fn) {
                    this._onToggle = fn || null;
                }

                /** Reflect the current recording state on the toggle + status row. */
                setRecording(isRecording) {
                    this._recording = !!isRecording;
                    if (this._recordBtn) {
                        this._recordBtn.classList.toggle('vt-recording', this._recording);
                        this._recordBtn.title = this._recording ? 'Stop recording' : 'Start recording';
                    }
                    if (this._statusDot && this._statusText) {
                        if (this._recording) {
                            this._statusDot.classList.add('vt-recording');
                            this._statusText.textContent = 'Recording…';
                        } else {
                            this._statusDot.classList.remove('vt-recording');
                            this._statusText.textContent = 'Idle';
                        }
                    }
                }

                /** Clear accumulated transcript lines. */
                clearTranscript() {
                    this._transcriptLines = [];
                    this._renderTranscript();
                }

                /**
                 * Add a transcribed line to the preview.
                 * @param {string} username
                 * @param {string} text
                 */
                addTranscriptLine(username, text) {
                    this._transcriptLines.push({ username, text });
                    // Keep a max of 200 lines in memory
                    if (this._transcriptLines.length > 200) {
                        this._transcriptLines = this._transcriptLines.slice(-200);
                    }
                    this._renderTranscript();
                }

                /**
                 * Update session statistics.
                 * @param {{elapsed?: string, chunks?: number, words?: number}} stats
                 */
                updateStats(stats) {
                    if (stats.elapsed !== undefined) this._stats.elapsed = stats.elapsed;
                    if (stats.chunks !== undefined) this._stats.chunks = stats.chunks;
                    if (stats.words !== undefined) this._stats.words = stats.words;
                    this._renderStats();
                }

                /** Whether the panel is currently visible. */
                isVisible() {
                    return this._isVisible;
                }
            }


            // TranscriptUIPanel: displays live transcription results in a floating panel
            class TranscriptUIPanel {
                constructor() {
                    this._panel = null;
                    this._visible = false;
                    this._entries = [];
                }

                show() {
                    if (this._visible) return;
                    this._createPanel();
                    this._visible = true;
                }

                hide() {
                    if (!this._visible) return;
                    if (this._panel) {
                        this._panel.remove();
                        this._panel = null;
                    }
                    this._visible = false;
                }

                _createPanel() {
                    this._panel = document.createElement('div');
                    this._panel.id = 'voice-transcriber-panel';
                    this._panel.style.cssText = `
                        position: fixed;
                        top: 80px;
                        right: 20px;
                        width: 350px;
                        max-height: 500px;
                        background: #2f3136;
                        border: 1px solid #202225;
                        border-radius: 8px;
                        box-shadow: 0 8px 16px rgba(0,0,0,0.4);
                        display: flex;
                        flex-direction: column;
                        z-index: 9999;
                        font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                    `;

                    const header = document.createElement('div');
                    header.style.cssText = `
                        padding: 12px 16px;
                        background: #202225;
                        border-bottom: 1px solid #18191c;
                        border-radius: 8px 8px 0 0;
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                    `;

                    const title = document.createElement('span');
                    title.textContent = '📝 Live Transcript';
                    title.style.cssText = 'color: #fff; font-size: 14px; font-weight: 600;';
                    header.appendChild(title);

                    const closeBtn = document.createElement('button');
                    closeBtn.textContent = '×';
                    closeBtn.style.cssText = `
                        background: transparent;
                        border: none;
                        color: #b9bbbe;
                        font-size: 24px;
                        cursor: pointer;
                        padding: 0;
                        width: 24px;
                        height: 24px;
                        line-height: 1;
                    `;
                    closeBtn.addEventListener('click', () => this.hide());
                    header.appendChild(closeBtn);

                    this._panel.appendChild(header);

                    const content = document.createElement('div');
                    content.id = 'voice-transcriber-content';
                    content.style.cssText = `
                        flex: 1;
                        overflow-y: auto;
                        padding: 12px 16px;
                        color: #dcddde;
                        font-size: 13px;
                        line-height: 1.5;
                    `;
                    this._panel.appendChild(content);

                    document.body.appendChild(this._panel);
                }

                addEntry(userId, username, text, timestamp) {
                    if (!this._visible || !this._panel) return;
                    
                    const content = this._panel.querySelector('#voice-transcriber-content');
                    if (!content) return;

                    const entry = document.createElement('div');
                    entry.style.cssText = 'margin-bottom: 12px;';

                    const header = document.createElement('div');
                    header.style.cssText = 'display: flex; justify-content: space-between; margin-bottom: 4px;';

                    const userSpan = document.createElement('span');
                    userSpan.textContent = username;
                    userSpan.style.cssText = 'color: #fff; font-weight: 600; font-size: 13px;';
                    header.appendChild(userSpan);

                    const timeSpan = document.createElement('span');
                    const time = new Date(timestamp);
                    timeSpan.textContent = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                    timeSpan.style.cssText = 'color: #72767d; font-size: 11px;';
                    header.appendChild(timeSpan);

                    entry.appendChild(header);

                    const textDiv = document.createElement('div');
                    textDiv.textContent = text;
                    textDiv.style.cssText = 'color: #dcddde; word-wrap: break-word;';
                    entry.appendChild(textDiv);

                    content.appendChild(entry);
                    content.scrollTop = content.scrollHeight;

                    this._entries.push({ userId, username, text, timestamp });
                }

                clear() {
                    if (this._panel) {
                        const content = this._panel.querySelector('#voice-transcriber-content');
                        if (content) content.innerHTML = '';
                    }
                    this._entries = [];
                }

                isVisible() {
                    return this._visible;
                }
            }

            // SessionController: orchestrates the full recording pipeline with state machine
            class SessionController {
                constructor(pluginInstance) {
                    this._plugin = pluginInstance;
                    this._state = 'IDLE'; // IDLE, RECORDING, STOPPING
                    this._audioChunker = null;
                    this._uiPanel = null;
                    this._errorLog = [];
                    this._speakingLog = [];      // completed speaking segments {userId,username,start,end}
                    this._openSpeakers = new Map(); // userId -> {userId,username,start}
                    this._lastProcessedCount = 0;   // results already handled by the polling loop
                    this._lastWrittenText = null;   // last transcript line written (dedupe guard)
                    this._sessionStartTime = null;   // when the current recording started
                    this._totalChunks = 0;           // transcription chunks processed
                    this._totalWords = 0;            // total words transcribed
                    this._elapsedTimer = null;       // 1s ticker for the overlay clock
                }

                getState() {
                    return this._state;
                }

                _formatElapsed(ms) {
                    const s = Math.max(0, Math.floor(ms / 1000));
                    const m = Math.floor(s / 60);
                    const sec = s % 60;
                    return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
                }

                // A newly transcribed result — bump chunk/word counters and push them to the
                // overlay stats bar.
                _bumpStats(text) {
                    this._totalChunks += 1;
                    const words = (text || '').trim().split(/\s+/).filter(Boolean).length;
                    this._totalWords += words;
                    if (this._plugin && this._plugin.uiOverlay) {
                        this._plugin.uiOverlay.updateStats({ chunks: this._totalChunks, words: this._totalWords });
                    }
                }

                _startElapsedTimer() {
                    if (this._elapsedTimer) return;
                    this._elapsedTimer = setInterval(() => {
                        if (this._state !== 'RECORDING') return;
                        const ms = Date.now() - (this._sessionStartTime || Date.now());
                        if (this._plugin && this._plugin.uiOverlay) {
                            this._plugin.uiOverlay.updateStats({ elapsed: this._formatElapsed(ms) });
                        }
                    }, 1000);
                }

                _stopElapsedTimer() {
                    if (this._elapsedTimer) {
                        clearInterval(this._elapsedTimer);
                        this._elapsedTimer = null;
                    }
                }

                // Record a SPEAKING event so chunks of the mixed loopback stream can be
                // attributed to whoever was actually talking.
                recordSpeaking(userId, username, speaking) {
                    if (!userId) return;
                    if (speaking) {
                        if (!this._openSpeakers.has(userId)) {
                            this._openSpeakers.set(userId, { userId, username, start: Date.now() });
                        }
                    } else {
                        const seg = this._openSpeakers.get(userId);
                        if (seg) {
                            this._openSpeakers.delete(userId);
                            this._speakingLog.push({ userId, username: seg.username, start: seg.start, end: Date.now() });
                        }
                    }
                }

                // Pick the participant who was speaking most during [startTime, endTime].
                _attributeSpeaker(startTime, endTime) {
                    const overlap = new Map(); // userId -> {username, ms}
                    const winStart = startTime || 0;
                    const winEnd = endTime || ((startTime || 0) + 60000);

                    const addOverlap = (userId, username, s, e) => {
                        if (s >= e) return;
                        const cur = overlap.get(userId) || { username, ms: 0 };
                        cur.ms += (e - s);
                        overlap.set(userId, cur);
                    };

                    // Completed speaking segments.
                    for (const seg of this._speakingLog) {
                        addOverlap(seg.userId, seg.username,
                            Math.max(seg.start, winStart),
                            Math.min(seg.end, winEnd));
                    }

                    // OPEN speaking segments (user still talking, `speaking:false` not yet
                    // received). A 30s chunk frequently flushes mid-sentence, so without this
                    // the person talking right now is never credited and the chunk falls back
                    // to a generic label.
                    for (const seg of this._openSpeakers.values()) {
                        addOverlap(seg.userId, seg.username,
                            Math.max(seg.start, winStart),
                            winEnd);
                    }

                    let best = null;
                    for (const [userId, info] of overlap) {
                        if (!best || info.ms > best.ms) best = { userId, username: info.username };
                    }
                    return best;
                }

                // Best-effort label for a group chunk when no SPEAKING overlap is found.
                // Uses whatever signal exists: the most recent speaker, a currently-open
                // speaker, or (for a call with exactly one other participant) that person.
                _bestGuessSpeaker() {
                    if (this._speakingLog.length) {
                        const seg = this._speakingLog[this._speakingLog.length - 1];
                        return { userId: seg.userId, username: seg.username };
                    }
                    if (this._openSpeakers.size) {
                        const seg = this._openSpeakers.values().next().value;
                        return { userId: seg.userId, username: seg.username };
                    }
                    const localId = (this._plugin && this._plugin._getLocalUserId) ? this._plugin._getLocalUserId() : null;
                    const remotes = [];
                    for (const p of this._plugin.voiceTracker.getParticipants().values()) {
                        if (p.userId && p.userId !== localId && p.userId !== MIXED_CALL_STREAM_KEY) {
                            remotes.push(p);
                        }
                    }
                    if (remotes.length === 1) {
                        return { userId: remotes[0].userId, username: remotes[0].username || remotes[0].userId };
                    }
                    return null;
                }

                async startRecording(channelId, channelName) {
                    if (this._state !== 'IDLE') {
                        console.warn('[VoiceTranscriber] SessionController: cannot start, state is', this._state);
                        return false;
                    }

                    try {
                        this._state = 'RECORDING';
                        // Reset per-session transcript tracking (the transcription service's
                        // result list is fresh each session, so the poll offset and dedupe guard
                        // must start over too, or the first N lines of this session get skipped).
                        this._lastProcessedCount = 0;
                        this._lastWrittenText = null;
                        console.log('[VoiceTranscriber] SessionController: starting recording...');

                        // 1. Start audio capture (single mixed input device, e.g. VB-Cable loopback)
                        if (typeof this._plugin.audioCapture.setDevice === 'function') {
                            this._plugin.audioCapture.setDevice(this._plugin.settings.audioInputDeviceId || '');
                        }
                        const captureStarted = await this._plugin.audioCapture.start(channelId);
                        if (!captureStarted) {
                            console.error('[VoiceTranscriber] SessionController: audio capture failed');
                            this._state = 'IDLE';
                            return false;
                        }

                        // Attach Discord's native "speaking" signal (per-user, works even when
                        // the Flux dispatcher doesn't relay speaking events).
                        try { this._plugin._attachVoiceConnectionSpeaking(); } catch (e) {}

                        // 2. Initialize and start AudioChunker
                        this._audioChunker = new AudioChunker({
                            chunkDuration: this._plugin.settings.chunkDuration || 30,
                            silenceThreshold: this._plugin.settings.silenceThreshold,
                            minChunkDuration: this._plugin.settings.minChunkDuration,
                            flushSilenceMs: this._plugin.settings.flushSilenceMs
                        });
                        this._audioChunker._running = true;
                        
                        // Wire chunk callback to transcription service
                        this._audioChunker.setChunkCallback((chunk) => {
                            try {
                                if (this._plugin.whisperService) {
                                    this._plugin.whisperService.enqueueChunk(chunk);
                                }
                            } catch (e) {
                                console.error('[VoiceTranscriber] SessionController: chunk enqueue error:', e);
                                this._errorLog.push({ type: 'chunk', error: e.message, timestamp: Date.now() });
                            }
                        });

                        // Start chunking for each active stream
                        const streams = this._plugin.audioCapture.getActiveStreams();
                        for (const [userId, stream] of streams) {
                            this._audioChunker.start(userId, stream);
                        }

                        // 3. Start transcription service
                        if (this._plugin.settings.backend === 0) {
                            // OpenAI Whisper API
                            console.log('[VoiceTranscriber] SessionController: starting OpenAI Whisper API backend');
                            this._plugin.whisperService = new WhisperTranscriptionService({
                                errorHandler: this._plugin.globalErrorHandler,
                                apiKey: this._plugin.settings.apiKey
                            });
                        } else {
                            // Local Whisper server
                            console.log(`[VoiceTranscriber] SessionController: starting Local Whisper server backend at ${this._plugin.settings.localServerUrl || 'http://localhost:9000'}`);
                            this._plugin.whisperService = new LocalWhisperTranscriptionService({
                                localServerUrl: this._plugin.settings.localServerUrl,
                                errorHandler: this._plugin.globalErrorHandler
                            });
                        }

                        const transcribeStarted = await this._plugin.whisperService.startTranscription();
                        if (!transcribeStarted) {
                            console.error('[VoiceTranscriber] SessionController: transcription service failed to start');
                            this._audioChunker.stopAll();
                            this._plugin.audioCapture.stop();
                            this._state = 'IDLE';
                            return false;
                        }

                        // Wire transcription results to file writer and UI
                        this._setupTranscriptionPolling();

                        // 4. Start file writer session
                        this._plugin.transcriptWriter = new TranscriptFileWriter({
                            outputDir: this._plugin.settings.outputDir,
                            outputFormat: this._plugin.settings.outputFormat
                        });
                        const sessionStarted = this._plugin.transcriptWriter.startSession(channelName);
                        if (!sessionStarted) {
                            console.error('[VoiceTranscriber] SessionController: file writer session failed');
                            this._plugin.whisperService.stopTranscription();
                            this._audioChunker.stopAll();
                            this._plugin.audioCapture.stop();
                            this._state = 'IDLE';
                            return false;
                        }

                        // 5. Show the Voice Transcriber overlay and start a fresh session view
                        this._sessionStartTime = Date.now();
                        this._totalChunks = 0;
                        this._totalWords = 0;
                        this._plugin.uiOverlay.showPanel();
                        this._plugin.uiOverlay.clearTranscript();
                        this._plugin.uiOverlay.updateStats({ elapsed: '00:00', chunks: 0, words: 0 });
                        this._plugin.uiOverlay.setRecording(true);
                        this._startElapsedTimer();

                        console.log('[VoiceTranscriber] SessionController: recording started successfully');
                        return true;

                    } catch (e) {
                        console.error('[VoiceTranscriber] SessionController: startRecording error:', e);
                        this._errorLog.push({ type: 'start', error: e.message, timestamp: Date.now() });
                        this._state = 'IDLE';
                        return false;
                    }
                }

                async stopRecording() {
                    if (this._state !== 'RECORDING') {
                        console.warn('[VoiceTranscriber] SessionController: cannot stop, state is', this._state);
                        return false;
                    }

                    try {
                        this._state = 'STOPPING';
                        console.log('[VoiceTranscriber] SessionController: stopping recording...');

                        let outputPath = null;

                        // Stop in reverse order:
                        // 1. Mark the overlay idle (keep it visible so the transcript is reviewable)
                        this._stopElapsedTimer();
                        this._plugin.uiOverlay.setRecording(false);

                        // 2. Stop file writer and get output path
                        if (this._plugin.transcriptWriter) {
                            const sessionInfo = this._plugin.transcriptWriter.getSessionInfo();
                            if (sessionInfo && sessionInfo.outputDir) {
                                outputPath = sessionInfo.outputDir;
                            }
                            this._plugin.transcriptWriter.endSession();
                        }

                        // 3. Stop transcription service
                        if (this._plugin.whisperService) {
                            this._plugin.whisperService.stopTranscription();
                        }

                        // 4. Stop audio chunker
                        if (this._audioChunker) {
                            this._audioChunker.stopAll();
                        }

                        // 5. Stop audio capture
                        this._plugin.audioCapture.stop();

                        // 6. (overlay marked idle above — kept visible for review)

                        // 7. Show toast with output path
                        if (outputPath) {
                            BdApi.UI.showToast(`Session saved to: ${outputPath}`, { type: 'success', timeout: 5000 });
                        } else {
                            BdApi.UI.showToast('Session stopped', { type: 'info' });
                        }

                        this._state = 'IDLE';
                        console.log('[VoiceTranscriber] SessionController: recording stopped successfully');
                        return true;

                    } catch (e) {
                        console.error('[VoiceTranscriber] SessionController: stopRecording error:', e);
                        this._errorLog.push({ type: 'stop', error: e.message, timestamp: Date.now() });
                        this._state = 'IDLE';
                        return false;
                    }
                }

                _setupTranscriptionPolling() {
                    // Poll transcription results every 500ms and wire to file writer + UI
                    const pollInterval = setInterval(() => {
                        if (this._state !== 'RECORDING' || !this._plugin.whisperService) {
                            clearInterval(pollInterval);
                            return;
                        }

                        try {
                            // Get transcripts from Whisper service
                            let transcripts;
                            if (this._plugin.whisperService.getTranscripts) {
                                // WhisperTranscriptionService (OpenAI API)
                                const allTranscripts = this._plugin.whisperService.getAllTranscripts();
                                for (const [userId, entries] of allTranscripts) {
                                    for (const entry of entries) {
                                        const user = this._plugin.getUserById(userId);
                                        const username = user ? (user.globalName || user.username) : userId;
                                        
                                        // Write to file
                                        if (this._plugin.transcriptWriter) {
                                            this._plugin.transcriptWriter.writeTranscript(
                                                userId, username, entry.text, entry.timestamp
                                            );
                                        }
                                        
                                        // Show in UI
                                        if (this._plugin.uiOverlay) {
                                            this._plugin.uiOverlay.addTranscriptLine(username, entry.text);
                                        }
                                        this._bumpStats(entry.text);
                                    }
                                }
                                // Clear after processing
                                this._plugin.whisperService.clearTranscripts();
                            } else if (this._plugin.whisperService.getResults) {
                                // LocalWhisperTranscriptionService. getResults() returns the FULL
                                // accumulated list every call, so only process NEW entries (tracked by
                                // _lastProcessedCount) — otherwise every chunk is re-written each poll.
                                transcripts = this._plugin.whisperService.getResults();
                                const newResults = transcripts.slice(this._lastProcessedCount || 0);
                                this._lastProcessedCount = transcripts.length;

                                // Loopback capture is one mixed stream (no per-speaker separation), so
                                // attribute each chunk to whoever was speaking during it via the
                                // SPEAKING-event log.
                                const usingMixed = this._plugin.audioCapture && typeof this._plugin.audioCapture.isFallbackMode === 'function' && this._plugin.audioCapture.isFallbackMode();

                                for (const result of newResults) {
                                    // Drop blank/hallucinated results and collapse consecutive
                                    // repeats of the same line (Whisper re-uttering the last
                                    // phrase produces many identical lines).
                                    const line = (result.text || '').trim();
                                    if (!line) continue;
                                    if (line === this._lastWrittenText) continue;
                                    this._lastWrittenText = line;

                                    let authorId = result.userId;
                                    let username = null;

                                    // Only loopback/group chunks are a mixed mix that needs speaker
                                    // attribution; the user's own mic chunk is already the local user.
                                    if (usingMixed && result.userId === MIXED_CALL_STREAM_KEY) {
                                        const attrib = this._attributeSpeaker(result.startTime, result.endTime)
                                            || this._bestGuessSpeaker();
                                        if (attrib) {
                                            authorId = attrib.userId;
                                            username = attrib.username;
                                        } else {
                                            // Diagnostic: no SPEAKING overlap or participant signal at all.
                                            console.log(`[VoiceTranscriber] group chunk unattributed (speakingLog=${this._speakingLog.length}, openSpeakers=${this._openSpeakers.size}), labeling as ${authorId}`);
                                        }
                                    }

                                    if (!username) {
                                        const user = this._plugin.getUserById(authorId);
                                        username = user ? (user.globalName || user.username) : authorId;
                                    }

                                    if (this._plugin.transcriptWriter) {
                                        this._plugin.transcriptWriter.writeTranscript(authorId, username, line, result.timestamp);
                                    }
                                    this._plugin.uiOverlay.addTranscriptLine(username, line);
                                    this._bumpStats(line);
                                }
                            }
                        } catch (e) {
                            console.error('[VoiceTranscriber] SessionController: transcription polling error:', e);
                            this._errorLog.push({ type: 'polling', error: e.message, timestamp: Date.now() });
                            // Don't crash, continue recording
                        }
                    }, 500);
                }

                getErrorLog() {
                    return [...this._errorLog];
                }
            }

            const plugin = class VoiceTranscriber {
                constructor() {
                    this.settings = this._loadSettings();
                    this.voiceTracker = new VoiceStateTracker();
                    this.audioCapture = new AudioCaptureEngine();
                    this.globalErrorHandler = new GlobalErrorHandler();
                    this.whisperService = null;
                    this.transcriptWriter = null;
                    this.uiOverlay = new TranscriptUIOverlay();
                    this.sessionController = null;
                    this._recordButton = null;
                    this._hotkeyHandler = null;
                    this._dispatcherUnsubscribes = [];
                    this._vcSpeakingSource = null;   // current voice connection we're listening on
                    this._vcSpeakingHandler = null;
                    this._FluxDispatcher = null;
                    this._UserStore = null;
                    this._SelectedChannelStore = null;
                    this._ChannelStore = null;
                }

                // --- BetterDiscord v4 plugin metadata + lifecycle ---
                getName() { return PLUGIN_NAME; }
                getAuthor() { return "Killerishere"; }
                getVersion() { return PLUGIN_VERSION; }
                getDescription() { return "Transcribes voice call audio per-user to text files."; }
                load() { }
                start() { this.onStart(); }
                stop() { this.onStop(); }

                _loadSettings() {
                    let saved = {};
                    try {
                        if (typeof BdApi !== 'undefined' && BdApi.Data && typeof BdApi.Data.load === 'function') {
                            saved = BdApi.Data.load(PLUGIN_NAME, 'settings') || {};
                        }
                    } catch (e) {
                        console.error('[VoiceTranscriber] Failed to load settings:', e);
                    }
                    return Object.assign({}, DEFAULTS, saved);
                }
                saveSettings() {
                    try {
                        if (typeof BdApi === 'undefined' || !BdApi.Data || typeof BdApi.Data.save !== 'function') return;
                        BdApi.Data.save(PLUGIN_NAME, 'settings', this.settings);
                    } catch (e) {
                        console.error('[VoiceTranscriber] Failed to save settings:', e);
                    }
                }

                _makeButton(label, handler) {
                    const btn = document.createElement('button');
                    btn.textContent = label;
                    btn.style.cssText = 'padding:4px 12px;background:#5865F2;color:#fff;border:none;border-radius:3px;cursor:pointer;font-size:12px;font-weight:500;white-space:nowrap;';
                    btn.addEventListener('click', (e) => { e.preventDefault(); handler(); });
                    return btn;
                }

                _browseOutputDir(input) {
                    try {
                        const electron = require('electron');
                        const dialog = electron.remote ? electron.remote.dialog : electron.dialog;
                        if (!dialog || typeof dialog.showOpenDialog !== 'function') {
                            BdApi.UI.showToast('Electron dialog unavailable', { type: 'error' });
                            return;
                        }
                        dialog.showOpenDialog({ properties: ['openDirectory'], title: 'Select Output Directory' }).then((result) => {
                            if (!result.canceled && result.filePaths && result.filePaths.length > 0) {
                                this.settings.outputDir = result.filePaths[0];
                                this.saveSettings();
                                if (input) input.value = result.filePaths[0];
                                BdApi.UI.showToast('Output directory set', { type: 'success' });
                            }
                        }).catch((err) => {
                            BdApi.UI.showToast('Folder picker error: ' + err.message, { type: 'error' });
                        });
                    } catch (err) {
                        BdApi.UI.showToast('Electron dialog unavailable: ' + err.message, { type: 'error' });
                    }
                }

                // Helper: resolve Discord internal modules with resilient lookups
                _resolveModules() {
                    try {
                        this._FluxDispatcher = BdApi.Webpack.getModule(
                            m => m && typeof m.subscribe === 'function' && typeof m.dispatch === 'function'
                        );
                    } catch (e) {
                        console.error('[VoiceTranscriber] Failed to resolve FluxDispatcher:', e);
                    }

                    try {
                        this._UserStore = BdApi.Webpack.getModule(
                            m => m && typeof m.getUser === 'function'
                        );
                    } catch (e) {
                        console.error('[VoiceTranscriber] Failed to resolve UserStore:', e);
                    }

                    try {
                        this._SelectedChannelStore = BdApi.Webpack.getModule(
                            m => m && typeof m.getVoiceChannelId === 'function'
                        );
                    } catch (e) {
                        console.error('[VoiceTranscriber] Failed to resolve SelectedChannelStore:', e);
                    }

                    try {
                        this._ChannelStore = BdApi.Webpack.getModule(
                            m => m && typeof m.getChannel === 'function'
                        );
                    } catch (e) {
                        console.error('[VoiceTranscriber] Failed to resolve ChannelStore:', e);
                    }
                }

                // Helper: get the voice channel the local user is currently in
                getCurrentChannelId() {
                    try {
                        if (this._SelectedChannelStore && typeof this._SelectedChannelStore.getVoiceChannelId === 'function') {
                            return this._SelectedChannelStore.getVoiceChannelId();
                        }
                    } catch (e) {
                        console.error('[VoiceTranscriber] getCurrentChannelId error:', e);
                    }
                    return null;
                }

                // Helper: return the current Map of voice participants
                getParticipants() {
                    return this.voiceTracker.getParticipants();
                }

                // Start audio capture for the current or specified voice channel
                async startCaptureForChannel(channelId) {
                    if (!channelId) {
                        channelId = this.getCurrentChannelId();
                    }
                    if (!channelId) {
                        console.warn('[VoiceTranscriber] Cannot start capture: no voice channel specified or detected');
                        return false;
                    }

                    if (this.audioCapture.isCapturing()) {
                        console.log('[VoiceTranscriber] Audio capture already active');
                        return true;
                    }

                    try {
                        const started = await this.audioCapture.start(channelId);
                        if (started) {
                            const streamCount = this.audioCapture.getActiveStreams().size;
                            const isFallback = this.audioCapture.isFallbackMode();
                            console.log(`[VoiceTranscriber] Audio capture started for channel ${channelId}: ` +
                                `${streamCount} stream(s)${isFallback ? ' (fallback mode)' : ''}`);
                        } else {
                            console.error('[VoiceTranscriber] Failed to start audio capture');
                        }
                        return started;
                    } catch (e) {
                        console.error('[VoiceTranscriber] startCaptureForChannel error:', e);
                        return false;
                    }
                }

                // Stop audio capture
                stopCapture() {
                    if (this.audioCapture) {
                        this.audioCapture.stop();
                    }
                }

                // Get a specific user's audio stream
                getUserAudioStream(userId) {
                    return this.audioCapture ? this.audioCapture.getUserStream(userId) : null;
                }

                // Get all active audio streams
                getAllAudioStreams() {
                    return this.audioCapture ? this.audioCapture.getActiveStreams() : new Map();
                }

                // Helper: resolve a Discord user object from the UserStore
                getUserById(userId) {
                    try {
                        if (this._UserStore && typeof this._UserStore.getUser === 'function') {
                            return this._UserStore.getUser(userId);
                        }
                    } catch (e) {
                        console.error('[VoiceTranscriber] getUserById error:', e);
                    }
                    return null;
                }

                // Subscribe to a FluxDispatcher event and store cleanup
                _subscribe(eventType, handler) {
                    if (!this._FluxDispatcher) return;
                    try {
                        this._FluxDispatcher.subscribe(eventType, handler);
                        this._dispatcherUnsubscribes.push(() => {
                            try {
                                this._FluxDispatcher.unsubscribe(eventType, handler);
                            } catch (e) {
                                console.error(`[VoiceTranscriber] Failed to unsubscribe from ${eventType}:`, e);
                            }
                        });
                    } catch (e) {
                        console.error(`[VoiceTranscriber] Failed to subscribe to ${eventType}:`, e);
                    }
                }

                async onStart() {
                    this._resolveModules();

                    // Initialize SessionController
                    this.sessionController = new SessionController(this);

                    // Centralized error bus: feed the session error log and surface via UI
                    this.globalErrorHandler.onError('*', (err) => {
                        if (this.sessionController) {
                            this.sessionController._errorLog.push({
                                type: err.type,
                                message: err.message,
                                timestamp: Date.now()
                            });
                        }
                    });

                    // Speaker-attribution events: the event Discord uses for "who is speaking" has
                    // varied across versions (SPEAKING / SPEAKING_UPDATE / VOICE_UPDATE /
                    // VOICE_STATE_UPDATES). Subscribe to all candidates and parse each payload
                    // robustly, logging which event we actually catch.
                    for (const evt of ['SPEAKING', 'SPEAKING_UPDATE', 'VOICE_UPDATE', 'VOICE_STATE_UPDATES']) {
                        this._subscribe(evt, this._onSpeaking(evt));
                    }

                    // VOICE_STATE_UPDATES: fires when users join/leave voice channels
                    this._subscribe('VOICE_STATE_UPDATES', (data) => {
                        try {
                            const voiceStates = data.voiceStates || [];
                            const localUserId = this._getLocalUserId();
                            
                            for (const state of voiceStates) {
                                const { userId, channelId } = state;
                                if (!userId) continue;

                                const currentChannelId = this.getCurrentChannelId();

                                if (channelId && channelId === currentChannelId) {
                                    // User joined or is in our voice channel
                                    const user = this.getUserById(userId);
                                    const username = user ? user.username : userId;
                                    const displayName = user
                                        ? (user.globalName || user.username)
                                        : userId;
                                    this.voiceTracker.addParticipant(userId, username, displayName);
                                    
                                    // Auto-detect: if local user just joined, show confirmation
                                    if (userId === localUserId && this.sessionController.getState() === 'IDLE') {
                                        this._showStartRecordingConfirmation(channelId);
                                    }
                                } else if (!channelId || channelId !== currentChannelId) {
                                    // User left our voice channel
                                    this.voiceTracker.removeParticipant(userId);
                                }
                            }
                            // Update the overlay's participant list / speaking indicators
                            try { this._refreshOverlaySpeakers(); } catch (e) {}
                        } catch (e) {
                            console.error('[VoiceTranscriber] VOICE_STATE_UPDATES handler error:', e);
                        }
                    });

                    // AUDIO_INPUT_SETTINGS_CHANGED: detect local user mic changes
                    this._subscribe('AUDIO_INPUT_SETTINGS_CHANGED', (data) => {
                        try {
                            console.log('[VoiceTranscriber] Audio input settings changed:', data);
                        } catch (e) {
                            console.error('[VoiceTranscriber] AUDIO_INPUT_SETTINGS_CHANGED handler error:', e);
                        }
                    });

                    // Initialize audio capture engine
                    try {
                        this.audioCapture = new AudioCaptureEngine();
                        console.log('[VoiceTranscriber] Audio capture engine initialized');
                    } catch (e) {
                        console.error('[VoiceTranscriber] Failed to initialize audio capture engine:', e);
                    }

                    console.log('[VoiceTranscriber] Voice state tracking initialized');

                    // Wire the "Voice Transcriber" overlay's record button and show it
                    // (the overlay is now the single control surface — no separate
                    // floating record button / live-transcript panel anymore).
                    this.uiOverlay.setToggleHandler(() => this._toggleRecording());

                    // Setup hotkey (Ctrl+Shift+R)
                    this._setupHotkey();

                    // Add toolbar menu item for "Open Transcript Folder"
                    this._addToolbarMenuItem();

                    // Show the live transcript overlay panel
                    try {
                        this.uiOverlay.showPanel();
                    } catch (e) {
                        console.error('[VoiceTranscriber] Failed to show UI overlay:', e);
                    }
                }

                _getLocalUserId() {
                    try {
                        if (this._UserStore && typeof this._UserStore.getCurrentUser === 'function') {
                            const user = this._UserStore.getCurrentUser();
                            return user ? user.id : null;
                        }
                    } catch (e) {}
                    return null;
                }

                _refreshOverlaySpeakers() {
                    if (!this.uiOverlay) return;
                    const users = [];
                    for (const p of this.voiceTracker.getParticipants().values()) {
                        users.push({ username: p.username || p.userId, isSpeaking: !!p.isSpeaking });
                    }
                    this.uiOverlay.updateSpeakingUsers(users);
                }

                // Shared path for recording a "who is speaking" signal into the tracker,
                // attribution log, and overlay. Called from both the Flux dispatcher events
                // and the native VoiceConnection "speaking" event.
                _applySpeaking(userId, speaking) {
                    if (!userId) return;
                    speaking = !!speaking;
                    try { this.voiceTracker.setSpeaking(userId, speaking); } catch (e) {}
                    let username = userId;
                    try { const u = this.getUserById(userId); if (u) username = u.username; } catch (e) {}
                    if (this.sessionController && typeof this.sessionController.recordSpeaking === 'function') {
                        try { this.sessionController.recordSpeaking(userId, username, speaking); } catch (e) {}
                    }
                    try { this._refreshOverlaySpeakers(); } catch (e) {}
                    console.log(`[VoiceTranscriber] speaking event -> ${username} speaking=${speaking}`);
                }

                // Attach a native "speaking" listener to Discord's live VoiceConnection. This is
                // Discord's own per-user speech signal and works even when the Flux dispatcher
                // doesn't relay speaking events (which is the case in the user's version).
                _attachVoiceConnectionSpeaking() {
                    try {
                        const vc = this.audioCapture && this.audioCapture._findVoiceConnection();
                        if (!vc || typeof vc.on !== 'function') return false;
                        if (this._vcSpeakingSource === vc) return true;
                        // Detach a previous connection, if any.
                        if (this._vcSpeakingSource && this._vcSpeakingHandler && typeof this._vcSpeakingSource.off === 'function') {
                            try { this._vcSpeakingSource.off('speaking', this._vcSpeakingHandler); } catch (e) {}
                        }
                        this._vcSpeakingSource = vc;
                        this._vcSpeakingHandler = (userId, speaking) => this._applySpeaking(userId, speaking);
                        vc.on('speaking', this._vcSpeakingHandler);
                        console.log('[VoiceTranscriber] attached speaking listener to voice connection');
                        return true;
                    } catch (e) {
                        console.warn('[VoiceTranscriber] could not attach voice connection speaking listener:', e && e.message);
                        return false;
                    }
                }

                // Returns a Flux handler that parses "who is speaking" from an event payload.
                // Handles the field/spelling variants Discord has used across versions and
                // logs which event it actually caught so we can pin down the real one.
                _onSpeaking(eventName) {
                    return (data) => {
                        try {
                            const d = data || {};
                            const userId = d.userId || d.user_id;
                            if (!userId) return;

                            let speaking;
                            if (typeof d.speaking === 'boolean') speaking = d.speaking;
                            else if (d.speaking !== undefined) speaking = !!d.speaking;
                            else if (d.streams && (d.streams.size || Object.keys(d.streams).length)) speaking = true;
                            else if (typeof d.state === 'boolean') speaking = d.state;
                            else return; // no recognizable speaking signal on this event

                            console.log(`[VoiceTranscriber] VT speaking caught via "${eventName}"`);
                            this._applySpeaking(userId, speaking);
                        } catch (e) {
                            console.error('[VoiceTranscriber] speaking handler error:', e);
                        }
                    };
                }

                _getChannelName(channelId) {
                    try {
                        if (this._ChannelStore && typeof this._ChannelStore.getChannel === 'function') {
                            const channel = this._ChannelStore.getChannel(channelId);
                            return channel ? channel.name : 'Unknown';
                        }
                    } catch (e) {}
                    return 'Unknown';
                }

                async _toggleRecording() {
                    const state = this.sessionController.getState();
                    
                    if (state === 'IDLE') {
                        const channelId = this.getCurrentChannelId();
                        if (!channelId) {
                            BdApi.UI.showToast('Join a voice channel first', { type: 'error' });
                            return;
                        }
                        const channelName = this._getChannelName(channelId);
                        await this.sessionController.startRecording(channelId, channelName);
                    } else if (state === 'RECORDING') {
                        await this.sessionController.stopRecording();
                    }
                }

                _showStartRecordingConfirmation(channelId) {
                    BdApi.showConfirmationModal(
                        'Start Recording?',
                        'You joined a voice channel. Would you like to start recording?',
                        {
                            confirmText: 'Start Recording',
                            cancelText: 'Cancel',
                            onConfirm: async () => {
                                const channelName = this._getChannelName(channelId);
                                await this.sessionController.startRecording(channelId, channelName);
                            }
                        }
                    );
                }

                _setupHotkey() {
                    // Ctrl+Shift+R to toggle recording
                    this._hotkeyHandler = (event) => {
                        if (event.ctrlKey && event.shiftKey && event.key === 'R') {
                            event.preventDefault();
                            this._toggleRecording();
                        }
                    };
                    document.addEventListener('keydown', this._hotkeyHandler);
                }

                _addToolbarMenuItem() {
                    // Add "Open Transcript Folder" to BetterDiscord plugin menu
                    try {
                        BdApi.ContextMenu.patch('user-settings-cog', (returnValue, props) => {
                            if (!returnValue || !returnValue.props || !returnValue.props.children) return;
                            
                            const children = returnValue.props.children;
                            if (!Array.isArray(children)) return;

                            // Find the BetterDiscord section
                            const bdSection = children.find(c => c && c.props && c.props.label === 'BetterDiscord');
                            if (!bdSection || !bdSection.props || !bdSection.props.children) return;

                            const bdChildren = bdSection.props.children;
                            if (!Array.isArray(bdChildren)) return;

                            // Find VoiceTranscriber submenu
                            const pluginSubmenu = bdChildren.find(c => 
                                c && c.props && c.props.label === 'VoiceTranscriber'
                            );

                            if (pluginSubmenu && pluginSubmenu.props && Array.isArray(pluginSubmenu.props.children)) {
                                // Add menu item to existing submenu
                                pluginSubmenu.props.children.push(
                                    BdApi.ContextMenu.buildItem({
                                        type: 'text',
                                        label: 'Open Transcript Folder',
                                        action: () => {
                                            this._openTranscriptFolder();
                                        }
                                    })
                                );
                            }
                        });
                    } catch (e) {
                        console.error('[VoiceTranscriber] Failed to add toolbar menu item:', e);
                    }
                }

                _openTranscriptFolder() {
                    try {
                        const outputDir = this.settings.outputDir || './transcripts';
                        const electron = require('electron');
                        const shell = electron.shell || (electron.remote && electron.remote.shell);
                        
                        if (shell && typeof shell.openPath === 'function') {
                            const path = require('path');
                            const absolutePath = path.isAbsolute(outputDir) 
                                ? outputDir 
                                : path.join(process.cwd(), outputDir);
                            
                            shell.openPath(absolutePath).then(err => {
                                if (err) {
                                    BdApi.UI.showToast(`Failed to open folder: ${err}`, { type: 'error' });
                                }
                            });
                        } else {
                            BdApi.UI.showToast('Shell API not available', { type: 'error' });
                        }
                    } catch (e) {
                        console.error('[VoiceTranscriber] Failed to open transcript folder:', e);
                        BdApi.UI.showToast(`Error: ${e.message}`, { type: 'error' });
                    }
                }

                onStop() {
                    // Stop session if recording
                    if (this.sessionController && this.sessionController.getState() === 'RECORDING') {
                        try {
                            this.sessionController.stopRecording();
                        } catch (e) {
                            console.error('[VoiceTranscriber] Error stopping session:', e);
                        }
                    }

                    // Remove hotkey listener
                    if (this._hotkeyHandler) {
                        try {
                            document.removeEventListener('keydown', this._hotkeyHandler);
                            this._hotkeyHandler = null;
                        } catch (e) {
                            console.error('[VoiceTranscriber] Error removing hotkey handler:', e);
                        }
                    }

                    // Stop audio capture engine
                    if (this.audioCapture) {
                        try {
                            this.audioCapture.stop();
                            console.log('[VoiceTranscriber] Audio capture engine stopped');
                        } catch (e) {
                            console.error('[VoiceTranscriber] Error stopping audio capture engine:', e);
                        }
                    }

                    // Destroy UI overlay
                    if (this.uiOverlay) {
                        try {
                            this.uiOverlay.destroy();
                        } catch (e) {
                            console.error('[VoiceTranscriber] Error destroying UI overlay:', e);
                        }
                    }

                    // Unsubscribe from all FluxDispatcher events
                    for (const unsubscribe of this._dispatcherUnsubscribes) {
                        unsubscribe();
                    }
                    this._dispatcherUnsubscribes = [];

                    // Detach the native voice-connection speaking listener
                    if (this._vcSpeakingSource && this._vcSpeakingHandler && typeof this._vcSpeakingSource.off === 'function') {
                        try { this._vcSpeakingSource.off('speaking', this._vcSpeakingHandler); } catch (e) {}
                    }
                    this._vcSpeakingSource = null;
                    this._vcSpeakingHandler = null;

                    // Clear participant data
                    this.voiceTracker.clear();

                    console.log('[VoiceTranscriber] Voice state tracking stopped, all listeners removed');
                }

                getSettingsPanel() {
                    const panel = document.createElement('div');
                    panel.style.cssText = 'display:flex;flex-direction:column;gap:12px;padding:12px 0;';

                    // Build a labeled field container
                    const field = (label, hint) => {
                        const wrap = document.createElement('div');
                        if (hint) {
                            const note = document.createElement('div');
                            note.textContent = hint;
                            note.style.cssText = 'color:#72767d;font-size:11px;margin-bottom:4px;';
                            wrap.appendChild(note);
                        }
                        const lab = document.createElement('div');
                        lab.textContent = label;
                        lab.style.cssText = 'color:#b9bbbe;font-size:12px;font-weight:600;margin-bottom:4px;';
                        wrap.appendChild(lab);
                        return wrap;
                    };
                    const inputStyle = 'width:100%;padding:6px 8px;border-radius:3px;background:#1e1f22;border:1px solid #3f4147;color:#dcddde;font-size:13px;box-sizing:border-box;';
                    const commit = () => this.saveSettings();

                    // API Key
                    const apiKeyWrap = field('API Key', 'OpenAI API key; only required for the OpenAI Whisper API backend.');
                    const apiKeyInput = document.createElement('input');
                    apiKeyInput.type = 'password';
                    apiKeyInput.placeholder = 'sk-...';
                    apiKeyInput.style.cssText = inputStyle;
                    apiKeyInput.value = this.settings.apiKey || '';
                    apiKeyInput.addEventListener('change', () => { this.settings.apiKey = apiKeyInput.value; commit(); });
                    apiKeyWrap.appendChild(apiKeyInput);
                    panel.appendChild(apiKeyWrap);

                    // Backend
                    const backendWrap = field('Transcription Backend');
                    const backendSelect = document.createElement('select');
                    backendSelect.style.cssText = inputStyle;
                    [['OpenAI Whisper API', 0], ['Local Whisper Server', 1]].forEach(([txt, v]) => {
                        const o = document.createElement('option'); o.value = v; o.textContent = txt; backendSelect.appendChild(o);
                    });
                    backendSelect.value = String(this.settings.backend ?? 0);
                    backendSelect.addEventListener('change', () => { this.settings.backend = Number(backendSelect.value); commit(); });
                    backendWrap.appendChild(backendSelect);
                    panel.appendChild(backendWrap);

                    // Local Whisper Server URL
                    const localWrap = field('Local Whisper Server URL', 'Used when the backend is Local Whisper Server.');
                    const localInput = document.createElement('input');
                    localInput.placeholder = 'http://localhost:9000';
                    localInput.style.cssText = inputStyle;
                    localInput.value = this.settings.localServerUrl || '';
                    localInput.addEventListener('change', () => { this.settings.localServerUrl = localInput.value; commit(); });
                    localWrap.appendChild(localInput);
                    localWrap.appendChild(this._makeButton('Test Local Server', () => this._testLocalServer(this.settings.localServerUrl || 'http://localhost:9000')));
                    panel.appendChild(localWrap);

                    // Output Directory
                    const dirWrap = field('Output Directory', 'Where per-user transcript files are written.');
                    const dirRow = document.createElement('div');
                    dirRow.style.cssText = 'display:flex;gap:6px;';
                    const dirInput = document.createElement('input');
                    dirInput.style.cssText = inputStyle + 'flex:1;';
                    dirInput.value = this.settings.outputDir || '';
                    dirInput.addEventListener('change', () => { this.settings.outputDir = dirInput.value; commit(); });
                    dirRow.appendChild(dirInput);
                    dirRow.appendChild(this._makeButton('Browse', () => this._browseOutputDir(dirInput)));
                    dirRow.appendChild(this._makeButton('Open', () => this._openTranscriptFolder()));
                    dirWrap.appendChild(dirRow);
                    panel.appendChild(dirWrap);

                    // Audio Input Device (VB-Cable loopback)
                    const devWrap = field('Audio Input Device', 'Select the device carrying call audio (usually "CABLE Output"). In Discord settings, set Output Device to "CABLE Input".');
                    const devRow = document.createElement('div');
                    devRow.style.cssText = 'display:flex;gap:6px;';
                    const devSelect = document.createElement('select');
                    devSelect.style.cssText = inputStyle + 'flex:1;';
                    const defaultOpt = document.createElement('option');
                    defaultOpt.value = '';
                    defaultOpt.textContent = 'Default input device';
                    devSelect.appendChild(defaultOpt);
                    devSelect.value = this.settings.audioInputDeviceId || '';
                    AudioCaptureEngine.enumerateInputDevices().then((devices) => {
                        const chosen = this.settings.audioInputDeviceId || '';
                        for (const d of devices) {
                            const o = document.createElement('option');
                            o.value = d.deviceId;
                            o.textContent = d.label ? `${d.label}` : d.deviceId;
                            devSelect.appendChild(o);
                        }
                        if (chosen) devSelect.value = chosen;
                    }).catch((e) => {
                        console.error('[VoiceTranscriber] Failed to enumerate audio devices:', e);
                    });
                    devSelect.addEventListener('change', () => { this.settings.audioInputDeviceId = devSelect.value; commit(); });
                    devRow.appendChild(devSelect);
                    devRow.appendChild(this._makeButton('Refresh', () => { /* re-populated by enumerateInputDevices above */ }));
                    devWrap.appendChild(devRow);
                    panel.appendChild(devWrap);

                    // Output Format
                    const fmtWrap = field('Output Format');
                    const fmtSelect = document.createElement('select');
                    fmtSelect.style.cssText = inputStyle;
                    [['Plain Text (.txt)', 0], ['Markdown (.md)', 1], ['JSON (.json)', 2]].forEach(([txt, v]) => {
                        const o = document.createElement('option'); o.value = v; o.textContent = txt; fmtSelect.appendChild(o);
                    });
                    fmtSelect.value = String(this.settings.outputFormat ?? 0);
                    fmtSelect.addEventListener('change', () => { this.settings.outputFormat = Number(fmtSelect.value); commit(); });
                    fmtWrap.appendChild(fmtSelect);
                    panel.appendChild(fmtWrap);

                    // Chunk Duration
                    const inRow = (label, hint) => {
                        const wrap = document.createElement('div');
                        wrap.style.cssText = 'display:flex;gap:16px;align-items:center;';
                        const l = field(label, hint);
                        l.style.cssText = 'flex:1;';
                        wrap.appendChild(l);
                        return wrap;
                    };
                    const chunkWrap = field('Chunk Duration (seconds)', 'Maximum length of an audio chunk sent for transcription.');
                    const chunkInput = document.createElement('input');
                    chunkInput.type = 'number'; chunkInput.min = 5; chunkInput.max = 60; chunkInput.step = 5;
                    chunkInput.style.cssText = inputStyle;
                    chunkInput.value = this.settings.chunkDuration ?? 30;
                    chunkInput.addEventListener('change', () => { this.settings.chunkDuration = Number(chunkInput.value) || 30; commit(); });
                    chunkWrap.appendChild(chunkInput);
                    panel.appendChild(chunkWrap);

                    // Silence Threshold (signal amplitude floor)
                    const ampWrap = field('Silence Threshold (level)', 'Minimum signal level (0-32767) treated as speech. Raise to suppress more background hiss/room tone.');
                    const ampInput = document.createElement('input');
                    ampInput.type = 'number'; ampInput.min = 100; ampInput.max = 8000; ampInput.step = 100;
                    ampInput.style.cssText = inputStyle;
                    ampInput.value = this.settings.silenceThreshold ?? 1500;
                    ampInput.addEventListener('change', () => { this.settings.silenceThreshold = Number(ampInput.value) || 1500; commit(); });
                    ampWrap.appendChild(ampInput);
                    panel.appendChild(ampWrap);

                    // Flush Silence: quiet period that finalizes a chunk early
                    const flushWrap = field('Flush Silence (ms)', 'How long of quiet ends a speaking turn and transcribes it (instead of waiting the full chunk duration).');
                    const flushInput = document.createElement('input');
                    flushInput.type = 'number'; flushInput.min = 500; flushInput.max = 5000; flushInput.step = 100;
                    flushInput.style.cssText = inputStyle;
                    flushInput.value = this.settings.flushSilenceMs ?? 2000;
                    flushInput.addEventListener('change', () => { this.settings.flushSilenceMs = Number(flushInput.value) || 2000; commit(); });
                    flushWrap.appendChild(flushInput);
                    panel.appendChild(flushWrap);

                    // Min Chunk Duration: earliest flush size
                    const minWrap = field('Min Chunk (seconds)', 'Smallest chunk that can be flushed early once flush-silence is reached.');
                    const minInput = document.createElement('input');
                    minInput.type = 'number'; minInput.min = 1; minInput.max = 10; minInput.step = 1;
                    minInput.style.cssText = inputStyle;
                    minInput.value = this.settings.minChunkDuration ?? 1;
                    minInput.addEventListener('change', () => { this.settings.minChunkDuration = Number(minInput.value) || 1; commit(); });
                    minWrap.appendChild(minInput);
                    panel.appendChild(minWrap);

                    return panel;
                }

                _testLocalServer(url) {
                    BdApi.UI.showToast('Testing connection...', { type: 'info' });
                    fetch(url).then((res) => {
                        if (res.status >= 200 && res.status < 400) {
                            BdApi.UI.showToast(`Server reachable (HTTP ${res.status}).`, { type: 'success' });
                        } else {
                            BdApi.UI.showToast(`Server responded HTTP ${res.status}.`, { type: 'error' });
                        }
                    }).catch((err) => {
                        BdApi.UI.showToast(`Cannot reach server: ${err.message || err}`, { type: 'error' });
                    });
                }
            };
            return plugin;
        })();
/*@end @*/
