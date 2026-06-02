// SeekDeep URL fetch policy (extracted leaf module — AUD-008).
//
// Was inline in index.js; extracted verbatim (one leaf at a time, per the audit)
// so the SSRF policy + bounded fetcher can be reasoned about and unit-tested in
// isolation. index.js re-imports these and re-exports them on __seekdeepTest, so
// the existing smoke suite exercises the same code through the same names.
//
// Two layers for user-supplied URLs (Discord attachment downloads, etc.):
//   1. SSRF policy (AUD-002): seekdeepValidateFetchTarget rejects non-http(s)
//      schemes and private/loopback/link-local/metadata targets, re-checked on
//      every redirect hop.
//   2. AbortController timeout + Content-Length precheck + streamed byte cap.
//
// Returns a Response-like object. Caller still does `.arrayBuffer()` / `.text()`.
//
// NOTE: this module reads its tunables from process.env at load time. index.js
// imports it AFTER `import 'dotenv/config'` (first import in index.js), so .env
// is already applied when these constants evaluate.

import dns from 'node:dns/promises';
import net from 'node:net';
import nodeFetch from 'node-fetch';

const SEEKDEEP_FETCH_DEFAULT_TIMEOUT_MS = Number(process.env.SEEKDEEP_FETCH_DEFAULT_TIMEOUT_MS || 30000);
const SEEKDEEP_FETCH_DEFAULT_MAX_BYTES = Number(process.env.SEEKDEEP_FETCH_DEFAULT_MAX_BYTES || 50 * 1024 * 1024);
// AUD-002: max redirect hops we'll follow for a user-supplied URL. Each hop is
// re-validated by seekdeepValidateFetchTarget, so a public→private redirect is
// rejected before its body is read.
const SEEKDEEP_FETCH_MAX_REDIRECTS = Number(process.env.SEEKDEEP_FETCH_MAX_REDIRECTS || 5);
// AUD-002: default-deny private/loopback/link-local fetch targets. A Discord
// user pasting a URL must not be able to make THIS host reach LAN admin panels,
// the local AI server, SearXNG, Docker-adjacent services, or cloud metadata.
// Flip on (SEEKDEEP_FETCH_ALLOW_PRIVATE=on) only for a single-user LAN install
// that legitimately pastes images hosted on its own private network — even
// then, cloud-metadata + unspecified addresses stay blocked.
const SEEKDEEP_FETCH_ALLOW_PRIVATE = /^(?:1|true|yes|on)$/i.test(String(process.env.SEEKDEEP_FETCH_ALLOW_PRIVATE || '').trim());
// Cloud-instance metadata endpoints. ALWAYS blocked, even with allowPrivate —
// no legitimate Discord image lives here and the blast radius (IAM creds) is
// the worst case for an SSRF on a cloud host.
const SEEKDEEP_FETCH_METADATA_HOSTS = new Set([
  '169.254.169.254',          // AWS / Azure / GCP / DigitalOcean / OpenStack IMDS
  '100.100.100.200',          // Alibaba Cloud
  'fd00:ec2::254',            // AWS IPv6 IMDS
  'metadata.google.internal', // GCP DNS name
  'metadata.goog',            // GCP short DNS name
]);

// AUD-002: classify an IP literal. Returns a human-readable reason string when
// the address is private/loopback/link-local/etc., or '' when it's a routable
// public address. Pure + synchronous so it's cheap and unit-testable.
function seekdeepClassifyBlockedIp(ip) {
  const fam = net.isIP(ip);
  if (fam === 4) {
    const o = ip.split('.').map((n) => Number(n));
    if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return 'malformed IPv4';
    const [a, b] = o;
    if (a === 0) return 'unspecified/this-network (0.0.0.0/8)';
    if (a === 10) return 'private (RFC1918 10.0.0.0/8)';
    if (a === 127) return 'loopback (127.0.0.0/8)';
    if (a === 100 && b >= 64 && b <= 127) return 'carrier-grade NAT (100.64.0.0/10)';
    if (a === 169 && b === 254) return 'link-local (169.254.0.0/16)';
    if (a === 172 && b >= 16 && b <= 31) return 'private (RFC1918 172.16.0.0/12)';
    if (a === 192 && b === 168) return 'private (RFC1918 192.168.0.0/16)';
    if (a === 192 && b === 0 && o[2] === 0) return 'IETF protocol assignment (192.0.0.0/24)';
    if (a >= 224 && a <= 239) return 'multicast (224.0.0.0/4)';
    if (a >= 240) return 'reserved (240.0.0.0/4)';
    return '';
  }
  if (fam === 6) {
    let s = ip.toLowerCase();
    // IPv4-mapped/-compatible (::ffff:a.b.c.d or ::a.b.c.d) — classify the v4 part.
    const v4 = s.match(/(?:::ffff:|::)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (v4) return seekdeepClassifyBlockedIp(v4[1]) || '';
    if (s === '::1') return 'loopback (::1)';
    if (s === '::') return 'unspecified (::)';
    const head = s.split(':')[0] || '';
    if (/^f[cd][0-9a-f]{2}$/.test(head)) return 'IPv6 unique-local (fc00::/7)';
    if (/^fe[89ab][0-9a-f]$/.test(head)) return 'IPv6 link-local (fe80::/10)';
    if (/^ff[0-9a-f]{2}$/.test(head)) return 'IPv6 multicast (ff00::/8)';
    return '';
  }
  return ''; // not an IP literal
}

// AUD-002: validate a user-supplied fetch target BEFORE any request goes out.
// Rejects non-http(s) schemes, blocks cloud-metadata always, and (unless
// allowPrivate) rejects private/loopback/link-local literals AND hostnames that
// resolve to such addresses. Returns the resolved address list so callers can
// log/diagnose. Async because it resolves DNS.
//
// Residual risk (documented): a DNS-rebinding attacker could answer this
// lookup with a public IP and answer the kernel's connect()-time lookup with a
// private one. Mitigating that fully needs IP-pinned connections, which differ
// across node-fetch vs undici; the resolve-and-check here matches the audit's
// prescribed fix and stops the realistic "URL→localhost / URL→metadata" cases.
async function seekdeepValidateFetchTarget(rawUrl, options = {}) {
  const allowPrivate = options.allowPrivate ?? SEEKDEEP_FETCH_ALLOW_PRIVATE;
  let u;
  try {
    u = new URL(String(rawUrl));
  } catch {
    throw new Error(`Blocked fetch: not a valid URL (${String(rawUrl).slice(0, 80)})`);
  }
  const proto = u.protocol.toLowerCase();
  if (proto !== 'http:' && proto !== 'https:') {
    throw new Error(`Blocked fetch: scheme "${proto}" not allowed (only http/https)`);
  }
  let host = u.hostname || '';
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1); // IPv6 literal
  const lowerHost = host.toLowerCase();
  if (SEEKDEEP_FETCH_METADATA_HOSTS.has(lowerHost)) {
    throw new Error(`Blocked fetch: cloud metadata endpoint (${host})`);
  }

  // IP literal — no DNS, classify directly.
  if (net.isIP(host)) {
    if (!allowPrivate) {
      const reason = seekdeepClassifyBlockedIp(host);
      if (reason) throw new Error(`Blocked fetch: private/loopback target ${host} — ${reason}`);
    } else {
      // Even with allowPrivate, never reach the unspecified address.
      if (host === '0.0.0.0' || host === '::') throw new Error(`Blocked fetch: unspecified address ${host}`);
    }
    return { host, addresses: [host], allowPrivate };
  }

  // Hostname — block obvious local names even before DNS, then resolve + check.
  if (!allowPrivate && (lowerHost === 'localhost' || lowerHost.endsWith('.localhost') || lowerHost.endsWith('.local') || lowerHost.endsWith('.internal'))) {
    throw new Error(`Blocked fetch: local hostname "${host}"`);
  }
  let resolved;
  try {
    resolved = await dns.lookup(host, { all: true });
  } catch (err) {
    throw new Error(`Blocked fetch: DNS resolution failed for "${host}" (${err?.code || err?.message || 'lookup error'})`);
  }
  if (!resolved.length) throw new Error(`Blocked fetch: no addresses resolved for "${host}"`);
  for (const { address } of resolved) {
    if (SEEKDEEP_FETCH_METADATA_HOSTS.has(String(address).toLowerCase())) {
      throw new Error(`Blocked fetch: "${host}" resolves to cloud metadata endpoint ${address}`);
    }
    if (!allowPrivate) {
      const reason = seekdeepClassifyBlockedIp(address);
      if (reason) throw new Error(`Blocked fetch: "${host}" resolves to private address ${address} — ${reason}`);
    } else if (address === '0.0.0.0' || address === '::') {
      throw new Error(`Blocked fetch: "${host}" resolves to unspecified address ${address}`);
    }
  }
  return { host, addresses: resolved.map((r) => r.address), allowPrivate };
}

async function seekdeepFetchWithLimits(url, options = {}) {
  const {
    timeoutMs = SEEKDEEP_FETCH_DEFAULT_TIMEOUT_MS,
    maxBytes = SEEKDEEP_FETCH_DEFAULT_MAX_BYTES,
    // AUD-002: SSRF controls. allowPrivate defaults to the env policy (off);
    // maxRedirects bounds the re-validated redirect chain.
    allowPrivate = SEEKDEEP_FETCH_ALLOW_PRIVATE,
    maxRedirects = SEEKDEEP_FETCH_MAX_REDIRECTS,
    ...rest
  } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));
  let timerCleared = false;
  const clearTimer = () => { if (!timerCleared) { clearTimeout(timer); timerCleared = true; } };
  const readCappedBody = async (res) => {
    const chunks = [];
    let consumed = 0;

    const addChunk = (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      consumed += buf.byteLength;
      if (consumed > maxBytes) {
        controller.abort();
        throw new Error(`Streamed body exceeded ${maxBytes} byte cap at ${consumed} bytes`);
      }
      chunks.push(buf);
    };

    try {
      if (res.body && typeof res.body.getReader === 'function') {
        const reader = res.body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) addChunk(value);
          }
        } catch (err) {
          try { await reader.cancel(); } catch {}
          throw err;
        }
      } else if (res.body && typeof res.body[Symbol.asyncIterator] === 'function') {
        for await (const chunk of res.body) {
          if (chunk) addChunk(chunk);
        }
      } else if (typeof res.arrayBuffer === 'function') {
        addChunk(Buffer.from(await res.arrayBuffer()));
      }

      return Buffer.concat(chunks);
    } finally {
      clearTimer();
    }
  };

  const responseWithCappedBody = (res) => {
    let bodyPromise = null;
    const getBody = () => {
      if (!bodyPromise) bodyPromise = readCappedBody(res);
      return bodyPromise;
    };

    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
      url: res.url,
      redirected: res.redirected,
      type: res.type,
      arrayBuffer: async () => {
        const buf = await getBody();
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      },
      text: async () => (await getBody()).toString('utf8'),
      json: async () => JSON.parse((await getBody()).toString('utf8')),
    };
  };

  try {
    const fetchImpl = (globalThis.fetch || nodeFetch);
    // AUD-002: follow redirects MANUALLY so every hop is re-validated against
    // the SSRF policy. Auto-follow ('redirect: follow') would let a public URL
    // 302 into 127.0.0.1 / 169.254.169.254 with no second check.
    let currentUrl = String(url);
    let res = null;
    for (let hop = 0; ; hop++) {
      await seekdeepValidateFetchTarget(currentUrl, { allowPrivate });
      res = await fetchImpl(currentUrl, { ...rest, redirect: 'manual', signal: controller.signal });
      const status = Number(res.status || 0);
      const location = (status >= 300 && status < 400) ? res.headers?.get?.('location') : null;
      if (!location) break;
      if (hop >= maxRedirects) {
        controller.abort();
        throw new Error(`Too many redirects (> ${maxRedirects}) starting from ${url}`);
      }
      // Resolve relative redirects against the current URL, then loop to revalidate.
      currentUrl = new URL(location, currentUrl).toString();
      // Drain the redirect response body so the connection can be reused/closed.
      try { if (typeof res.arrayBuffer === 'function') await res.arrayBuffer(); } catch {}
    }
    if (!res.ok) {
      throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
    }
    const cl = Number(res.headers?.get?.('content-length') || 0);
    if (Number.isFinite(cl) && cl > 0 && cl > maxBytes) {
      controller.abort();
      throw new Error(`Attachment too large: ${cl} bytes > ${maxBytes} byte cap`);
    }
    // Return WITHOUT clearing timer when there is a body: it stays alive during
    // body reads and is cleared by readCappedBody(). node-fetch exposes a Node
    // Readable stream, while native fetch exposes a Web ReadableStream, so the
    // wrapper supports both instead of assuming `.getReader()`.
    if (res.body) return responseWithCappedBody(res);
    clearTimer();
    return res;
  } catch (err) {
    clearTimer();
    throw err;
  }
}

export {
  seekdeepClassifyBlockedIp,
  seekdeepValidateFetchTarget,
  seekdeepFetchWithLimits,
  SEEKDEEP_FETCH_DEFAULT_TIMEOUT_MS,
  SEEKDEEP_FETCH_DEFAULT_MAX_BYTES,
  SEEKDEEP_FETCH_MAX_REDIRECTS,
  SEEKDEEP_FETCH_ALLOW_PRIVATE,
  SEEKDEEP_FETCH_METADATA_HOSTS,
};
