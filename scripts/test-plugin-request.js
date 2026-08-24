#!/usr/bin/env node
/**
 * Reproduce the plugin's exact LocalWhisper transcription request so we can
 * see what the server returns for it (field names, single-Response multipart
 * built exactly like _formDataToMultipart, sent via browser-style fetch with a
 * manual Content-Type header). Compares against curl's multipart.
 */
'use strict';
const fs = require('fs');

const AUDIO = process.argv[2];
const ENDPOINT = process.argv[3] || 'http://localhost:9000/v1/audio/transcriptions';
if (!AUDIO || !fs.existsSync(AUDIO)) { console.error('usage: node test-plugin-request.js <audiofile> [url]'); process.exit(2); }

async function run() {
    // Exactly like the plugin's _buildRequest (openai-compatible) + _formDataToMultipart.
    const formData = new FormData();
    formData.append('file', new Blob([fs.readFileSync(AUDIO)]), 'chunk_test.wav');
    formData.append('model', 'whisper-1');
    formData.append('response_format', 'json');

    const resp = new Response(formData);              // single instance -> consistent boundary
    const contentType = resp.headers.get('content-type');
    const bytes = new Uint8Array(await resp.arrayBuffer());

    console.log('content-type:', contentType);
    console.log('body bytes:', bytes.length);

    const signal = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(60000) : undefined;
    const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': contentType },
        body: bytes,
        signal
    });
    console.log('HTTP', res.status);
    console.log(await res.text());
    process.exit(res.status >= 200 && res.status < 300 ? 0 : 1);
}
run().catch((e) => { console.error('Error:', e.message); process.exit(1); });