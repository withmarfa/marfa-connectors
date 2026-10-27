/* global performance */
// Preloaded into a connector process so that every conversion of markup seems
// to take 20 seconds, which is longer than a feed's whole budget.
let now = 0;
performance.now = () => (now += 20_000);
