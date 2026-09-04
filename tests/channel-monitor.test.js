const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const monitor=require('../src/channel-monitor.js');

test('normalizes only New API models with performance samples',()=>{
  const rows=monitor.normalizeNewApi({models:[{model_name:'gpt-4o',success_rate:99.5,avg_latency_ms:810,avg_tps:42,request_count:12,recent_success_rates:[98,100]},{model_name:'gpt-4o-latest-failure',success_rate:99.5,recent_success_rates:[100,80]},{model_name:'claude-3',success_rate:null}]});
  assert.equal(rows.length,2);
  assert.deepEqual(rows[0],{model:'gpt-4o',status:'operational',successRate:99.5,latencyMs:810,tps:42,requestCount:12,recentRates:[98,100]});
  assert.equal(rows[1].status,'failed');
  assert.equal(monitor.normalizeNewApi({models:[{model_name:'legacy',success_rate:97}]})[0].status,'degraded');
});

test('maps New API health thresholds',()=>{
  assert.equal(monitor.healthFromRate(99),'operational');
  assert.equal(monitor.healthFromRate(97),'degraded');
  assert.equal(monitor.healthFromRate(80),'failed');
  assert.equal(monitor.healthFromRate(null),'unknown');
});

test('uses the latest three valid statuses with majority and newest tie-break',()=>{
  assert.equal(monitor.recentStatus(['operational','failed','failed']),'failed');
  assert.equal(monitor.recentStatus(['failed','operational','operational']),'operational');
  assert.equal(monitor.recentStatus(['operational','degraded','failed']),'failed');
  assert.equal(monitor.recentStatus(['unknown','failed','unknown']),'failed');
  assert.equal(monitor.recentStatus([]),'unknown');
});

test('normalizes Sub2API monitor list and wrapped detail',()=>{
  const rows=monitor.normalizeSub2List({items:[{id:7,name:'Primary',provider:'openai',group_name:'default',group_id:11,primary_model:'gpt-4o',primary_status:'operational',primary_latency_ms:620,availability_7d:99.8,extra_models:[{model:'gpt-4o-mini',status:'degraded',latency_ms:2100}],timeline:[{status:'failed',latency_ms:null,checked_at:'2026-01-01T00:00:00Z'}]}]});
  assert.equal(rows[0].status,'failed');
  assert.equal(rows[0].groupId,11);
  assert.equal(rows[0].extraModels[0].status,'degraded');
  assert.equal(rows[0].timeline[0].status,'failed');
  const detail=monitor.normalizeSub2Detail({data:{id:7,models:[{model:'gpt-4o',latest_status:'error',availability_7d:99,availability_15d:98,availability_30d:97,avg_latency_7d_ms:700}]}});
  assert.equal(detail.models[0].status,'error');
  assert.equal(detail.models[0].avgLatency7dMs,700);
});

test('normalizes New API model detail into group timelines',()=>{
  const detail=monitor.normalizeNewApiDetail({model_name:'gpt-4o',groups:[{group:'default',success_rate:99.5,avg_ttft_ms:420,series:[{ts:1710000000,success_rate:99,avg_latency_ms:810,avg_ttft_ms:400,avg_tps:35},{ts:1710000300,success_rate:97,avg_latency_ms:820,avg_ttft_ms:410,avg_tps:35},{ts:1710000600,success_rate:97,avg_latency_ms:830,avg_ttft_ms:420,avg_tps:35}]}]});
  assert.equal(detail.groups[0].status,'degraded');
  assert.deepEqual(detail.groups[0].timeline[0],{status:'operational',successRate:99,latencyMs:810,ttftMs:400,tps:35,checkedAt:1710000000});
});

test('builds a complete 24 hour timeline with stable display buckets',()=>{
  const end=Date.parse('2026-01-02T00:00:00Z');
  const minutePoints=Array.from({length:60},(_,i)=>({checkedAt:new Date(end-3600000+i*60000).toISOString(),status:'operational',successRate:99}));
  const minuteTimeline=monitor.buildBucketTimeline(minutePoints,{rangeSeconds:86400,maxSlots:48,end});
  assert.equal(minuteTimeline.sourceBucketSeconds,60);
  assert.equal(minuteTimeline.displayBucketSeconds,1800);
  assert.equal(minuteTimeline.points.length,48);
  assert.equal(minuteTimeline.points.filter(x=>x.hasData).length,2);

  const hourPoints=[0,2].map(hour=>({checkedAt:new Date(Date.parse('2026-01-01T20:00:00Z')+hour*3600000).toISOString(),status:'operational'}));
  const hourTimeline=monitor.buildBucketTimeline(hourPoints,{rangeSeconds:86400,maxSlots:48,end});
  assert.equal(hourTimeline.sourceBucketSeconds,3600);
  assert.equal(hourTimeline.displayBucketSeconds,3600);
  assert.equal(hourTimeline.points.length,24);
  assert.equal(hourTimeline.points.filter(x=>x.hasData).length,2);
  assert.equal(hourTimeline.points.filter(x=>!x.hasData).length,22);
  assert.equal(hourTimeline.bucketExact,true);

  const singlePoint=monitor.buildBucketTimeline([{checkedAt:'2026-01-01T23:00:00Z',status:'operational'}],{rangeSeconds:86400,maxSlots:48,end});
  assert.equal(singlePoint.sourceBucketSeconds,3600);
  assert.equal(singlePoint.bucketExact,false);
});

test('orders V1 probe history from old to new and reports the typical interval',()=>{
  const timeline=monitor.buildProbeTimeline([
    {checkedAt:'2026-01-01T00:20:00Z',status:'failed'},
    {checkedAt:'2026-01-01T00:00:00Z',status:'operational'},
    {checkedAt:'2026-01-01T00:10:00Z',status:'degraded'},
  ]);
  assert.equal(timeline.points[0].checkedAt,'2026-01-01T00:00:00Z');
  assert.equal(timeline.points[2].checkedAt,'2026-01-01T00:20:00Z');
  assert.equal(timeline.typicalIntervalSeconds,600);
});

test('normalizes Sub2API V2 snapshot and group matrix percentages',()=>{
  const data=monitor.normalizeSub2V2({health:{overall:'warning'},metrics:{error_rate:0.02,ttft:{p50_ms:500},duration:{avg_ms:900},tpm:1800,cache_rate:0.4},coverage:{data_through:'2026-01-01T00:00:00Z'}},{items:[{platform:'openai',group_id:7,group_name:'default',health:{overall:'healthy'},metrics:{success_rate:0.99,error_rate:0.01,ttft:{p50_ms:420},duration:{avg_ms:800},tpm:1200,cache_rate:0.4},buckets:[{bucket_start:'2026-01-01T00:00:00Z',health:{overall:'critical'},metrics:{error_rate:0.2,cache_rate:0.2,ttft:{p50_ms:900},duration:{avg_ms:1500},tpm:600}},{bucket_start:'2026-01-01T00:05:00Z',health:{overall:'healthy'},metrics:{success_rate:0.99}},{bucket_start:'2026-01-01T00:10:00Z',health:{overall:'healthy'},metrics:{success_rate:0.99}}]}]});
  assert.equal(data.summary.status,'degraded');
  assert.equal(data.summary.successRate,98);
  assert.equal(data.rows[0].status,'operational');
  assert.equal(data.rows[0].name,'default');
  assert.equal(data.rows[0].groupId,7);
  assert.equal(data.rows[0].successRate,99);
  assert.equal(data.rows[0].cacheRate,40);
  assert.equal(data.rows[0].tps,20);
  assert.equal(data.rows[0].timeline[0].status,'failed');
});

test('treats redacted Sub2API V2 throughput as unavailable',()=>{
  const data=monitor.normalizeSub2V2(
    {metrics:{success_rate:0.99,request_count:0,rpm:0,tpm:0}},
    {items:[{platform:'openai',model:'gpt-4o',metrics:{success_rate:0.99,request_count:0,rpm:0,tpm:0}}]},
  );
  assert.equal(data.summary.tps,null);
  assert.equal(data.summary.rpm,null);
  assert.equal(data.rows[0].tps,null);
  assert.equal(data.rows[0].requestCount,null);
});

test('uses the upstream New API detail query contract',()=>{
  const app=fs.readFileSync(path.join(__dirname,'../src/app.js'),'utf8');
  assert.match(app,/\/api\/perf-metrics\?model=\$\{encodeURIComponent\(model\)\}&hours=24/);
  assert.doesNotMatch(app,/\/api\/perf-metrics\?model_name=/);
  assert.match(app,/if\(chMonitorDetails\[key\]\)\{renderChMonitor\(\);return\}/);
  assert.doesNotMatch(app,/delete chMonitorDetails\[key\]/);
  assert.doesNotMatch(app,/fetchChMonitor[^\n]*\/api\/user\/models/);
  assert.match(app,/group_by=platform_group/);
  assert.match(app,/channel-monitor-v2\/snapshot\?range=90m/);
  assert.match(app,/channel-monitor-v2\/matrix\?range=90m&group_by=platform_group/);
  assert.match(app,/rangeSeconds:5400/);
  assert.doesNotMatch(app,/channel-monitor-v2\/(snapshot|matrix)\?range=24h/);
  assert.doesNotMatch(app,/group_by=platform_model/);
  assert.doesNotMatch(app,/toggleSub2MonitorDetail/);
  assert.doesNotMatch(app,/monitor-summary/);
  assert.doesNotMatch(app,/chMonitorIdentity\(r\.name\|\|r\.provider,r\.status,\[r\.provider,'V2'\]\)/);
  assert.doesNotMatch(app,/<span>左旧右新<\/span>/);
  assert.doesNotMatch(app,/Sub2API · 自动识别 V1 \/ V2/);
  assert.doesNotMatch(app,/New API · 24 小时概览/);
  assert.doesNotMatch(app,/\[r\.provider,'V1'\]/);
  assert.doesNotMatch(app,/\['New API',detail\.model\]/);
  assert.match(app,/function chMonitorGroupLabel\(c,name,id,groups\)/);
  assert.match(app,/chMonitorGroupLabel\(c,g\.name\)/);
  assert.match(app,/chMonitorGroupLabel\(c,r\.name\|\|r\.provider,r\.groupId,data\.groups\)/);
  assert.match(app,/chMonitorGroupLabel\(c,r\.group\|\|r\.name\|\|r\.primaryModel,r\.groupId,data\.groups\)/);
  assert.match(app,/groupId\?list\.find\(g=>String\(g\?\.id\?\?g\?\.group_id\?\?'\'\)\.trim\(\)===groupId\):null/);
  assert.doesNotMatch(app,/replace\(\/\\s\+\/g,''\)\.toLowerCase\(\)===key/);
  assert.match(app,/monitor-status \$\{s\}/);
  assert.doesNotMatch(app,/monitor-status-dot/);
  assert.match(app,/label:'缓存率',value:r\.cacheRate==null\?null:chMonitorPct\(r\.cacheRate\)/);
  assert.match(app,/\['缓存率',el\.dataset\.cache\]/);
  assert.match(fs.readFileSync(path.join(__dirname,'../pages/index.html'),'utf8'),/\.monitor-model-table-row \.monitor-name\{white-space:normal/);
  assert.doesNotMatch(app,/mapLimit\(/);
  assert.doesNotMatch(app,/channel-monitors\/\$\{encodeURIComponent\(row\.id\)\}\/status/);
  assert.doesNotMatch(app,/renderSub2Models\(/);
  assert.match(app,/return\{kind:'sub2api',groups,rows:channelMonitor\.normalizeSub2List\(raw\)\}/);
  assert.match(app,/function testChannelGroup\(channelId,group,event\)/);
  assert.match(app,/matches=chKeys\.filter\(k=>chKeyGroupName\(k\)===group\)/);
  assert.match(app,/matches\.find\(k=>chKeyStatus\(k\)==='启用'\)\|\|matches\[0\]/);
});

test('includes the monitor module in extension release manifests',()=>{
  const packageScript=fs.readFileSync(path.join(__dirname,'../scripts/package-extension.py'),'utf8');
  const collectScript=fs.readFileSync(path.join(__dirname,'../scripts/collect-release.js'),'utf8');
  assert.match(packageScript,/'src\/channel-monitor\.js'/);
  assert.match(collectScript,/'src\/channel-monitor\.js'/);
});

test('coalesces concurrent authentication recovery per channel',async()=>{
  const coordinate=monitor.createRecoveryCoordinator();
  let calls=0;
  let release;
  const gate=new Promise(resolve=>{release=resolve});
  const recover=async()=>{calls+=1;await gate};
  const version=coordinate.version('channel-1');
  const first=coordinate.recover('channel-1',version,recover);
  const second=coordinate.recover('channel-1',version,recover);
  await Promise.resolve();
  assert.equal(calls,1);
  release();
  await Promise.all([first,second]);
  await coordinate.recover('channel-1',coordinate.version('channel-1'),recover);
  assert.equal(calls,2);
});

test('skips a late 401 recovery after the same request generation recovered',async()=>{
  const coordinate=monitor.createRecoveryCoordinator();
  let calls=0;
  const staleVersion=coordinate.version('channel-1');
  await coordinate.recover('channel-1',staleVersion,async()=>{calls+=1});
  await coordinate.recover('channel-1',staleVersion,async()=>{calls+=1});
  assert.equal(calls,1);
  assert.equal(coordinate.version('channel-1'),1);
});

test('falls back from Sub2API V2 only for unsupported feature responses',()=>{
  assert.equal(monitor.shouldFallbackSub2V2(new Error('HTTP 403: CHANNEL_MONITOR_DISABLED')),true);
  assert.equal(monitor.shouldFallbackSub2V2(new Error('HTTP 403: CHANNEL_MONITOR_MODE_MISMATCH')),true);
  assert.equal(monitor.shouldFallbackSub2V2(new Error('HTTP 403: channel monitor mode does not allow this operation')),true);
  assert.equal(monitor.shouldFallbackSub2V2(new Error('HTTP 403: permission denied')),false);
  assert.equal(monitor.shouldFallbackSub2V2(new Error('HTTP 404: not found')),true);
  assert.equal(monitor.shouldFallbackSub2V2(new Error('HTTP 500: database unavailable')),false);
  assert.equal(monitor.shouldFallbackSub2V2(new Error('HTTP 500: record not found')),false);
  assert.equal(monitor.shouldFallbackSub2V2(new Error('route not found')),true);
  assert.equal(monitor.shouldFallbackSub2V2(new Error('network timeout')),false);
});

test('keeps V1 group id for multiplier lookup',()=>{
  const row=monitor.normalizeSub2List({items:[{group_name:'default',group_id:11,timeline:[]}]})[0];
  assert.equal(row.groupId,11);
});

test('loads Sub2API user group rates and merges them before rendering',()=>{
  const app=fs.readFileSync(path.join(__dirname,'../src/app.js'),'utf8');
  assert.match(app,/\/api\/v1\/groups\/rates/);
  assert.match(app,/function sub2GroupRate\(rates,id\)/);
  assert.match(app,/user_rate_multiplier:custom/);
  assert.match(app,/g\.rate_multiplier\?\?g\.user_rate_multiplier/);
  assert.match(app,/async function fetchSub2MonitorGroups\(c\)/);
  assert.match(app,/chMonitorGroupLabel\(c,r\.name\|\|r\.provider,r\.groupId,data\.groups\)/);
});

test('hides the V1 probe timeline label while preserving its accessible label',()=>{
  const app=fs.readFileSync(path.join(__dirname,'../src/app.js'),'utf8');
  assert.match(app,/visibleLabel=timeline\.mode==='probe'\?'':/);
  assert.match(app,/aria-label="\$\{esc\(label\)\}，从左到右由旧到新"/);
});
