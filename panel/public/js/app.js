const App = {
    user: null,
    currentServerId: null,
    term: null,
    socket: null,
    fitAddon: null,
    currentPath: '',

    init: async () => {
        const token = localStorage.getItem('token');
        if (token) {
            try {
                const res = await fetch('/api/me', {
                    headers: { 'Authorization': `Bearer ${token}` }
                });
                const data = await res.json();
                if (data.user) {
                    App.user = data.user;
                    if (['/login', '/register'].includes(location.pathname)) {
                        App.navigate('/dashboard');
                    } else {
                        App.router();
                    }
                } else {
                    localStorage.removeItem('token');
                    if (!['/login', '/register'].includes(location.pathname)) {
                        App.navigate('/login');
                    } else {
                        App.router();
                    }
                }
            } catch (e) {
                console.error(e);
                localStorage.removeItem('token');
                App.navigate('/login');
            }
        } else {
            if (!['/login', '/register'].includes(location.pathname)) {
                App.navigate('/login');
            } else {
                App.router();
            }
        }

        window.addEventListener('popstate', App.router);
    },

    navigate: (path) => {
        history.pushState(null, '', path);
        App.router();
    },

    renderNav: (view, serverId = null) => {
        const navToggle = document.getElementById('nav-toggle');
        const navMenu = document.getElementById('nav-menu');
        const navUser = document.getElementById('nav-user');

        if (!App.user) {
            navToggle.style.display = 'none';
            return;
        }
        
        navToggle.style.display = 'inline-flex';
        navUser.textContent = App.user.username;

        navToggle.onclick = (e) => {
             e.stopPropagation();
             navMenu.classList.toggle('hidden');
        };
        document.onclick = () => navMenu.classList.add('hidden');
        navMenu.onclick = (e) => e.stopPropagation();

        navMenu.innerHTML = '';
        
        const createItem = (label, path, isActive, icon) => {
            const a = document.createElement('div');
            a.className = `dropdown-item ${isActive ? 'active' : ''}`;
            a.innerHTML = `<span class="material-symbols-outlined" style="font-size:1.1rem; margin-right:8px; vertical-align:-3px;">${icon || 'circle'}</span> ${label}`;
            a.onclick = () => {
                navMenu.classList.add('hidden');
                App.navigate(path);
            };
            navMenu.appendChild(a);
        };

        const createHeader = (label) => {
            const h = document.createElement('div');
            h.className = 'dropdown-header';
            h.textContent = label;
            navMenu.appendChild(h);
        };

        const createDivider = () => {
            const d = document.createElement('div');
            d.className = 'dropdown-divider';
            navMenu.appendChild(d);
        };

        createItem('Dashboard', '/dashboard', view === 'dashboard', 'dashboard');

        if (App.user.role === 'admin') {
             createItem('Admin', '/admin', view === 'admin', 'admin_panel_settings');
        }
        
        if (serverId) {
             createDivider();
             createHeader('Server Management');
             createItem('Console', `/server/${serverId}/console`, view === 'console', 'terminal');
             createItem('Files', `/server/${serverId}/files`, view === 'files', 'folder');
        }

        createDivider();
        const logout = document.createElement('div');
        logout.className = 'dropdown-item';
        logout.innerHTML = `<span class="material-symbols-outlined" style="font-size:1.1rem; margin-right:8px; vertical-align:-3px;">logout</span> Logout`;
        logout.onclick = App.logout;
        navMenu.appendChild(logout);
    },

    logout: async () => {
        await fetch('/api/logout', { method: 'POST' });
        localStorage.removeItem('token');
        App.user = null;
        document.getElementById('nav-toggle').style.display = 'none';
        App.navigate('/login');
    },

    router: () => {
        const appDiv = document.getElementById('app');
        const path = location.pathname === '/' ? '/dashboard' : location.pathname;
        
        if (!path.startsWith('/server/') && App.socket) {
            App.cleanupTerminal();
        }

        const serverMatch = path.match(/^\/server\/([^\/]+)\/(console|files)$/);

        if (path === '/dashboard') App.renderNav('dashboard');
        else if (path === '/admin') App.renderNav('admin');
        else if (serverMatch) App.renderNav(serverMatch[2], serverMatch[1]);
        else App.renderNav('none');

        if (path === '/login') App.renderLogin(appDiv);
        else if (path === '/register') App.renderRegister(appDiv);
        else if (path === '/admin') {
            if (!App.user) return App.navigate('/login');
            if (App.user.role !== 'admin') return App.navigate('/dashboard');
            App.renderAdminDashboard(appDiv);
        }
        else if (path === '/dashboard') {
            if (!App.user) return App.navigate('/login');
            App.renderDashboard(appDiv);
        }
        else if (serverMatch) {
            if (!App.user) return App.navigate('/login');
            const [_, serverId, view] = serverMatch;
            App.renderServerLayout(appDiv, serverId, view);
        }
        else {
            if (App.user) App.navigate('/dashboard');
            else App.navigate('/login');
        }
    },

    cleanupTerminal: () => {
        if (App.socket) {
            App.socket.disconnect();
            App.socket = null;
        }
        if (App.term) {
            App.term.dispose();
            App.term = null;
        }
    },

    renderLogin: (container) => {
        const tmpl = document.getElementById('login-template').content.cloneNode(true);
        container.innerHTML = '';
        container.appendChild(tmpl);

        document.getElementById('login-form').onsubmit = async (e) => {
            e.preventDefault();
            const u = document.getElementById('l-username').value;
            const p = document.getElementById('l-password').value;
            
            const res = await fetch('/api/login', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ username: u, password: p })
            });
            const data = await res.json();
            if (data.success) {
                App.user = data.user;
                localStorage.setItem('token', data.token);
                App.updateNav();
                App.navigate('/dashboard');
            } else {
                const err = document.getElementById('login-error');
                err.textContent = data.error;
                err.classList.remove('hidden');
            }
        };
    },

    renderRegister: (container) => {
        const tmpl = document.getElementById('register-template').content.cloneNode(true);
        container.innerHTML = '';
        container.appendChild(tmpl);

        document.getElementById('register-form').onsubmit = async (e) => {
            e.preventDefault();
            const u = document.getElementById('r-username').value;
            const p = document.getElementById('r-password').value;

            const res = await fetch('/api/register', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ username: u, password: p })
            });
            const data = await res.json();
            if (data.success) {
                App.user = data.user;
                localStorage.setItem('token', data.token);
                App.updateNav();
                App.navigate('/dashboard');
            } else {
                const err = document.getElementById('reg-error');
                err.textContent = data.error;
                err.classList.remove('hidden');
            }
        };
    },
    
    updateNav: () => {
       // Helper to re-render nav if needed, usually handled by router
    },

    renderDashboard: async (container) => {
        container.innerHTML = '<div class="text-center mt-5">Loading dashboard...</div>';
        try {
            const res = await fetch('/api/dashboard', {
                headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
            });
            if (!res.ok) throw new Error('Failed to load');
            const data = await res.json();
            
            const tmpl = document.getElementById('dashboard-template').content.cloneNode(true);
            container.innerHTML = '';
            container.appendChild(tmpl);

            document.getElementById('d-username').textContent = App.user.username;
            document.getElementById('d-ram').textContent = data.stats.totalRam;
            document.getElementById('d-storage').textContent = (data.stats.totalStorage / 1024 / 1024).toFixed(2);
            document.getElementById('d-slots').textContent = data.stats.slotsUsed;

            document.getElementById('create-server-form').onsubmit = async (e) => {
                e.preventDefault();
                const payload = {
                    name: document.getElementById('c-name').value,
                    ram: document.getElementById('c-ram').value,
                    diskSize: document.getElementById('c-disk').value,
                    description: document.getElementById('c-desc').value
                };
                
                const r = await fetch('/api/server/create', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${localStorage.getItem('token')}`
                    },
                    body: JSON.stringify(payload)
                });
                const d = await r.json();
                if (d.success) {
                    App.renderDashboard(container);
                } else {
                    const err = document.getElementById('create-error');
                    err.textContent = d.error;
                    err.classList.remove('hidden');
                }
            };

            const list = document.getElementById('server-list');
            data.servers.forEach(s => {
                const item = document.createElement('div');
                item.className = 'server-item';
                item.onclick = () => App.navigate(`/server/${s.id}/console`);
                item.innerHTML = `
                    <div>
                        <h5 class="mb-0" style="font-size: 1.1rem;">${s.name}</h5>
                        <small class="text-muted" style="display:block; margin-top:4px;">${s.description || 'No description'} • ${s.ram}MB RAM</small>
                    </div>
                    <div style="margin-top: 1rem; display: flex; justify-content: space-between; align-items: center;">
                         <span class="badge ${s.isRunning ? 'running' : 'stopped'}">${s.isRunning ? 'RUNNING' : 'STOPPED'}</span>
                         <div class="d-flex gap-2">
                             <button class="btn btn-sm btn-secondary" onclick="event.stopPropagation(); App.navigate('/server/${s.id}/files')">Files</button>
                             <button class="btn btn-sm btn-danger del-btn" onclick="event.stopPropagation()">Delete</button>
                         </div>
                    </div>
                `;
                item.querySelector('.del-btn').onclick = async (e) => {
                    e.stopPropagation();
                    if(!confirm(`Delete server ${s.name}?`)) return;
                    await fetch(`/api/server/${s.id}`, {
                        method: 'DELETE',
                        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
                    });
                    App.renderDashboard(container);
                };
                list.appendChild(item);
            });
        } catch (err) {
            console.error(err);
            container.innerHTML = '<div class="alert alert-danger">Error loading dashboard</div>';
        }
    },

    renderServerLayout: async (container, id, view) => {
        container.innerHTML = '<div class="text-center mt-5">Loading server...</div>';
        const res = await fetch(`/api/server/${id}`, {
            headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
        });
        if (res.status !== 200) {
            container.innerHTML = '<div class="alert alert-danger">Server not found or access denied</div>';
            return;
        }
        const data = await res.json();
        const server = data.server;
        const isRunning = data.isRunning;

        App.currentServerId = id;
        const tmpl = document.getElementById('server-layout-template').content.cloneNode(true);
        container.innerHTML = '';
        container.appendChild(tmpl);

        document.getElementById('s-name').textContent = server.name;
        document.getElementById('s-id').textContent = `ID: ${server.id}`;
        
        const statusBadge = document.getElementById('s-status-badge');
        const btnStart = document.getElementById('btn-start');
        const btnStop = document.getElementById('btn-stop');

        const updateStatus = (running) => {
            statusBadge.textContent = running ? 'RUNNING' : 'STOPPED';
            statusBadge.className = `badge ${running ? 'running' : 'stopped'}`;
            btnStart.disabled = running;
            btnStop.disabled = !running;
        };
        updateStatus(isRunning);

        btnStart.onclick = async () => {
            btnStart.disabled = true;
            await fetch(`/api/server/${id}/start`, { 
                method: 'POST',
                headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
            });
            updateStatus(true); 
        };
        btnStop.onclick = async () => {
            btnStop.disabled = true;
            await fetch(`/api/server/${id}/stop`, { 
                method: 'POST',
                headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
            });
            updateStatus(false);
        };

        const contentDiv = document.getElementById('server-content');
        if (view === 'console') {
            App.renderServerConsole(contentDiv, id, isRunning, updateStatus);
        } else if (view === 'files') {
            App.renderServerFiles(contentDiv, id);
        }
    },

    renderServerConsole: (container, id, isInitiallyRunning, statusCallback) => {
        const tmpl = document.getElementById('server-console-template').content.cloneNode(true);
        container.innerHTML = '';
        container.appendChild(tmpl);

        App.cleanupTerminal();

        App.term = new Terminal({ 
            cursorBlink: true,
            convertEol: true,
            theme: {
                background: '#0a0a0a',
                foreground: '#ededed',
                cursor: '#3b82f6'
            },
            fontFamily: 'Menlo, Monaco, "Courier New", monospace',
            fontSize: 14
        });
        App.fitAddon = new FitAddon.FitAddon();
        App.term.loadAddon(App.fitAddon);
        App.term.open(document.getElementById('terminal'));
        App.fitAddon.fit();
        
        const resizeHandler = () => App.fitAddon.fit();
        window.addEventListener('resize', resizeHandler);
        
        App.socket = io({
            auth: { token: localStorage.getItem('token') }
        });
        App.socket.emit('join-server', id);
        
        App.term.onData(d => App.socket.emit('input', { serverId: id, data: d }));
        App.socket.on('term-data', d => App.term.write(d));
        App.socket.on('vm-status', s => statusCallback(s === 'started'));
        
        App.socket.on('connect_error', (err) => {
             App.term.write('\r\n\x1b[31mConnection error: ' + err.message + '\x1b[0m\r\n');
        });
    },

    renderServerFiles: (container, id) => {
        const tmpl = document.getElementById('server-files-template').content.cloneNode(true);
        container.innerHTML = '';
        container.appendChild(tmpl);

        App.currentPath = '';
        const loadFiles = async (pathVal = '') => {
            App.currentPath = pathVal;
            const list = document.getElementById('file-list');
            list.innerHTML = '<tr><td colspan="3" class="text-center text-muted">Loading...</td></tr>';

            try {
                const r = await fetch(`/api/server/${id}/files?path=${encodeURIComponent(pathVal)}`, {
                    headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
                });
                const files = await r.json();
                
                const bc = document.getElementById('file-breadcrumb');
                bc.innerHTML = `<li class="breadcrumb-item"><a href="#" class="root-link">root</a></li>`;
                bc.querySelector('.root-link').onclick = (e) => { e.preventDefault(); loadFiles(''); };
    
                let acc = '';
                const parts = pathVal.split('/').filter(Boolean);
                parts.forEach((p, i) => {
                    acc += (i ? '/' : '') + p;
                    const li = document.createElement('li');
                    li.className = 'breadcrumb-item';
                    if (i === parts.length - 1) li.textContent = p;
                    else {
                        const a = document.createElement('a');
                        a.href = '#';
                        a.textContent = p;
                        const target = acc;
                        a.onclick = (e) => { e.preventDefault(); loadFiles(target); };
                        li.appendChild(a);
                    }
                    bc.appendChild(li);
                });
    
                list.innerHTML = '';
                
                if (pathVal) {
                    const tr = document.createElement('tr');
                    const parent = pathVal.split('/').slice(0, -1).join('/');
                    tr.innerHTML = `<td><a href="#" style="display:flex; align-items:center;"><span class="material-symbols-outlined icon-sm" style="margin-right:5px;">arrow_upward</span> ..</a></td><td>-</td><td>-</td>`;
                    tr.querySelector('a').onclick = (e) => { e.preventDefault(); loadFiles(parent); };
                    list.appendChild(tr);
                }
    
                if (files.length === 0) {
                    list.innerHTML += '<tr><td colspan="3" class="text-center text-muted">Empty directory</td></tr>';
                }
    
                files.forEach(f => {
                    const tr = document.createElement('tr');
                    const fullPath = pathVal ? `${pathVal}/${f.name}` : f.name;
                    
                    let icon = f.isDirectory ? 'folder' : 'draft';
                    let nameHtml = f.isDirectory 
                        ? `<a href="#" class="dir-link" style="display:flex; align-items:center;"><span class="material-symbols-outlined icon-sm" style="margin-right:5px;">${icon}</span> ${f.name}</a>` 
                        : `<span style="display:flex; align-items:center;"><span class="material-symbols-outlined icon-sm" style="margin-right:5px;">${icon}</span> ${f.name}</span>`;
                    
                    let sizeHtml = f.isDirectory ? '-' : (f.size < 1024 ? f.size + ' B' : (f.size/1024).toFixed(2) + ' KB');
                    
                    tr.innerHTML = `
                        <td>${nameHtml}</td>
                        <td>${sizeHtml}</td>
                        <td style="text-align:right">
                            <div class="d-flex gap-2" style="justify-content:flex-end">
                                ${!f.isDirectory ? `<button class="btn btn-sm btn-secondary edit-btn" title="Edit"><span class="material-symbols-outlined icon-sm">edit</span></button>` : ''}
                                ${!f.isDirectory ? `<button class="btn btn-sm btn-secondary dl-btn" title="Download"><span class="material-symbols-outlined icon-sm">download</span></button>` : ''}
                                <button class="btn btn-sm btn-secondary ren-btn" title="Rename"><span class="material-symbols-outlined icon-sm">edit_square</span></button>
                                <button class="btn btn-sm btn-danger del-btn" title="Delete"><span class="material-symbols-outlined icon-sm">delete</span></button>
                            </div>
                        </td>
                    `;

                    if(f.isDirectory) {
                        tr.querySelector('.dir-link').onclick = (e) => { e.preventDefault(); loadFiles(fullPath); };
                    } else {
                        tr.querySelector('.edit-btn').onclick = () => App.openEditor(id, fullPath);
                        tr.querySelector('.dl-btn').onclick = () => {
                             // For download, we can't easily add headers to window.open or simple link.
                             // We might need a temporary token in URL or a cookie, or use XHR/Blob download.
                             // Using XHR/Blob download:
                             App.downloadFile(id, fullPath);
                        };
                    }
    
                    tr.querySelector('.del-btn').onclick = async () => {
                        if(!confirm(`Delete ${f.name}?`)) return;
                        await fetch(`/api/server/${id}/file-action`, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'Authorization': `Bearer ${localStorage.getItem('token')}`
                            },
                            body: JSON.stringify({ action: 'delete', path: fullPath })
                        });
                        loadFiles(pathVal);
                    };
    
                    tr.querySelector('.ren-btn').onclick = async () => {
                        const newName = prompt('New name:', f.name);
                        if(!newName) return;
                        const newPath = pathVal ? `${pathVal}/${newName}` : newName;
                        await fetch(`/api/server/${id}/file-action`, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'Authorization': `Bearer ${localStorage.getItem('token')}`
                            },
                            body: JSON.stringify({ action: 'rename', path: fullPath, newPath })
                        });
                        loadFiles(pathVal);
                    };
    
                    list.appendChild(tr);
                });
            } catch (e) {
                console.error(e);
                list.innerHTML = '<tr><td colspan="3" class="text-center text-danger">Error loading files</td></tr>';
            }
        };

        loadFiles();
        document.getElementById('btn-refresh-files').onclick = () => loadFiles(App.currentPath);
        
        document.getElementById('btn-new-folder').onclick = async () => {
            const name = prompt('Folder name:');
            if(!name) return;
            await fetch(`/api/server/${id}/create-entry`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${localStorage.getItem('token')}`
                },
                body: JSON.stringify({ type: 'folder', name, path: App.currentPath })
            });
            loadFiles(App.currentPath);
        };

        document.getElementById('btn-new-file').onclick = async () => {
            const name = prompt('File name (e.g. script.js):');
            if(!name) return;
            await fetch(`/api/server/${id}/create-entry`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${localStorage.getItem('token')}`
                },
                body: JSON.stringify({ type: 'file', name, path: App.currentPath })
            });
            loadFiles(App.currentPath);
        };

        document.getElementById('file-upload').onchange = async (e) => {
            const file = e.target.files[0];
            if(!file) return;
            
            const btn = document.querySelector('button[onclick*="file-upload"]');
            const originalText = btn.textContent;
            btn.textContent = 'Uploading...';
            btn.disabled = true;

            const fd = new FormData();
            fd.append('file', file);
            fd.append('path', App.currentPath);
            
            try {
                const r = await fetch(`/api/server/${id}/upload`, { 
                    method: 'POST', 
                    body: fd,
                    headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
                });
                if(!r.ok) {
                    const d = await r.json();
                    alert('Upload failed: ' + d.error);
                }
                loadFiles(App.currentPath);
            } catch(err) {
                alert('Upload failed');
            } finally {
                btn.textContent = originalText;
                btn.disabled = false;
                e.target.value = '';
            }
        };
    },
    
    downloadFile: async (id, path) => {
        try {
            const res = await fetch(`/api/server/${id}/download?path=${encodeURIComponent(path)}`, {
                 headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
            });
            if (!res.ok) throw new Error('Download failed');
            const blob = await res.blob();
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = path.split('/').pop();
            document.body.appendChild(a);
            a.click();
            a.remove();
        } catch (e) {
            alert('Cannot download file');
        }
    },

    openEditor: async (id, fullPath) => {
        const r = await fetch(`/api/server/${id}/read-file?path=${encodeURIComponent(fullPath)}`, {
             headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
        });
        if (!r.ok) {
            const d = await r.json();
            return alert('Cannot edit file: ' + (d.error || 'Unknown error'));
        }
        const { content } = await r.json();

        const tmpl = document.getElementById('editor-template').content.cloneNode(true);
        document.body.appendChild(tmpl);

        const overlay = document.querySelector('.editor-overlay');
        const textarea = document.getElementById('code-editor');
        document.getElementById('editor-filename').textContent = fullPath;
        textarea.value = content;

        document.getElementById('btn-close-editor').onclick = () => {
            document.body.removeChild(overlay);
        };

        document.getElementById('btn-save-file').onclick = async () => {
            const btn = document.getElementById('btn-save-file');
            const originalText = btn.textContent;
            btn.textContent = 'Saving...';
            btn.disabled = true;

            try {
                await fetch(`/api/server/${id}/save-file`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${localStorage.getItem('token')}`
                    },
                    body: JSON.stringify({ path: fullPath, content: textarea.value })
                });
                btn.textContent = 'Saved!';
                setTimeout(() => { 
                    btn.textContent = originalText; 
                    btn.disabled = false; 
                }, 1000);
            } catch (e) {
                alert('Error saving file');
                btn.textContent = originalText;
                btn.disabled = false;
            }
        };
    },

    renderAdminDashboard: async (container) => {
        container.innerHTML = '<div class="text-center mt-5">Loading Admin Dashboard...</div>';
        const tmpl = document.getElementById('admin-dashboard-template').content.cloneNode(true);
        container.innerHTML = '';
        container.appendChild(tmpl);

        let currentPage = 1;
        
        const loadServers = async (page) => {
             try {
                const r = await fetch(`/api/admin/servers?page=${page}&limit=10`, {
                    headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
                });
                if (r.status === 403) return; 
                const data = await r.json();
                const tbody = document.getElementById('admin-server-list');
                tbody.innerHTML = '';
                
                data.servers.forEach(s => {
                    const tr = document.createElement('tr');
                    tr.innerHTML = `
                        <td><strong>${s.name}</strong> <br><small class="text-muted">${s.id}</small></td>
                        <td>${s.ownerName}</td>
                        <td><span class="badge ${s.isRunning ? 'running' : 'stopped'}">${s.isRunning ? 'RUNNING' : 'STOPPED'}</span></td>
                        <td>${s.ram} MB</td>
                        <td style="text-align:right">
                            <button class="btn btn-sm btn-accent manage-btn">Manage</button>
                            <button class="btn btn-sm btn-danger del-btn">Delete</button>
                        </td>
                    `;
                    tr.querySelector('.manage-btn').onclick = () => App.navigate(`/server/${s.id}/console`);
                    tr.querySelector('.del-btn').onclick = async () => {
                        if(!confirm(`Delete server ${s.name}?`)) return;
                        await fetch(`/api/server/${s.id}`, {
                            method: 'DELETE',
                            headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
                        });
                        loadServers(currentPage);
                    };
                    tbody.appendChild(tr);
                });

                document.getElementById('page-info').textContent = `Page ${data.page} of ${data.totalPages}`;
                document.getElementById('prev-page').disabled = data.page <= 1;
                document.getElementById('next-page').disabled = data.page >= data.totalPages;
                
                document.getElementById('prev-page').onclick = () => loadServers(data.page - 1);
                document.getElementById('next-page').onclick = () => loadServers(data.page + 1);
                currentPage = data.page;
             } catch (e) {
                 console.error(e);
             }
        };
        
        const loadUsers = async () => {
            try {
                const r = await fetch('/api/admin/users', {
                     headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
                });
                if (r.status === 403) return;
                const users = await r.json();
                const tbody = document.getElementById('admin-user-list');
                tbody.innerHTML = '';
                users.forEach(u => {
                    const tr = document.createElement('tr');
                    tr.innerHTML = `<td>${u.username}</td><td>${u.role}</td><td>${new Date(u.created_at).toLocaleDateString()}</td>`;
                    tbody.appendChild(tr);
                });
            } catch (e) { console.error(e); }
        };

        loadServers(1);
        loadUsers();
    }
};

document.addEventListener('DOMContentLoaded', App.init);
