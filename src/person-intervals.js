// Unknown/error entries interrupt an interval; never infer absence from missing evidence.
export function findAbsentIntervals(values, absentCount=10, presentCount=3) {
 if(!Number.isSafeInteger(absentCount)||absentCount<=0||!Number.isSafeInteger(presentCount)||presentCount<=0)throw new Error('区间阈值必须为正整数');
 const ranges=[];
 let run=0;
 for(let i=0;i<values.length;i++){
  run=values[i]===false?run+1:0;
  if(run<absentCount)continue;
  const seed=i-run+1;
  let start=seed,end=i,count=0;
  for(let j=seed-1;j>=0;j--){if(typeof values[j]!=='boolean')break;count=values[j]===true?count+1:0;if(count===presentCount)break;start=j;}
  // When a present streak is found, preserve its entire confirmation window.
  if(count===presentCount)start+=presentCount-1;
  count=0;
  for(let j=i+1;j<values.length;j++){if(typeof values[j]!=='boolean')break;count=values[j]===true?count+1:0;if(count===presentCount){end=j-presentCount;break;}end=j;}
  const previous=ranges.at(-1);
  if(previous&&start<=previous.end+1)previous.end=Math.max(previous.end,end);else ranges.push({start,end});
  i=end;run=0;
 }
 return ranges;
}
export function excludedFlags(values, absentCount=10, presentCount=3){const flags=values.map(()=>false);for(const {start,end}of findAbsentIntervals(values,absentCount,presentCount))for(let i=start;i<=end;i++)flags[i]=true;return flags;}
