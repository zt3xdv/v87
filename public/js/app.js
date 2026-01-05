const Dialog = {
    container: null,
    
    init() {
        if (this.container) return;
        this.container = document.createElement('div');
        this.container.id = 'dialog-container';
        document.body.appendChild(this.container);
    },
    
    _create(type, title, message, options = {}) {
        this.init();
        
        return new Promise((resolve) => {
            const icons = {
                alert: { icon: 'info', class: 'info' },
                success: { icon: 'check_circle', class: 'success' },
                warning: { icon: 'warning', class: 'warning' },
                confirm: { icon: 'help', class: 'warning' },
                prompt: { icon: 'edit', class: 'prompt' }
            };
            
            const iconData = icons[type] || icons.alert;
            const isPrompt = type === 'prompt';
            const isConfirm = type === 'confirm';
            const isDanger = options.danger;
            
            const overlay = document.createElement('div');
            overlay.className = 'dialog-overlay';
            overlay.innerHTML = `
                <div class="dialog-box">
                    <div class="dialog-header">
                        <div class="dialog-icon ${iconData.class}">
                            <span class="material-symbols-outlined">${iconData.icon}</span>
                        </div>
                        <h3 class="dialog-title">${title}</h3>
                    </div>
                    <div class="dialog-body">
                        <p class="dialog-message">${message}</p>
                        ${isPrompt ? `<input type="text" class="dialog-input" value="${options.defaultValue || ''}" placeholder="${options.placeholder || ''}">` : ''}
                    </div>
                    <div class="dialog-footer">
                        ${(isConfirm || isPrompt) ? `<button class="dialog-btn dialog-btn-cancel">${options.cancelText || 'Cancel'}</button>` : ''}
                        <button class="dialog-btn ${isDanger ? 'dialog-btn-danger' : 'dialog-btn-confirm'}">${options.confirmText || 'OK'}</button>
                    </div>
                </div>
            `;
            
            this.container.appendChild(overlay);
            
            requestAnimationFrame(() => overlay.classList.add('active'));
            
            const input = overlay.querySelector('.dialog-input');
            const confirmBtn = overlay.querySelector('.dialog-btn-confirm, .dialog-btn-danger');
            const cancelBtn = overlay.querySelector('.dialog-btn-cancel');
            
            if (input) {
                input.focus();
                input.select();
            } else {
                confirmBtn.focus();
            }
            
            const close = (result) => {
                overlay.classList.remove('active');
                setTimeout(() => overlay.remove(), 200);
                resolve(result);
            };
            
            confirmBtn.onclick = () => {
                if (isPrompt) {
                    close(input.value);
                } else if (isConfirm) {
                    close(true);
                } else {
                    close(undefined);
                }
            };
            
            if (cancelBtn) {
                cancelBtn.onclick = () => close(isPrompt ? null : false);
            }
            
            overlay.onclick = (e) => {
                if (e.target === overlay && (isConfirm || isPrompt)) {
                    close(isPrompt ? null : false);
                }
            };
            
            if (input) {
                input.onkeydown = (e) => {
                    if (e.key === 'Enter') confirmBtn.click();
                    if (e.key === 'Escape') cancelBtn?.click();
                };
            }
            
            overlay.onkeydown = (e) => {
                if (e.key === 'Escape') {
                    if (isConfirm || isPrompt) {
                        close(isPrompt ? null : false);
                    } else {
                        close(undefined);
                    }
                }
            };
        });
    },
    
    alert(message, title = 'Notice', options = {}) {
        return this._create('alert', title, message, options);
    },
    
    success(message, title = 'Success', options = {}) {
        return this._create('success', title, message, options);
    },
    
    warning(message, title = 'Warning', options = {}) {
        return this._create('warning', title, message, options);
    },
    
    confirm(message, title = 'Confirm', options = {}) {
        return this._create('confirm', title, message, options);
    },
    
    prompt(message, title = 'Input', options = {}) {
        return this._create('prompt', title, message, options);
    }
};

const App = {
    user: null,
    currentServerId: null,
    term: null,
    socket: null,
    fitAddon: null,

    initTheme: () => {
        const saved = localStorage.getItem('theme') || 'dark';
        App.setTheme(saved);
    },

    setTheme: (theme) => {
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('theme', theme);
    },

    getTheme: () => {
        return localStorage.getItem('theme') || 'dark';
    },

    init: async () => {
        App.initTheme();
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
        createItem('Create VM', '/create', view === 'create', 'note_add');
        createItem('Account', '/account', view === 'account', 'account_circle');
        
        if (App.user.role === 'admin') {
             createItem('Admin', '/admin', view === 'admin', 'admin_panel_settings');
        }
        
        if (serverId) {
             createDivider();
             createHeader('VM Console');
             createItem('Console', `/server/${serverId}/console`, view === 'console', 'terminal');
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

        const serverMatch = path.match(/^\/server\/([^\/]+)\/(console|creating)$/);
        const adminMatch = path.match(/^\/admin(?:\/(servers|users|audit|maintenance|config))?$/);
        const accountMatch = path.match(/^\/account(?:\/(apikeys|webhooks|prefs|activity))?$/);

        if (path === '/dashboard') App.renderNav('dashboard');
        else if (adminMatch) App.renderNav('admin');
        else if (accountMatch) App.renderNav('account');
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
        else if (accountMatch) {
            if (!App.user) return App.navigate('/login');
            const tab = accountMatch[1] || 'apikeys';
            App.renderAccountPage(appDiv, tab);
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
                App.renderServerLayout(appDiv, serverId);
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
                    setTimeout(pollProgress, 1000);
                }
            } catch (e) {
                setTimeout(pollProgress, 2000);
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
                App.navigate('/dashboard');
            } else {
                const err = document.getElementById('reg-error');
                err.textContent = data.error;
                err.classList.remove('hidden');
            }
        };
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
            if (data.servers.length != 0) list.innerHTML = "";
            data.servers.forEach(s => {
                const item = document.createElement('div');
                item.className = 'server-item';
                item.onclick = () => App.navigate(`/server/${s.id}/console`);
                
                const statusClass = s.status === 'running' ? 'running' : (s.status === 'creating' ? 'creating' : 'stopped');
                const statusText = s.status === 'running' ? 'RUNNING' : (s.status === 'creating' ? 'CREATING...' : 'STOPPED');
                
                item.innerHTML = `
                    <div>
                        <h5 class="mb-0" style="font-size: 1.1rem;">${s.name}</h5>
                        <small class="text-muted" style="display:block; margin-top:4px;">${s.image || 'Unknown'} • ${s.ram}MB RAM • ${s.diskSize}</small>
                    </div>
                    <div style="margin-top: 1rem; display: flex; justify-content: space-between; align-items: center;">
                         <span class="badge ${statusClass}">${statusText}</span>
                         <button class="btn btn-sm btn-danger del-btn" onclick="event.stopPropagation()">Delete</button>
                    </div>
                `;
                item.querySelector('.del-btn').onclick = async (e) => {
                    e.stopPropagation();
                    if(!confirm(`Delete VM ${s.name}? This will delete all data!`)) return;
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
        container.innerHTML = '<div class="text-center mt-5">Loading...</div>';
        try {
            const [dashRes, imagesRes] = await Promise.all([
                fetch('/api/dashboard', {
                    headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
                }),
                fetch('/api/images', {
                    headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
                })
            ]);
            if (!dashRes.ok) throw new Error('Failed to load');
            const data = await dashRes.json();
            const imagesData = await imagesRes.json();
            
            const tmpl = document.getElementById('create-template').content.cloneNode(true);
            container.innerHTML = '';
            container.appendChild(tmpl);
            
            document.getElementById('d-ram').textContent = data.stats.totalRam;
            document.getElementById('d-max-ram').textContent = data.stats.maxRam;
            document.getElementById('d-cpu').textContent = data.stats.totalCpu;
            document.getElementById('d-max-cpu').textContent = data.stats.maxCpu;
            document.getElementById('d-disk').textContent = data.stats.totalDisk;
            document.getElementById('d-max-disk').textContent = data.stats.maxDisk;
            document.getElementById('d-slots').textContent = data.stats.slotsUsed;
            document.getElementById('d-max-slots').textContent = data.stats.slotsMax;

            const ramInput = document.getElementById('c-ram');
            const diskInput = document.getElementById('c-disk');
            const cpuInput = document.getElementById('c-cpu');
            const ioInput = document.getElementById('c-io');
            
            const availableRam = data.stats.availableRam || 0;
            const availableCpu = data.stats.availableCpu || 0;
            const availableDisk = data.stats.availableDisk || 0;
            
            ramInput.min = 1;
            ramInput.max = availableRam;
            ramInput.value = Math.min(data.defaults?.ram || 1024, availableRam);
            
            diskInput.min = 1;
            diskInput.max = availableDisk;
            diskInput.value = Math.min(data.defaults?.disk || 10, availableDisk);
            
            cpuInput.min = 1;
            cpuInput.max = availableCpu;
            cpuInput.value = Math.min(data.defaults?.cpu || 100, availableCpu);
            
            ioInput.max = data.stats.maxIo || 100;
            ioInput.value = data.defaults?.io || 0;

            const imageSelect = document.getElementById('c-image');
            imageSelect.innerHTML = '<option value="">Select a Linux distribution...</option>';
            if (imagesData.images && imagesData.images.length > 0) {
                imagesData.images.forEach(img => {
                    const opt = document.createElement('option');
                    opt.value = img.id;
                    opt.textContent = `${img.name} - ${img.description}`;
                    imageSelect.appendChild(opt);
                });
            }

            document.getElementById('create-server-form').onsubmit = async (e) => {
                e.preventDefault();
                const imageId = document.getElementById('c-image').value;
                if (!imageId) {
                    const err = document.getElementById('create-error');
                    err.textContent = 'Please select a Linux distribution';
                    err.classList.remove('hidden');
                    return;
                }
                
                const diskValue = parseInt(document.getElementById('c-disk').value) || 10;
                const payload = {
                    name: document.getElementById('c-name').value,
                    description: document.getElementById('c-desc').value,
                    imageId: imageId,
                    ram: parseInt(document.getElementById('c-ram').value) || 1024,
                    diskSize: `${diskValue}G`,
                    cpuLimit: parseInt(document.getElementById('c-cpu').value) || 100,
                    ioLimit: parseInt(document.getElementById('c-io').value) || 0
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
                    App.navigate(`/server/${d.server.id}/creating`);
                } else {
                    const err = document.getElementById('create-error');
                    err.textContent = d.error;
                    err.classList.remove('hidden');
                }
            };
        } catch (err) {
            console.error(err);
            container.innerHTML = '<div class="alert alert-danger">Error loading</div>';
        }
    },

    renderServerLayout: async (container, id) => {
        container.innerHTML = '<div class="text-center mt-5">Loading VM...</div>';
        const res = await fetch(`/api/server/${id}`, {
            headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
        });
        if (res.status !== 200) {
            container.innerHTML = '<div class="alert alert-danger">VM not found or access denied</div>';
            return;
        }
        const data = await res.json();
        const server = data.server;

        App.currentServerId = id;
        const tmpl = document.getElementById('server-layout-template').content.cloneNode(true);
        container.innerHTML = '';
        container.appendChild(tmpl);

        document.getElementById('s-name').textContent = server.name;
        document.getElementById('s-id').textContent = `ID: ${server.id}`;
        document.getElementById('s-image').textContent = data.image?.name || 'Unknown';
        
        // Show credentials if available
        if (data.credentials) {
            document.getElementById('s-credentials').innerHTML = `
                <strong>Login:</strong> ${data.credentials.user} / ${data.credentials.password}
            `;
            document.getElementById('s-credentials').classList.remove('hidden');
        }
        
        const statusBadge = document.getElementById('s-status-badge');
        const btnStart = document.getElementById('btn-start');
        const btnStop = document.getElementById('btn-stop');

        const updateStatus = (running) => {
            statusBadge.textContent = running ? 'RUNNING' : 'STOPPED';
            statusBadge.className = `badge ${running ? 'running' : 'stopped'}`;
            btnStart.disabled = running;
            btnStop.disabled = !running;
        };
        updateStatus(server.status === 'running');

        btnStart.onclick = async () => {
            btnStart.disabled = true;
            btnStart.textContent = 'Starting...';
            try {
                const r = await fetch(`/api/server/${id}/start`, { 
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
                });
                if (r.ok) {
                    updateStatus(true);
                } else {
                    const d = await r.json();
                    await Dialog.warning('Error: ' + d.error);
                    btnStart.disabled = false;
                }
            } catch (e) {
                await Dialog.warning('Error starting VM');
                btnStart.disabled = false;
            }
            btnStart.textContent = 'Start';
        };
        
        btnStop.onclick = async () => {
            btnStop.disabled = true;
            btnStop.textContent = 'Stopping...';
            await fetch(`/api/server/${id}/stop`, { 
                method: 'POST',
                headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
            });
            updateStatus(false);
            btnStop.textContent = 'Stop';
        };

        const tabConsole = document.getElementById('tab-console');
        const tabStats = document.getElementById('tab-stats');
        const tabSchedules = document.getElementById('tab-schedules');
        const tabSettings = document.getElementById('tab-settings');
        const serverContent = document.getElementById('server-content');
        
        let currentTab = 'console';
        let statsInterval = null;
        
        const renderCurrentTab = () => {
            tabConsole.className = `tab-btn ${currentTab === 'console' ? 'active' : ''}`;
            tabStats.className = `tab-btn ${currentTab === 'stats' ? 'active' : ''}`;
            tabSchedules.className = `tab-btn ${currentTab === 'schedules' ? 'active' : ''}`;
            tabSettings.className = `tab-btn ${currentTab === 'settings' ? 'active' : ''}`;
            
            if (statsInterval) {
                clearInterval(statsInterval);
                statsInterval = null;
            }
            
            if (currentTab === 'console') {
                App.renderServerConsole(serverContent, id, server.status === 'running', updateStatus, server);
            } else if (currentTab === 'stats') {
                App.cleanupTerminal();
                App.renderServerStats(serverContent, id, server, (interval) => { statsInterval = interval; });
            } else if (currentTab === 'schedules') {
                App.cleanupTerminal();
                App.renderServerSchedules(serverContent, id, server);
            } else {
                App.cleanupTerminal();
                App.renderServerSettings(serverContent, id, server, data, () => updateStatus(server.status === 'running'));
            }
        };
        
        tabConsole.onclick = () => {
            if (currentTab !== 'console') {
                currentTab = 'console';
                renderCurrentTab();
            }
        };
        
        tabStats.onclick = () => {
            if (currentTab !== 'stats') {
                currentTab = 'stats';
                renderCurrentTab();
            }
        };
        
        tabSchedules.onclick = () => {
            if (currentTab !== 'schedules') {
                currentTab = 'schedules';
                renderCurrentTab();
            }
        };
        
        tabSettings.onclick = () => {
            if (currentTab !== 'settings') {
                currentTab = 'settings';
                renderCurrentTab();
            }
        };
        
        renderCurrentTab();
    },
    
    renderServerStats: async (container, id, server, setInterval) => {
        const tmpl = document.getElementById('server-stats-template').content.cloneNode(true);
        container.innerHTML = '';
        container.appendChild(tmpl);
        
        const formatBytes = (bytes) => {
            if (!bytes || bytes === 0) return '0 B';
            const k = 1024;
            const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
        };
        
        const formatUptime = (seconds) => {
            const days = Math.floor(seconds / 86400);
            const hours = Math.floor((seconds % 86400) / 3600);
            const mins = Math.floor((seconds % 3600) / 60);
            const secs = seconds % 60;
            
            if (days > 0) return `${days}d ${hours}h ${mins}m`;
            if (hours > 0) return `${hours}h ${mins}m ${secs}s`;
            if (mins > 0) return `${mins}m ${secs}s`;
            return `${secs}s`;
        };
        
        const updateStats = async () => {
            try {
                const res = await fetch(`/api/server/${id}/stats`, {
                    headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
                });
                const stats = await res.json();
                
                if (!stats.running) {
                    document.getElementById('stats-offline').classList.remove('hidden');
                    document.getElementById('stats-content').style.opacity = '0.5';
                    return;
                }
                
                document.getElementById('stats-offline').classList.add('hidden');
                document.getElementById('stats-content').style.opacity = '1';
                
                document.getElementById('stat-uptime').textContent = formatUptime(stats.uptime || 0);
                document.getElementById('stat-cpu').textContent = stats.cpuUsage !== undefined ? `${stats.cpuUsage}%` : '-';
                
                if (stats.cpu) {
                    const active = stats.cpu.cpus.filter(c => !c.halted).length;
                    document.getElementById('stat-cpu-cores').textContent = `${active}/${stats.cpu.count} cores active`;
                }
                
                if (stats.memory) {
                    document.getElementById('stat-memory').textContent = `${stats.memory.actual} / ${stats.memory.configured} MB`;
                } else {
                    document.getElementById('stat-memory').textContent = `${stats.configuredRam || '-'} MB`;
                }
                
                if (stats.block && stats.block[0]) {
                    const disk = stats.block[0];
                    document.getElementById('stat-disk-read').textContent = formatBytes(disk.bytesRead);
                    document.getElementById('stat-disk-write').textContent = formatBytes(disk.bytesWritten);
                    document.getElementById('stat-disk-read-ops').textContent = disk.opsRead.toLocaleString();
                    document.getElementById('stat-disk-write-ops').textContent = disk.opsWritten.toLocaleString();
                }
                
                document.getElementById('stat-pid').textContent = stats.pid || '-';
                document.getElementById('stat-started').textContent = stats.startedAt ? new Date(stats.startedAt).toLocaleString() : '-';
                
            } catch (e) {
                console.error('Failed to fetch stats:', e);
            }
        };
        
        await updateStats();
        const interval = window.setInterval(updateStats, 2000);
        setInterval(interval);
    },
    
    renderServerSettings: async (container, id, server, data, refreshStatus) => {
        const tmpl = document.getElementById('server-settings-template').content.cloneNode(true);
        container.innerHTML = '';
        container.appendChild(tmpl);
        
        document.getElementById('set-name').value = server.name || '';
        document.getElementById('set-desc').value = server.description || '';
        
        const isRunning = server.status === 'running';
        if (isRunning) {
            document.getElementById('settings-running-warning').classList.remove('hidden');
        }
        
        try {
            const limitsRes = await fetch(`/api/server/${id}/limits`, {
                headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
            });
            if (limitsRes.ok) {
                const limits = await limitsRes.json();
                document.getElementById('set-ram').value = limits.ram || 1024;
                document.getElementById('set-cpu').value = limits.cpuLimit || 100;
                document.getElementById('set-io').value = limits.ioLimit || 0;
                document.getElementById('set-cores').value = limits.cpuCores || 1;
            }
        } catch {}
        
        document.getElementById('set-disk-size').textContent = server.diskSize || '-';
        
        try {
            const diskRes = await fetch(`/api/server/${id}/disk-info`, {
                headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
            });
            if (diskRes.ok) {
                const disk = await diskRes.json();
                document.getElementById('set-disk-virtual').textContent = disk.virtualSize || '-';
                document.getElementById('set-disk-actual').textContent = disk.actualSize || '-';
            }
        } catch {}
        
        document.getElementById('btn-save-info').onclick = async () => {
            const btn = document.getElementById('btn-save-info');
            btn.disabled = true;
            btn.textContent = 'Saving...';
            
            await fetch(`/api/server/${id}/settings`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${localStorage.getItem('token')}`
                },
                body: JSON.stringify({
                    name: document.getElementById('set-name').value,
                    description: document.getElementById('set-desc').value
                })
            });
            
            btn.innerHTML = '<span class="material-symbols-outlined icon-sm">check</span> Saved';
            setTimeout(() => {
                btn.innerHTML = '<span class="material-symbols-outlined icon-sm">save</span> Save Info';
                btn.disabled = false;
            }, 2000);
        };
        
        document.getElementById('btn-save-resources').onclick = async () => {
            if (isRunning) {
                document.getElementById('resources-status').textContent = 'Changes will apply after restart';
            }
            
            const btn = document.getElementById('btn-save-resources');
            btn.disabled = true;
            btn.textContent = 'Saving...';
            
            const res = await fetch(`/api/server/${id}/limits`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${localStorage.getItem('token')}`
                },
                body: JSON.stringify({
                    ram: parseInt(document.getElementById('set-ram').value),
                    cpuLimit: parseInt(document.getElementById('set-cpu').value),
                    ioLimit: parseInt(document.getElementById('set-io').value),
                    cpuCores: parseInt(document.getElementById('set-cores').value)
                })
            });
            
            const data = await res.json();
            if (data.requiresRestart) {
                document.getElementById('resources-status').textContent = 'Saved! Restart VM to apply.';
            } else {
                document.getElementById('resources-status').textContent = 'Saved!';
            }
            
            btn.innerHTML = '<span class="material-symbols-outlined icon-sm">check</span> Saved';
            setTimeout(() => {
                btn.innerHTML = '<span class="material-symbols-outlined icon-sm">save</span> Save Resources';
                btn.disabled = false;
            }, 2000);
        };
        
        document.getElementById('btn-reinstall').onclick = async () => {
            if (isRunning) {
                await Dialog.warning('Please stop the VM first');
                return;
            }
            const confirmed = await Dialog.confirm('Reinstall VM? This will delete all data on the disk!', 'Reinstall VM', { danger: true, confirmText: 'Reinstall' });
            if (!confirmed) return;
            
            const btn = document.getElementById('btn-reinstall');
            btn.disabled = true;
            btn.textContent = 'Reinstalling...';
            
            const res = await fetch(`/api/server/${id}/reinstall`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
            });
            
            if (res.ok) {
                App.navigate(`/server/${id}/creating`);
            } else {
                const data = await res.json();
                await Dialog.warning('Error: ' + data.error);
                btn.disabled = false;
                btn.innerHTML = '<span class="material-symbols-outlined icon-sm">refresh</span> Reinstall VM';
            }
        };
        
        document.getElementById('btn-delete-vm').onclick = async () => {
            if (isRunning) {
                await Dialog.warning('Please stop the VM first');
                return;
            }
            const confirmed = await Dialog.confirm(`Delete VM ${server.name}? This cannot be undone!`, 'Delete VM', { danger: true, confirmText: 'Delete' });
            if (!confirmed) return;
            
            await fetch(`/api/server/${id}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
            });
            
            App.navigate('/dashboard');
        };
        
        // Tags
        const tagsContainer = document.getElementById('tags-container');
        const renderTags = (tags) => {
            tagsContainer.innerHTML = (tags || []).map(t => `
                <span class="badge" style="padding: 0.25rem 0.5rem;">
                    ${t}
                    <span class="remove-tag" data-tag="${t}" style="cursor: pointer; margin-left: 4px;">&times;</span>
                </span>
            `).join('');
            
            tagsContainer.querySelectorAll('.remove-tag').forEach(btn => {
                btn.onclick = async () => {
                    const newTags = (server.tags || []).filter(t => t !== btn.dataset.tag);
                    await fetch(`/api/server/${id}/tags`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('token')}` },
                        body: JSON.stringify({ tags: newTags })
                    });
                    server.tags = newTags;
                    renderTags(newTags);
                };
            });
        };
        renderTags(server.tags);
        
        document.getElementById('btn-add-tag').onclick = async () => {
            const input = document.getElementById('new-tag-input');
            const tag = input.value.trim();
            if (!tag) return;
            
            const newTags = [...(server.tags || []), tag].slice(0, 10);
            await fetch(`/api/server/${id}/tags`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('token')}` },
                body: JSON.stringify({ tags: newTags })
            });
            server.tags = newTags;
            renderTags(newTags);
            input.value = '';
        };
        
        // Notes
        document.getElementById('vm-notes').value = server.notes || '';
        document.getElementById('btn-save-notes').onclick = async () => {
            const notes = document.getElementById('vm-notes').value;
            const btn = document.getElementById('btn-save-notes');
            btn.disabled = true;
            
            await fetch(`/api/server/${id}/notes`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('token')}` },
                body: JSON.stringify({ notes })
            });
            
            btn.innerHTML = '<span class="material-symbols-outlined icon-sm">check</span> Saved';
            setTimeout(() => {
                btn.innerHTML = '<span class="material-symbols-outlined icon-sm">save</span> Save Notes';
                btn.disabled = false;
            }, 2000);
        };
        
        // Alerts
        const loadAlerts = async () => {
            const res = await fetch('/api/alerts', {
                headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
            });
            const data = await res.json();
            const serverAlerts = (data.alerts || []).filter(a => a.serverId === id);
            const list = document.getElementById('alerts-list');
            
            if (serverAlerts.length > 0) {
                list.innerHTML = serverAlerts.map(a => `
                    <div class="d-flex justify-between align-center" style="padding: 0.5rem; background: var(--bg-app); border-radius: var(--radius-sm); margin-bottom: 0.5rem;">
                        <div>
                            <span class="badge ${a.triggered ? 'running' : ''}">${a.metric.toUpperCase()}</span>
                            <span class="text-sm ml-2">${a.comparison} ${a.threshold}%</span>
                            <span class="text-sm text-muted ml-2">→ ${a.action}</span>
                        </div>
                        <button class="btn btn-sm btn-danger btn-delete-alert" data-id="${a.id}">
                            <span class="material-symbols-outlined icon-sm">delete</span>
                        </button>
                    </div>
                `).join('');
                
                list.querySelectorAll('.btn-delete-alert').forEach(btn => {
                    btn.onclick = async () => {
                        await fetch(`/api/alerts/${btn.dataset.id}`, {
                            method: 'DELETE',
                            headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
                        });
                        loadAlerts();
                    };
                });
            } else {
                list.innerHTML = '<div class="text-muted text-sm">No alerts configured</div>';
            }
        };
        loadAlerts();
        
        document.getElementById('btn-add-alert').onclick = () => {
            document.getElementById('alert-form-container').classList.remove('hidden');
        };
        
        document.getElementById('btn-cancel-alert').onclick = () => {
            document.getElementById('alert-form-container').classList.add('hidden');
        };
        
        document.getElementById('btn-save-alert').onclick = async () => {
            const metric = document.getElementById('alert-metric').value;
            const comparison = document.getElementById('alert-comparison').value;
            const threshold = document.getElementById('alert-threshold').value;
            const action = document.getElementById('alert-action').value;
            
            await fetch('/api/alerts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('token')}` },
                body: JSON.stringify({ serverId: id, metric, comparison, threshold, action })
            });
            
            document.getElementById('alert-form-container').classList.add('hidden');
            loadAlerts();
        };
    },

    renderServerConsole: (container, id, isInitiallyRunning, statusCallback, server) => {
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
        
        window.addEventListener('resize', () => App.fitAddon.fit());
        
        App.socket = io({
            auth: { token: localStorage.getItem('token') },
            reconnection: true,
            reconnectionAttempts: Infinity,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            timeout: 20000
        });
        
        App.socket.on('connect', () => {
            App.socket.emit('join-server', id);
        });
        
        App.socket.emit('join-server', id);
        
        App.term.onData(d => App.socket.emit('input', { serverId: id, data: d }));
        App.socket.on('term-data', d => App.term.write(d));
        App.socket.on('vm-status', s => {
            const running = s === 'started';
            statusCallback(running);
        });

        App.socket.on('disconnect', (reason) => {
            if (reason === 'io server disconnect') {
                App.socket.connect();
            }
        });

        App.socket.on('connect_error', () => {});
    },

    // =====================
    // ADMIN PANEL
    // =====================
    
    renderAdminPanel: async (container, tab) => {
        container.innerHTML = '<div class="text-center mt-5">Loading Admin Panel...</div>';
        
        const tmpl = document.getElementById('admin-layout-template').content.cloneNode(true);
        container.innerHTML = '';
        container.appendChild(tmpl);
        
        const tabs = ['servers', 'users', 'audit', 'maintenance', 'config'];
        tabs.forEach(t => {
            const btn = document.getElementById(`tab-${t}`);
            btn.className = `tab-btn ${t === tab ? 'active' : ''}`;
            btn.onclick = () => App.navigate(`/admin/${t}`);
        });
        
        const content = document.getElementById('admin-content');
        
        if (tab === 'servers') {
            await App.renderAdminServers(content);
        } else if (tab === 'users') {
            await App.renderAdminUsers(content);
        } else if (tab === 'audit') {
            await App.renderAdminAudit(content);
        } else if (tab === 'maintenance') {
            await App.renderAdminMaintenance(content);
        } else if (tab === 'config') {
            await App.renderAdminConfig(content);
        }
    },
    
    renderAdminServers: async (container) => {
        const tmpl = document.getElementById('admin-servers-template').content.cloneNode(true);
        container.innerHTML = '';
        container.appendChild(tmpl);
        
        let currentPage = 1;
        let searchQuery = '';
        
        const loadServers = async () => {
            const tbody = document.getElementById('admin-servers-list');
            tbody.innerHTML = '<tr><td colspan="5" class="text-center">Loading...</td></tr>';
            
            try {
                const r = await fetch(`/api/admin/servers?page=${currentPage}&limit=10&search=${encodeURIComponent(searchQuery)}`, {
                    headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
                });
                const data = await r.json();
                
                tbody.innerHTML = '';
                data.servers.forEach(s => {
                    const tr = document.createElement('tr');
                    tr.innerHTML = `
                        <td>${s.name}</td>
                        <td>${s.ownerName}</td>
                        <td>${s.imageName}</td>
                        <td><span class="badge ${s.status === 'running' ? 'running' : 'stopped'}">${s.status.toUpperCase()}</span></td>
                        <td style="text-align:right">
                            <button class="btn btn-sm btn-secondary edit-btn">Edit</button>
                        </td>
                    `;
                    tr.querySelector('.edit-btn').onclick = () => App.openServerEditModal(s, loadServers);
                    tbody.appendChild(tr);
                });
                
                if (data.servers.length === 0) {
                    tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted">No servers found</td></tr>';
                }
                
                document.getElementById('admin-servers-pagination').innerHTML = `
                    Page ${data.page} of ${data.totalPages} (${data.total} total)
                `;
            } catch (e) {
                console.error(e);
                tbody.innerHTML = '<tr><td colspan="5" class="text-center text-danger">Error loading servers</td></tr>';
            }
        };
        
        document.getElementById('admin-server-search').oninput = (e) => {
            searchQuery = e.target.value;
            currentPage = 1;
            loadServers();
        };
        
        loadServers();
    },
    
    renderAdminUsers: async (container) => {
        const tmpl = document.getElementById('admin-users-template').content.cloneNode(true);
        container.innerHTML = '';
        container.appendChild(tmpl);
        
        const loadUsers = async () => {
            const tbody = document.getElementById('admin-users-list');
            tbody.innerHTML = '<tr><td colspan="5" class="text-center">Loading...</td></tr>';
            
            try {
                const r = await fetch('/api/admin/users', {
                    headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
                });
                const users = await r.json();
                
                tbody.innerHTML = '';
                users.forEach(u => {
                    const tr = document.createElement('tr');
                    tr.innerHTML = `
                        <td>${u.username}</td>
                        <td><span class="badge ${u.role === 'admin' ? 'running' : 'stopped'}">${u.role.toUpperCase()}</span></td>
                        <td>${u.serverCount}</td>
                        <td>${u.suspended ? '<span class="badge suspended">SUSPENDED</span>' : '<span class="badge running">ACTIVE</span>'}</td>
                        <td style="text-align:right">
                            <button class="btn btn-sm btn-secondary edit-btn">Edit</button>
                        </td>
                    `;
                    tr.querySelector('.edit-btn').onclick = () => App.openUserEditModal(u.id, loadUsers);
                    tbody.appendChild(tr);
                });
            } catch (e) {
                console.error(e);
                tbody.innerHTML = '<tr><td colspan="5" class="text-center text-danger">Error loading users</td></tr>';
            }
        };
        
        loadUsers();
    },
    
    renderAdminConfig: async (container) => {
        const tmpl = document.getElementById('admin-config-template').content.cloneNode(true);
        container.innerHTML = '';
        container.appendChild(tmpl);
        
        try {
            const [configRes, statsRes] = await Promise.all([
                fetch('/api/admin/config', { headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` } }),
                fetch('/api/admin/stats', { headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` } })
            ]);
            
            const config = await configRes.json();
            const stats = await statsRes.json();
            
            document.getElementById('cfg-max-servers').value = config.limits?.maxServers || 3;
            document.getElementById('cfg-max-ram').value = config.limits?.maxRam || 2048;
            document.getElementById('cfg-max-disk').value = config.limits?.maxDisk || 50;
            document.getElementById('cfg-max-cpu').value = config.limits?.maxCpu || 400;
            document.getElementById('cfg-max-io').value = config.limits?.maxIo || 100;
            document.getElementById('cfg-min-ram').value = config.limits?.minRam || 512;
            document.getElementById('cfg-min-disk').value = config.limits?.minDisk || 5;
            document.getElementById('cfg-min-cpu').value = config.limits?.minCpu || 25;
            
            document.getElementById('cfg-def-ram').value = config.vm?.defaultRam || 1024;
            document.getElementById('cfg-def-disk').value = parseInt((config.vm?.defaultDisk || '10G').replace('G', ''));
            document.getElementById('cfg-def-cpu').value = config.vm?.defaultCpu || 100;
            document.getElementById('cfg-def-io').value = config.vm?.defaultIo || 0;
            
            document.getElementById('cfg-port').textContent = config.port || 3000;
            document.getElementById('cfg-total-users').textContent = stats.totalUsers;
            document.getElementById('cfg-total-servers').textContent = stats.totalServers;
            document.getElementById('cfg-running').textContent = stats.runningServers;
        } catch (e) { console.error(e); }
        
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
                            maxDisk: parseInt(document.getElementById('cfg-max-disk').value),
                            maxCpu: parseInt(document.getElementById('cfg-max-cpu').value),
                            maxIo: parseInt(document.getElementById('cfg-max-io').value),
                            minRam: parseInt(document.getElementById('cfg-min-ram').value),
                            minDisk: parseInt(document.getElementById('cfg-min-disk').value),
                            minCpu: parseInt(document.getElementById('cfg-min-cpu').value)
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
        
        document.getElementById('defaults-form').onsubmit = async (e) => {
            e.preventDefault();
            const btn = e.target.querySelector('button[type="submit"]');
            btn.disabled = true;
            
            try {
                await fetch('/api/admin/config', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${localStorage.getItem('token')}`
                    },
                    body: JSON.stringify({
                        vm: {
                            defaultRam: parseInt(document.getElementById('cfg-def-ram').value),
                            defaultDisk: document.getElementById('cfg-def-disk').value + 'G',
                            defaultCpu: parseInt(document.getElementById('cfg-def-cpu').value),
                            defaultIo: parseInt(document.getElementById('cfg-def-io').value)
                        }
                    })
                });
                
                document.getElementById('config-success').classList.remove('hidden');
                setTimeout(() => document.getElementById('config-success').classList.add('hidden'), 3000);
            } catch (e) { console.error(e); }
            
            btn.disabled = false;
        };
        
        document.getElementById('btn-stop-all').onclick = async () => {
            const confirmed = await Dialog.confirm('Stop ALL running VMs? This will force stop every VM.', 'Stop All VMs', { danger: true, confirmText: 'Stop All' });
            if (!confirmed) return;
            
            const btn = document.getElementById('btn-stop-all');
            btn.disabled = true;
            btn.textContent = 'Stopping...';
            
            try {
                await fetch('/api/admin/stop-all', {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
                });
                
                const statsRes = await fetch('/api/admin/stats', { 
                    headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` } 
                });
                const stats = await statsRes.json();
                document.getElementById('cfg-running').textContent = stats.runningServers;
            } catch (e) { console.error(e); }
            
            btn.disabled = false;
            btn.innerHTML = '<span class="material-symbols-outlined icon-sm">stop</span> Stop All VMs';
        };
    },
    
    renderAdminAudit: async (container) => {
        const tmpl = document.getElementById('admin-audit-template').content.cloneNode(true);
        container.innerHTML = '';
        container.appendChild(tmpl);
        
        let offset = 0;
        const limit = 50;
        
        const loadLogs = async () => {
            const action = document.getElementById('audit-filter-action').value;
            const params = new URLSearchParams({ limit, offset });
            if (action) params.append('action', action);
            
            const res = await fetch(`/api/admin/audit?${params}`, {
                headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
            });
            const logs = await res.json();
            
            const tbody = document.getElementById('audit-logs-list');
            tbody.innerHTML = logs.map(log => `
                <tr>
                    <td class="text-sm">${new Date(log.timestamp).toLocaleString()}</td>
                    <td>${log.username || '-'}</td>
                    <td><span class="badge">${log.action}</span></td>
                    <td class="text-sm text-muted">${log.serverId ? `VM: ${log.serverId}` : ''} ${log.serverName || ''}</td>
                </tr>
            `).join('') || '<tr><td colspan="4" class="text-muted">No logs found</td></tr>';
            
            document.getElementById('btn-audit-prev').disabled = offset === 0;
            document.getElementById('btn-audit-next').disabled = logs.length < limit;
        };
        
        await loadLogs();
        
        document.getElementById('audit-filter-action').onchange = () => { offset = 0; loadLogs(); };
        document.getElementById('btn-refresh-audit').onclick = loadLogs;
        document.getElementById('btn-audit-prev').onclick = () => { offset = Math.max(0, offset - limit); loadLogs(); };
        document.getElementById('btn-audit-next').onclick = () => { offset += limit; loadLogs(); };
    },
    
    renderAdminMaintenance: async (container) => {
        const tmpl = document.getElementById('admin-maintenance-template').content.cloneNode(true);
        container.innerHTML = '';
        container.appendChild(tmpl);
        
        const res = await fetch('/api/admin/maintenance', {
            headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
        });
        const data = await res.json();
        
        document.getElementById('maint-enabled').checked = data.maintenance;
        document.getElementById('maint-message').value = data.message || '';
        
        const statusDiv = document.getElementById('maintenance-status');
        statusDiv.innerHTML = data.maintenance 
            ? '<div class="alert alert-warning"><span class="material-symbols-outlined icon-sm">warning</span> Maintenance mode is currently ENABLED</div>'
            : '<div class="alert alert-success"><span class="material-symbols-outlined icon-sm">check_circle</span> System is operating normally</div>';
        
        // Load servers and users for transfer
        const [serversRes, usersRes] = await Promise.all([
            fetch('/api/admin/servers?limit=100', { headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` } }),
            fetch('/api/admin/users', { headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` } })
        ]);
        const servers = (await serversRes.json()).servers;
        const users = await usersRes.json();
        
        document.getElementById('transfer-server').innerHTML = '<option value="">Select a VM</option>' + 
            servers.map(s => `<option value="${s.id}">${s.name} (${s.ownerName})</option>`).join('');
        document.getElementById('transfer-user').innerHTML = '<option value="">Select user</option>' +
            users.map(u => `<option value="${u.id}">${u.username}</option>`).join('');
        
        document.getElementById('btn-save-maintenance').onclick = async () => {
            const enabled = document.getElementById('maint-enabled').checked;
            const message = document.getElementById('maint-message').value;
            const stopAllVms = document.getElementById('maint-stop-vms').checked;
            
            await fetch('/api/admin/maintenance', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('token')}` },
                body: JSON.stringify({ enabled, message, stopAllVms })
            });
            
            App.renderAdminMaintenance(container);
        };
        
        document.getElementById('btn-transfer-vm').onclick = async () => {
            const serverId = document.getElementById('transfer-server').value;
            const newOwnerId = document.getElementById('transfer-user').value;
            const statusEl = document.getElementById('transfer-status');
            
            if (!serverId || !newOwnerId) {
                statusEl.textContent = 'Select both VM and new owner';
                statusEl.className = 'text-sm ml-3 text-danger';
                return;
            }
            
            const res = await fetch(`/api/admin/server/${serverId}/transfer`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('token')}` },
                body: JSON.stringify({ newOwnerId })
            });
            
            const data = await res.json();
            if (res.ok) {
                statusEl.textContent = data.message;
                statusEl.className = 'text-sm ml-3 text-success';
                App.renderAdminMaintenance(container);
            } else {
                statusEl.textContent = data.error;
                statusEl.className = 'text-sm ml-3 text-danger';
            }
        };
    },
    
    renderServerSchedules: async (container, id, server) => {
        const tmpl = document.getElementById('server-schedules-template').content.cloneNode(true);
        container.innerHTML = '';
        container.appendChild(tmpl);
        
        const loadSchedules = async () => {
            const res = await fetch(`/api/server/${id}/schedules`, {
                headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
            });
            const data = await res.json();
            const list = document.getElementById('schedules-list');
            
            if (data.schedules && data.schedules.length > 0) {
                list.innerHTML = data.schedules.map(s => `
                    <div class="d-flex justify-between align-center" style="padding: 0.75rem; background: var(--bg-app); border-radius: var(--radius-sm); margin-bottom: 0.5rem;">
                        <div>
                            <span class="badge">${s.action.toUpperCase()}</span>
                            <span class="text-sm ml-2">${s.cronExpression}</span>
                            ${s.lastRun ? `<div class="text-sm text-muted">Last run: ${new Date(s.lastRun).toLocaleString()}</div>` : ''}
                        </div>
                        <button class="btn btn-sm btn-danger btn-delete-sched" data-id="${s.id}">
                            <span class="material-symbols-outlined icon-sm">delete</span>
                        </button>
                    </div>
                `).join('');
                
                list.querySelectorAll('.btn-delete-sched').forEach(btn => {
                    btn.onclick = async () => {
                        const confirmed = await Dialog.confirm('Delete this schedule?', 'Delete Schedule', { danger: true, confirmText: 'Delete' });
                        if (!confirmed) return;
                        await fetch(`/api/server/${id}/schedules/${btn.dataset.id}`, {
                            method: 'DELETE',
                            headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
                        });
                        loadSchedules();
                    };
                });
            } else {
                list.innerHTML = '<div class="text-muted">No schedules yet</div>';
            }
        };
        
        await loadSchedules();
        
        document.getElementById('btn-add-schedule').onclick = () => {
            document.getElementById('schedule-form-container').classList.remove('hidden');
        };
        
        document.getElementById('btn-cancel-schedule').onclick = () => {
            document.getElementById('schedule-form-container').classList.add('hidden');
        };
        
        document.getElementById('btn-save-schedule').onclick = async () => {
            const action = document.getElementById('sched-action').value;
            const hour = document.getElementById('sched-hour').value;
            const minute = document.getElementById('sched-minute').value;
            const days = document.getElementById('sched-days').value;
            
            const cronExpression = `${minute} ${hour} * * ${days}`;
            
            await fetch(`/api/server/${id}/schedules`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('token')}` },
                body: JSON.stringify({ action, cronExpression })
            });
            
            document.getElementById('schedule-form-container').classList.add('hidden');
            loadSchedules();
        };
    },
    
    renderAccountPage: async (container, tab) => {
        const tmpl = document.getElementById('account-template').content.cloneNode(true);
        container.innerHTML = '';
        container.appendChild(tmpl);
        
        const tabs = ['apikeys', 'webhooks', 'prefs', 'activity'];
        tabs.forEach(t => {
            const btn = document.getElementById(`tab-${t}`);
            btn.className = `tab-btn ${t === tab ? 'active' : ''}`;
            btn.onclick = () => App.navigate(`/account/${t}`);
        });
        
        const content = document.getElementById('account-content');
        
        if (tab === 'apikeys') await App.renderApiKeys(content);
        else if (tab === 'webhooks') await App.renderWebhooks(content);
        else if (tab === 'prefs') await App.renderPreferences(content);
        else if (tab === 'activity') await App.renderActivity(content);
    },
    
    renderApiKeys: async (container) => {
        const tmpl = document.getElementById('apikeys-template').content.cloneNode(true);
        container.innerHTML = '';
        container.appendChild(tmpl);
        
        const loadKeys = async () => {
            const res = await fetch('/api/keys', {
                headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
            });
            const data = await res.json();
            const list = document.getElementById('apikeys-list');
            
            if (data.keys && data.keys.length > 0) {
                list.innerHTML = data.keys.map(k => `
                    <div class="d-flex justify-between align-center" style="padding: 0.75rem; background: var(--bg-app); border-radius: var(--radius-sm); margin-bottom: 0.5rem;">
                        <div>
                            <strong>${k.name}</strong>
                            <code class="text-sm ml-2">${k.prefix}</code>
                            <div class="text-sm text-muted">
                                Permissions: ${k.permissions.join(', ')}
                                ${k.lastUsed ? ` • Last used: ${new Date(k.lastUsed).toLocaleDateString()}` : ''}
                            </div>
                        </div>
                        <button class="btn btn-sm btn-danger btn-delete-key" data-id="${k.id}">
                            <span class="material-symbols-outlined icon-sm">delete</span>
                        </button>
                    </div>
                `).join('');
                
                list.querySelectorAll('.btn-delete-key').forEach(btn => {
                    btn.onclick = async () => {
                        const confirmed = await Dialog.confirm('Delete this API key?', 'Delete API Key', { danger: true, confirmText: 'Delete' });
                        if (!confirmed) return;
                        await fetch(`/api/keys/${btn.dataset.id}`, {
                            method: 'DELETE',
                            headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
                        });
                        loadKeys();
                    };
                });
            } else {
                list.innerHTML = '<div class="text-muted">No API keys yet</div>';
            }
        };
        
        await loadKeys();
        
        document.getElementById('btn-create-key').onclick = () => {
            document.getElementById('create-key-form').classList.remove('hidden');
        };
        
        document.getElementById('btn-cancel-key').onclick = () => {
            document.getElementById('create-key-form').classList.add('hidden');
        };
        
        document.getElementById('btn-save-key').onclick = async () => {
            const name = document.getElementById('key-name').value || 'API Key';
            const permissions = [];
            if (document.getElementById('key-perm-read').checked) permissions.push('read');
            if (document.getElementById('key-perm-write').checked) permissions.push('write');
            
            const res = await fetch('/api/keys', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('token')}` },
                body: JSON.stringify({ name, permissions })
            });
            
            const data = await res.json();
            if (data.key) {
                document.getElementById('new-key-value').textContent = data.key;
                document.getElementById('new-key-alert').classList.remove('hidden');
            }
            
            document.getElementById('create-key-form').classList.add('hidden');
            loadKeys();
        };
    },
    
    renderWebhooks: async (container) => {
        const tmpl = document.getElementById('webhooks-template').content.cloneNode(true);
        container.innerHTML = '';
        container.appendChild(tmpl);
        
        const loadWebhooks = async () => {
            const res = await fetch('/api/webhooks', {
                headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
            });
            const data = await res.json();
            const list = document.getElementById('webhooks-list');
            
            if (data.webhooks && data.webhooks.length > 0) {
                list.innerHTML = data.webhooks.map(w => `
                    <div class="d-flex justify-between align-center" style="padding: 0.75rem; background: var(--bg-app); border-radius: var(--radius-sm); margin-bottom: 0.5rem;">
                        <div>
                            <strong>${w.name}</strong>
                            <span class="badge ml-2 ${w.enabled ? '' : 'suspended'}">${w.enabled ? 'ACTIVE' : 'DISABLED'}</span>
                            <div class="text-sm text-muted">${w.url}</div>
                            <div class="text-sm">${w.events.map(e => `<span class="badge" style="font-size: 0.7rem;">${e}</span>`).join(' ')}</div>
                        </div>
                        <div class="d-flex gap-2">
                            <button class="btn btn-sm btn-secondary btn-test-wh" data-id="${w.id}">
                                <span class="material-symbols-outlined icon-sm">send</span>
                            </button>
                            <button class="btn btn-sm btn-danger btn-delete-wh" data-id="${w.id}">
                                <span class="material-symbols-outlined icon-sm">delete</span>
                            </button>
                        </div>
                    </div>
                `).join('');
                
                list.querySelectorAll('.btn-test-wh').forEach(btn => {
                    btn.onclick = async () => {
                        btn.disabled = true;
                        btn.innerHTML = '<span class="material-symbols-outlined icon-sm">hourglass_empty</span>';
                        
                        const res = await fetch(`/api/webhooks/${btn.dataset.id}/test`, {
                            method: 'POST',
                            headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
                        });
                        const data = await res.json();
                        
                        btn.disabled = false;
                        btn.innerHTML = '<span class="material-symbols-outlined icon-sm">send</span>';
                        
                        if (data.success) {
                            await Dialog.success('Webhook test successful!');
                        } else {
                            await Dialog.warning('Webhook test failed: ' + (data.error || 'Unknown error'));
                        }
                    };
                });
                
                list.querySelectorAll('.btn-delete-wh').forEach(btn => {
                    btn.onclick = async () => {
                        const confirmed = await Dialog.confirm('Delete this webhook?', 'Delete Webhook', { danger: true, confirmText: 'Delete' });
                        if (!confirmed) return;
                        await fetch(`/api/webhooks/${btn.dataset.id}`, {
                            method: 'DELETE',
                            headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
                        });
                        loadWebhooks();
                    };
                });
            } else {
                list.innerHTML = '<div class="text-muted">No webhooks yet</div>';
            }
        };
        
        await loadWebhooks();
        
        document.getElementById('btn-create-webhook').onclick = () => {
            document.getElementById('create-webhook-form').classList.remove('hidden');
        };
        
        document.getElementById('btn-cancel-webhook').onclick = () => {
            document.getElementById('create-webhook-form').classList.add('hidden');
        };
        
        document.getElementById('btn-save-webhook').onclick = async () => {
            const name = document.getElementById('wh-name').value || 'Webhook';
            const url = document.getElementById('wh-url').value;
            const secret = document.getElementById('wh-secret').value;
            const events = Array.from(document.querySelectorAll('.wh-event:checked')).map(c => c.value);
            
            if (!url) { await Dialog.warning('URL is required'); return; }
            if (events.length === 0) { await Dialog.warning('Select at least one event'); return; }
            
            await fetch('/api/webhooks', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('token')}` },
                body: JSON.stringify({ name, url, secret, events })
            });
            
            document.getElementById('create-webhook-form').classList.add('hidden');
            loadWebhooks();
        };
    },
    
    renderPreferences: async (container) => {
        const tmpl = document.getElementById('preferences-template').content.cloneNode(true);
        container.innerHTML = '';
        container.appendChild(tmpl);
        
        const res = await fetch('/api/preferences', {
            headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
        });
        const data = await res.json();
        const prefs = data.preferences || {};
        
        document.getElementById('pref-theme').value = App.getTheme();
        document.getElementById('pref-font-size').value = prefs.terminalFontSize || 14;
        document.getElementById('pref-default-view').value = prefs.defaultView || 'console';
        document.getElementById('pref-notifications').checked = prefs.notifications || false;
        
        // Apply theme immediately on change
        document.getElementById('pref-theme').onchange = (e) => {
            App.setTheme(e.target.value);
        };
        
        document.getElementById('btn-save-prefs').onclick = async () => {
            const theme = document.getElementById('pref-theme').value;
            const terminalFontSize = parseInt(document.getElementById('pref-font-size').value);
            const defaultView = document.getElementById('pref-default-view').value;
            const notifications = document.getElementById('pref-notifications').checked;
            
            App.setTheme(theme);
            
            await fetch('/api/preferences', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('token')}` },
                body: JSON.stringify({ theme, terminalFontSize, defaultView, notifications })
            });
            
            document.getElementById('prefs-success').classList.remove('hidden');
            setTimeout(() => document.getElementById('prefs-success').classList.add('hidden'), 2000);
        };
        
        // Security - Revoke all sessions
        document.getElementById('btn-revoke-all-sessions').onclick = async () => {
            const confirmed = await Dialog.confirm('This will log you out from all devices. Continue?', 'Logout All Sessions', { danger: true, confirmText: 'Logout All' });
            if (!confirmed) return;
            
            const btn = document.getElementById('btn-revoke-all-sessions');
            btn.disabled = true;
            btn.textContent = 'Logging out...';
            
            try {
                await fetch('/api/revoke-tokens', {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
                });
                
                localStorage.removeItem('token');
                App.user = null;
                App.navigate('/login');
            } catch (e) {
                btn.disabled = false;
                btn.innerHTML = '<span class="material-symbols-outlined icon-sm">logout</span> Logout All Sessions';
            }
        };
    },
    
    renderActivity: async (container) => {
        const tmpl = document.getElementById('activity-template').content.cloneNode(true);
        container.innerHTML = '';
        container.appendChild(tmpl);
        
        let offset = 0;
        const limit = 20;
        
        const loadActivity = async (append = false) => {
            const res = await fetch(`/api/activity?limit=${limit}&offset=${offset}`, {
                headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
            });
            const logs = await res.json();
            const list = document.getElementById('activity-list');
            
            const html = logs.map(log => `
                <div style="padding: 0.5rem 0; border-bottom: 1px solid var(--border-color);">
                    <span class="badge">${log.action}</span>
                    <span class="text-sm text-muted ml-2">${new Date(log.timestamp).toLocaleString()}</span>
                    ${log.serverName ? `<span class="text-sm ml-2">${log.serverName}</span>` : ''}
                </div>
            `).join('');
            
            if (append) {
                list.innerHTML += html;
            } else {
                list.innerHTML = html || '<div class="text-muted">No activity yet</div>';
            }
            
            document.getElementById('btn-load-more-activity').style.display = logs.length < limit ? 'none' : 'inline-block';
        };
        
        await loadActivity();
        
        document.getElementById('btn-load-more-activity').onclick = () => {
            offset += limit;
            loadActivity(true);
        };
    },
    
    openUserEditModal: async (userId, onSave) => {
        const r = await fetch(`/api/admin/user/${userId}`, {
            headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
        });
        if (!r.ok) { await Dialog.warning('Failed to load user'); return; }
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
            document.getElementById('edit-limit-disk').value = user.limits.maxDisk || '';
            document.getElementById('edit-limit-cpu').value = user.limits.maxCpu || '';
            document.getElementById('edit-limit-io').value = user.limits.maxIo || '';
        }
        
        const serversList = document.getElementById('user-servers-list');
        if (user.servers && user.servers.length > 0) {
            serversList.innerHTML = user.servers.map(s => `
                <div style="padding: 0.5rem; background: var(--bg-app); border-radius: 6px; margin-bottom: 0.5rem;">
                    <strong>${s.name}</strong> - ${s.ram} MB
                    <span class="badge ${s.suspended ? 'suspended' : (s.status === 'running' ? 'running' : 'stopped')}" style="margin-left: 0.5rem;">
                        ${s.suspended ? 'SUSPENDED' : s.status.toUpperCase()}
                    </span>
                </div>
            `).join('');
        } else {
            serversList.textContent = 'No VMs';
        }
        
        document.getElementById('btn-close-user-edit').onclick = () => overlay.remove();
        
        document.getElementById('btn-revoke-tokens').onclick = async () => {
            const confirmed = await Dialog.confirm(`Logout all sessions for ${user.username}?`, 'Logout Sessions', { danger: true, confirmText: 'Logout All' });
            if (!confirmed) return;
            
            const btn = document.getElementById('btn-revoke-tokens');
            btn.disabled = true;
            
            const res = await fetch(`/api/admin/user/${userId}/revoke-tokens`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
            });
            
            btn.disabled = false;
            
            if (res.ok) {
                document.getElementById('user-edit-success').textContent = 'All sessions logged out';
                document.getElementById('user-edit-success').classList.remove('hidden');
                setTimeout(() => document.getElementById('user-edit-success').classList.add('hidden'), 2000);
            } else {
                const data = await res.json();
                await Dialog.warning('Error: ' + data.error);
            }
        };
        
        document.getElementById('btn-delete-user').onclick = async () => {
            const confirmed = await Dialog.confirm(`Delete user ${user.username}? This will delete all their VMs!`, 'Delete User', { danger: true, confirmText: 'Delete' });
            if (!confirmed) return;
            
            const dr = await fetch(`/api/admin/user/${userId}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
            });
            
            if (dr.ok) {
                overlay.remove();
                onSave();
            } else {
                const data = await dr.json();
                await Dialog.warning('Error: ' + data.error);
            }
        };
        
        document.getElementById('user-edit-form').onsubmit = async (e) => {
            e.preventDefault();
            
            const limits = {};
            const maxServers = document.getElementById('edit-limit-servers').value;
            const maxRam = document.getElementById('edit-limit-ram').value;
            const maxDisk = document.getElementById('edit-limit-disk').value;
            const maxCpu = document.getElementById('edit-limit-cpu').value;
            const maxIo = document.getElementById('edit-limit-io').value;
            
            if (maxServers) limits.maxServers = parseInt(maxServers);
            if (maxRam) limits.maxRam = parseInt(maxRam);
            if (maxDisk) limits.maxDisk = parseInt(maxDisk);
            if (maxCpu) limits.maxCpu = parseInt(maxCpu);
            if (maxIo) limits.maxIo = parseInt(maxIo);
            
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
        document.getElementById('edit-server-suspended').checked = server.suspended || false;
        document.getElementById('edit-server-suspend-reason').value = server.suspendReason || '';
        
        const statusBadge = document.getElementById('edit-server-status');
        statusBadge.textContent = server.status?.toUpperCase() || 'STOPPED';
        statusBadge.className = `badge ${server.status === 'running' ? 'running' : 'stopped'}`;
        
        document.getElementById('edit-server-owner').textContent = server.ownerName || '-';
        document.getElementById('edit-server-image').textContent = server.imageName || '-';
        document.getElementById('edit-server-disk').textContent = server.diskSize || '-';
        
        document.getElementById('edit-server-ram').value = server.ram || 1024;
        document.getElementById('edit-server-cpu').value = server.cpuLimit || 100;
        document.getElementById('edit-server-io').value = server.ioLimit || 0;
        
        document.getElementById('btn-close-server-edit').onclick = () => overlay.remove();
        
        document.getElementById('btn-force-stop').onclick = async () => {
            const confirmed = await Dialog.confirm('Force stop this VM?', 'Force Stop', { danger: true, confirmText: 'Force Stop' });
            if (!confirmed) return;
            
            await fetch(`/api/admin/server/${server.id}/force-stop`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
            });
            
            overlay.remove();
            onSave();
        };
        
        document.getElementById('btn-reinstall-admin').onclick = async () => {
            if (server.status === 'running') {
                await Dialog.warning('Stop the VM first');
                return;
            }
            const confirmed = await Dialog.confirm(`Reinstall ${server.name}? This will delete all disk data!`, 'Reinstall VM', { danger: true, confirmText: 'Reinstall' });
            if (!confirmed) return;
            
            await fetch(`/api/admin/server/${server.id}/reinstall`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
            });
            
            overlay.remove();
            onSave();
        };
        
        document.getElementById('btn-delete-server-admin').onclick = async () => {
            const confirmed = await Dialog.confirm(`Delete VM ${server.name}? This cannot be undone!`, 'Delete VM', { danger: true, confirmText: 'Delete' });
            if (!confirmed) return;
            
            const dr = await fetch(`/api/admin/server/${server.id}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
            });
            
            if (dr.ok) {
                overlay.remove();
                onSave();
            } else {
                const data = await dr.json();
                await Dialog.warning('Error: ' + data.error);
            }
        };
        
        document.getElementById('server-edit-form').onsubmit = async (e) => {
            e.preventDefault();
            
            const suspended = document.getElementById('edit-server-suspended').checked;
            const suspendReason = document.getElementById('edit-server-suspend-reason').value;
            
            const payload = {
                name: document.getElementById('edit-server-name').value,
                description: document.getElementById('edit-server-desc').value,
                ram: parseInt(document.getElementById('edit-server-ram').value),
                cpuLimit: parseInt(document.getElementById('edit-server-cpu').value),
                ioLimit: parseInt(document.getElementById('edit-server-io').value)
            };
            
            await fetch(`/api/admin/server/${server.id}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${localStorage.getItem('token')}`
                },
                body: JSON.stringify(payload)
            });
            
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
