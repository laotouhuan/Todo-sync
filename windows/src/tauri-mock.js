// Browser Mock for Tauri APIs to allow instant testing and preview in standard web browsers
if (!window.__TAURI__) {
  window.__TAURI__ = {
    core: {
      invoke: async (cmd, args) => {
        console.log(`[Tauri Mock Invoke] ${cmd}`, args);
        if (cmd === 'get_app_config') {
          return JSON.parse(localStorage.getItem('todo_app_config') || '{"sync_mode":"local","local_sync_path":""}');
        }
        if (cmd === 'read_todo_data') {
          return localStorage.getItem('todo_data') || '{"version":1,"todos":[]}';
        }
        if (cmd === 'write_todo_data') {
          localStorage.setItem('todo_data', args.data);
          return;
        }
        if (cmd === 'save_app_config') {
          localStorage.setItem('todo_app_config', JSON.stringify(args.config));
          return;
        }
        if (cmd === 'get_app_version') {
          return '1.2.4';
        }
        if (cmd === 'read_collaborations_data') {
          return localStorage.getItem('todo_collabs_data') || '{"entries":[]}';
        }
        if (cmd === 'get_collaborations') {
          return [];
        }
        if (cmd === 'list_backups') {
          return [];
        }
        return null;
      }
    },
    event: {
      listen: async (event, callback) => {
        console.log(`[Tauri Mock Listen] ${event}`);
        return () => {};
      }
    }
  };
}
