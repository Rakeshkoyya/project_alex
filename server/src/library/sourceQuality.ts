import type { SearchHit } from "./webSearch.js";

/**
 * Source-quality scoring for learning material. Combines:
 *   authority  — who published it (textbooks, universities, encyclopedias, official docs …)
 *   agreement  — how many independent engines returned it
 *   rank       — the fused search rank
 * and penalises sites that are unreadable, paywalled, user-generated Q&A or
 * homework-answer farms. Scores are 0..1; anything below MIN_QUALITY is skipped.
 */

export const MIN_QUALITY = 0.35;

const TIER1 = [
  "wikipedia.org", "britannica.com", "khanacademy.org", "openstax.org", "libretexts.org", "ck12.org",
  "ocw.mit.edu", "mit.edu", "stanford.edu", "harvard.edu", "berkeley.edu", "ox.ac.uk", "cam.ac.uk",
  "nasa.gov", "nih.gov", "ncbi.nlm.nih.gov", "cdc.gov", "noaa.gov", "usgs.gov", "nist.gov",
  "nature.com", "science.org", "royalsociety.org", "plato.stanford.edu", "iep.utm.edu",
  "docs.python.org", "developer.mozilla.org", "w3.org", "learn.microsoft.com", "php.net", "rust-lang.org",
  "mathsisfun.com", "mathworld.wolfram.com", "physicsclassroom.com", "hyperphysics.phy-astr.gsu.edu",
  "bbc.co.uk", "nationalgeographic.com", "smithsonianmag.com", "gutenberg.org", "phet.colorado.edu",
];
const TIER2 = [
  "sciencedirect.com", "springer.com", "arxiv.org", "jstor.org", "scientificamerican.com", "newscientist.com",
  "geeksforgeeks.org", "freecodecamp.org", "realpython.com", "w3schools.com", "tutorialspoint.com", "byjus.com",
  "toppr.com", "vedantu.com", "sparknotes.com", "cliffsnotes.com", "investopedia.com", "history.com",
  "worldhistory.org", "biologydictionary.net", "chem.libretexts.org", "study.com", "coursera.org", "edx.org",
];
const PENALTY: Record<string, number> = {
  "pinterest.com": 0.6, "facebook.com": 0.6, "instagram.com": 0.6, "tiktok.com": 0.6, "x.com": 0.5, "twitter.com": 0.5,
  "linkedin.com": 0.4, "youtube.com": 0.35, // not readable as text
  "quora.com": 0.35, "reddit.com": 0.3, "answers.com": 0.4, "brainly.com": 0.5, "brainly.in": 0.5,
  "chegg.com": 0.5, "coursehero.com": 0.5, "studocu.com": 0.45, "scribd.com": 0.45, "slideshare.net": 0.35,
};

const matches = (domain: string, list: string[]) => list.some((d) => domain === d || domain.endsWith(`.${d}`));

export function authority(domain: string): number {
  const d = domain.toLowerCase();
  if (matches(d, TIER1)) return 1;
  if (/\.(edu|gov|mil)$/.test(d) || /\.(ac|edu|gov)\.[a-z]{2}$/.test(d)) return 0.95;
  if (matches(d, TIER2)) return 0.7;
  if (d.endsWith(".org")) return 0.6;
  return 0.45;
}

export function penalty(domain: string): number {
  const d = domain.toLowerCase();
  for (const [k, v] of Object.entries(PENALTY)) if (d === k || d.endsWith(`.${k}`)) return v;
  return 0;
}

/** Quality of one fused search hit, 0..1. `rank` is its 0-based position in the fused list. */
export function sourceQuality(hit: Pick<SearchHit, "domain" | "foundBy" | "url">, rank: number): number {
  const a = authority(hit.domain);
  const agreement = Math.min(1, (hit.foundBy.length - 1) / 2); // 1 engine: 0, 2: 0.5, 3: 1
  const pos = 1 / (1 + rank * 0.35);
  const pdfBonus = /\.pdf($|\?)/i.test(hit.url) && a >= 0.9 ? 0.05 : 0; // lecture notes / textbook chapters
  const q = 0.55 * a + 0.25 * agreement + 0.2 * pos + pdfBonus - penalty(hit.domain);
  return Math.round(Math.max(0, Math.min(1, q)) * 100) / 100;
}
