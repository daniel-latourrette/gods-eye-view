/**
 * @module gtfsDiscovery
 * @description Find an operator's current static GTFS zip on its own web page.
 *
 * Some operators publish each timetable under a new, dated file name and only
 * link the current one from a page (Metro do Porto: "Mapas e horários" →
 * "GTFS Horários (para aplicações)"). A feed entry names that page and the
 * link text; this picks the matching `.zip` link so a new timetable is used
 * without a code change.
 *
 * The result is pinned to the page's own https origin: a link to any other
 * host is ignored, so the page can never steer the proxy elsewhere.
 *
 * Pure: no Node built-ins, no Cesium.
 */

function decodeEntities(text) {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

/**
 * @param {string} html Page HTML.
 * @param {string} pageUrl Absolute URL the HTML came from.
 * @param {RegExp} linkText Pattern the link's visible text (or its file
 *   name) must match, e.g. /GTFS/i.
 * @returns {string|null} Absolute https URL of the first matching `.zip` link
 *   on the page's origin, or null.
 */
export function findGtfsZipLink(html, pageUrl, linkText) {
  let origin;
  try {
    const page = new URL(pageUrl);
    if (page.protocol !== 'https:') return null;
    origin = page.origin;
  } catch {
    return null;
  }
  const anchor = /<a\b[^>]*?\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of String(html || '').matchAll(anchor)) {
    let href;
    try {
      href = new URL(decodeEntities(match[2].trim()), pageUrl);
    } catch {
      continue;
    }
    if (href.origin !== origin || !/\.zip$/i.test(href.pathname)) continue;
    const text = decodeEntities(match[3].replace(/<[^>]*>/g, ' '))
      .replace(/\s+/g, ' ')
      .trim();
    const fileName = decodeURIComponent(href.pathname.split('/').pop() || '');
    if (linkText.test(text) || linkText.test(fileName)) {
      href.hash = '';
      return href.toString();
    }
  }
  return null;
}
