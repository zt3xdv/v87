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
        createItem('Create', '/create', view === 'create', 'note_add');
        
        if (App.user.role === 'admin') {
             createItem('Admin', '/admin', view === 'admin', 'admin_panel_settings');
        }
        
        if (serverId) {
             createDivider();
             createHeader('Server Management');
             createItem('Console', `/server/${serverId}/console`, view === 'console', 'terminal');
             createItem('Files', `/server/${serverId}/files`, view === 'files', 'folder');
             createItem('Startup', `/server/${serverId}/startup`, view === 'startup', 'settings_power');
             createItem('Settings', `/server/${serverId}/settings`, view === 'settings', 'settings');
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

        const serverMatch = path.match(/^\/server\/([^\/]+)\/(console|files|startup|settings|creating)$/);

        // Check for admin routes
        const adminMatch = path.match(/^\/admin(?:\/(servers|users|config))?$/);

        if (path === '/dashboard') App.renderNav('dashboard');
        else if (adminMatch) App.renderNav('admin');
        else if (serverMatch) App.renderNav(serverMatch[2], serverMatch[1]);
        else App.renderNav('none');

        if (path === '/login') App.renderLogin(appDiv);
        else if (path === '/register') App.renderRegister(appDiv);
        else if (adminMatch) {
            if (!App.user) return App.navigate('/login');
            if (App.user.role !== 'admin') return App.navigate('/dashboard');
            const tab = adminMatch[1] || 'servers';
            App.renderAdminPanel(appDiv, tab);
        }
        else if (path === '/dashboard') {
            if (!App.user) return App.navigate('/login');
            App.renderDashboard(appDiv);
        }
        else if (path === '/create') {
            if (!App.user) return App.navigate('/login');
            App.renderCreate(appDiv);
        }
        else if (serverMatch) {
            if (!App.user) return App.navigate('/login');
            const [_, serverId, view] = serverMatch;
            if (view === 'creating') {
                App.renderServerCreating(appDiv, serverId);
            } else {
                App.renderServerLayout(appDiv, serverId, view);
            }
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

    renderServerCreating: async (container, serverId) => {
        const res = await fetch(`/api/server/${serverId}`, {
            headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
        });
        if (!res.ok) {
            container.innerHTML = '<div class="alert alert-danger">Server not found</div>';
            return;
        }
        const data = await res.json();
        
        const tmpl = document.getElementById('server-creating-template').content.cloneNode(true);
        container.innerHTML = '';
        container.appendChild(tmpl);
        
        document.getElementById('creating-name').textContent = data.server.name;
        
        const pollProgress = async () => {
            try {
                const r = await fetch(`/api/server/${serverId}/creation-progress`, {
                    headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
                });
                const progress = await r.json();
                
                document.getElementById('creating-progress').style.width = `${progress.percent}%`;
                document.getElementById('creating-percent').textContent = progress.percent;
                document.getElementById('creating-status').textContent = progress.status || 'Processing...';
                
                if (progress.complete) {
                    setTimeout(() => App.navigate(`/server/${serverId}/console`), 500);
                } else {
                    setTimeout(pollProgress, 500);
                }
            } catch (e) {
                setTimeout(pollProgress, 1000);
            }
        };
        
        pollProgress();
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
    
    renderCreate: async (container) => {
        container.innerHTML = '<div class="text-center mt-5">Loading create...</div>';
        try {
            const res = await fetch('/api/dashboard', {
                headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
            });
            if (!res.ok) throw new Error('Failed to load');
            const data = await res.json();
            
            const tmpl = document.getElementById('create-template').content.cloneNode(true);
            container.innerHTML = '';
            container.appendChild(tmpl);
            
            document.getElementById('d-ram').textContent = data.stats.totalRam;
            document.getElementById('d-max-ram').textContent = data.stats.maxRam;
            document.getElementById('d-storage').textContent = (data.stats.totalStorage / 1024 / 1024).toFixed(2);
            document.getElementById('d-max-storage').textContent = data.stats.maxStorage;
            document.getElementById('d-slots').textContent = data.stats.slotsUsed;
            document.getElementById('d-max-slots').textContent = data.stats.slotsMax;

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
                    if (d.creating) {
                        App.navigate(`/server/${d.server.id}/creating`);
                    } else {
                        App.navigate("/dashboard");
                    }
                } else {
                    const err = document.getElementById('create-error');
                    err.textContent = d.error;
                    err.classList.remove('hidden');
                }
            };
        } catch (err) {
            console.error(err);
            container.innerHTML = '<div class="alert alert-danger">Error loading create</div>';
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
            App.renderServerConsole(contentDiv, id, isRunning, updateStatus, server);
        } else if (view === 'files') {
            App.renderServerFiles(contentDiv, id);
        } else if (view === 'startup') {
            App.renderServerStartup(contentDiv, id, server);
        } else if (view === 'settings') {
            App.renderServerSettings(contentDiv, id, server);
        }
    },

    renderServerStartup: (container, id, server) => {
        const tmpl = document.getElementById('server-startup-template').content.cloneNode(true);
        container.innerHTML = '';
        container.appendChild(tmpl);

        const ramInput = document.getElementById('su-ram');
        const diskInput = document.getElementById('su-disk');
        
        ramInput.value = server.ram;
        diskInput.value = server.diskSize;

        document.getElementById('startup-form').onsubmit = async (e) => {
            e.preventDefault();
            const btn = e.target.querySelector('button');
            btn.disabled = true;
            
            try {
                const res = await fetch(`/api/server/${id}/startup`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${localStorage.getItem('token')}`
                    },
                    body: JSON.stringify({
                        ram: ramInput.value,
                        diskSize: diskInput.value
                    })
                });
                const data = await res.json();
                if (data.success) {
                    document.getElementById('startup-success').classList.remove('hidden');
                    document.getElementById('startup-error').classList.add('hidden');
                    setTimeout(() => document.getElementById('startup-success').classList.add('hidden'), 3000);
                } else {
                    document.getElementById('startup-error').textContent = data.error;
                    document.getElementById('startup-error').classList.remove('hidden');
                }
            } catch (err) {
                console.error(err);
                alert('Error saving settings');
            } finally {
                btn.disabled = false;
            }
        };
    },

    renderServerSettings: (container, id, server) => {
        const tmpl = document.getElementById('server-settings-template').content.cloneNode(true);
        container.innerHTML = '';
        container.appendChild(tmpl);

        const nameInput = document.getElementById('st-name');
        const descInput = document.getElementById('st-desc');
        
        nameInput.value = server.name;
        descInput.value = server.description || '';

        document.getElementById('settings-form').onsubmit = async (e) => {
            e.preventDefault();
            const btn = e.target.querySelector('button');
            btn.disabled = true;
            
            try {
                const res = await fetch(`/api/server/${id}/settings`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${localStorage.getItem('token')}`
                    },
                    body: JSON.stringify({
                        name: nameInput.value,
                        description: descInput.value
                    })
                });
                const data = await res.json();
                if (data.success) {
                    document.getElementById('settings-success').classList.remove('hidden');
                    // Update layout title if needed, but a reload/nav handles it
                    document.getElementById('s-name').textContent = nameInput.value;
                    setTimeout(() => document.getElementById('settings-success').classList.add('hidden'), 3000);
                } else {
                    alert('Error: ' + data.error);
                }
            } catch (err) {
                 console.error(err);
            } finally {
                btn.disabled = false;
            }
        };

        document.getElementById('btn-delete-server').onclick = async () => {
             if (!confirm(`Are you sure you want to delete ${server.name}? This action cannot be undone.`)) return;
             
             try {
                 const res = await fetch(`/api/server/${id}`, {
                    method: 'DELETE',
                    headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
                });
                const data = await res.json();
                if (data.success) {
                    App.navigate('/dashboard');
                } else {
                    alert('Error deleting server: ' + data.error);
                }
             } catch (err) {
                 alert('Error deleting server');
             }
        };
    },

    renderServerConsole: (container, id, isInitiallyRunning, statusCallback, server) => {
        const tmpl = document.getElementById('server-console-template').content.cloneNode(true);
        container.innerHTML = '';
        container.appendChild(tmpl);

        App.cleanupTerminal();

        // Initialize Charts
        const createChart = (ctx, label, color, max) => {
            return new Chart(ctx, {
                type: 'line',
                data: {
                    labels: Array(20).fill(''),
                    datasets: [{
                        label: label,
                        data: Array(20).fill(0),
                        borderColor: color,
                        tension: 0.4,
                        pointRadius: 0,
                        borderWidth: 2,
                        fill: true,
                        backgroundColor: color + '33'
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { display: false } },
                    scales: {
                        x: { display: false },
                        y: { beginAtZero: true, max: max, grid: { color: '#333' } }
                    },
                    animation: false
                }
            });
        };

        const cpuChart = createChart(document.getElementById('chart-cpu'), 'CPU (%)', '#8b5cf6', 100);
        const ramChart = createChart(document.getElementById('chart-ram'), 'RAM (MB)', '#3b82f6', server.ram);
        const netChart = createChart(document.getElementById('chart-net'), 'Net (KB/s)', '#10b981');
        const diskChart = createChart(document.getElementById('chart-disk'), 'Disk (MB)', '#f59e0b', server.diskSize);

        // Initial Disk State
        if (server.diskUsed) {
             document.getElementById('stat-disk').textContent = `${(server.diskUsed / 1024 / 1024).toFixed(2)} / ${server.diskSize} MB`;
             // Fill disk chart with current value
             diskChart.data.datasets[0].data.fill((server.diskUsed / 1024 / 1024).toFixed(2));
             diskChart.update();
        } else {
             document.getElementById('stat-disk').textContent = `? / ${server.diskSize} MB`;
        }

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
        App.socket.on('vm-status', s => {
            const running = s === 'started';
            statusCallback(running);
            if (!running) {
                document.getElementById('stat-cpu').textContent = 'OFFLINE';
                document.getElementById('stat-ram').textContent = 'OFFLINE';
                document.getElementById('stat-net').textContent = 'OFFLINE';
            }
        });
        
        let lastRx = 0;
        let lastTx = 0;

        App.socket.on('stats', (stats) => {
             // Update CPU
             const cpuPercent = stats.cpu || 0;
             document.getElementById('stat-cpu').textContent = `${cpuPercent}%`;
             cpuChart.data.datasets[0].data.shift();
             cpuChart.data.datasets[0].data.push(cpuPercent);
             cpuChart.update();
             
             // Update RAM
             document.getElementById('stat-ram').textContent = `${stats.ram} / ${server.ram} MB`;
             
             // Disk
             if (stats.disk) {
                 const diskMB = (stats.disk / 1024 / 1024).toFixed(2);
                 document.getElementById('stat-disk').textContent = `${diskMB} / ${server.diskSize} MB`;
                 
                 // Update Disk Chart
                 diskChart.data.datasets[0].data.shift();
                 diskChart.data.datasets[0].data.push(diskMB);
                 diskChart.update();
             }
             
             // Net
             const rxDiff = stats.netRx - lastRx;
             const txDiff = stats.netTx - lastTx;
             
             // Handle initial large jump or reset
             if (lastRx === 0 && stats.netRx > 0) { lastRx = stats.netRx; lastTx = stats.netTx; return; }
             
             lastRx = stats.netRx;
             lastTx = stats.netTx;
             
             const speed = ((rxDiff + txDiff) / 1024).toFixed(1); // KB/s roughly (assuming 1s interval)
             document.getElementById('stat-net').textContent = `RX: ${(rxDiff/1024).toFixed(1)} KB/s | TX: ${(txDiff/1024).toFixed(1)} KB/s`;
             
             // Update Charts
             ramChart.data.datasets[0].data.shift();
             ramChart.data.datasets[0].data.push(stats.ram);
             ramChart.update();

             netChart.data.datasets[0].data.shift();
             netChart.data.datasets[0].data.push(speed);
             // Dynamic scale for net
             if (speed > netChart.options.scales.y.max || netChart.options.scales.y.max === undefined) {
                  netChart.options.scales.y.max = Math.ceil(speed * 1.2);
             }
             netChart.update();
        });

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

    monacoEditor: null,
    monacoLoaded: false,
    
    loadMonaco: () => {
        return new Promise((resolve) => {
            if (App.monacoLoaded) {
                resolve();
                return;
            }
            
            if (typeof require !== 'undefined' && typeof require.config === 'function') {
                resolve();
                App.monacoLoaded = true;
                return;
            }
            
            const script = document.createElement('script');
            script.src = '/js/monaco/vs/loader.js';
            script.onload = () => {
                require.config({ paths: { vs: '/js/monaco/vs' } });
                App.monacoLoaded = true;
                resolve();
            };
            document.head.appendChild(script);
        });
    },
    
    getLanguageFromPath: (filePath) => {
        const ext = filePath.split('.').pop().toLowerCase();
        const langMap = {
            'js': 'javascript', 'jsx': 'javascript',
            'ts': 'typescript', 'tsx': 'typescript',
            'json': 'json',
            'html': 'html', 'htm': 'html',
            'css': 'css', 'scss': 'scss', 'less': 'less',
            'md': 'markdown',
            'py': 'python',
            'rb': 'ruby',
            'php': 'php',
            'java': 'java',
            'c': 'c', 'h': 'c',
            'cpp': 'cpp', 'hpp': 'cpp', 'cc': 'cpp',
            'go': 'go',
            'rs': 'rust',
            'sh': 'shell', 'bash': 'shell',
            'yaml': 'yaml', 'yml': 'yaml',
            'xml': 'xml',
            'sql': 'sql',
            'dockerfile': 'dockerfile',
            'makefile': 'makefile'
        };
        return langMap[ext] || 'plaintext';
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
        document.getElementById('editor-filename').textContent = fullPath;

        await App.loadMonaco();
        
        require(['vs/editor/editor.main'], function() {
            App.monacoEditor = monaco.editor.create(document.getElementById('monaco-editor'), {
                value: content,
                language: App.getLanguageFromPath(fullPath),
                theme: 'vs-dark',
                automaticLayout: true,
                minimap: { enabled: true },
                fontSize: 14,
                fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, monospace",
                scrollBeyondLastLine: false,
                wordWrap: 'on',
                tabSize: 4
            });
            
            App.monacoEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
                document.getElementById('btn-save-file').click();
            });
        });

        document.getElementById('btn-close-editor').onclick = () => {
            if (App.monacoEditor) {
                App.monacoEditor.dispose();
                App.monacoEditor = null;
            }
            document.body.removeChild(overlay);
        };

        document.getElementById('btn-save-file').onclick = async () => {
            const btn = document.getElementById('btn-save-file');
            const originalHTML = btn.innerHTML;
            btn.innerHTML = '<span class="material-symbols-outlined icon-sm">hourglass_empty</span> Saving...';
            btn.disabled = true;

            try {
                const editorContent = App.monacoEditor ? App.monacoEditor.getValue() : '';
                await fetch(`/api/server/${id}/save-file`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${localStorage.getItem('token')}`
                    },
                    body: JSON.stringify({ path: fullPath, content: editorContent })
                });
                btn.innerHTML = '<span class="material-symbols-outlined icon-sm">check</span> Saved!';
                setTimeout(() => { 
                    btn.innerHTML = originalHTML; 
                    btn.disabled = false; 
                }, 1000);
            } catch (e) {
                alert('Error saving file');
                btn.innerHTML = originalHTML;
                btn.disabled = false;
            }
        };
    },

    // =====================
    // ADMIN PANEL
    // =====================
    
    renderAdminPanel: async (container, tab) => {
        container.innerHTML = '<div class="text-center mt-5">Loading Admin Panel...</div>';
        
        const tmpl = document.getElementById('admin-layout-template').content.cloneNode(true);
        container.innerHTML = '';
        container.appendChild(tmpl);
        
        // Load stats
        try {
            const r = await fetch('/api/admin/stats', {
                headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
            });
            const stats = await r.json();
            document.getElementById('stat-users').textContent = stats.totalUsers;
            document.getElementById('stat-servers').textContent = stats.totalServers;
            document.getElementById('stat-running').textContent = stats.runningServers;
            document.getElementById('stat-ram').textContent = stats.totalRam + ' MB';
        } catch (e) { console.error(e); }
        
        // Setup tabs
        const tabs = ['servers', 'users', 'config'];
        tabs.forEach(t => {
            const btn = document.getElementById(`admin-tab-${t}`);
            if (btn) {
                btn.onclick = () => App.navigate(`/admin/${t}`);
                if (t === tab) btn.classList.add('active');
            }
        });
        
        const contentDiv = document.getElementById('admin-content');
        
        if (tab === 'servers') App.renderAdminServers(contentDiv);
        else if (tab === 'users') App.renderAdminUsers(contentDiv);
        else if (tab === 'config') App.renderAdminConfig(contentDiv);
    },
    
    renderAdminServers: (container) => {
        const tmpl = document.getElementById('admin-servers-template').content.cloneNode(true);
        container.innerHTML = '';
        container.appendChild(tmpl);
        
        let currentPage = 1;
        let searchTerm = '';
        
        const loadServers = async (page) => {
            try {
                const url = `/api/admin/servers?page=${page}&limit=10${searchTerm ? `&search=${encodeURIComponent(searchTerm)}` : ''}`;
                const r = await fetch(url, {
                    headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
                });
                if (r.status === 403) return;
                const data = await r.json();
                const tbody = document.getElementById('admin-server-list');
                tbody.innerHTML = '';
                
                if (data.servers.length === 0) {
                    tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted">No servers found</td></tr>';
                    return;
                }
                
                data.servers.forEach(s => {
                    const tr = document.createElement('tr');
                    let statusBadge = s.suspended 
                        ? '<span class="badge suspended">SUSPENDED</span>'
                        : `<span class="badge ${s.isRunning ? 'running' : 'stopped'}">${s.isRunning ? 'RUNNING' : 'STOPPED'}</span>`;
                    
                    tr.innerHTML = `
                        <td>
                            <strong>${s.name}</strong>
                            <br><small class="text-muted">${s.id}</small>
                        </td>
                        <td>${s.ownerName}</td>
                        <td>${statusBadge}</td>
                        <td>${s.ram} MB</td>
                        <td style="text-align:right">
                            <button class="btn btn-sm btn-secondary edit-btn" title="Edit">
                                <span class="material-symbols-outlined icon-sm">edit</span>
                            </button>
                            <button class="btn btn-sm btn-accent manage-btn" title="Manage">
                                <span class="material-symbols-outlined icon-sm">terminal</span>
                            </button>
                        </td>
                    `;
                    tr.querySelector('.edit-btn').onclick = () => App.openServerEditModal(s, () => loadServers(currentPage));
                    tr.querySelector('.manage-btn').onclick = () => App.navigate(`/server/${s.id}/console`);
                    tbody.appendChild(tr);
                });
                
                document.getElementById('page-info').textContent = `Page ${data.page} of ${data.totalPages || 1}`;
                document.getElementById('prev-page').disabled = data.page <= 1;
                document.getElementById('next-page').disabled = data.page >= data.totalPages;
                
                document.getElementById('prev-page').onclick = () => loadServers(data.page - 1);
                document.getElementById('next-page').onclick = () => loadServers(data.page + 1);
                currentPage = data.page;
            } catch (e) { console.error(e); }
        };
        
        // Search handler
        let searchTimeout;
        document.getElementById('server-search').addEventListener('input', (e) => {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(() => {
                searchTerm = e.target.value;
                loadServers(1);
            }, 300);
        });
        
        loadServers(1);
    },
    
    renderAdminUsers: (container) => {
        const tmpl = document.getElementById('admin-users-template').content.cloneNode(true);
        container.innerHTML = '';
        container.appendChild(tmpl);
        
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
                    let statusBadge = u.suspended 
                        ? '<span class="badge suspended">SUSPENDED</span>'
                        : '<span class="badge running">ACTIVE</span>';
                    let roleBadge = `<span class="badge ${u.role}">${u.role.toUpperCase()}</span>`;
                    
                    tr.innerHTML = `
                        <td>
                            <strong>${u.username}</strong>
                            <br><small class="text-muted">${u.id}</small>
                        </td>
                        <td>${roleBadge}</td>
                        <td>${u.serverCount}</td>
                        <td>${u.totalRam} MB</td>
                        <td>${statusBadge}</td>
                        <td style="text-align:right">
                            <button class="btn btn-sm btn-secondary edit-btn" title="Edit">
                                <span class="material-symbols-outlined icon-sm">edit</span>
                            </button>
                        </td>
                    `;
                    tr.querySelector('.edit-btn').onclick = () => App.openUserEditModal(u.id, loadUsers);
                    tbody.appendChild(tr);
                });
            } catch (e) { console.error(e); }
        };
        
        loadUsers();
    },
    
    renderAdminConfig: async (container) => {
        const tmpl = document.getElementById('admin-config-template').content.cloneNode(true);
        container.innerHTML = '';
        container.appendChild(tmpl);
        
        // Load current config
        try {
            const [configRes, statsRes] = await Promise.all([
                fetch('/api/admin/config', { headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` } }),
                fetch('/api/admin/stats', { headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` } })
            ]);
            
            const config = await configRes.json();
            const stats = await statsRes.json();
            
            document.getElementById('cfg-max-servers').value = config.limits?.maxServers || 3;
            document.getElementById('cfg-max-ram').value = config.limits?.maxRam || 1024;
            document.getElementById('cfg-max-storage').value = config.limits?.maxStorage || 1024;
            
            document.getElementById('cfg-port').textContent = config.port || 3000;
            document.getElementById('cfg-total-users').textContent = stats.totalUsers;
            document.getElementById('cfg-total-servers').textContent = stats.totalServers;
            document.getElementById('cfg-running').textContent = stats.runningServers;
        } catch (e) { console.error(e); }
        
        // Save config
        document.getElementById('config-form').onsubmit = async (e) => {
            e.preventDefault();
            const btn = e.target.querySelector('button[type="submit"]');
            btn.disabled = true;
            
            try {
                const r = await fetch('/api/admin/config', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${localStorage.getItem('token')}`
                    },
                    body: JSON.stringify({
                        limits: {
                            maxServers: parseInt(document.getElementById('cfg-max-servers').value),
                            maxRam: parseInt(document.getElementById('cfg-max-ram').value),
                            maxStorage: parseInt(document.getElementById('cfg-max-storage').value)
                        }
                    })
                });
                
                if (r.ok) {
                    document.getElementById('config-success').classList.remove('hidden');
                    setTimeout(() => document.getElementById('config-success').classList.add('hidden'), 3000);
                }
            } catch (e) { console.error(e); }
            
            btn.disabled = false;
        };
    },
    
    openUserEditModal: async (userId, onSave) => {
        // Fetch user data
        const r = await fetch(`/api/admin/user/${userId}`, {
            headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
        });
        if (!r.ok) return alert('Failed to load user');
        const user = await r.json();
        
        const tmpl = document.getElementById('user-edit-template').content.cloneNode(true);
        document.body.appendChild(tmpl);
        
        const overlay = document.querySelector('.editor-overlay');
        
        document.getElementById('edit-user-title').textContent = `Edit: ${user.username}`;
        document.getElementById('edit-role').value = user.role;
        document.getElementById('edit-suspended').checked = user.suspended;
        document.getElementById('edit-suspend-reason').value = user.suspendReason || '';
        
        if (user.limits) {
            document.getElementById('edit-limit-servers').value = user.limits.maxServers || '';
            document.getElementById('edit-limit-ram').value = user.limits.maxRam || '';
            document.getElementById('edit-limit-storage').value = user.limits.maxStorage || '';
        }
        
        // Show user servers
        const serversList = document.getElementById('user-servers-list');
        if (user.servers && user.servers.length > 0) {
            serversList.innerHTML = user.servers.map(s => `
                <div style="padding: 0.5rem; background: var(--bg-app); border-radius: 6px; margin-bottom: 0.5rem;">
                    <strong>${s.name}</strong> - ${s.ram} MB
                    <span class="badge ${s.suspended ? 'suspended' : (s.isRunning ? 'running' : 'stopped')}" style="margin-left: 0.5rem;">
                        ${s.suspended ? 'SUSPENDED' : (s.isRunning ? 'RUNNING' : 'STOPPED')}
                    </span>
                </div>
            `).join('');
        } else {
            serversList.textContent = 'No servers';
        }
        
        // Close button
        document.getElementById('btn-close-user-edit').onclick = () => overlay.remove();
        
        // Delete button
        document.getElementById('btn-delete-user').onclick = async () => {
            if (!confirm(`Delete user ${user.username}? This will delete all their servers!`)) return;
            
            const dr = await fetch(`/api/admin/user/${userId}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
            });
            
            if (dr.ok) {
                overlay.remove();
                onSave();
            } else {
                const data = await dr.json();
                alert('Error: ' + data.error);
            }
        };
        
        // Save form
        document.getElementById('user-edit-form').onsubmit = async (e) => {
            e.preventDefault();
            
            const limits = {};
            const maxServers = document.getElementById('edit-limit-servers').value;
            const maxRam = document.getElementById('edit-limit-ram').value;
            const maxStorage = document.getElementById('edit-limit-storage').value;
            
            if (maxServers) limits.maxServers = parseInt(maxServers);
            if (maxRam) limits.maxRam = parseInt(maxRam);
            if (maxStorage) limits.maxStorage = parseInt(maxStorage);
            
            const payload = {
                role: document.getElementById('edit-role').value,
                suspended: document.getElementById('edit-suspended').checked,
                suspendReason: document.getElementById('edit-suspend-reason').value,
                limits: Object.keys(limits).length > 0 ? limits : null
            };
            
            const sr = await fetch(`/api/admin/user/${userId}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${localStorage.getItem('token')}`
                },
                body: JSON.stringify(payload)
            });
            
            if (sr.ok) {
                document.getElementById('user-edit-success').classList.remove('hidden');
                setTimeout(() => {
                    overlay.remove();
                    onSave();
                }, 500);
            } else {
                const data = await sr.json();
                document.getElementById('user-edit-error').textContent = data.error;
                document.getElementById('user-edit-error').classList.remove('hidden');
            }
        };
    },
    
    openServerEditModal: async (server, onSave) => {
        const tmpl = document.getElementById('server-edit-template').content.cloneNode(true);
        document.body.appendChild(tmpl);
        
        const overlay = document.querySelector('.editor-overlay');
        
        document.getElementById('edit-server-title').textContent = `Edit: ${server.name}`;
        document.getElementById('edit-server-name').value = server.name;
        document.getElementById('edit-server-desc').value = server.description || '';
        document.getElementById('edit-server-ram').value = server.ram;
        document.getElementById('edit-server-disk').value = server.diskSize;
        document.getElementById('edit-server-suspended').checked = server.suspended || false;
        document.getElementById('edit-server-suspend-reason').value = server.suspendReason || '';
        
        // Close button
        document.getElementById('btn-close-server-edit').onclick = () => overlay.remove();
        
        // Force stop button
        document.getElementById('btn-force-stop').onclick = async () => {
            if (!confirm('Force stop this server?')) return;
            
            await fetch(`/api/admin/server/${server.id}/force-stop`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
            });
            
            overlay.remove();
            onSave();
        };
        
        // Delete button
        document.getElementById('btn-delete-server-admin').onclick = async () => {
            if (!confirm(`Delete server ${server.name}? This cannot be undone!`)) return;
            
            const dr = await fetch(`/api/admin/server/${server.id}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
            });
            
            if (dr.ok) {
                overlay.remove();
                onSave();
            } else {
                const data = await dr.json();
                alert('Error: ' + data.error);
            }
        };
        
        // Save form
        document.getElementById('server-edit-form').onsubmit = async (e) => {
            e.preventDefault();
            
            const suspended = document.getElementById('edit-server-suspended').checked;
            const suspendReason = document.getElementById('edit-server-suspend-reason').value;
            
            // First update server info
            const payload = {
                name: document.getElementById('edit-server-name').value,
                description: document.getElementById('edit-server-desc').value,
                ram: parseInt(document.getElementById('edit-server-ram').value),
                diskSize: parseInt(document.getElementById('edit-server-disk').value)
            };
            
            await fetch(`/api/admin/server/${server.id}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${localStorage.getItem('token')}`
                },
                body: JSON.stringify(payload)
            });
            
            // Then update suspension status
            await fetch(`/api/admin/server/${server.id}/suspend`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${localStorage.getItem('token')}`
                },
                body: JSON.stringify({ suspended, reason: suspendReason })
            });
            
            document.getElementById('server-edit-success').classList.remove('hidden');
            setTimeout(() => {
                overlay.remove();
                onSave();
            }, 500);
        };
    }
};

document.addEventListener('DOMContentLoaded', App.init);
