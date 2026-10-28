/* Visual workflows share the commerce application's backend and event journal. */
const $ = id => document.getElementById(id);
const clone = value => JSON.parse(JSON.stringify(value));
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const TYPES = {
  event_trigger: { title:'Event trigger', short:'Event', subtitle:'Listen to a hub event', icon:'E', prefix:'event' },
  schedule_trigger: { title:'Schedule trigger', short:'Schedule', subtitle:'Start at a set interval', icon:'T', prefix:'schedule' },
  condition: { title:'If / then / else', short:'Condition', subtitle:'Choose the next branch', icon:'?', prefix:'condition' },
  http_get: { title:'Get data', short:'HTTP GET', subtitle:'Bring in system context', icon:'GET', prefix:'lookup' },
  email: { title:'Send email', short:'Email', subtitle:'Send through Resend', icon:'@', prefix:'email' },
};
const FALLBACK_PATHS = ['event.eventId','event.systemId','event.table','event.op','event.brandId','event.occurredAt','event.after.orderId','event.after.cartId','event.after.amountCents','event.after.currency','event.after.status','event.before.amountCents','schedule.scheduledAt'];
const SIZE = {width:240,height:128,conditionHeight:155,stageWidth:2200,stageHeight:1400};
const state = {catalog:null,workflows:[],flow:{name:'Untitled workflow',enabled:false,nodes:[],edges:[]},selected:null,edge:null,connection:null,pointer:null,zoom:1,dirty:false,busy:false,tab:'builder',runs:[],messages:[],toastTimer:null,lastTemplateField:null,constantTypes:{},refreshEpoch:0};
function notify(message,error=false){clearTimeout(state.toastTimer);$('toast').textContent=message;$('toast').classList.toggle('error',error);$('toast').hidden=false;state.toastTimer=setTimeout(()=>{$('toast').hidden=true;},error?8500:4500);}
function showError(message){$('wfError').textContent=message;$('wfError').hidden=false;}
async function api(path,{method='GET',body}={}){
  const response=await fetch(path,{method,...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});
  let data;try{data=await response.json();}catch{throw new Error('The server returned an unreadable response.');}
  if(!response.ok){const error=new Error(data.error||`Request failed (${response.status}).`);error.details=data.details;throw error;}
  return data;
}
function dateText(value){if(!value)return'—';const d=new Date(value);return Number.isFinite(d.getTime())?new Intl.DateTimeFormat('en-GB',{dateStyle:'medium',timeStyle:'medium'}).format(d):'—';}
function localInput(value){const date=new Date(value);if(!Number.isFinite(date.getTime()))return'';const local=new Date(date.getTime()-date.getTimezoneOffset()*60000);return local.toISOString().slice(0,19);}
function trigger(){return state.flow.nodes.find(n=>n.type==='event_trigger'||n.type==='schedule_trigger');}
function nodeById(id){return state.flow.nodes.find(n=>n.id===id);}
function setDirty(value=true){state.dirty=value;$('dirtyLabel').textContent=value?'Unsaved changes':state.flow.id?'Saved':'Unsaved';$('dirtyLabel').hidden=!value&&!!state.flow.id;}
function definition(){return {name:$('workflowName').value.trim()||'Untitled workflow',enabled:!!state.flow.enabled,nodes:clone(state.flow.nodes),edges:clone(state.flow.edges),...(state.flow.id?{id:state.flow.id,revision:state.flow.revision}:{})};}
function setBusy(value){state.busy=value;['saveWorkflow','toggleWorkflow','testWorkflow','newWorkflow','runTest'].forEach(id=>{$(id).disabled=value;});$('workflowSelect').disabled=value;$('exampleSelect').disabled=value;}
async function perform(action){if(state.busy)return;setBusy(true);try{return await action();}catch(error){notify(error.message,true);if(error.details)renderValidation({valid:false,errors:Array.isArray(error.details)?error.details:[{message:String(error.details)}]});}finally{setBusy(false);}}
function guardDiscard(){return !state.dirty||confirm('Discard unsaved workflow changes?');}
function refreshPicker(){
  $('workflowSelect').innerHTML='<option value="">Unsaved workflow</option>'+state.workflows.map(f=>`<option value="${escape(f.id)}">${escape(f.name)}${f.enabled?' · Enabled':''}</option>`).join('');
  $('workflowSelect').value=state.flow.id||'';
}
function updateToolbar(){
  $('workflowName').value=state.flow.name||'Untitled workflow';
  $('workflowState').textContent=state.flow.enabled?'Enabled':'Draft';$('workflowState').classList.toggle('enabled',!!state.flow.enabled);
  $('toggleWorkflow').textContent=state.flow.enabled?'Disable workflow':'Enable workflow';
  $('deleteWorkflow').disabled=!state.flow.id;
  const t=trigger();
  $('workflowTiming').textContent=state.flow.enabled?(t?.type==='schedule_trigger'?`Next scheduled run: ${dateText(state.flow.nextRunAt)}. Server must be running.`:'Listening for future matching event-hub changes.'): 'Draft flows do not run automatically.';
  const email=state.catalog?.capabilities?.email;
  const ready=email?.configured&&email?.senderConfigured;
  $('wfEmailStatus').textContent=ready?'Resend connection configured · test emails stay in the outbox':'Resend needs an API key and verified sender in environment settings.';
  $('wfEmailStatus').classList.toggle('missing-email',!ready);
  refreshPicker();
}
function renderValidation(validation=state.flow.validation){
  const errors=validation?.errors||[];
  $('validationPanel').hidden=!errors.length;
  if(errors.length)$('validationPanel').innerHTML='<strong>Before this flow can run</strong><ul>'+errors.map(e=>`<li>${e.nodeId?`${escape(e.nodeId)}: `:''}${escape(e.message||e)}</li>`).join('')+'</ul>';
}
function loadFlow(flow,dirty=false){
  state.flow=clone(flow||{name:'Untitled workflow',enabled:false,nodes:[],edges:[]});state.flow.nodes??=[];state.flow.edges??=[];
  state.flow.nodes.forEach((n,i)=>{n.position??={x:80+i*300,y:100};n.config??={};});
  state.selected=state.flow.nodes[0]?.id||null;state.edge=null;state.connection=null;state.constantTypes={};state.runs=[];setDirty(dirty);updateToolbar();renderCanvas();renderInspector();renderValidation();
  if(state.tab==='runs')refreshRuns();
}
async function refreshWorkflows(){const result=await api('/api/workflows');state.workflows=result.workflows||[];refreshPicker();}
async function saveFlow(enabled=state.flow.enabled){
  const body={...definition(),enabled};
  const response=await api(state.flow.id?`/api/workflows/${encodeURIComponent(state.flow.id)}`:'/api/workflows',{method:state.flow.id?'PUT':'POST',body});
  const previous=state.selected;state.flow=response.workflow;state.flow.nodes??=[];state.flow.edges??=[];state.selected=previous&&nodeById(previous)?previous:null;setDirty(false);
  await refreshWorkflows();updateToolbar();renderCanvas();renderInspector();renderValidation();return state.flow;
}
function defaultConfig(type){
  if(type==='event_trigger')return {matches:[{systemId:'erp',table:'orders',op:'c'}],fields:[{key:'amount',path:'event.after.amountCents'},{key:'orderId',path:'event.after.orderId'}]};
  if(type==='schedule_trigger')return {startAt:new Date(Date.now()+60000).toISOString(),interval:1,unit:'minutes'};
  if(type==='condition')return {left:{kind:'path',value:'vars.amount'},operator:'gt',right:{kind:'constant',value:15000}};
  if(type==='http_get')return {url:'/api/workflow-demo/reference?brandId={{event.brandId}}'};
  return {delivery:'resend',to:'',subject:'Order {{event.after.orderId}} requires a review',text:'Order {{event.after.orderId}} has a value of {{event.after.amountCents}} EUR cents.'};
}
function addNode(type,position){
  if(!TYPES[type])return;
  if((type==='event_trigger'||type==='schedule_trigger')&&trigger()){notify('A flow has one starting trigger. Remove the current trigger to replace it.');selectNode(trigger().id);return;}
  if(state.flow.nodes.length>=(state.catalog?.limits?.maxNodes||25))return notify('This prototype supports up to 25 blocks per flow.',true);
  let count=1;while(nodeById(TYPES[type].prefix+count))count++;
  const viewport=$('canvasViewport');
  const point=position||{x:Math.max(40,Math.round((viewport.scrollLeft+viewport.clientWidth/2)/state.zoom-120)),y:Math.max(60,Math.round((viewport.scrollTop+viewport.clientHeight/2)/state.zoom-64))};
  const node={id:TYPES[type].prefix+count,type,position:{x:Math.min(SIZE.stageWidth-260,Math.max(20,Math.round(point.x/10)*10)),y:Math.min(SIZE.stageHeight-180,Math.max(20,Math.round(point.y/10)*10))},config:defaultConfig(type)};
  state.flow.nodes.push(node);state.selected=node.id;state.edge=null;setDirty();renderCanvas();renderInspector();
}
function nodeSummary(node){const c=node.config||{};if(node.type==='event_trigger')return `${c.matches?.length||0} event type${c.matches?.length===1?'':'s'} · ${c.fields?.length||0} selected values`;if(node.type==='schedule_trigger')return `Every ${c.interval||'…'} ${c.unit||'minutes'}`;if(node.type==='condition')return `${c.left?.kind==='path'?c.left.value:JSON.stringify(c.left?.value)} ${c.operator||'eq'} ${c.operator==='exists'?'':c.right?.kind==='path'?c.right.value:JSON.stringify(c.right?.value)}`;if(node.type==='http_get')return c.url||'Configure a JSON endpoint';return c.to||'Add a recipient';}
function renderCanvas(){
  $('nodeLayer').innerHTML=state.flow.nodes.map(n=>{const type=TYPES[n.type]||{title:n.type,icon:'?',short:n.type};return `<article class="wf-node wf-type-${escape(n.type)}${n.type==='condition'?' condition':''}${state.selected===n.id?' selected':''}" data-node="${escape(n.id)}" tabindex="0" role="group" aria-label="${escape(type.title)} block ${escape(n.id)}"><div class="wf-node-header" data-move="${escape(n.id)}"><span class="wf-block-icon" aria-hidden="true">${escape(type.icon)}</span><div><strong class="wf-node-title">${escape(type.title)}</strong><span class="wf-node-id">${escape(n.id)}</span></div></div><p class="wf-node-summary" title="${escape(nodeSummary(n))}">${escape(nodeSummary(n))}</p><div class="wf-node-foot"><span>${escape(type.short)}</span><span>Configure →</span></div>${n.type.endsWith('_trigger')?'':`<button type="button" class="wf-node-port input" data-input="${escape(n.id)}" aria-label="Connect input of ${escape(n.id)}"></button>`}${n.type==='condition'?`<span class="wf-condition-label true">Then · true</span><button type="button" class="wf-node-port output true" data-output="${escape(n.id)}" data-port="true" aria-label="Connect true output of ${escape(n.id)}"></button><span class="wf-condition-label false">Else · false</span><button type="button" class="wf-node-port output false" data-output="${escape(n.id)}" data-port="false" aria-label="Connect false output of ${escape(n.id)}"></button>`:`<button type="button" class="wf-node-port output" data-output="${escape(n.id)}" data-port="next" aria-label="Connect output of ${escape(n.id)}"></button>`}</article>`;}).join('');
  state.flow.nodes.forEach(n=>{const el=document.querySelector(`[data-node="${CSS.escape(n.id)}"]`);el.style.left=`${n.position.x}px`;el.style.top=`${n.position.y}px`;});
  $('emptyCanvas').hidden=!!state.flow.nodes.length;$('canvasSummary').textContent=`${state.flow.nodes.length} blocks · ${state.flow.edges.length} connections`;
  $('removeSelectedEdge').hidden=!state.edge;$('cancelConnection').hidden=!state.connection;
  renderEdges();renderReferences();
}
function point(node,port='input'){return{x:node.position.x+(port==='input'?0:SIZE.width),y:node.position.y+(port==='false'?113:port==='true'?65:58)};}
function curve(a,b){const distance=Math.max(65,Math.abs(b.x-a.x)*.45);return`M ${a.x} ${a.y} C ${a.x+distance} ${a.y}, ${b.x-distance} ${b.y}, ${b.x} ${b.y}`;}
function renderEdges(){
  let html=state.flow.edges.map(e=>{const source=nodeById(e.source),target=nodeById(e.target);if(!source||!target)return'';const a=point(source,e.port),b=point(target);return`<path class="wf-edge ${escape(e.port)}${state.edge===e.id?' selected':''}" data-edge="${escape(e.id)}" d="${curve(a,b)}" tabindex="0" role="button" aria-label="Connection from ${escape(e.source)} ${escape(e.port)} to ${escape(e.target)}. Select then press Delete to remove."></path>${e.port!=='next'?`<text class="wf-edge-label" x="${a.x+18}" y="${a.y-8}">${e.port==='true'?'then':'else'}</text>`:''}`;}).join('');
  if(state.connection&&state.pointer){const source=nodeById(state.connection.source);if(source)html+=`<path class="wf-edge-temporary" d="${curve(point(source,state.connection.port),state.pointer)}"></path>`;}
  $('connections').innerHTML=html;
}
function selectNode(id){state.selected=id;state.edge=null;document.querySelectorAll('[data-node]').forEach(el=>el.classList.toggle('selected',el.dataset.node===id));$('removeSelectedEdge').hidden=true;renderEdges();renderInspector();}
function connectNodes(target){
  const connection=state.connection;if(!connection)return;
  if(target===connection.source||nodeById(target)?.type.endsWith('_trigger'))return notify('Connect the trigger or block output to another block’s input.',true);
  const candidate=state.flow.edges.filter(e=>!(e.source===connection.source&&e.port===connection.port)&&e.target!==target);
  const adjacency=new Map();candidate.forEach(e=>{const list=adjacency.get(e.source)||[];list.push(e.target);adjacency.set(e.source,list);});
  const seen=new Set();function reaches(id){if(id===connection.source)return true;if(seen.has(id))return false;seen.add(id);return(adjacency.get(id)||[]).some(reaches);}
  if(reaches(target))return notify('This connection would create a loop. Keep the flow moving forward.',true);
  candidate.push({id:`edge-${crypto.randomUUID().slice(0,8)}`,source:connection.source,target,port:connection.port});state.flow.edges=candidate;state.connection=null;state.pointer=null;setDirty();renderCanvas();$('canvasHelp').textContent='Connection added. Each input and output branch connects to one block.';
}
function stagePoint(event){const box=$('canvasStage').getBoundingClientRect();return{x:(event.clientX-box.left)/state.zoom,y:(event.clientY-box.top)/state.zoom};}
function setZoom(value){state.zoom=Math.max(.35,Math.min(1.5,value));$('canvasStage').style.transform=`scale(${state.zoom})`;$('canvasSpace').style.width=`${SIZE.stageWidth*state.zoom}px`;$('canvasSpace').style.height=`${SIZE.stageHeight*state.zoom}px`;$('zoomValue').textContent=`${Math.round(state.zoom*100)}%`;}
function fitCanvas(){const nodes=state.flow.nodes;if(!nodes.length){setZoom(1);return;}const minX=Math.min(...nodes.map(n=>n.position.x)),maxX=Math.max(...nodes.map(n=>n.position.x+SIZE.width));const minY=Math.min(...nodes.map(n=>n.position.y)),maxY=Math.max(...nodes.map(n=>n.position.y+(n.type==='condition'?155:128)));const viewport=$('canvasViewport');setZoom(Math.min(1,(viewport.clientWidth-65)/(maxX-minX),(viewport.clientHeight-70)/(maxY-minY)));viewport.scrollLeft=Math.max(0,minX*state.zoom-30);viewport.scrollTop=Math.max(0,minY*state.zoom-35);}
function removeEdge(id){state.flow.edges=state.flow.edges.filter(e=>e.id!==id);if(state.edge===id)state.edge=null;setDirty();renderCanvas();}
function variablePaths(){const paths=new Set([...(state.catalog?.variablePaths||FALLBACK_PATHS),...FALLBACK_PATHS]);const t=trigger();(t?.config.fields||[]).forEach(f=>{if(f.key)paths.add('vars.'+f.key);});state.flow.nodes.filter(n=>n.type==='http_get').forEach(n=>['status','data','data.limitCents','data.teamEmail','data.currency','data.brandId'].forEach(path=>paths.add(`nodes.${n.id}.${path}`)));return[...paths];}
function renderReferences(){const paths=variablePaths();$('wfVariablePaths').innerHTML=paths.map(path=>`<option value="${escape(path)}"></option>`).join('');$('variableReference').innerHTML=paths.slice(0,24).map(path=>`<code>${escape(path)}</code>`).join('');$('connectionList').innerHTML=state.flow.edges.length?state.flow.edges.map(e=>`<li>${escape(e.source)} <span>(${escape(e.port)}) →</span> ${escape(e.target)} <button type="button" data-remove-edge="${escape(e.id)}">Remove</button></li>`).join(''):'<li>No connections yet. Click an output dot, then an input dot.</li>';}
function field(label,control,hint=''){return`<label class="wf-field">${label}${control}${hint?`<span class="wf-field-hint">${hint}</span>`:''}</label>`;}
function configInput(key,value,{type='text',id='',placeholder='',template=false,attrs=''}={}){return`<input ${id?`id="${id}"`:''} type="${type}" data-config="${key}" ${template?'data-template-field="true"':''} value="${escape(value)}" placeholder="${escape(placeholder)}" ${attrs}>`;}
function operandEditor(side,operand={kind:'path',value:''}){
  const type=state.constantTypes[`${state.selected}:${side}`]||(typeof operand.value==='number'?'number':typeof operand.value==='boolean'?'boolean':'string');
  const kind=`<select id="wf${side}Kind" data-operand="${side}" data-part="kind"><option value="path" ${operand.kind==='path'?'selected':''}>Received value / variable</option><option value="constant" ${operand.kind==='constant'?'selected':''}>Constant</option></select>`;
  const value=operand.kind==='path'?`<input id="wf${side}Value" data-operand="${side}" data-part="value" list="wfVariablePaths" value="${escape(operand.value)}" placeholder="event.after.amountCents">`:
    `<div class="wf-field-row"><select aria-label="${side} constant type" data-operand="${side}" data-part="constantType"><option value="number" ${type==='number'?'selected':''}>Number</option><option value="string" ${type==='string'?'selected':''}>Text</option><option value="boolean" ${type==='boolean'?'selected':''}>Boolean</option></select>${type==='boolean'?`<select id="wf${side}Value" data-operand="${side}" data-part="value" data-constant-type="boolean"><option value="true" ${operand.value===true?'selected':''}>True</option><option value="false" ${operand.value===false?'selected':''}>False</option></select>`:`<input id="wf${side}Value" type="${type==='number'?'number':'text'}" ${type==='number'?'step="any"':''} data-operand="${side}" data-part="value" data-constant-type="${type}" value="${escape(operand.value)}">`}</div>`;
  return`<section class="wf-operand"><div class="wf-operand-title">${side==='left'?'Value to compare':'Compare against'}</div>${field('Input',kind)}${field(operand.kind==='path'?'Variable path':'Constant value',value,operand.kind==='path'?'Paths retain their data type; ordered comparisons require numbers.':'')}</section>`;
}
function templateTools(){return`<div class="wf-template-tools">${field('Insert a variable',`<select id="insertVariablePath"><option value="">Choose an available path…</option>${variablePaths().map(path=>`<option value="${escape(path)}">${escape(path)}</option>`).join('')}</select>`,'Focus an email or URL field, choose a path, then insert. You can also type a response field path directly.')}<button class="button button-muted" type="button" data-insert-variable>Insert {{ variable }}</button></div>`;}
function renderInspector(){
  const node=nodeById(state.selected);$('removeNode').hidden=!node;
  if(!node){$('inspectorTitle').textContent='Make it your flow.';$('nodeInspector').innerHTML='<div class="wf-inspector-empty"><span aria-hidden="true">→</span><p>Select a block to configure its inputs, values and output.</p><p>Fields can use event values and data returned by earlier blocks.</p></div>';return;}
  $('inspectorTitle').textContent=TYPES[node.type]?.title||node.type;const c=node.config||{};
  let html=`<div class="wf-node-config-id">Block ID: ${escape(node.id)}</div>`;
  if(node.type==='event_trigger'){
    const options=state.catalog?.eventOptions||[];
    const key=m=>`${m.systemId}:${m.table}:${m.op}`;
    html+='<div class="wf-section-title">Listen for one or more event types</div><div class="wf-event-options">'+options.map((option,index)=>`<label class="wf-event-choice"><input type="checkbox" data-match="${index}" ${c.matches?.some(m=>key(m)===key(option))?'checked':''}><span>${escape(option.label||`${option.systemId} / ${option.table} / ${option.op}`)}</span></label>`).join('')+'</div><p class="wf-field-hint">Any selected type starts this flow. The full received envelope remains available under <code>event</code>.</p><div class="wf-section-title">Select values for this flow</div>';
    html+=(c.fields||[]).map((mapping,index)=>`<div class="wf-alias-row"><button type="button" class="wf-alias-remove" data-remove-mapping="${index}" aria-label="Remove selected field ${escape(mapping.key||index+1)}">×</button>${field('Variable name',`<input data-mapping="${index}" data-map-part="key" value="${escape(mapping.key)}" placeholder="orderTotal" pattern="[A-Za-z][A-Za-z0-9_]*">`)}${field('Received field',`<input data-mapping="${index}" data-map-part="path" list="wfVariablePaths" value="${escape(mapping.path)}" placeholder="event.after.amountCents">`,`Use downstream as <code>vars.${escape(mapping.key||'name')}</code>.`)}</div>`).join('');
    html+='<button type="button" class="wf-add-field" data-add-mapping>+ Select another event value</button><div class="wf-info">Event workflows listen to new matching hub changes after activation. They do not depend on the commerce dashboard’s subscriptions.</div>';
  }else if(node.type==='schedule_trigger'){
    html+=field(`Start date and time`,configInput('startAt',localInput(c.startAt),{type:'datetime-local',id:'wfScheduleStart',attrs:'step="1"'}),`Your browser’s timezone: ${escape(Intl.DateTimeFormat().resolvedOptions().timeZone)}. Saved as an absolute UTC timestamp.`);
    html+='<div class="wf-field-row">'+field('Repeat every',configInput('interval',c.interval??1,{type:'number',id:'wfScheduleInterval',attrs:'min="1" max="31536000" step="1"'}))+field('Interval unit',`<select id="wfScheduleUnit" data-config="unit">${['seconds','minutes','hours','days'].map(unit=>`<option value="${unit}" ${c.unit===unit?'selected':''}>${unit}</option>`).join('')}</select>` )+'</div>';
    html+='<div class="wf-info">Intervals stay anchored to the start date. The server must be running; missed intervals are combined into one catch-up run. <code>schedule.scheduledAt</code> is available downstream.</div>';
  }else if(node.type==='condition'){
    html+=operandEditor('left',c.left);
    html+=field('Comparison',`<select id="wfConditionOperator" data-config="operator">${[['eq','equals'],['neq','does not equal'],['gt','is greater than'],['gte','is greater than or equal to'],['lt','is less than'],['lte','is less than or equal to'],['contains','contains'],['exists','exists / is present']].map(([value,label])=>`<option value="${value}" ${c.operator===value?'selected':''}>${label}</option>`).join('')}</select>`);
    if(c.operator!=='exists')html+=operandEditor('right',c.right);
    html+='<div class="wf-info">True follows the <strong>Then</strong> connection. False follows <strong>Else</strong>. An unconnected branch ends the run.</div>';
  }else if(node.type==='http_get'){
    html+=field('HTTP GET URL',`<textarea id="wfHttpUrl" data-config="url" data-template-field="true" class="wf-code-field" rows="4" spellcheck="false" placeholder="https://api.example.com/orders/{{vars.orderId}}">${escape(c.url||'')}</textarea>`,'Use a public JSON endpoint or the built-in demo reference. Variable values can be inserted in the URL.');
    html+=`<div class="wf-info">The JSON response is available as <code>nodes.${escape(node.id)}.data</code>. For the demo reference, compare against <code>nodes.${escape(node.id)}.data.limitCents</code>.</div>`;
    html+='<p class="wf-field-hint">Demo endpoint: <code>/api/workflow-demo/reference?brandId={{event.brandId}}</code>. Requests time out rather than holding a flow open indefinitely.</p>'+templateTools();
  }else if(node.type==='email'){
    const email=state.catalog?.capabilities?.email;const ready=email?.configured&&email?.senderConfigured;
    html+=field('Delivery',`<select id="wfEmailDelivery" data-config="delivery"><option value="resend" ${c.delivery==='resend'?'selected':''}>Send real email · Resend</option><option value="outbox" ${c.delivery==='outbox'?'selected':''}>Demo outbox · no message sent</option></select>`);
    if(c.delivery!=='outbox')html+=`<div class="wf-info ${ready?'':'warning'}">${ready?'Resend is configured. Enabled live runs can submit email.': 'Add WORKFLOW_EMAIL_API_KEY and a Resend-verified WORKFLOW_EMAIL_FROM in environment settings to enable real sending. Secrets are never saved in this flow.'}</div>`;
    html+=field('Recipient',configInput('to',c.to||'',{id:'wfEmailTo',template:true,placeholder:'operations@example.com'}),'Use one address or a variable resolving to an address.');
    html+=field('Subject',configInput('subject',c.subject||'',{id:'wfEmailSubject',template:true,attrs:'maxlength="500"'}));
    html+=field('Email text',`<textarea id="wfEmailText" data-config="text" data-template-field="true" rows="7">${escape(c.text||'')}</textarea>`,'Plain text. Test runs always capture the rendered message in the outbox, including when Resend is selected.');
    html+=templateTools();
  }
  $('nodeInspector').innerHTML=html;
}
function configChanged(node,{redrawInspector=false}={}){setDirty();renderCanvas();if(redrawInspector)renderInspector();}
$('nodeInspector').addEventListener('input',event=>{
  const input=event.target,node=nodeById(state.selected);if(!node)return;
  if(input.dataset.config){
    const key=input.dataset.config;let value=input.value;
    if(key==='interval')value=input.value===''?'':Number(input.value);
    if(key==='startAt'){const date=new Date(input.value);value=Number.isFinite(date.getTime())?date.toISOString():'';}
    node.config[key]=value;configChanged(node);
  }else if(input.dataset.mapping!==undefined){node.config.fields[Number(input.dataset.mapping)][input.dataset.mapPart]=input.value;configChanged(node);
  }else if(input.dataset.operand&&input.dataset.part==='value'){
    const side=input.dataset.operand,kind=node.config[side].kind,type=input.dataset.constantType;
    node.config[side].value=kind==='path'?input.value:type==='number'?(input.value===''?'':Number(input.value)):type==='boolean'?input.value==='true':input.value;configChanged(node);
  }
});
$('nodeInspector').addEventListener('change',event=>{
  const input=event.target,node=nodeById(state.selected);if(!node)return;
  if(input.dataset.match!==undefined){node.config.matches=[...$('nodeInspector').querySelectorAll('[data-match]:checked')].map(el=>{const source=state.catalog.eventOptions[Number(el.dataset.match)];return{systemId:source.systemId,table:source.table,op:source.op};});configChanged(node);}
  else if(input.dataset.operand&&input.dataset.part==='kind'){
    const side=input.dataset.operand;node.config[side]={kind:input.value,value:input.value==='path'?'vars.amount':0};state.constantTypes[`${node.id}:${side}`]='number';configChanged(node,{redrawInspector:true});
  }else if(input.dataset.operand&&input.dataset.part==='constantType'){
    const side=input.dataset.operand;state.constantTypes[`${node.id}:${side}`]=input.value;node.config[side].value=input.value==='number'?0:input.value==='boolean'?true:'';configChanged(node,{redrawInspector:true});
  }else if(input.dataset.config){node.config[input.dataset.config]=input.dataset.config==='interval'?Number(input.value):input.dataset.config==='startAt'?(Number.isFinite(new Date(input.value).getTime())?new Date(input.value).toISOString():''):input.value;configChanged(node,{redrawInspector:['operator','delivery'].includes(input.dataset.config)});}
});
$('nodeInspector').addEventListener('focusin',event=>{if(event.target.dataset.templateField)state.lastTemplateField=event.target;});
$('nodeInspector').addEventListener('click',event=>{
  const node=nodeById(state.selected);if(!node)return;
  const remove=event.target.closest('[data-remove-mapping]');
  if(remove){node.config.fields.splice(Number(remove.dataset.removeMapping),1);configChanged(node,{redrawInspector:true});}
  if(event.target.closest('[data-add-mapping]')){node.config.fields??=[];node.config.fields.push({key:`value${node.config.fields.length+1}`,path:'event.after.amountCents'});configChanged(node,{redrawInspector:true});}
  if(event.target.closest('[data-insert-variable]')){
    const path=$('insertVariablePath').value,target=state.lastTemplateField;
    if(!path)return notify('Choose a variable path first.');
    if(!target?.isConnected)return notify(`Focus a URL or email field first, or type {{${path}}} in the field.`);
    const token=`{{${path}}}`,start=target.selectionStart??target.value.length,end=target.selectionEnd??start;
    target.value=target.value.slice(0,start)+token+target.value.slice(end);target.dispatchEvent(new Event('input',{bubbles:true}));target.focus();target.setSelectionRange(start+token.length,start+token.length);
  }
});
function setTab(tab){state.tab=tab;['builder','runs','outbox'].forEach(value=>{$(value+'Panel').hidden=value!==tab;$(value+'Tab').classList.toggle('active',value===tab);$(value+'Tab').setAttribute('aria-selected',String(value===tab));});if(tab==='runs')refreshRuns();if(tab==='outbox')refreshOutbox();}
async function refreshRuns(){
  if(!state.flow.id){$('runList').innerHTML='<p class="empty-state">Save a workflow, then test it or enable its trigger.</p>';$('runsCount').textContent='';return;}
  const id=state.flow.id,epoch=state.refreshEpoch;
  try{const result=await api(`/api/workflows/${encodeURIComponent(id)}/runs`);if(state.flow.id!==id||epoch!==state.refreshEpoch)return;state.runs=result.runs||[];$('runsCount').textContent=state.runs.length||'';
    $('runList').innerHTML=state.runs.length?`<div class="table-scroll"><table class="wf-data-table"><thead><tr><th>Started</th><th>Status</th><th>Trigger</th><th>Mode</th><th>Detail</th></tr></thead><tbody>${state.runs.map(run=>`<tr><td>${escape(dateText(run.startedAt||run.createdAt))}<code>${escape(run.id)}</code></td><td><span class="wf-run-status ${escape(run.status)}">${escape(run.status)}</span></td><td>${escape(run.triggerType||'manual')}</td><td>${run.mode==='test'?'Test · outbox only':'Live'}</td><td><button class="wf-text-button" type="button" data-run="${escape(run.id)}">Inspect run →</button></td></tr>`).join('')}</tbody></table></div>`:'<p class="empty-state">No runs yet.<br>Use Test flow, or enable this workflow and publish a matching event.</p>';
    if($('runDialog').open&&state.openRunId){const run=state.runs.find(r=>r.id===state.openRunId);if(run)renderRun(run,false);}
  }catch(error){$('runList').innerHTML=`<p class="wf-unavailable">${escape(error.message)}</p>`;}
}
async function refreshOutbox(){
  try{const result=await api('/api/workflows/outbox');state.messages=result.messages||[];$('outboxCount').textContent=state.messages.length||'';
    $('outboxList').innerHTML=state.messages.length?`<div class="table-scroll"><table class="wf-data-table"><thead><tr><th>Created</th><th>Recipient / subject</th><th>Delivery</th><th>Status</th><th>Detail</th></tr></thead><tbody>${state.messages.map(raw=>{const message=messageData(raw);return`<tr><td>${escape(dateText(message.createdAt))}<code>${escape(message.nodeId)}</code></td><td>${escape(message.to)}<code>${escape(message.subject)}</code></td><td>${message.delivery==='outbox'?'Demo outbox':'Resend'}</td><td><span class="wf-run-status ${escape(message.status)}">${escape(message.status)}</span></td><td><button class="wf-text-button" type="button" data-message="${escape(message.id)}">Inspect email →</button></td></tr>`;}).join('')}</tbody></table></div>`:'<p class="empty-state">No email actions yet.<br>Run a test flow to inspect its rendered message here.</p>';
  }catch(error){$('outboxList').innerHTML=`<p class="wf-unavailable">${escape(error.message)}</p>`;}
}
function messageData(m){return{...m,id:m.id,runId:m.runId??m.run_id,nodeId:m.nodeId??m.node_id,to:m.to??m.to_address,createdAt:m.createdAt??m.created_at,providerMessageId:m.providerMessageId??m.provider_message_id};}
function renderRun(run,open=true){
  state.openRunId=run.id;$('runDialogTitle').textContent=run.workflowName||state.flow.name||'Workflow run';
  $('runOverview').innerHTML=`<div class="wf-run-metadata"><span><strong>Status</strong><span class="wf-run-status ${escape(run.status)}">${escape(run.status)}</span></span><span><strong>Run mode</strong>${run.mode==='test'?'Test · all emails captured in outbox':'Live trigger'}</span><span><strong>Started</strong>${escape(dateText(run.startedAt||run.createdAt))}</span><span><strong>Finished</strong>${escape(dateText(run.finishedAt))}</span><span><strong>Trigger</strong>${escape(run.triggerType||'manual')}</span><span><strong>Run ID</strong>${escape(run.id)}</span></div>${run.error?`<div class="wf-run-error">${escape(typeof run.error==='object'?JSON.stringify(run.error):run.error)}</div>`:''}`;
  const steps=run.steps||[];
  const oldOpen=new Set([...$('runSteps').querySelectorAll('details[open]')].map(el=>el.dataset.step));
  $('runSteps').innerHTML=steps.length?steps.map((step,index)=>`<details class="wf-run-step" data-step="${escape(step.nodeId||index)}" ${oldOpen.has(String(step.nodeId||index))||index===steps.length-1?'open':''}><summary><strong>${escape(TYPES[step.nodeType]?.title||step.nodeType||'Step')}</strong><code>${escape(step.nodeId)}</code><span class="wf-run-status ${escape(step.status)}">${escape(step.status)}</span></summary><pre>${escape(JSON.stringify({input:step.input,output:step.output,...(step.error?{error:step.error}:{})},null,2))}</pre></details>`).join(''):'<p class="wf-field-hint">The run is waiting to execute its first block.</p>';
  $('runContext').textContent=JSON.stringify(run.context||{},null,2);if(open&&!$('runDialog').open)$('runDialog').showModal();
}
function inspectMessage(id){const raw=state.messages.find(m=>m.id===id);if(!raw)return;const m=messageData(raw);$('messageTitle').textContent=m.subject||'Email action';$('messageMetadata').innerHTML=`<span><strong>Recipient</strong>${escape(m.to)}</span><span><strong>Status</strong>${escape(m.status)}${m.delivery==='outbox'?' · no message sent':''}</span><span><strong>Delivery</strong>${m.delivery==='outbox'?'Demo outbox':'Resend'}</span><span><strong>Created</strong>${escape(dateText(m.createdAt))}</span><span><strong>Run</strong>${escape(m.runId)}</span><span><strong>Provider message</strong>${escape(m.providerMessageId||'—')}</span>${m.error?`<span><strong>Error</strong>${escape(m.error)}</span>`:''}`;$('messageText').textContent=m.text||'';$('messageDialog').showModal();}
async function openTest(){
  const t=trigger();$('testScheduleNote').hidden=t?.type!=='schedule_trigger';$('testEvent').parentElement.hidden=t?.type==='schedule_trigger';$('testEvent').innerHTML='<option value="">Latest matching event from the hub</option>';
  if(t?.type==='event_trigger'){
    try{const data=await api('/api/hub/events?limit=100');const matches=(data.events||[]).filter(event=>(t.config.matches||[]).some(m=>m.systemId===event.systemId&&m.table===event.table&&m.op===event.op));$('testEvent').innerHTML+=[...matches].map(event=>`<option value="${escape(event.eventId)}">${escape(event.source?.name||event.systemId)} · ${escape(event.table)} ${escape(event.op)} · ${escape(event.after?.orderId||event.after?.cartId||event.before?.orderId||event.before?.cartId||event.eventId)}</option>`).join('');}catch(error){notify('Event choices could not load: '+error.message,true);}
  }
  $('testDialog').showModal();
}
$('nodePalette').innerHTML=Object.entries(TYPES).map(([type,value])=>`<button type="button" class="wf-palette-block wf-type-${type}" draggable="true" data-add-node="${type}" aria-label="Add ${escape(value.title)} block"><span class="wf-block-icon" aria-hidden="true">${escape(value.icon)}</span><span><strong>${escape(value.title)}</strong><small>${escape(value.subtitle)}</small></span></button>`).join('');
$('nodePalette').addEventListener('click',event=>{const button=event.target.closest('[data-add-node]');if(button)addNode(button.dataset.addNode);});
$('nodePalette').addEventListener('dragstart',event=>{const button=event.target.closest('[data-add-node]');if(button){event.dataTransfer.setData('application/x-commerce-block',button.dataset.addNode);event.dataTransfer.setData('text/plain',button.dataset.addNode);event.dataTransfer.effectAllowed='copy';}});
$('canvasViewport').addEventListener('dragover',event=>{if(event.dataTransfer.types.includes('application/x-commerce-block')){event.preventDefault();event.dataTransfer.dropEffect='copy';}});
$('canvasViewport').addEventListener('drop',event=>{event.preventDefault();const type=event.dataTransfer.getData('application/x-commerce-block');if(TYPES[type])addNode(type,stagePoint(event));});
let moving=null;
$('nodeLayer').addEventListener('pointerdown',event=>{
  const output=event.target.closest('[data-output]');
  if(output){event.preventDefault();event.stopPropagation();state.connection={source:output.dataset.output,port:output.dataset.port};state.pointer=stagePoint(event);state.selected=output.dataset.output;state.edge=null;$('cancelConnection').hidden=false;$('canvasHelp').textContent='Choose the next block’s input dot. Press Escape to cancel.';renderCanvas();renderInspector();return;}
  const input=event.target.closest('[data-input]');if(input){event.preventDefault();event.stopPropagation();if(state.connection)connectNodes(input.dataset.input);else{selectNode(input.dataset.input);notify('Choose an output dot first, then this input.');}return;}
  const node=event.target.closest('[data-node]');if(!node)return;selectNode(node.dataset.node);
  const header=event.target.closest('[data-move]');
  if(header&&event.button===0){event.preventDefault();const item=nodeById(node.dataset.node);moving={id:item.id,pointerId:event.pointerId,startX:event.clientX,startY:event.clientY,x:item.position.x,y:item.position.y};}
});
document.addEventListener('pointermove',event=>{
  if(moving){const node=nodeById(moving.id);if(!node)return;node.position.x=Math.max(20,Math.min(SIZE.stageWidth-260,moving.x+(event.clientX-moving.startX)/state.zoom));node.position.y=Math.max(20,Math.min(SIZE.stageHeight-180,moving.y+(event.clientY-moving.startY)/state.zoom));const el=document.querySelector(`[data-node="${CSS.escape(node.id)}"]`);if(el){el.style.left=node.position.x+'px';el.style.top=node.position.y+'px';}renderEdges();return;}
  if(state.connection){state.pointer=stagePoint(event);renderEdges();}
});
document.addEventListener('pointerup',event=>{
  if(moving){const node=nodeById(moving.id);if(node){node.position.x=Math.round(node.position.x/10)*10;node.position.y=Math.round(node.position.y/10)*10;if(Math.abs(event.clientX-moving.startX)+Math.abs(event.clientY-moving.startY)>3)setDirty();}moving=null;renderCanvas();return;}
  if(state.connection){const input=document.elementFromPoint(event.clientX,event.clientY)?.closest('[data-input]');if(input)connectNodes(input.dataset.input);}
});
$('nodeLayer').addEventListener('click',event=>{
  const output=event.target.closest('[data-output]'),input=event.target.closest('[data-input]');
  if(event.detail===0&&output){state.connection={source:output.dataset.output,port:output.dataset.port};state.pointer=point(nodeById(output.dataset.output),output.dataset.port);renderCanvas();document.querySelector(`[data-output="${CSS.escape(output.dataset.output)}"][data-port="${CSS.escape(output.dataset.port)}"]`)?.focus();return;}
  if(event.detail===0&&input){connectNodes(input.dataset.input);return;}
  const node=event.target.closest('[data-node]');if(node&&!output&&!input)selectNode(node.dataset.node);
});
$('connections').addEventListener('click',event=>{const edge=event.target.closest('[data-edge]');if(edge){state.edge=edge.dataset.edge;state.selected=null;renderCanvas();renderInspector();}});
$('canvasViewport').addEventListener('keydown',event=>{
  if(event.key==='Escape'){state.connection=null;state.pointer=null;renderCanvas();return;}
  if(event.key==='Delete'||event.key==='Backspace'){if(state.edge){event.preventDefault();removeEdge(state.edge);}else if(state.selected){event.preventDefault();$('removeNode').click();}return;}
  const node=nodeById(state.selected);if(node&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)){event.preventDefault();const amount=event.shiftKey?50:10;node.position.x=Math.max(20,Math.min(SIZE.stageWidth-260,node.position.x+(event.key==='ArrowRight'?amount:event.key==='ArrowLeft'?-amount:0)));node.position.y=Math.max(20,Math.min(SIZE.stageHeight-180,node.position.y+(event.key==='ArrowDown'?amount:event.key==='ArrowUp'?-amount:0)));setDirty();renderCanvas();document.querySelector(`[data-node="${CSS.escape(node.id)}"]`)?.focus();}
});
$('removeNode').addEventListener('click',()=>{const id=state.selected;if(!id)return;state.flow.nodes=state.flow.nodes.filter(n=>n.id!==id);state.flow.edges=state.flow.edges.filter(e=>e.source!==id&&e.target!==id);state.selected=null;state.connection=null;setDirty();renderCanvas();renderInspector();});
$('removeSelectedEdge').addEventListener('click',()=>{if(state.edge)removeEdge(state.edge);});
$('cancelConnection').addEventListener('click',()=>{state.connection=null;state.pointer=null;renderCanvas();});
$('connectionList').addEventListener('click',event=>{const button=event.target.closest('[data-remove-edge]');if(button)removeEdge(button.dataset.removeEdge);});
$('zoomIn').addEventListener('click',()=>setZoom(state.zoom+.1));$('zoomOut').addEventListener('click',()=>setZoom(state.zoom-.1));$('fitCanvas').addEventListener('click',fitCanvas);
$('workflowName').addEventListener('input',()=>{state.flow.name=$('workflowName').value;setDirty();});
$('saveWorkflow').addEventListener('click',()=>perform(async()=>{await saveFlow();notify('Workflow saved.');}));
$('toggleWorkflow').addEventListener('click',()=>perform(async()=>{const enabled=!state.flow.enabled;await saveFlow(enabled);notify(enabled?'Workflow enabled. Its trigger is now listening.':'Workflow disabled. New automatic runs are paused.');}));
$('testWorkflow').addEventListener('click',()=>perform(openTest));
$('runTest').addEventListener('click',()=>perform(async()=>{await saveFlow();const body=trigger()?.type==='event_trigger'&&$('testEvent').value?{eventId:$('testEvent').value}:{};const result=await api(`/api/workflows/${encodeURIComponent(state.flow.id)}/test`,{method:'POST',body});$('testDialog').close();setTab('runs');if(result.run){state.runs=[result.run,...state.runs.filter(r=>r.id!==result.run.id)];renderRun(result.run);}notify('Test started. Email actions are captured in the demo outbox.');}));
$('newWorkflow').addEventListener('click',()=>{if(!guardDiscard())return;state.refreshEpoch++;loadFlow({name:'Untitled workflow',enabled:false,nodes:[],edges:[]},true);setTab('builder');setZoom(1);$('canvasViewport').scrollTo(0,0);});
$('workflowSelect').addEventListener('change',()=>{const selected=$('workflowSelect').value;if(!guardDiscard()){refreshPicker();return;}const flow=state.workflows.find(f=>f.id===selected);if(flow){state.refreshEpoch++;loadFlow(flow);setTab('builder');fitCanvas();}});
$('exampleSelect').addEventListener('change',()=>{const index=$('exampleSelect').value;if(index==='')return;if(!guardDiscard()){$('exampleSelect').value='';return;}const example=state.catalog.examples[Number(index)];if(example){state.refreshEpoch++;loadFlow({...clone(example),enabled:false},true);setTab('builder');fitCanvas();notify('Example loaded as an unsaved draft. Configure, save, and test before enabling.');}$('exampleSelect').value='';});
$('deleteWorkflow').addEventListener('click',()=>{if(!state.flow.id||!confirm('Delete this workflow? It will stop listening for new triggers. Existing run history is retained.'))return;perform(async()=>{await api(`/api/workflows/${encodeURIComponent(state.flow.id)}`,{method:'DELETE'});await refreshWorkflows();loadFlow(state.workflows[0]||{name:'Untitled workflow',enabled:false,nodes:[],edges:[]});notify('Workflow deleted.');});});
document.querySelectorAll('[data-tab]').forEach(button=>button.addEventListener('click',()=>setTab(button.dataset.tab)));
document.querySelectorAll('[data-close]').forEach(button=>button.addEventListener('click',()=>$(button.dataset.close).close()));
$('refreshRuns').addEventListener('click',refreshRuns);$('refreshOutbox').addEventListener('click',refreshOutbox);
$('runList').addEventListener('click',event=>{const button=event.target.closest('[data-run]');if(button){const run=state.runs.find(r=>r.id===button.dataset.run);if(run)renderRun(run);}});
$('outboxList').addEventListener('click',event=>{const button=event.target.closest('[data-message]');if(button)inspectMessage(button.dataset.message);});
window.addEventListener('beforeunload',event=>{if(state.dirty){event.preventDefault();event.returnValue='';}});
async function initialize(){
  try{state.catalog=await api('/api/workflows/catalog');state.workflows=(await api('/api/workflows')).workflows||[];
    $('exampleSelect').innerHTML='<option value="">Start from an example…</option>'+(state.catalog.examples||[]).map((example,index)=>`<option value="${index}">${escape(example.name)}</option>`).join('');
    const first=state.workflows[0];loadFlow(first||(state.catalog.examples?.[0]?{...clone(state.catalog.examples[0]),enabled:false}:{name:'Untitled workflow',enabled:false,nodes:[],edges:[]}),!first);setZoom(.8);if(state.flow.nodes.length)fitCanvas();
    $('wfServiceStatus').textContent='Automation ready';$('wfServiceDot').classList.add('connected');$('wfError').hidden=true;
  }catch(error){showError('Workflow automation could not load: '+error.message);$('wfServiceStatus').textContent='Connection unavailable';$('wfServiceDot').classList.remove('connected');}
}
setInterval(()=>{if(document.hidden)return;if(state.tab==='runs'||$('runDialog').open)refreshRuns();if(state.tab==='outbox')refreshOutbox();},3000);
initialize();
