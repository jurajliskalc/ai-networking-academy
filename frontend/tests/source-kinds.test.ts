// Further-reading references are labelled by kind of source (scripts/source-kinds.mjs). The content compiler
// rejects an unclassified host; these tests pin the classifier itself.
import { describe, expect, it } from 'vitest';
import { hostOf, SOURCE_KIND_HINTS, SOURCE_KINDS, sourceKind } from '../scripts/source-kinds.mjs';
import { repoStats } from '../scripts/doc-stats.mjs';

describe('source kinds', () => {
  it('classifies by host, including sub-domains', () => {
    expect(sourceKind('https://www.rfc-editor.org/rfc/rfc3168')).toBe('standard');
    expect(sourceKind('https://1.ieee802.org/dcb/802-1qbb/')).toBe('standard');
    expect(sourceKind('https://docs.nvidia.com/networking/')).toBe('vendor');
    expect(sourceKind('https://enterprise-support.nvidia.com/s/article/x')).toBe('vendor');
    expect(sourceKind('https://github.com/linux-rdma/rdma-core')).toBe('source');
    expect(sourceKind('https://docs.kernel.org/networking/ip-sysctl.html')).toBe('source');
    expect(sourceKind('https://arxiv.org/abs/2001.08361')).toBe('paper');
    expect(sourceKind('https://en.wikipedia.org/wiki/InfiniBand')).toBe('article');
  });

  it('prefers the more specific host and does not match on a partial name', () => {
    expect(sourceKind('https://gnmic.openconfig.net/')).toBe('source');
    expect(sourceKind('https://www.openconfig.net/projects/models/')).toBe('standard');
    expect(sourceKind('https://notnvidia.com/')).toBeNull();
    expect(sourceKind('https://nvidia.com.example.org/')).toBeNull();
  });

  it('returns null for an unknown host or a string that is not a URL', () => {
    expect(sourceKind('https://example.org/paper.pdf')).toBeNull();
    expect(sourceKind('docs/HARDWARE_VERIFICATION.md')).toBeNull();
    expect(hostOf('HTTPS://Docs.NVIDIA.com:443/x')).toBe('docs.nvidia.com');
  });

  it('has a label and a hint for every kind, and every reference in the content has a kind', () => {
    expect(Object.keys(SOURCE_KIND_HINTS)).toEqual(Object.keys(SOURCE_KINDS));
    const s = repoStats();
    expect(s.standardReferences + s.vendorReferences + s.sourceReferences + s.paperReferences + s.articleReferences).toBe(s.references);
    expect(s.referenceUrls).toBeLessThanOrEqual(s.references);
    expect(s.references).toBeGreaterThan(0);
  });
});
