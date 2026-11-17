// Domain lists used to label results and to steer web search towards quality sources.

// Editorial / long-form outlets that publish argued pieces useful for a discursive essay.
// Free-to-read ones come first; they are what Tavily is pointed at by default.
export const EDITORIAL_FREE = [
  'theconversation.com', 'theguardian.com', 'aeon.co', 'psyche.co', 'bbc.com', 'bbc.co.uk', 'npr.org',
  'brookings.edu', 'weforum.org', 'vox.com', 'theatlantic.com', 'project-syndicate.org', 'newscientist.com',
  'nature.com', 'knowablemagazine.org', 'undark.org', 'pewresearch.org', 'ourworldindata.org', 'unesco.org',
  'oecd.org', 'worldbank.org', 'blogs.worldbank.org', 'chathamhouse.org', 'lowyinstitute.org',
  'eastasiaforum.org', 'thediplomat.com', 'aljazeera.com', 'independent.co.uk', 'time.com', 'wired.com',
  'scientificamerican.com', 'bigthink.com', 'nautil.us', 'theprint.in', 'channelnewsasia.com',
];

export const EDITORIAL_PAYWALLED = [
  'economist.com', 'nytimes.com', 'ft.com', 'wsj.com', 'washingtonpost.com', 'newyorker.com', 'hbr.org',
  'foreignaffairs.com', 'foreignpolicy.com', 'telegraph.co.uk', 'thetimes.co.uk', 'bloomberg.com',
  'latimes.com', 'scmp.com', 'straitstimes.com', 'newstatesman.com', 'spectator.co.uk', 'prospectmagazine.co.uk',
];

const ACADEMIC = [
  'doi.org', 'jstor.org', 'sciencedirect.com', 'springer.com', 'link.springer.com', 'wiley.com',
  'onlinelibrary.wiley.com', 'tandfonline.com', 'sagepub.com', 'journals.sagepub.com', 'academic.oup.com',
  'cambridge.org', 'ncbi.nlm.nih.gov', 'pmc.ncbi.nlm.nih.gov', 'pubmed.ncbi.nlm.nih.gov', 'arxiv.org',
  'ssrn.com', 'papers.ssrn.com', 'researchgate.net', 'frontiersin.org', 'mdpi.com', 'plos.org',
  'journals.plos.org', 'bmj.com', 'thelancet.com', 'nber.org', 'semanticscholar.org', 'core.ac.uk',
  'europepmc.org', 'eric.ed.gov', 'apa.org', 'psycnet.apa.org', 'emerald.com', 'muse.jhu.edu',
  'iza.org', 'scielo.org', 'hindawi.com', 'cell.com', 'science.org', 'pnas.org', 'osf.io',
];

export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

function matches(host, list) {
  return list.some((d) => host === d || host.endsWith(`.${d}`));
}

export function classifyUrl(url) {
  const host = hostOf(url);
  if (matches(host, ACADEMIC) || (/\.(edu|ac\.[a-z]{2})$/.test(host) && /\.pdf($|\?)/i.test(url))) {
    return { kind: 'academic', paywall: false, host };
  }
  if (matches(host, EDITORIAL_PAYWALLED)) return { kind: 'editorial', paywall: true, host };
  if (matches(host, EDITORIAL_FREE)) return { kind: 'editorial', paywall: false, host };
  return { kind: 'web', paywall: false, host };
}

export function canonicalUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    for (const k of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|ref$|cmp$|CMP$)/.test(k)) u.searchParams.delete(k);
    }
    u.hostname = u.hostname.replace(/^www\./, '');
    return u.toString().replace(/\/$/, '');
  } catch {
    return url;
  }
}
