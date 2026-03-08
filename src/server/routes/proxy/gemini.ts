import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { TextDecoder } from 'node:util';
import { fetch } from 'undici';
import { tokenRouter } from '../../services/tokenRouter.js';
import { getDownstreamRoutingPolicy } from './downstreamPolicy.js';
import {
  geminiGenerateContentTransformer,
} from '../../transformers/gemini/generate-content/index.js';

const GEMINI_MODEL_PROBES = [
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-1.5-flash',
  'gemini-pro',
];

async function selectGeminiChannel(request: FastifyRequest) {
  const policy = getDownstreamRoutingPolicy(request);
  for (const candidate of GEMINI_MODEL_PROBES) {
    const selected = await tokenRouter.selectChannel(candidate, policy);
    if (selected) return selected;
  }
  return null;
}

function resolveGeminiApiVersion(request: FastifyRequest): string {
  const params = request.params as { geminiApiVersion?: string } | undefined;
  return (params?.geminiApiVersion || 'v1beta').trim() || 'v1beta';
}

function getRawRequestUrl(request: FastifyRequest): string {
  return request.raw.url || request.url || '';
}

function extractGeminiModelActionPath(request: FastifyRequest, apiVersion: string): string {
  const rawUrl = getRawRequestUrl(request);
  const withoutQuery = rawUrl.split('?')[0] || rawUrl;
  const normalizedVersion = apiVersion.replace(/^\/+/, '');
  const geminiPrefix = `/gemini/${normalizedVersion}/`;
  const aliasPrefix = `/${normalizedVersion}/`;
  if (withoutQuery.startsWith(geminiPrefix)) {
    return withoutQuery.slice(geminiPrefix.length);
  }
  if (withoutQuery.startsWith(aliasPrefix)) {
    return withoutQuery.slice(aliasPrefix.length);
  }
  return withoutQuery.replace(/^\/+/, '');
}

export async function geminiProxyRoute(app: FastifyInstance) {
  const listModels = async (request: FastifyRequest, reply: FastifyReply) => {
    const selected = await selectGeminiChannel(request);
    if (!selected) {
      return reply.code(503).send({
        error: { message: 'No available channels for Gemini models', type: 'server_error' },
      });
    }

    const apiVersion = resolveGeminiApiVersion(request);
    const upstream = await fetch(
      geminiGenerateContentTransformer.resolveModelsUrl(selected.site.url, apiVersion, selected.tokenValue),
      { method: 'GET' },
    );
    const text = await upstream.text();
    try {
      return reply.code(upstream.status).send(JSON.parse(text));
    } catch {
      return reply.code(upstream.status).type(upstream.headers.get('content-type') || 'application/json').send(text);
    }
  };

  const generateContent = async (request: FastifyRequest, reply: FastifyReply) => {
    const apiVersion = resolveGeminiApiVersion(request);
    const modelActionPath = extractGeminiModelActionPath(request, apiVersion);
    const requestedModel = modelActionPath.replace(/^models\//, '').split(':')[0].trim();
    if (!requestedModel) {
      return reply.code(400).send({
        error: { message: 'Gemini model path is required', type: 'invalid_request_error' },
      });
    }

    const policy = getDownstreamRoutingPolicy(request);
    const selected = await tokenRouter.selectChannel(requestedModel, policy);
    if (!selected) {
      return reply.code(503).send({
        error: { message: 'No available channels for this model', type: 'server_error' },
      });
    }

    const body = geminiGenerateContentTransformer.inbound.normalizeRequest(
      request.body || {},
      selected.actualModel || requestedModel,
    );

    const actualModelAction = modelActionPath.replace(
      /^models\/[^:]+/,
      `models/${selected.actualModel || requestedModel}`,
    );
    const query = new URLSearchParams(request.query as Record<string, string>).toString();
    const upstream = await fetch(
      geminiGenerateContentTransformer.resolveActionUrl(
        selected.site.url,
        apiVersion,
        actualModelAction,
        selected.tokenValue,
        query,
      ),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );

    const contentType = upstream.headers.get('content-type');
    if (geminiGenerateContentTransformer.stream.isSseContentType(contentType)) {
      reply.hijack();
      reply.raw.statusCode = upstream.status;
      reply.raw.setHeader('Content-Type', contentType || 'text/event-stream');
      const reader = upstream.body?.getReader();
      if (!reader) {
        reply.raw.end();
        return;
      }
      const aggregateState = geminiGenerateContentTransformer.stream.createAggregateState();
      const decoder = new TextDecoder();
      let rest = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          const chunkText = decoder.decode(value, { stream: true });
          const parsed = geminiGenerateContentTransformer.stream.parseSsePayloads(rest + chunkText);
          rest = parsed.rest;
          for (const event of parsed.events) {
            geminiGenerateContentTransformer.stream.applyAggregate(aggregateState, event);
            reply.raw.write(
              geminiGenerateContentTransformer.stream.serializeSsePayload(
                geminiGenerateContentTransformer.outbound.serializeAggregateResponse(aggregateState),
              ),
            );
          }
        }
        const tail = decoder.decode();
        if (tail) {
          const parsed = geminiGenerateContentTransformer.stream.parseSsePayloads(rest + tail);
          for (const event of parsed.events) {
            geminiGenerateContentTransformer.stream.applyAggregate(aggregateState, event);
            reply.raw.write(
              geminiGenerateContentTransformer.stream.serializeSsePayload(
                geminiGenerateContentTransformer.outbound.serializeAggregateResponse(aggregateState),
              ),
            );
          }
        }
      } finally {
        reader.releaseLock();
        reply.raw.end();
      }
      return;
    }

    const text = await upstream.text();
    try {
      const parsed = JSON.parse(text);
      if (!upstream.ok) {
        return reply.code(upstream.status).send(parsed);
      }

      const aggregateState = geminiGenerateContentTransformer.aggregator.createState();
      if (Array.isArray(parsed)) {
        for (const chunk of geminiGenerateContentTransformer.stream.parseJsonArrayPayload(parsed)) {
          geminiGenerateContentTransformer.aggregator.apply(aggregateState, chunk);
        }
        return reply.code(upstream.status).send(
          geminiGenerateContentTransformer.outbound.serializeAggregateResponse(aggregateState),
        );
      }

      geminiGenerateContentTransformer.aggregator.apply(aggregateState, parsed);
      return reply.code(upstream.status).send(
        geminiGenerateContentTransformer.outbound.serializeAggregateResponse(aggregateState),
      );
    } catch {
      return reply.code(upstream.status).type(contentType || 'application/json').send(text);
    }
  };

  app.get('/v1beta/models', listModels);
  app.get('/gemini/:geminiApiVersion/models', listModels);
  app.post('/v1beta/models/*', generateContent);
  app.post('/gemini/:geminiApiVersion/models/*', generateContent);
}
