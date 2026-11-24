// What kind of source a further-reading link points to, derived from its host name. The validator rejects a
// link whose host is not listed here (or that has no explicit `kind:`), so a new source is classified on
// purpose, not by default. Shared by the content compiler and the app, like stack-variants.mjs.

/** Kinds in the order the app lists them, with the label shown next to a link. */
export const SOURCE_KINDS = {
  standard: 'Standard',
  vendor: 'Vendor docs',
  source: 'Open source',
  paper: 'Paper',
  article: 'Article',
};

/** One line per kind for the legend under a lesson's reading list. */
export const SOURCE_KIND_HINTS = {
  standard: 'a standard, specification or registry, or the body that publishes it',
  vendor: 'documentation or a product page from the vendor',
  source: 'an open-source project: its documentation, manual pages or source code',
  paper: 'a peer-reviewed paper or a preprint',
  article: 'an engineering article, book chapter or encyclopedia entry',
};

// Host suffixes, most specific first: "nvidia.com" also matches docs.nvidia.com.
const HOSTS = [
  // Standards bodies, specifications and registries
  ['rfc-editor.org', 'standard'], ['infinibandta.org', 'standard'], ['ieee802.org', 'standard'], ['iana.org', 'standard'],
  ['ultraethernet.org', 'standard'], ['ualinkconsortium.org', 'standard'], ['mpi-forum.org', 'standard'], ['dmtf.org', 'standard'],
  ['pcisig.com', 'standard'], ['osfpmsa.org', 'standard'], ['qsfp-dd.com', 'standard'], ['oiforum.com', 'standard'],
  ['nvmexpress.org', 'standard'], ['opencompute.org', 'standard'],
  ['gnmic.openconfig.net', 'source'], ['openconfig.net', 'standard'],
  // Vendors
  ['nvidia.com', 'vendor'], ['cloud.google.com', 'vendor'],
  // Open-source projects: documentation, manual pages and source code
  ['github.com', 'source'], ['githubusercontent.com', 'source'], ['github.io', 'source'], ['readthedocs.io', 'source'],
  ['kernel.org', 'source'], ['man7.org', 'source'], ['tcpdump.org', 'source'], ['frrouting.org', 'source'],
  ['open-mpi.org', 'source'], ['pytorch.org', 'source'], ['prometheus.io', 'source'], ['netboxlabs.com', 'source'],
  ['nautobot.com', 'source'], ['ansible.com', 'source'], ['batfish.org', 'source'], ['kubernetes.io', 'source'], ['lustre.org', 'source'],
  // Papers
  ['arxiv.org', 'paper'], ['dl.acm.org', 'paper'], ['doi.org', 'paper'], ['ieeexplore.ieee.org', 'paper'], ['usenix.org', 'paper'],
  ['conferences.sigcomm.org', 'paper'], ['people.csail.mit.edu', 'paper'], ['dspace.mit.edu', 'paper'], ['research.google', 'paper'],
  // Articles and books
  ['sre.google', 'article'], ['rdmamojo.com', 'article'], ['engineering.fb.com', 'article'], ['wikipedia.org', 'article'],
];

/** The host of a URL in lower case, or '' if it is not an absolute http(s) URL. */
export function hostOf(url) {
  const m = /^https?:\/\/([^/?#:]+)/i.exec(String(url ?? ''));
  return m ? m[1].toLowerCase() : '';
}

/** The kind of source behind a URL, or null if its host is not classified. */
export function sourceKind(url) {
  const host = hostOf(url);
  if (!host) return null;
  const hit = HOSTS.find(([suffix]) => host === suffix || host.endsWith(`.${suffix}`));
  return hit ? hit[1] : null;
}
