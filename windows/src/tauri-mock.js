// Browser Mock for Tauri APIs to allow instant testing and preview in standard web browsers
if (!window.__TAURI__) {
  window.__TAURI__ = {
    core: {
      invoke: async (cmd, args) => {
        console.log(`[Tauri Mock Invoke] ${cmd}`, args);
        if (cmd === 'export_review_markdown') {
          const url = URL.createObjectURL(new Blob([args.content], {type: 'text/markdown;charset=utf-8'}));
          const link = document.createElement('a'); link.href = url; link.download = args.filename;
          document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
          return false; // 浏览器只能确认发起下载，不能声称落盘成功。
        }
        if (cmd === 'get_app_config') {
          return { time_tracking_enabled: true, ...JSON.parse(localStorage.getItem('todo_app_config') || '{"sync_mode":"local","local_sync_path":""}') };
        }
        if (cmd === 'read_personal_target' || cmd === 'activate_personal_target') {
          const config = args.config;
          const target = config.sync_mode === 'webdav'
            ? JSON.stringify(['webdav', config.webdav_url, config.webdav_username, config.webdav_filepath])
            : JSON.stringify(['local', config.sync_path || '']);
          const key = 'todo_target_' + target;
          if (cmd === 'activate_personal_target') {
            if (config.sync_mode === 'webdav') localStorage.setItem(key, args.data);
            localStorage.setItem('todo_app_config', JSON.stringify(config)); return;
          }
          const stored = localStorage.getItem(key) || (target === '["local",""]' ? localStorage.getItem('todo_data') : null);
          return {target, missing: stored === null, data: stored || (config.sync_mode === 'webdav' ? null : '{"version":1,"todos":[]}')};
        }
        if (cmd === 'read_todo_data') {
          return localStorage.getItem('todo_data') || '{"version":1,"todos":[]}';
        }
        if (cmd === 'write_todo_data') {
          localStorage.setItem('todo_target_' + args.target, args.data);
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
