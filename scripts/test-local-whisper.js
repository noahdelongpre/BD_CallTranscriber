#!/usr/bin/env node
/**
 * Validate the CORS-free local-Whisper path the plugin uses.
 *
 * The plugin sends transcription requests via Node http/https (not browser
 * fetch) so Discord's cross-origin CORS rules don't block requests to a local
 * server. This replicates that path exactly: builds a multipart body with
 * "new Response(formData).arrayBuffer()", POSTs it with Node http, prints the
 * server's reply.
 *
 * usage: node scripts/test-local-whisper.js [url] <audiofile>
 *   url defaults to http://localhost:9000/v1/audio/transcriptions
 */
'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');

const arg = process.argv.slice(2);
const DEFAULT_URL = 'http://localhost:9000/v1/audio/transcriptions';
const ENDPOINT = arg.length === 2 ? arg[0] : DEFAULT_URL;
const AUDIO = arg.length === 2 ? arg[1] : arg[0];

if (!AUDIO || !fs.existsSync(AUDIO)) {
    console.error(`usage: node scripts/test-local-whisper.js [url] <audiofile>\n  (file '${AUDIO}' not found)`);
    process.exit(2);
}

function post(formData) {
    return new Promise((resolve, reject) => {
        // ONE Response instance -> same boundary in header and body.
        const resp = new Response(formData);
        resp.arrayBuffer()
            .then(ab => Buffer.from(ab))
            .then((body) => {
                // This is exactly the plugin's _httpRequest.
                const parsed = new URL(ENDPOINT);
                const mod = parsed.protocol === 'https:' ? https : http;
                const req = mod.request({
                    hostname: parsed.hostname,
                    port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
                    path: parsed.pathname + parsed.search,
                    method: 'POST',
                    headers: { 'Content-Type': resp.headers.get('content-type') }
                }, (res) => {
                    const chunks = [];
                    res.on('data', c => chunks.push(c));
                    res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
                });
                req.on('error', reject);
                req.end(body);
            })
            .catch(reject);
    });
}

(async () => {
    const formData = new FormData();
    formData.append('file', new Blob([fs.readFileSync(AUDIO)]), 'test.mp3');
    formData.append('model', 'whisper-1');
    formData.append('response_format', 'json');

    const out = await post(formData);
    console.log('HTTP', out.status, '->', ENDPOINT);
    console.log(out.body);
    process.exit(out.status >= 200 && out.status < 300 ? 0 : 1);
})().catch((e) => {
    console.error('Error:', e.message);
    process.exit(1);
});