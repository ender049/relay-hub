const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const app=fs.readFileSync(path.join(__dirname,'../src/app.js'),'utf8');
const page=fs.readFileSync(path.join(__dirname,'../pages/index.html'),'utf8');

function appFunction(name){
  const match=app.match(new RegExp(`function ${name}\\([^\\n]+`));
  assert.ok(match,`${name} should exist`);
  return Function(`${match[0]}; return ${name}`)();
}

test('formats token counts with compact K, M and B units',()=>{
  const fmtTokens=appFunction('fmtTokens');
  assert.equal(fmtTokens(999),'999');
  assert.equal(fmtTokens(1200),'1.2K');
  assert.equal(fmtTokens(999500),'1M');
  assert.equal(fmtTokens(1500000),'1.5M');
  assert.equal(fmtTokens(999999999),'1B');
  assert.equal(fmtTokens(2300000000),'2.3B');
  assert.equal(fmtTokens(null),'-');
});

test('formats cache-read share against today total tokens',()=>{
  const fmtTokenShare=appFunction('fmtTokenShare');
  assert.equal(fmtTokenShare(250000,1000000),'25.0%');
  assert.equal(fmtTokenShare(0,1000000),'0.0%');
  assert.equal(fmtTokenShare(null,1000000),'-');
  assert.equal(fmtTokenShare(100,0),'-');
});

test('uses aggregate channel usage without scanning NewAPI logs',()=>{
  assert.match(app,/\/api\/data\/self\?start_timestamp=/);
  assert.doesNotMatch(app,/\/api\/log\/self/);
  assert.match(app,/todayTokens:sumArr\(data,'token_used'\)/);
});

test('appends token usage to today spend and shows cache share only for Sub2API',()=>{
  const newApiRenderer=app.match(/function renderNewApiMetrics\([^\n]+/)?.[0]||'';
  const sub2Renderer=app.match(/function renderSub2Metrics\([^\n]+/)?.[0]||'';
  const rowsRenderer=app.match(/function renderChannelMetricRows\([^\n]+/)?.[0]||'';
  const usageRenderer=app.match(/function renderTodayUsage\([^\n]+/)?.[0]||'';
  assert.match(newApiRenderer,/renderTodayUsage\(d\.todayTokens\)/);
  assert.doesNotMatch(newApiRenderer,/todayCache/);
  assert.match(sub2Renderer,/renderTodayUsage\(d\.todayTokens,d\.todayCacheReadTokens\)/);
  assert.match(rowsRenderer,/今日 <strong>\$\{today\}<\/strong>\$\{todayUsage\}/);
  assert.doesNotMatch(rowsRenderer,/channel-token-line/);
  assert.match(usageRenderer,/title="缓存读取 Token"/);
  assert.match(usageRenderer,/title="今日总 Token"/);
  assert.match(usageRenderer,/title="缓存读取占比"/);
  assert.doesNotMatch(usageRenderer,/`缓 |缓 \$\{/);
  assert.match(app,/todayCacheReadTokens:usage\?\.today_cache_read_tokens/);
  assert.doesNotMatch(app,/todayCacheCreationTokens|缓存写入/);
});

test('keeps spend and cumulative metrics on the same column grid',()=>{
  assert.match(page,/\.channel-metrics \.channel-line\{[^}]*grid-template-columns:minmax\(0,1fr\) minmax\(0,1fr\)/);
  assert.doesNotMatch(page,/\.channel-metrics \.channel-spend-line\{[^}]*grid-template-columns/);
});
