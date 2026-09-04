(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  root.RelayChannelMonitor=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  function finite(value){const n=Number(value);return value!==null&&value!==''&&Number.isFinite(n)?n:null}
  function items(value){if(Array.isArray(value))return value;if(Array.isArray(value?.items))return value.items;if(Array.isArray(value?.data?.items))return value.data.items;return[]}
  function healthFromRate(rate,hasData=true){const n=finite(rate);if(!hasData||n===null)return'unknown';if(n>=99)return'operational';if(n>=95)return'degraded';return'failed'}
  function recentStatus(statuses,limit=3){const list=(Array.isArray(statuses)?statuses:[]).map(normalizeStatus).filter(s=>s!=='unknown').slice(-Math.max(1,Number(limit)||3));if(!list.length)return'unknown';const counts=new Map();list.forEach(s=>counts.set(s,(counts.get(s)||0)+1));const max=Math.max(...counts.values());for(let i=list.length-1;i>=0;i--)if(counts.get(list[i])===max)return list[i];return'unknown'}
  function healthFromLatestRate(rates){const list=(Array.isArray(rates)?rates:[]).map(finite).filter(v=>v!==null);return recentStatus(list.map(v=>healthFromRate(v)),3)}
  function normalizeNewApi(summary){
    const raw=Array.isArray(summary)?summary:summary?.models||summary?.data?.models||[];
    return(Array.isArray(raw)?raw:[]).filter(x=>x&&finite(x.success_rate)!==null&&String(x.model_name||x.model||'')).map(x=>{const model=String(x.model_name||x.model),successRate=finite(x.success_rate),requestCount=finite(x.request_count),recentRates=(Array.isArray(x.recent_success_rates)?x.recent_success_rates:[]).map(finite).filter(v=>v!==null);return{model,status:healthFromLatestRate(recentRates.length?recentRates:[successRate]),successRate,latencyMs:finite(x.avg_latency_ms),tps:finite(x.avg_tps),requestCount,recentRates}}).sort((a,b)=>(b.requestCount??-1)-(a.requestCount??-1)||a.model.localeCompare(b.model))
  }
  function normalizeNewApiDetail(value){
    const x=value?.data&&typeof value.data==='object'?value.data:value||{};
    const groups=(Array.isArray(x.groups)?x.groups:[]).map(g=>{
      const successRate=finite(g?.success_rate);
      const timeline=(Array.isArray(g?.series)?g.series:[]).map(p=>{
        const pointRate=finite(p?.success_rate);
        return{status:healthFromRate(pointRate,pointRate!==null),successRate:pointRate,latencyMs:finite(p?.avg_latency_ms),ttftMs:finite(p?.avg_ttft_ms),tps:finite(p?.avg_tps),checkedAt:finite(p?.ts)};
      }).sort((a,b)=>(timestampMs(a.checkedAt)||0)-(timestampMs(b.checkedAt)||0));
      return{name:String(g?.group||''),status:recentStatus(timeline.map(p=>p.status),3),successRate,latencyMs:finite(g?.avg_latency_ms),ttftMs:finite(g?.avg_ttft_ms),tps:finite(g?.avg_tps),timeline};
    });
    return{model:String(x.model_name||''),groups};
  }
  function normalizeStatus(value){const status=String(value||'unknown').toLowerCase(),aliases={healthy:'operational',warning:'degraded',critical:'failed'};return aliases[status]||(['operational','degraded','failed','error'].includes(status)?status:'unknown')}
  function normalizeSub2List(value){
    return items(value).map(x=>{
      const timeline=(Array.isArray(x.timeline)?x.timeline:[]).map(p=>({
        status:normalizeStatus(p?.status),
        latencyMs:finite(p?.latency_ms),
        pingLatencyMs:finite(p?.ping_latency_ms),
        checkedAt:String(p?.checked_at||''),
      })).sort((a,b)=>(timestampMs(a.checkedAt)||0)-(timestampMs(b.checkedAt)||0));
      const current=recentStatus(timeline.map(p=>p.status),3);
      return{
        id:x.id,
        name:String(x.name||''),
        provider:String(x.provider||''),
        group:String(x.group_name||''),
        groupId:x.group_id??x.groupId??null,
        primaryModel:String(x.primary_model||''),
        status:current==='unknown'?normalizeStatus(x.primary_status):current,
        latencyMs:finite(x.primary_latency_ms),
        pingLatencyMs:finite(x.primary_ping_latency_ms),
        availability7d:finite(x.availability_7d),
        extraModels:(Array.isArray(x.extra_models)?x.extra_models:[]).map(m=>({
          model:String(m?.model||''),
          status:normalizeStatus(m?.status),
          latencyMs:finite(m?.latency_ms),
        })).filter(m=>m.model),
        timeline,
      };
    });
  }
  function normalizeSub2Detail(value){const x=value?.data&&typeof value.data==='object'?value.data:value||{};return{id:x.id,name:String(x.name||''),provider:String(x.provider||''),group:String(x.group_name||''),models:(Array.isArray(x.models)?x.models:[]).map(m=>({model:String(m?.model||''),status:normalizeStatus(m?.latest_status),latencyMs:finite(m?.latest_latency_ms),availability7d:finite(m?.availability_7d),availability15d:finite(m?.availability_15d),availability30d:finite(m?.availability_30d),avgLatency7dMs:finite(m?.avg_latency_7d_ms)})).filter(m=>m.model)}}
  function ratioPercent(value){const n=finite(value);return n===null?null:n>=0&&n<=1?n*100:n}
  function normalizeV2Metric(value){const x=value||{},ttft=x.ttft||{},duration=x.duration||{},tpm=finite(x.tpm);return{successRate:finite(x.success_rate)!=null?ratioPercent(x.success_rate):finite(x.error_rate)!=null?100-ratioPercent(x.error_rate):null,errorRate:ratioPercent(x.error_rate),ttftMs:finite(ttft.p50_ms),ttftP90Ms:finite(ttft.p90_ms??ttft.p95_ms),latencyMs:finite(duration.avg_ms??duration.p50_ms),latencyP90Ms:finite(duration.p90_ms??duration.p95_ms),tps:tpm!=null&&tpm>0?tpm/60:null,rpm:finite(x.rpm)>0?finite(x.rpm):null,cacheRate:ratioPercent(x.cache_rate),requestCount:finite(x.request_count)>0?finite(x.request_count):null}}
  function normalizeSub2V2(snapshot,matrix){
    const snap=snapshot?.data&&typeof snapshot.data==='object'?snapshot.data:snapshot||{};
    const mx=matrix?.data&&typeof matrix.data==='object'?matrix.data:matrix||{};
    const toPoint=p=>({
      status:normalizeStatus(p?.health?.overall),
      ...normalizeV2Metric(p?.metrics),
      checkedAt:String(p?.bucket_start||''),
    });
    const rows=items(mx).map((r,i)=>{
      const timeline=(Array.isArray(r?.buckets)?r.buckets:[]).map(toPoint).sort((a,b)=>(timestampMs(a.checkedAt)||0)-(timestampMs(b.checkedAt)||0));
      return{
        id:`${r?.platform||''}:${r?.group_id||i}`,
        name:String(r?.group_name||((r?.group_id!==null&&r?.group_id!==undefined)?`#${r.group_id}`:r?.platform||'')),
        provider:String(r?.platform||''),
        group:String(r?.group_name||''),
        groupId:r?.group_id??null,
        status:recentStatus(timeline.map(p=>p.status),3),
        ...normalizeV2Metric(r?.metrics),
        timeline,
      };
    });
    return{
      summary:{
        status:normalizeStatus(snap.health?.overall),
        ...normalizeV2Metric(snap.metrics),
        coverage:snap.coverage||{},
        trend:(Array.isArray(snap.trend)?snap.trend:[]).map(toPoint),
      },
      rows,
      coverage:mx.coverage||snap.coverage||{},
    };
  }
  function timestampMs(value){const n=finite(value);if(n!==null)return n>0&&n<1e12?n*1000:n;const parsed=Date.parse(String(value||''));return Number.isFinite(parsed)?parsed:null}
  function inferBucketSeconds(points){const times=(points||[]).map(p=>timestampMs(p?.checkedAt)).filter(v=>v!==null).sort((a,b)=>a-b),diffs=[];for(let i=1;i<times.length;i++){const diff=Math.round((times[i]-times[i-1])/1000);if(diff>0)diffs.push(diff)}if(!diffs.length)return null;const shortest=Math.min(...diffs);return shortest>=3600?3600:shortest>=300?300:60}
  function typicalIntervalSeconds(points){const times=(points||[]).map(p=>timestampMs(p?.checkedAt)).filter(v=>v!==null).sort((a,b)=>a-b),diffs=[];for(let i=1;i<times.length;i++){const diff=Math.round((times[i]-times[i-1])/1000);if(diff>0)diffs.push(diff)}if(!diffs.length)return null;diffs.sort((a,b)=>a-b);return diffs[Math.floor(diffs.length/2)]}
  function average(values){const list=values.filter(v=>finite(v)!==null).map(Number);return list.length?list.reduce((sum,v)=>sum+v,0)/list.length:null}
  function worstStatus(points){const rank={unknown:0,operational:1,degraded:2,failed:3,error:4};return(points||[]).map(p=>normalizeStatus(p?.status)).sort((a,b)=>(rank[b]||0)-(rank[a]||0))[0]||'unknown'}
  function timelinePoint(points,checkedAt){return{status:worstStatus(points),successRate:average(points.map(p=>p?.successRate)),cacheRate:average(points.map(p=>p?.cacheRate)),latencyMs:average(points.map(p=>p?.latencyMs)),ttftMs:average(points.map(p=>p?.ttftMs)),pingLatencyMs:average(points.map(p=>p?.pingLatencyMs)),tps:average(points.map(p=>p?.tps)),checkedAt,hasData:points.length>0}}
  function buildBucketTimeline(points,opt={}){
    const inferredSeconds=inferBucketSeconds(points),configuredSeconds=finite(opt.bucketSeconds),sourceSeconds=Math.max(1,configuredSeconds||inferredSeconds||3600),rangeSeconds=Math.max(sourceSeconds,Number(opt.rangeSeconds)||86400),maxSlots=Math.max(1,Number(opt.maxSlots)||48),multiple=Math.max(1,Math.ceil(rangeSeconds/maxSlots/sourceSeconds)),displaySeconds=sourceSeconds*multiple,endValue=timestampMs(opt.end),times=(points||[]).map(p=>timestampMs(p?.checkedAt)).filter(v=>v!==null),latest=times.length?Math.max(...times):null,end=endValue||(latest!==null?latest+sourceSeconds*1000:Date.now()),alignedEnd=Math.ceil(end/(displaySeconds*1000))*displaySeconds*1000,start=alignedEnd-rangeSeconds*1000,slotCount=Math.ceil(rangeSeconds/displaySeconds),slots=Array.from({length:slotCount},()=>[]);
    for(const point of points||[]){const ts=timestampMs(point?.checkedAt),index=ts===null?-1:Math.floor((ts-start)/(displaySeconds*1000));if(index>=0&&index<slots.length)slots[index].push(point)}
    return{mode:'bucket',points:slots.map((slot,i)=>timelinePoint(slot,new Date(start+i*displaySeconds*1000).toISOString())),rangeSeconds,sourceBucketSeconds:sourceSeconds,displayBucketSeconds:displaySeconds,bucketExact:configuredSeconds!==null||inferredSeconds!==null};
  }
  function buildProbeTimeline(points){const list=(points||[]).map(p=>({...p,hasData:true})).sort((a,b)=>(timestampMs(a.checkedAt)||0)-(timestampMs(b.checkedAt)||0));return{mode:'probe',points:list,sampleCount:list.length,typicalIntervalSeconds:typicalIntervalSeconds(list)}}
  function createRecoveryCoordinator(){
    const pending=new Map();
    const versions=new Map();
    return{
      version:key=>versions.get(key)||0,
      recover:async(key,observedVersion,recover)=>{
        if((versions.get(key)||0)!==observedVersion)return;
        let task=pending.get(key);
        if(!task){
          task=Promise.resolve().then(recover).then(value=>{versions.set(key,(versions.get(key)||0)+1);return value}).finally(()=>pending.delete(key));
          pending.set(key,task);
        }
        return task;
      },
    };
  }
  function shouldFallbackSub2V2(error){const message=String(error?.message||error||'');if(/CHANNEL_MONITOR_(DISABLED|MODE_MISMATCH)\b/i.test(message)||/channel\s+monitor\s+mode\s+does\s+not\s+allow/i.test(message))return true;if(/HTTP\s*404\b/i.test(message))return true;return!(/HTTP\s*\d+/i.test(message))&&/\bnot found\b/i.test(message)}
  return{healthFromRate,healthFromLatestRate,recentStatus,normalizeNewApi,normalizeNewApiDetail,normalizeStatus,normalizeSub2List,normalizeSub2Detail,normalizeSub2V2,buildBucketTimeline,buildProbeTimeline,createRecoveryCoordinator,shouldFallbackSub2V2};
});
