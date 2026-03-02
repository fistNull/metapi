import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchModelPricingCatalogMock = vi.fn(async (_arg?: unknown) => null);

vi.mock('../../services/modelPricingService.js', () => ({
  fetchModelPricingCatalog: (arg: unknown) => fetchModelPricingCatalogMock(arg),
}));

import { resolveUpstreamEndpointCandidates } from './upstreamEndpoint.js';

const baseContext = {
  site: {
    id: 1,
    url: 'https://upstream.example.com',
    platform: '',
    apiKey: null,
  },
  account: {
    id: 2,
    accessToken: 'token-demo',
    apiToken: null,
  },
};

describe('resolveUpstreamEndpointCandidates', () => {
  beforeEach(() => {
    fetchModelPricingCatalogMock.mockReset();
    fetchModelPricingCatalogMock.mockResolvedValue(null);
  });

  it('uses downstream-aligned endpoint priority for unknown platforms', async () => {
    const openaiOrder = await resolveUpstreamEndpointCandidates(
      {
        ...baseContext,
        site: { ...baseContext.site, platform: 'new-api' },
      },
      'gpt-5.3',
      'openai',
    );
    expect(openaiOrder).toEqual(['chat', 'messages', 'responses']);

    const claudeOrder = await resolveUpstreamEndpointCandidates(
      {
        ...baseContext,
        site: { ...baseContext.site, platform: 'new-api' },
      },
      'gpt-5.3',
      'claude',
    );
    expect(claudeOrder).toEqual(['messages', 'chat', 'responses']);

    const responsesOrder = await resolveUpstreamEndpointCandidates(
      {
        ...baseContext,
        site: { ...baseContext.site, platform: 'new-api' },
      },
      'gpt-5.3',
      'responses',
    );
    expect(responsesOrder).toEqual(['responses', 'chat', 'messages']);
  });

  it('keeps explicit platform priority rules', async () => {
    const openaiOrder = await resolveUpstreamEndpointCandidates(
      {
        ...baseContext,
        site: { ...baseContext.site, platform: 'openai' },
      },
      'gpt-5.3',
      'openai',
    );
    expect(openaiOrder).toEqual(['chat', 'responses']);

    const openaiResponsesOrder = await resolveUpstreamEndpointCandidates(
      {
        ...baseContext,
        site: { ...baseContext.site, platform: 'openai' },
      },
      'gpt-5.3',
      'responses',
    );
    expect(openaiResponsesOrder).toEqual(['responses', 'chat']);

    const claudeOrder = await resolveUpstreamEndpointCandidates(
      {
        ...baseContext,
        site: { ...baseContext.site, platform: 'claude' },
      },
      'claude-opus-4-6',
      'claude',
    );
    expect(claudeOrder).toEqual(['messages']);
  });

  it('keeps anyrouter messages-first special case', async () => {
    const openaiOrder = await resolveUpstreamEndpointCandidates(
      {
        ...baseContext,
        site: { ...baseContext.site, platform: 'anyrouter' },
      },
      'claude-opus-4-6',
      'openai',
    );
    expect(openaiOrder).toEqual(['messages', 'chat']);

    const responsesOrder = await resolveUpstreamEndpointCandidates(
      {
        ...baseContext,
        site: { ...baseContext.site, platform: 'anyrouter' },
      },
      'claude-opus-4-6',
      'responses',
    );
    expect(responsesOrder).toEqual(['responses', 'messages', 'chat']);
  });
});
