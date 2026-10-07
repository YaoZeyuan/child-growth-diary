import test from 'node:test';
import assert from 'node:assert/strict';
import {choosePersonDevice} from '../src/person-device.js';
test('NVIDIA preferred by vendor rather than a fixed index',()=>{assert.equal(choosePersonDevice([{deviceId:0,vendorId:0x1002,name:'AMD'},{deviceId:5,vendorId:0x10de,name:'NVIDIA'}]).deviceId,5);});
test('absence of NVIDIA uses device zero',()=>{assert.equal(choosePersonDevice([{deviceId:2,vendorId:0x8086},{deviceId:0,vendorId:0x1002}]).deviceId,0);assert.equal(choosePersonDevice([]).deviceId,0);});
