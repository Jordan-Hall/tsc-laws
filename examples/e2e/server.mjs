// A whole web app in one file: a Node server that serves a task board and keeps the tasks. The laws drive it from outside,
// through a real browser, so everything runs: the server, the page, the script and the network between them.
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 4410);
let tasks = [];
let nextId = 1;

const page = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Task board</title>
    <style>
      :root { --ink: #1f2937; --muted: #4b5563; --line: #e5e7eb; --accent: #be185d; --danger: #b91c1c; }
      body { margin: 0; min-height: 100vh; background: #f3f4f6; color: var(--ink); font: 16px/1.5 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }
      main { box-sizing: border-box; max-width: 34rem; margin: 2.5rem auto; padding: 0 0 1rem; background: #fff; border: 1px solid var(--line); border-radius: 16px; box-shadow: 0 10px 30px rgba(31, 41, 55, .10); overflow: hidden; }
      h1 { margin: 0; padding: 1.25rem 1.5rem; font-size: 1.35rem; color: #fff; background: linear-gradient(135deg, #be185d, #7e22ce); }
      form { display: grid; grid-template-columns: 1fr auto; gap: .25rem .5rem; padding: 1rem 1.5rem .5rem; }
      label { grid-column: 1 / -1; font-weight: 600; font-size: .9rem; }
      input[type=text], #title { font: inherit; padding: .6rem .8rem; border: 1px solid #9ca3af; border-radius: 10px; min-width: 0; }
      button { font: inherit; cursor: pointer; padding: .5rem .9rem; border-radius: 10px; border: 1px solid transparent; background: var(--accent); color: #fff; }
      button:hover { filter: brightness(1.1); }
      :focus-visible { outline: 3px solid #f9a8d4; outline-offset: 2px; }
      ul { list-style: none; margin: .5rem 0 0; padding: 0; }
      li { display: flex; align-items: center; gap: .65rem; padding: .6rem 1.5rem; border-top: 1px solid var(--line); }
      li:hover { background: #fdf2f8; }
      li .title { flex: 1; }
      li input[type=checkbox] { width: 1.15rem; height: 1.15rem; accent-color: var(--accent); }
      li button { background: transparent; color: var(--danger); padding: .25rem .6rem; }
      .done .title { text-decoration: line-through; color: var(--muted); }
      #left { margin: .75rem 1.5rem 0; color: var(--muted); }
    </style>
  </head>
  <body>
    <main>
      <h1>Task board</h1>
      <form id="add">
        <label for="title">New task</label>
        <input id="title" autocomplete="off" />
        <button type="submit">Add</button>
      </form>
      <ul id="list" aria-label="Tasks"></ul>
      <p id="left" aria-live="polite"></p>
    </main>
    <script>
      const list = document.getElementById('list');
      const left = document.getElementById('left');
      async function api(path, method, body) {
        const response = await fetch(path, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
        return response.json();
      }
      function render(tasks) {
        list.replaceChildren(
          ...tasks.map((task) => {
            const li = document.createElement('li');
            li.className = task.done ? 'done' : '';
            const box = document.createElement('input');
            box.type = 'checkbox';
            box.checked = task.done;
            box.setAttribute('aria-label', 'Done: ' + task.title);
            box.addEventListener('change', async () => render(await api('/api/tasks/' + task.id + '/toggle', 'POST')));
            const title = document.createElement('span');
            title.className = 'title';
            title.textContent = task.title;
            const remove = document.createElement('button');
            remove.textContent = 'Delete';
            remove.setAttribute('aria-label', 'Delete ' + task.title);
            remove.addEventListener('click', async () => render(await api('/api/tasks/' + task.id, 'DELETE')));
            li.append(box, title, remove);
            return li;
          }),
        );
        left.textContent = tasks.filter((task) => !task.done).length + ' left';
      }
      document.getElementById('add').addEventListener('submit', async (event) => {
        event.preventDefault();
        const field = document.getElementById('title');
        const title = field.value.trim();
        if (title === '') return;
        field.value = '';
        render(await api('/api/tasks', 'POST', { title }));
      });
      api('/api/tasks', 'GET').then(render);
    </script>
  </body>
</html>
`;

const send = (response, status, type, body) => {
  response.writeHead(status, { 'content-type': type });
  response.end(body);
};

createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const json = (body) => send(response, 200, 'application/json', JSON.stringify(body));
  if (url.pathname === '/') return send(response, 200, 'text/html; charset=utf-8', page);
  if (url.pathname === '/api/reset' && request.method === 'POST') {
    tasks = [];
    nextId = 1;
    return json(tasks);
  }
  if (url.pathname === '/api/tasks' && request.method === 'GET') return json(tasks);
  if (url.pathname === '/api/tasks' && request.method === 'POST') {
    let text = '';
    request.on('data', (chunk) => (text += chunk));
    request.on('end', () => {
      tasks = [...tasks, { id: nextId++, title: String(JSON.parse(text).title), done: false }];
      json(tasks);
    });
    return;
  }
  const match = /^\/api\/tasks\/(\d+)(\/toggle)?$/.exec(url.pathname);
  if (match !== null) {
    const id = Number(match[1]);
    tasks =
      match[2] === undefined
        ? tasks.filter((task) => task.id !== id)
        : tasks.map((task) => (task.id === id ? { ...task, done: !task.done } : task));
    return json(tasks);
  }
  send(response, 404, 'text/plain', 'not found');
}).listen(port, '127.0.0.1');
