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
import http from 'node:http';
import https from 'node:https';
import nodeFetch from 'node-fetch';

// AUD-002 follow-up: the actual HTTP transport. We use node-fetch (not native
// fetch/undici) because only node-fetch honors the per-request `agent` option,
// which is how we pin the connection to a pre-validated IP (DNS-rebinding
// defense below). Tests inject a stub via __setFetchTransportForTests().
let _fetchTransport = nodeFetch;
function __setFetchTransportForTests(fn) { _fetchTransport = fn || nodeFetch; }

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

// AUD-002c: canonicalize a valid IPv6 string to its compressed/lowercased WHATWG
// form BEFORE classification, so non-canonical literals (uncompressed, e.g.
// 0:0:0:0:0:ffff:7f00:1) can't slip past the v4-mapped regexes below. Current
// callers already feed canonical forms (the URL parser for literal hosts, inet_ntop
// for dns.lookup results), so this is defense-in-depth that makes the classifier
// correct for ANY valid IPv6 input. Non-IPv6 / unparseable strings (e.g. plain
// IPv4) are returned unchanged — the bracketed parse throws and is caught.
function seekdeepCanonicalizeIpv6(s) {
  try {
    // net.isIP() accepts a zone/scope id (fe80::1%eth0) but the URL parser throws on it
    // — strip the zone before parsing so a zoned loopback/link-local can't slip past the
    // $-anchored classification regexes by carrying a "%eth0" tail.
    const pct = s.indexOf('%');
    const ip = pct !== -1 ? s.slice(0, pct) : s;
    const host = new URL('http://[' + ip + ']/').hostname;
    return (host.startsWith('[') && host.endsWith(']')) ? host.slice(1, -1) : host;
  } catch { return s; }
}

// Expand a canonicalized (lowercased, zone-stripped) IPv6 string into its 8
// 16-bit groups, or null if it doesn't parse as 8 groups. Handles `::`
// compression and an embedded dotted-quad tail. Used to pull the embedded IPv4
// out of NAT64 (64:ff9b::/96) and 6to4 (2002::/16) addresses, whose v4 lives at
// fixed hextet positions rather than the ::ffff:/:: tail the regexes above cover.
function seekdeepExpandIpv6(s) {
  let str = String(s);
  // Convert a trailing dotted-quad (e.g. 64:ff9b::1.2.3.4) into two hextets.
  const dotted = str.match(/^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) {
    const p = dotted[2].split('.').map(Number);
    if (p.length === 4 && p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
      const hi = (p[0] << 8) | p[1], lo = (p[2] << 8) | p[3];
      str = dotted[1] + hi.toString(16) + ':' + lo.toString(16);
    }
  }
  const hasDouble = str.includes('::');
  let head, tail;
  if (hasDouble) {
    const parts = str.split('::');
    if (parts.length !== 2) return null;        // more than one '::' is invalid
    head = parts[0] ? parts[0].split(':') : [];
    tail = parts[1] ? parts[1].split(':') : [];
  } else {
    head = str.split(':');
    tail = [];
  }
  const fill = hasDouble ? (8 - head.length - tail.length) : 0;
  if (fill < 0) return null;
  if (!hasDouble && head.length !== 8) return null;
  const groups = [...head, ...Array(fill).fill('0'), ...tail];
  if (groups.length !== 8) return null;
  const nums = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 0xffff)) return null;
  return nums;
}

// Pull the embedded IPv4 (dotted) out of a NAT64 / 6to4 IPv6 literal, else null.
// NAT64 (64:ff9b::/96): the v4 is the last 32 bits (groups 6-7).
// 6to4   (2002::/16):    the v4 is the 32 bits after 2002: (groups 1-2).
function seekdeepTranslatedV4FromIpv6(s) {
  const g = seekdeepExpandIpv6(s);
  if (!g) return null;
  const v4 = (a, b) => `${(a >> 8) & 255}.${a & 255}.${(b >> 8) & 255}.${b & 255}`;
  if (g[0] === 0x0064 && g[1] === 0xff9b) return { dotted: v4(g[6], g[7]), label: 'NAT64 64:ff9b::/96' };
  if (g[0] === 0x2002)                    return { dotted: v4(g[1], g[2]), label: '6to4 2002::/16' };
  return null;
}

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
    let s = seekdeepCanonicalizeIpv6(ip.toLowerCase());   // AUD-002c: canonicalize before matching
    // IPv4-mapped/-compatible in DOTTED form (::ffff:a.b.c.d or ::a.b.c.d) — classify the v4 part.
    const v4 = s.match(/(?:::ffff:|::)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (v4) return seekdeepClassifyBlockedIp(v4[1]) || '';
    // AUD-002b: the WHATWG URL parser canonicalizes IPv4-in-IPv6 to compressed HEX
    // (e.g. ::ffff:127.0.0.1 -> ::ffff:7f00:1, ::ffff:169.254.169.254 -> ::ffff:a9fe:a9fe).
    // Reconstruct the embedded IPv4 from the two hextets and classify it, so
    // loopback / RFC1918 / cloud-metadata can't slip through the gate in hex form.
    const v4hex = s.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (v4hex) {
      const hi = parseInt(v4hex[1], 16), lo = parseInt(v4hex[2], 16);
      const dotted = `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
      const reason = seekdeepClassifyBlockedIp(dotted);
      return reason ? `${reason} (IPv4-in-IPv6)` : '';
    }
    if (s === '::1') return 'loopback (::1)';
    if (s === '::') return 'unspecified (::)';
    const head = s.split(':')[0] || '';
    if (/^f[cd][0-9a-f]{2}$/.test(head)) return 'IPv6 unique-local (fc00::/7)';
    if (/^fe[89ab][0-9a-f]$/.test(head)) return 'IPv6 link-local (fe80::/10)';
    if (/^ff[0-9a-f]{2}$/.test(head)) return 'IPv6 multicast (ff00::/8)';
    // AUD-002b: default-deny any remaining IPv4-mapped (::ffff:0:0/96) literal we
    // couldn't cleanly parse, rather than treating it as routable-public.
    if (s.startsWith('::ffff:')) return 'IPv4-mapped IPv6 (unclassified, default-deny)';
    // NAT64 (64:ff9b::/96) and 6to4 (2002::/16) embed an IPv4 address. On an
    // IPv6-only / NAT64 network these translate to that embedded IPv4, so a
    // loopback / metadata / RFC1918 embed (e.g. 64:ff9b::a9fe:a9fe =
    // 169.254.169.254, or 2002:7f00:1::1 = 127.0.0.1) must be blocked instead of
    // passing as routable-public. Extract + recurse so a genuinely-public embed
    // (e.g. 2002:808:808:: = 8.8.8.8) still resolves.
    const xlat = seekdeepTranslatedV4FromIpv6(s);
    if (xlat) {
      const reason = seekdeepClassifyBlockedIp(xlat.dotted);
      return reason ? `${reason} (${xlat.label})` : '';
    }
    return '';
  }
  return ''; // not an IP literal
}

// AUD-002b: return the embedded IPv4 (dotted) for an IPv4-mapped/-compatible IPv6
// literal in EITHER dotted (::ffff:1.2.3.4) or the compressed-hex form the WHATWG
// URL parser emits (::ffff:7f00:1), else null. Lets the always-on metadata guard
// also catch hex-mapped literals that the host-string Set check would miss.
function seekdeepEmbeddedIPv4(ip) {
  if (net.isIP(ip) !== 6) return null;
  const s = seekdeepCanonicalizeIpv6(String(ip).toLowerCase());   // AUD-002c: canonicalize before matching
  const dotted = s.match(/(?:::ffff:|::)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) return dotted[1];
  const hex = s.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) { const hi = parseInt(hex[1], 16), lo = parseInt(hex[2], 16); return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`; }
  // NAT64 / 6to4 translated IPv4 — so the always-on metadata guard catches
  // e.g. 64:ff9b::a9fe:a9fe (169.254.169.254) and 2002:a9fe:a9fe::1.
  const xlat = seekdeepTranslatedV4FromIpv6(s);
  if (xlat) return xlat.dotted;
  return null;
}

// AUD-002: validate a user-supplied fetch target BEFORE any request goes out.
// Rejects non-http(s) schemes, blocks cloud-metadata always, and (unless
// allowPrivate) rejects private/loopback/link-local literals AND hostnames that
// resolve to such addresses. Returns the resolved address list so callers can
// log/diagnose. Async because it resolves DNS.
//
// DNS rebinding: CLOSED. The validated address list is pinned into the fetch
// agent (seekdeepBuildPinnedAgent below, wired in at the fetch call), so the
// socket connects to the exact IP this function approved — there is no second,
// independent connect()-time DNS lookup for a fast-flipping record to win.
// Residual risk is now limited to a transport that ignores the `agent` option
// (e.g. a future fetch implementation or an injected proxy).
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
  // AUD-002b: an IPv4-mapped IPv6 literal can embed a metadata IP in hex form
  // (::ffff:a9fe:a9fe = 169.254.169.254) that the host-string check above misses.
  // Block on the embedded v4 ALWAYS — even with allowPrivate.
  const mappedV4 = seekdeepEmbeddedIPv4(host);
  if (mappedV4 && SEEKDEEP_FETCH_METADATA_HOSTS.has(mappedV4)) {
    throw new Error(`Blocked fetch: cloud metadata endpoint (${host} → ${mappedV4})`);
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

// AUD-002 follow-up (DNS rebinding): build a node `lookup`-compatible function
// that ALWAYS resolves to the already-validated address(es), ignoring the
// hostname it's asked about. Passed to an http(s).Agent so the socket connects
// to the exact IP seekdeepValidateFetchTarget approved — there is no second,
// independent DNS resolution for an attacker's fast-flipping record to win.
// TLS still uses the original hostname for SNI + cert validation (the URL is
// unchanged; only address resolution is pinned).
function seekdeepBuildPinnedLookup(addresses) {
  const entries = (addresses || [])
    .filter(Boolean)
    .map((address) => ({ address, family: net.isIP(address) || 4 }));
  return (hostname, options, callback) => {
    let cb = callback;
    let opts = options;
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    if (!entries.length) { cb(new Error('no pinned address available')); return; }
    if (opts && opts.all) { cb(null, entries); return; }
    cb(null, entries[0].address, entries[0].family);
  };
}

// Build the per-request agent that pins DNS to `addresses`. Returns a function
// of the parsed URL so http vs https (and each redirect hop) gets the right
// agent class. keepAlive:false — these are one-shot downloads, don't pool.
function seekdeepBuildPinnedAgent(addresses) {
  const lookup = seekdeepBuildPinnedLookup(addresses);
  return (parsedUrl) => {
    const proto = (parsedUrl && parsedUrl.protocol) || 'https:';
    const AgentClass = proto === 'http:' ? http.Agent : https.Agent;
    return new AgentClass({ lookup, keepAlive: false });
  };
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
    const fetchImpl = _fetchTransport;
    // AUD-002: follow redirects MANUALLY so every hop is re-validated against
    // the SSRF policy. Auto-follow ('redirect: follow') would let a public URL
    // 302 into 127.0.0.1 / 169.254.169.254 with no second check.
    let currentUrl = String(url);
    let res = null;
    for (let hop = 0; ; hop++) {
      const verdict = await seekdeepValidateFetchTarget(currentUrl, { allowPrivate });
      const fetchOpts = { ...rest, redirect: 'manual', signal: controller.signal };
      // AUD-002 follow-up: for HOSTNAME targets, pin the connection to the IP(s)
      // we just validated so the socket can't re-resolve to a private address
      // (DNS rebinding). IP-literal targets need no pinning — there's no DNS.
      if (verdict && verdict.host && net.isIP(verdict.host) === 0 && verdict.addresses && verdict.addresses.length) {
        fetchOpts.agent = seekdeepBuildPinnedAgent(verdict.addresses);
      }
      res = await fetchImpl(currentUrl, fetchOpts);
      const status = Number(res.status || 0);
      const location = (status >= 300 && status < 400) ? res.headers?.get?.('location') : null;
      if (!location) break;
      if (hop >= maxRedirects) {
        controller.abort();
        throw new Error(`Too many redirects (> ${maxRedirects}) starting from ${url}`);
      }
      // Resolve relative redirects against the current URL, then loop to revalidate.
      currentUrl = new URL(location, currentUrl).toString();
      // Discard the redirect body WITHOUT buffering it. A hostile redirect could
      // carry a huge body, and arrayBuffer() would load it all into memory (OOM) —
      // the streamed maxBytes cap only guards the FINAL response, not redirect
      // hops. resume() drains+drops a node-fetch Readable; arrayBuffer() is only a
      // fallback for bodiless test stubs. (per PR review feedback.)
      try {
        if (res.body && typeof res.body.resume === 'function') res.body.resume();
        else if (typeof res.arrayBuffer === 'function') await res.arrayBuffer();
      } catch {}
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
  seekdeepBuildPinnedLookup,
  seekdeepBuildPinnedAgent,
  __setFetchTransportForTests,
  SEEKDEEP_FETCH_DEFAULT_TIMEOUT_MS,
  SEEKDEEP_FETCH_DEFAULT_MAX_BYTES,
  SEEKDEEP_FETCH_MAX_REDIRECTS,
  SEEKDEEP_FETCH_ALLOW_PRIVATE,
  SEEKDEEP_FETCH_METADATA_HOSTS,
};
