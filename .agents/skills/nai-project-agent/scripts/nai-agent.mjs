#!/usr/bin/env node
import fs from 'node:fs/promises';
import process from 'node:process';

const usage = `NAI project Agent client
  node nai-agent.mjs capabilities [--base-url http://127.0.0.1:5001]
  node nai-agent.mjs call <action> --args <UTF-8 JSON file|-> [--action-id <id>] [--base-url <url>]
  node nai-agent.mjs job <action-id> [--base-url <url>]
  node nai-agent.mjs request <UTF-8 JSON envelope file|-> [--base-url <url>]
Write actions require an actionId. This client never generates one and never retries a mutation.
Use '-' to read JSON from stdin. Output is one JSON response; non-ok responses exit with code 1.`;

async function jsonFile(filename) {
  if (!filename) throw new Error('Missing JSON input file; use --args <file> or stdin (-).');
  let data;
  if (filename === '-') {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    data = Buffer.concat(chunks).toString('utf8');
  } else data = await fs.readFile(filename, 'utf8');
  return JSON.parse(data.replace(/^\uFEFF/, ''));
}

try {
  const args = process.argv.slice(2);
  if (!args.length || args.includes('--help')) {
    console.log(usage);
  } else {
    const options = {};
    const positional = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i].startsWith('--')) {
        if (!['--base-url', '--args', '--action-id'].includes(args[i]) || !args[i + 1]) throw new Error('Unknown or incomplete option.');
        options[args[i]] = args[++i];
      } else positional.push(args[i]);
    }
    const base = new URL(options['--base-url'] || process.env.NAI_AGENT_BASE_URL || 'http://127.0.0.1:5001');
    if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)
      || base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
      throw new Error('Use a local HTTP server origin, such as http://127.0.0.1:5001.');
    }
    let endpoint;
    let body;
    if (positional[0] === 'capabilities' && positional.length === 1) endpoint = '/api/agent/capabilities';
    else if (positional[0] === 'job' && positional.length === 2) endpoint = `/api/agent/jobs/${encodeURIComponent(positional[1])}`;
    else if (positional[0] === 'call' && positional.length === 2) {
      endpoint = '/api/agent/call';
      body = { action: positional[1], arguments: await jsonFile(options['--args']) };
      if (options['--action-id']) body.actionId = options['--action-id'];
    } else if (positional[0] === 'request' && positional.length === 2) {
      endpoint = '/api/agent/call';
      body = await jsonFile(positional[1]);
    } else throw new Error('Invalid command. Use --help.');
    const response = await fetch(new URL(endpoint, base), {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60000)
    });
    const result = await response.json();
    console.log(JSON.stringify(result, null, 2));
    if (!response.ok || !result.ok) process.exitCode = 1;
  }
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: { code: 'CLIENT_ERROR', message: error.message },
    mutationMayHaveBeenAccepted: true, instruction: 'If a mutation timed out, inspect its actionId before retrying. Do not create a new id automatically.' }));
  process.exitCode = 1;
}
