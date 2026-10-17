import test from 'node:test';
import assert from 'node:assert/strict';
import { createStreamObservation } from '../scripts/grok-stream-observation.mjs';

test('live observation decodes split UTF8, CRLF, multiline data and EOF without saving content', () => {
  const record = {};
  const observe = createStreamObservation(record);
  const body = Buffer.from(': ping\r\n\r\ndata:{"type":"response.output_item.done",\r\ndata: "item":{"type":"message","channel":"final","content":[{"text":"секрет"}]}}\r\n\r\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":7,"output_tokens":4}}}');
  for (const byte of body) observe.push(Buffer.from([byte]));
  observe.end();
  assert.equal(record.terminal, 'response.completed');
  assert.equal(record.eventCounts['response.output_item.done'], 1);
  assert.deepEqual(record.outputKinds, [{type:'message',channel:'final'}]);
  assert.equal(record.usage.outputTokens, 4);
  assert.ok(record.firstByteMs >= 0);
  assert.ok(!JSON.stringify(record).includes('секрет'));
});

test('the first terminal seals observation just like the production parser', () => {
  for (const terminal of ['response.failed', 'response.completed']) {
    const record = {}; const observe = createStreamObservation(record);
    observe.push(Buffer.from(`data: ${JSON.stringify({type:terminal})}\n\ndata: ${JSON.stringify({type:terminal==='response.failed'?'response.completed':'response.failed'})}\n\n`));
    observe.end();
    assert.equal(record.terminal, terminal);
    assert.equal(Object.keys(record.eventCounts).length, 1);
  }
});
