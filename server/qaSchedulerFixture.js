import http from 'node:http';

/** Disposable task workspace. All state changes are local DOM interactions.
 * The realistic variant has two seeded deterministic defects for reproduction.
 * Nothing authenticates, persists business records, or contacts external sites. */
export function qaSchedulerFixture({defects=false}={}) {
  let writes=0;
  const server=http.createServer((request,response)=>{
    if(request.method!=='GET'){writes++;response.writeHead(405).end();return;}
    const pathname=new URL(request.url,'http://fixture.test').pathname;
    if(pathname==='/illustration.svg'){
      response.setHeader('Content-Type','image/svg+xml');
      response.end('<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48" fill="teal"/></svg>');return;
    }
    const names={'/':'Team practice workspace','/docs':'Practice documentation','/practice':'Task practice','/pricing':'Team pricing'};
    const heading=names[pathname];if(!heading){response.writeHead(404).end('Unknown fixture route');return;}
    response.setHeader('Content-Type','text/html');
    const home=pathname==='/'?`<section aria-label="Workspace views"><div role="tablist" aria-label="Task views"><button id="overview" role="tab" aria-selected="true" aria-controls="overview-panel">Overview</button><button id="details" role="tab" aria-selected="false" aria-controls="details-panel">Details</button></div><section id="overview-panel" role="tabpanel">Alpha and Beta task summaries</section><section id="details-panel" role="tabpanel" hidden>Task ownership and priority</section></section><details id="faq"><summary id="faq-toggle">FAQ</summary><p>Practice tasks locally before involving your team.</p></details>`:'';
    const copy=pathname==='/docs'?'<p>Task names require at least three characters. Email must have valid syntax. Priority must be between one and five. Practice does not send a request or save data.</p>':pathname==='/pricing'?'<p>Fixture product offer: $19 per team per month. This is product copy, not evidence of actual revenue.</p>':pathname==='/practice'?'<p>Try valid and invalid values. Inputs are local; nothing is submitted.</p>':'<p>Find, inspect and practice a repeatable team task.</p>';
    const fields=pathname==='/practice'?'<form id="practice-form" onsubmit="event.preventDefault()"><label for="task-name">Task name</label><input id="task-name" name="task" required minlength="3" maxlength="40"><label for="task-email">Team email</label><input id="task-email" name="email" type="email" required><label for="priority">Priority</label><input id="priority" name="priority" type="number" min="1" max="5" required></form>':'';
    response.end(`<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>${heading}</title><style>body{font:16px system-ui;margin:20px;line-height:1.5}nav{display:flex;flex-wrap:wrap;gap:14px}main{max-width:900px;margin:auto}input{display:block;max-width:90%;margin-bottom:14px}img{max-width:100%}button{padding:8px}section{margin:14px 0}</style></head><body><nav aria-label="Main navigation">${Object.entries(names).map(([url,name])=>`<a href="${url}">${name}</a>`).join(' ')}<a href="#guide">Jump to guide</a></nav><main><h1>${heading}</h1>${copy}${home}${fields}<section id="guide"><h2>Task guide</h2><p>Read a task, check its requirements, then practice.</p><img src="/illustration.svg" alt="Task illustration" width="48" height="48"></section><label for="query">Search tasks</label><input id="query" type="search" aria-controls="results"><ul id="results"><li>Alpha planning task</li><li>Beta review task</li><li>Gamma task notes</li></ul>${defects&&pathname==='/docs'?'<div style="width:1800px;height:32px">Seeded horizontal overflow</div>':''}${defects&&pathname==='/practice'?'<button type="button" id="unnamed-action"><svg width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="6"/></svg></button>':''}</main><script>document.querySelector('#query').oninput=e=>{for(const row of document.querySelectorAll('#results li'))row.hidden=!row.textContent.toLowerCase().includes(e.target.value.toLowerCase())};for(const tab of document.querySelectorAll('[role=tab]'))tab.onclick=()=>{for(const other of document.querySelectorAll('[role=tab]')){const selected=other===tab;other.setAttribute('aria-selected',String(selected));document.getElementById(other.getAttribute('aria-controls')).hidden=!selected}}</script></body></html>`);
  });
  return {server,writes:()=>writes,expectedPaths:['/','/docs','/practice','/pricing'],expectedDefects:defects?['responsive:/docs','accessibility:/practice']:[]};
}
