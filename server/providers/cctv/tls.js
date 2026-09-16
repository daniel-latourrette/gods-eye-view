import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import tls from 'node:tls';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { LUSOPONTE_IMAGE_ORIGIN } from './constants.js';

const CERT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../config/certs',
);

/**
 * Image hosts that serve an incomplete TLS chain (the leaf without its issuing
 * intermediate), keyed by exact hostname. Browsers and curl on macOS repair
 * this by fetching the intermediate over AIA; Node does not, so the missing
 * public intermediate is bundled and added to Node's root store for that host
 * only. Verification stays fully on: the intermediate must still chain to a
 * bundled Mozilla root and the leaf must match the hostname.
 *
 * lusoponte.pt: leaf issued by "Sectigo Public Server Authentication CA OV R36"
 * but the server sends the unrelated "Sectigo RSA Organization Validation
 * Secure Server CA". Intermediate fetched from the certificate's AIA URL
 * http://crt.sectigo.com/SectigoPublicServerAuthenticationCAOVR36.crt
 * (SHA-256 65:42:D1:76:BE:D5:0F:19:3C:0C:E2:97:AE:44:EC:D8:A0:A8:6B:EC:2E:DE:68:27:69:34:40:59:B4:E7:85:30).
 */
const EXTRA_INTERMEDIATES_BY_HOST = Object.freeze({
  [new URL(LUSOPONTE_IMAGE_ORIGIN).hostname]: [
    'sectigo-public-server-authentication-ca-ov-r36.pem',
  ],
});

const agentByHost = new Map();

function agentFor(hostname) {
  if (agentByHost.has(hostname)) return agentByHost.get(hostname);
  const files = EXTRA_INTERMEDIATES_BY_HOST[hostname];
  let agent = null;
  if (files) {
    try {
      const ca = [
        ...tls.rootCertificates,
        ...files.map((file) =>
          fs.readFileSync(path.join(CERT_DIR, file), 'utf8'),
        ),
      ];
      agent = new https.Agent({ ca, keepAlive: false });
    } catch (error) {
      console.warn(
        '[CCTV] Extra TLS intermediate unavailable for',
        hostname,
        error?.message || error,
      );
    }
  }
  agentByHost.set(hostname, agent);
  return agent;
}

/**
 * Minimal fetch over node:https with a host-specific CA bundle. Returns a
 * standard Response and never follows redirects itself, so the caller's
 * same-host redirect policy still applies.
 */
function fetchWithAgent(url, agent, init = {}) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      { agent, headers: init.headers || {}, signal: init.signal },
      (res) => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(res.headers)) {
          if (value == null) continue;
          headers.set(key, Array.isArray(value) ? value.join(', ') : value);
        }
        const status = res.statusCode || 502;
        const bodyless = status === 204 || status === 304;
        if (bodyless) res.resume();
        resolve(
          new Response(bodyless ? null : Readable.toWeb(res), {
            status,
            headers,
          }),
        );
      },
    );
    request.on('error', reject);
  });
}

/**
 * Fetch implementation for one upstream frame URL: global fetch for every
 * host except those registered with a bundled intermediate above.
 *
 * @param {string} url
 * @returns {typeof fetch}
 */
export function cctvFetchForUrl(url) {
  let hostname = '';
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:') hostname = parsed.hostname;
  } catch {
    return fetch;
  }
  const agent = hostname ? agentFor(hostname) : null;
  if (!agent) return fetch;
  return (target, init) => fetchWithAgent(target, agent, init);
}
