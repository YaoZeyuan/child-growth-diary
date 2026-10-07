import test from 'node:test';
import assert from 'node:assert/strict';
import {parseMonthPipelineArgs,monthPipelineSteps,executeMonthPipeline} from '../src/month-pipeline.js';
import {parseScreenshotArgs} from '../src/monitor-video-2-img.js';
test('month commands validate months and support pnpm separator',()=>{assert.equal(parseScreenshotArgs(['--','--month','202603','--yes']).month,'202603');assert.equal(parseMonthPipelineArgs(['--month','202603']).month,'202603');assert.throws(()=>parseScreenshotArgs(['--month','202613']));assert.throws(()=>parseMonthPipelineArgs(['--month']));});
test('one-command flow carries the same month in order',async()=>{const stages=[];await executeMonthPipeline('202603',async step=>{stages.push(step);return 0;});assert.deepEqual(stages.map(step=>step.script),['monitor-video-2-img.js','detect-person.js','screenshot-2-video.js']);assert.ok(stages.every(step=>step.args.includes('202603')));});
test('failure stops all later stages and cancellation does not start work',async()=>{const seen=[];await assert.rejects(executeMonthPipeline('202603',async step=>{seen.push(step.script);return seen.length===2?1:0;}),/后续步骤未执行/);assert.equal(seen.length,2);const signal=AbortSignal.abort();await assert.rejects(executeMonthPipeline('202603',()=>{throw Error('should not execute');},signal));});
