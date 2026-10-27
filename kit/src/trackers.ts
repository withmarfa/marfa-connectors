/** Hosts and paths that serve a counting pixel, which is no picture. */
const trackers: readonly RegExp[] = [
  /^([a-z0-9-]+\.)*feedburner\.com\/~(ff|r)\//i,
  /^([a-z0-9-]+\.)*feedsportal\.com\//i,
  /^([a-z0-9-]+\.)*feedblitz\.com\//i,
  /^([a-z0-9-]+\.)*feedpress\.(it|me)\/.*\/(i|pixel)/i,
  /^(pixel|stats)\.wp\.com\//i,
  /^stats\.wordpress\.com\//i,
  /^medium\.com\/_\/stat/i,
  /^([a-z0-9-]+\.)*google-analytics\.com\//i,
  /^([a-z0-9-]+\.)*doubleclick\.net\//i,
  /^([a-z0-9-]+\.)*scorecardresearch\.com\//i,
  /^([a-z0-9-]+\.)*quantserve\.com\//i,
  /^([a-z0-9-]+\.)*list-manage\.com\/track\//i,
];

/** Whether the address is one a known tracker serves a counting pixel from. */
export function isTracker(address: string): boolean {
  const url = URL.parse(address);
  if (url === null) return false;
  const where = `${url.hostname.replace(/\.$/, "")}${url.pathname}`;
  return trackers.some((tracker) => tracker.test(where));
}
