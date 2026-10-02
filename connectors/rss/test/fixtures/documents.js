// Documents built to strain a read, shared by the tests that measure one in
// a process of its own.
const rss = (channel) =>
  `<?xml version="1.0"?><rss version="2.0"><channel>${channel}</channel></rss>`;

/** Few elements, each with thousands of attributes: under every count, and
 *  far over what any real feed takes to parse. */
export function heavyDocument() {
  const attributes = Array.from({ length: 4000 }, (_, at) => `a${at}="v"`).join(
    " ",
  );
  const item = `<item><title ${attributes}>t</title><guid>g</guid></item>`;
  return rss(
    `<title>T</title>${item.repeat(Math.floor((44 * 1024 * 1024) / item.length))}`,
  );
}

/** A channel title under the field cap, which every one of thousands of small
 *  entries carries. */
export function sharedDocument() {
  const items = Array.from(
    { length: 4000 },
    (_, at) => `<item><title>${at}</title><guid>${at}</guid></item>`,
  ).join("");
  return rss(`<title>${"t".repeat(90000)}</title>${items}`);
}
