import test from 'node:test';
import assert from 'node:assert/strict';
import {validateCompositionMonth, screenshotMonth, parseVideoArgs} from '../src/screenshot-2-video.js';
test('month arguments validate calendar months',()=>{assert.equal(parseVideoArgs(['--month','202606','--dry-run','--no-person-filter']).month,'202606');for(const value of ['202613','202600','20266','bad',undefined])assert.throws(()=>validateCompositionMonth(value));});
test('screenshots crossing midnight enter the correct calendar month',()=>{assert.equal(screenshotMonth('20260630235950',0,10),'202606');assert.equal(screenshotMonth('20260630235950',1,10),'202607');assert.equal(screenshotMonth('20261231235950',1,10),'202701');});

import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {BaseDir, ScreenshotIntervalSeconds} from '../src/const/index.js';
test('monthly dry-run separates images from a video crossing months', t => {
 const dir=fs.mkdtempSync(path.join(BaseDir,'log','monthly-test-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const files=[0,1].map(i=>path.join(dir,'20260630235959_20260701001000_'+String(i).padStart(4,'0')+'_step_by_'+ScreenshotIntervalSeconds+'s.jpg'));
 files.forEach(f=>fs.writeFileSync(f,'sample'));
 const list=path.join(dir,'images.json');fs.writeFileSync(list,JSON.stringify(files));
 for(const month of ['202606','202607']){const output=execFileSync(process.execPath,[path.join(BaseDir,'src','screenshot-2-video.js'),'--month',month,'--person-json',list,'--dry-run','--no-person-filter'],{encoding:'utf8'});assert.match(output,/本次将合成 1 张图片/);assert.ok(output.includes(month));}
});
