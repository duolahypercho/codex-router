import { parseSseBlockEvent } from '../src/grok-oauth-turn.mjs';

// Metadata only: never retain text, reasoning, arguments or encrypted content.
// Use the production event decoder, including CRLF, multiline data and EOF.
export function createStreamObservation(record, now = Date.now) {
  const started = now();
  const decoder = new TextDecoder();
  let buffer = '';
  let sealed = false;
  record.eventCounts = {};
  record.outputKinds = [];
  record.firstByteMs = null;
  record.firstEventMs = null;
  record.lastEventMs = null;
  const dispatch = (block) => {
    if (sealed) return;
    const event = parseSseBlockEvent(block);
    if (!event || typeof event.type !== 'string') return;
    record.firstEventMs ??= now() - started;
    record.lastEventMs = now() - started;
    record.eventCounts[event.type] = (record.eventCounts[event.type] || 0) + 1;
    if (event.type === 'response.output_item.done') {
      const item = event.item;
      record.outputKinds.push({ type: item?.type, channel: item?.channel });
      if (item?.type === 'function_call') {
        (record.toolCalls ||= []).push({ name: item.name, argumentBytes: Buffer.byteLength(item.arguments || '') });
      }
    }
    if (['response.completed', 'response.failed', 'response.incomplete', 'error'].includes(event.type)) {
      sealed = true;
      record.terminal = event.type;
      const usage = event.response?.usage;
      if (usage) record.usage = { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens,
        reasoningTokens: usage.output_tokens_details?.reasoning_tokens, cachedTokens: usage.input_tokens_details?.cached_tokens };
    }
  };
  const drain = () => {
    let match;
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      dispatch(buffer.slice(0, match.index));
      buffer = buffer.slice(match.index + match[0].length);
    }
    if (buffer.length > 4 * 1024 * 1024) throw new Error('Observation frame exceeds limit');
  };
  return {
    push(bytes) { record.firstByteMs ??= now() - started; buffer += decoder.decode(bytes, { stream: true }); drain(); },
    end() { buffer += decoder.decode(); drain(); if (buffer.trim()) dispatch(buffer); buffer = ''; },
  };
}
