import http from 'node:http';

/** Owned disposable SPA fixture: nested navigation, forms and seeded unnamed control. */
export function hybridFeatureFixture() {
  let writes = 0, reads = 0;
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET') { writes++; res.setHeader('Content-Type', 'text/html'); res.end('<h1>Test record received</h1>'); return; }
    if (req.url === '/api/read') { reads++; res.setHeader('Content-Type', 'application/json'); res.end('{"ok":true}'); return; }
    res.setHeader('Content-Type', 'text/html');
    res.end(`<title>Owned feature fixture</title><nav><button id="home" aria-current="page" onclick="show('Home')">Home</button><button id="projects" onclick="show('Projects')">Projects</button><button id="reports" onclick="show('Reports')">Reports</button></nav><main><h1>Home</h1></main>
      <script>async function show(name){await fetch('/api/read');for(const b of document.querySelectorAll('nav button')){if(b.textContent===name)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current')}
      document.querySelector('main').innerHTML='<h1>'+name+'</h1>'+(name==='Projects'?'<div role="tablist"><button id="overview" role="tab" aria-selected="true" onclick="details(false)">Overview</button><button id="details" role="tab" aria-selected="false" onclick="details(true)">Details</button></div><section id="panel">Project overview</section><button id="add" onclick="addRecord()">Add record</button>':'')}
      function addRecord(){const dialog=document.createElement('dialog');dialog.id='create-dialog';dialog.innerHTML='<h2>New record</h2><form id="new-record" method="post" action="/records"><label>Record name<input name="name" required minlength="3"></label><button type="submit">Save test record</button></form><button onclick="this.closest(&quot;dialog&quot;).remove()">Close</button>';document.body.append(dialog);dialog.showModal()}
      function details(open){document.querySelector('#overview').setAttribute('aria-selected',String(!open));document.querySelector('#details').setAttribute('aria-selected',String(open));document.querySelector('#panel').innerHTML=open?'<h2>Project details</h2><form id="record" method="post" action="/records"><label>Project name<input name="name" id="name" required minlength="3"></label><button type="submit">Save test record</button></form><button id="unnamed"></button>':'Project overview'}</script>`);
  });
  return { server, writes: () => writes, reads: () => reads, expectedPages: 1, expectedGroups: ['accessibility:/'], expectedFeatures: ['Projects', 'Reports', 'Projects / Details', 'Projects / Add record'] };
}
