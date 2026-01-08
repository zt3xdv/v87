import Dialog from './dialog.js';
import API from './api.js';

const Server = {
    socket: null,
    term: null,
    fitAddon: null,
    vncClient: null,

    cleanupTerminal() {
        if (this.socket) {
            this.socket.disconnect();
            this.socket = null;
        }
        if (this.term) {
            this.term.dispose();
            this.term = null;
        }
    },

    cleanupVnc() {
        if (this.vncClient) {
            this.vncClient.destroy();
            this.vncClient = null;
        }
    },

    async renderCreating(container, serverId, navigate) {
        const data = await API.get(`/api/server/${serverId}`);
        if (!data || data.error) {
            container.innerHTML = '<div class="alert alert-danger">Server not found</div>';
            return;
        }

        const tmpl = document.getElementById('server-creating-template').content.cloneNode(true);
        container.innerHTML = '';
        container.appendChild(tmpl);

        document.getElementById('creating-name').textContent = data.server.name;

        const pollProgress = async () => {
            try {
                const progress = await API.get(`/api/server/${serverId}/creation-progress`);

                document.getElementById('creating-progress').style.width = `${progress.percent}%`;
                document.getElementById('creating-percent').textContent = progress.percent;
                document.getElementById('creating-status').textContent = progress.status || 'Processing...';

                if (progress.complete) {
                    setTimeout(() => navigate(`/server/${serverId}/console`), 500);
                } else {
                    setTimeout(pollProgress, 1000);
                }
            } catch (e) {
                setTimeout(pollProgress, 2000);
            }
        };

        pollProgress();
    },

    async renderPage(container, serverId, navigate, user, view = 'console') {
        container.innerHTML = '<div class="text-center mt-5">Loading VM...</div>';
        
        const data = await API.get(`/api/server/${serverId}`);
        if (!data || data.error) {
            container.innerHTML = '<div class="alert alert-danger">VM not found or access denied</div>';
            return;
        }
        
        const server = data.server;
        const tmpl = document.getElementById('server-layout-template').content.cloneNode(true);
        container.innerHTML = '';
        container.appendChild(tmpl);

        document.getElementById('s-name').textContent = server.name;
        document.getElementById('s-id').textContent = `ID: ${server.id}`;
        document.getElementById('s-image').textContent = data.image?.name || 'Unknown';
        
        if (data.credentials) {
            document.getElementById('s-credentials').innerHTML = `
                <strong>User:</strong> ${data.credentials.user}<br><strong>Password:</strong> ${data.credentials.password}
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
            try {
                const r = await API.post(`/api/server/${serverId}/start`);
                if (r && !r.error) {
                    updateStatus(true);
                } else {
                    await Dialog.warning('Error: ' + (r?.error || 'Unknown error'));
                    btnStart.disabled = false;
                }
            } catch (e) {
                await Dialog.warning('Error starting VM');
                btnStart.disabled = false;
            }
        };
        
        btnStop.onclick = async () => {
            btnStop.disabled = true;
            await API.post(`/api/server/${serverId}/stop`);
            updateStatus(false);
        };

        const tabConsole = document.getElementById('tab-console');
        const tabVnc = document.getElementById('tab-vnc');
        const tabStats = document.getElementById('tab-stats');
        const tabSchedules = document.getElementById('tab-schedules');
        const tabSettings = document.getElementById('tab-settings');
        const serverContent = document.getElementById('server-content');
        
        let currentTab = 'console';
        let statsInterval = null;
        
        const renderCurrentTab = () => {
            tabConsole.className = `tab-btn ${currentTab === 'console' ? 'active' : ''}`;
            tabVnc.className = `tab-btn ${currentTab === 'vnc' ? 'active' : ''}`;
            tabStats.className = `tab-btn ${currentTab === 'stats' ? 'active' : ''}`;
            tabSchedules.className = `tab-btn ${currentTab === 'schedules' ? 'active' : ''}`;
            tabSettings.className = `tab-btn ${currentTab === 'settings' ? 'active' : ''}`;
            
            if (statsInterval) {
                clearInterval(statsInterval);
                statsInterval = null;
            }
            
            this.cleanupVnc();
            
            if (currentTab === 'console') {
                this.renderConsole(serverContent, serverId, updateStatus, server);
            } else if (currentTab === 'vnc') {
                this.cleanupTerminal();
                this.renderVnc(serverContent, serverId, server);
            } else if (currentTab === 'stats') {
                this.cleanupTerminal();
                this.renderStats(serverContent, serverId, (interval) => { statsInterval = interval; });
            } else if (currentTab === 'schedules') {
                this.cleanupTerminal();
                this.renderSchedules(serverContent, serverId);
            } else {
                this.cleanupTerminal();
                this.renderSettings(serverContent, serverId, server, () => updateStatus(server.status === 'running'), navigate);
            }
        };
        
        tabConsole.onclick = () => { if (currentTab !== 'console') { currentTab = 'console'; renderCurrentTab(); } };
        tabVnc.onclick = () => { if (currentTab !== 'vnc') { currentTab = 'vnc'; renderCurrentTab(); } };
        tabStats.onclick = () => { if (currentTab !== 'stats') { currentTab = 'stats'; renderCurrentTab(); } };
        tabSchedules.onclick = () => { if (currentTab !== 'schedules') { currentTab = 'schedules'; renderCurrentTab(); } };
        tabSettings.onclick = () => { if (currentTab !== 'settings') { currentTab = 'settings'; renderCurrentTab(); } };
        
        renderCurrentTab();
    },

    renderConsole(container, serverId, statusCallback, server) {
        const tmpl = document.getElementById('server-console-template').content.cloneNode(true);
        container.innerHTML = '';
        container.appendChild(tmpl);
        
        container.querySelector("#server-url").innerHTML = '<a href="/s/' + serverId + '/">/s/' + serverId + '/</a>';

        this.cleanupTerminal();

        this.term = new Terminal({ 
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
        this.fitAddon = new FitAddon.FitAddon();
        this.term.loadAddon(this.fitAddon);
        this.term.open(document.getElementById('terminal'));
        this.fitAddon.fit();
        
        const fitAddon = this.fitAddon;
        window.addEventListener('resize', () => fitAddon.fit());
        
        this.socket = io({
            auth: { token: localStorage.getItem('token') },
            reconnection: true,
            reconnectionAttempts: Infinity,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            timeout: 20000
        });
        
        const socket = this.socket;
        const term = this.term;
        
        socket.on('connect', () => {
            socket.emit('join-server', serverId);
        });
        
        socket.emit('join-server', serverId);
        
        term.onData(d => socket.emit('input', { serverId, data: d }));
        socket.on('term-data', d => term.write(d));
        socket.on('vm-status', s => {
            const running = s === 'started';
            statusCallback(running);
        });

        socket.on('disconnect', (reason) => {
            if (reason === 'io server disconnect') {
                socket.connect();
            }
        });

        socket.on('connect_error', () => {});
    },

    renderStats(container, serverId, setIntervalCallback) {
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
            
            if (days > 0) return `${days}d ${hours}h`;
            if (hours > 0) return `${hours}h ${mins}m`;
            if (mins > 0) return `${mins}m ${secs}s`;
            return `${secs}s`;
        };
        
        let cpuChart = null;
        let memoryChart = null;
        let diskChart = null;
        const maxDataPoints = 30;
        const cpuHistory = Array(maxDataPoints).fill(0);
        const memoryHistory = Array(maxDataPoints).fill(0);
        
        const chartOptions = {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: '#18181b',
                    titleColor: '#fafafa',
                    bodyColor: '#a1a1aa',
                    borderColor: '#27272a',
                    borderWidth: 1,
                    padding: 10,
                    cornerRadius: 6
                }
            },
            scales: {
                x: { display: false },
                y: {
                    min: 0,
                    max: 100,
                    grid: { color: 'rgba(255,255,255,0.05)' },
                    ticks: { color: '#52525b', font: { size: 10 }, callback: v => v + '%' }
                }
            },
            elements: {
                line: { tension: 0.4, borderWidth: 2 },
                point: { radius: 0, hoverRadius: 4 }
            }
        };
        
        if (typeof Chart !== 'undefined') {
            const cpuCtx = document.getElementById('cpu-chart');
            const memCtx = document.getElementById('memory-chart');
            const diskCtx = document.getElementById('disk-chart');
            
            if (cpuCtx) {
                cpuChart = new Chart(cpuCtx, {
                    type: 'line',
                    data: {
                        labels: Array(maxDataPoints).fill(''),
                        datasets: [{
                            data: cpuHistory,
                            borderColor: '#f59e0b',
                            backgroundColor: 'rgba(245, 158, 11, 0.1)',
                            fill: true
                        }]
                    },
                    options: chartOptions
                });
            }
            
            if (memCtx) {
                memoryChart = new Chart(memCtx, {
                    type: 'line',
                    data: {
                        labels: Array(maxDataPoints).fill(''),
                        datasets: [{
                            data: memoryHistory,
                            borderColor: '#10b981',
                            backgroundColor: 'rgba(16, 185, 129, 0.1)',
                            fill: true
                        }]
                    },
                    options: chartOptions
                });
            }
            
            if (diskCtx) {
                diskChart = new Chart(diskCtx, {
                    type: 'doughnut',
                    data: {
                        labels: ['Used', 'Free'],
                        datasets: [{
                            data: [0, 100],
                            backgroundColor: ['#7c3aed', '#27272a'],
                            borderWidth: 0
                        }]
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: false,
                        cutout: '70%',
                        plugins: {
                            legend: { display: false },
                            tooltip: {
                                backgroundColor: '#18181b',
                                bodyColor: '#a1a1aa',
                                padding: 8,
                                cornerRadius: 4,
                                callbacks: {
                                    label: ctx => `${ctx.label}: ${ctx.raw}%`
                                }
                            }
                        }
                    }
                });
            }
        }
        
        const updateStats = async () => {
            try {
                const stats = await API.get(`/api/server/${serverId}/stats`);
                
                if (!stats.running) {
                    document.getElementById('stats-offline').classList.remove('hidden');
                    document.getElementById('stats-content').style.opacity = '0.5';
                    return;
                }
                
                document.getElementById('stats-offline').classList.add('hidden');
                document.getElementById('stats-content').style.opacity = '1';
                
                document.getElementById('stat-uptime').textContent = formatUptime(stats.uptime || 0);
                
                const cpuUsage = stats.cpuUsage !== undefined ? stats.cpuUsage : 0;
                document.getElementById('stat-cpu').textContent = `${cpuUsage}%`;
                
                if (stats.cpu) {
                    const active = stats.cpu.cpus.filter(c => !c.halted).length;
                    document.getElementById('stat-cpu-cores').textContent = `${active}/${stats.cpu.count} cores`;
                }
                
                let memUsagePercent = 0;
                if (stats.memory) {
                    document.getElementById('stat-memory').textContent = `${stats.memory.actual}/${stats.memory.configured} MB`;
                    memUsagePercent = Math.round((stats.memory.actual / stats.memory.configured) * 100);
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
                const startedEl = document.getElementById('stat-started');
                if (startedEl) {
                    startedEl.textContent = stats.startedAt ? new Date(stats.startedAt).toLocaleTimeString() : '-';
                }
                
                if (cpuChart) {
                    cpuHistory.shift();
                    cpuHistory.push(cpuUsage);
                    cpuChart.data.datasets[0].data = cpuHistory;
                    cpuChart.update('none');
                }
                
                if (memoryChart) {
                    memoryHistory.shift();
                    memoryHistory.push(memUsagePercent);
                    memoryChart.data.datasets[0].data = memoryHistory;
                    memoryChart.update('none');
                }
                
                if (diskChart && stats.diskUsage) {
                    const used = stats.diskUsage.usedPercent || 30;
                    diskChart.data.datasets[0].data = [used, 100 - used];
                    diskChart.update();
                }
                
            } catch (e) {
                console.error('Failed to fetch stats:', e);
            }
        };
        
        updateStats();
        const interval = window.setInterval(updateStats, 2000);
        if (setIntervalCallback) setIntervalCallback(interval);
    },

    async renderSettings(container, serverId, server, onUpdate, navigate) {
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
            const limits = await API.get(`/api/server/${serverId}/limits`);
            if (limits && !limits.error) {
                document.getElementById('set-ram').value = limits.ram || 1024;
                document.getElementById('set-cpu').value = limits.cpuLimit || 100;
                document.getElementById('set-io').value = limits.ioLimit || 0;
                document.getElementById('set-cores').value = limits.cpuCores || 1;
            }
        } catch {}
        
        document.getElementById('set-disk-size').textContent = server.diskSize || '-';
        
        try {
            const disk = await API.get(`/api/server/${serverId}/disk-info`);
            if (disk && !disk.error) {
                document.getElementById('set-disk-virtual').textContent = disk.virtualSize || '-';
                document.getElementById('set-disk-actual').textContent = disk.actualSize || '-';
            }
        } catch {}
        
        document.getElementById('btn-save-info').onclick = async () => {
            const btn = document.getElementById('btn-save-info');
            btn.disabled = true;
            btn.textContent = 'Saving...';
            
            await API.post(`/api/server/${serverId}/settings`, {
                name: document.getElementById('set-name').value,
                description: document.getElementById('set-desc').value
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
            
            const data = await API.post(`/api/server/${serverId}/limits`, {
                ram: parseInt(document.getElementById('set-ram').value),
                cpuLimit: parseInt(document.getElementById('set-cpu').value),
                ioLimit: parseInt(document.getElementById('set-io').value),
                cpuCores: parseInt(document.getElementById('set-cores').value)
            });
            
            if (data && data.requiresRestart) {
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
            
            const res = await API.post(`/api/server/${serverId}/reinstall`);
            
            if (res && res.success !== false && !res.error) {
                navigate(`/server/${serverId}/creating`);
            } else {
                await Dialog.warning('Error: ' + (res?.error || 'Unknown error'));
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
            
            await API.delete(`/api/server/${serverId}`);
            navigate('/dashboard');
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
                    await API.post(`/api/server/${serverId}/tags`, { tags: newTags });
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
            await API.post(`/api/server/${serverId}/tags`, { tags: newTags });
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
            
            await API.post(`/api/server/${serverId}/notes`, { notes });
            
            btn.innerHTML = '<span class="material-symbols-outlined icon-sm">check</span> Saved';
            setTimeout(() => {
                btn.innerHTML = '<span class="material-symbols-outlined icon-sm">save</span> Save Notes';
                btn.disabled = false;
            }, 2000);
        };
        
        // Alerts
        const loadAlerts = async () => {
            const data = await API.get('/api/alerts');
            const serverAlerts = (data.alerts || []).filter(a => a.serverId === serverId);
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
                        await API.delete(`/api/alerts/${btn.dataset.id}`);
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
            
            await API.post('/api/alerts', { serverId, metric, comparison, threshold, action });
            
            document.getElementById('alert-form-container').classList.add('hidden');
            loadAlerts();
        };
    },

    async renderSchedules(container, serverId) {
        const tmpl = document.getElementById('server-schedules-template').content.cloneNode(true);
        container.innerHTML = '';
        container.appendChild(tmpl);
        
        const loadSchedules = async () => {
            const data = await API.get(`/api/server/${serverId}/schedules`);
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
                        await API.delete(`/api/server/${serverId}/schedules/${btn.dataset.id}`);
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
            
            await API.post(`/api/server/${serverId}/schedules`, { action, cronExpression });
            
            document.getElementById('schedule-form-container').classList.add('hidden');
            loadSchedules();
        };
    },

    renderVnc(container, serverId, server) {
        const tmpl = document.getElementById('server-vnc-template').content.cloneNode(true);
        container.innerHTML = '';
        container.appendChild(tmpl);
        
        const vncContainer = document.getElementById('vnc-container');
        const placeholder = document.getElementById('vnc-placeholder');
        const statusBadge = document.getElementById('vnc-status');
        const connectBtn = document.getElementById('btn-vnc-connect');
        const fullscreenBtn = document.getElementById('btn-vnc-fullscreen');
        const codeBtn = document.getElementById('btn-vnc-code');
        
        let connected = false;
        
        const updateStatus = (status) => {
            statusBadge.textContent = status.toUpperCase();
            statusBadge.className = `badge ${status === 'connected' ? 'running' : status === 'connecting' ? '' : 'stopped'}`;
            connectBtn.innerHTML = status === 'connected' 
                ? '<span class="material-symbols-outlined icon-sm">power_off</span> Disconnect'
                : '<span class="material-symbols-outlined icon-sm">power</span> Connect';
            fullscreenBtn.disabled = status !== 'connected';
        };
        
        const self = this;
        
        connectBtn.onclick = () => {
            if (connected) {
                self.cleanupVnc();
                placeholder.style.display = 'block';
                connected = false;
                updateStatus('disconnected');
                return;
            }
            
            placeholder.style.display = 'none';
            updateStatus('connecting');
            
            self.cleanupVnc();
            
            vncContainer.innerHTML = "";
            
            self.vncClient = new VNCClient(vncContainer, {
                onConnect: () => {
                    connected = true;
                    updateStatus('connected');
                },
                onDisconnect: () => {
                    connected = false;
                    updateStatus('disconnected');
                    placeholder.style.display = 'block';
                },
                onError: (err) => {
                    Dialog.warning(err, 'VNC Error');
                    connected = false;
                    updateStatus('disconnected');
                    placeholder.style.display = 'block';
                }
            });
            
            self.vncClient.connect(serverId, localStorage.getItem('token'));
        };
        
        fullscreenBtn.onclick = () => {
            if (self.vncClient && self.vncClient.canvas) {
                if (self.vncClient.canvas.requestFullscreen) {
                    self.vncClient.canvas.requestFullscreen();
                } else if (self.vncClient.canvas.webkitRequestFullscreen) {
                    self.vncClient.canvas.webkitRequestFullscreen();
                }
            }
        };
        
        codeBtn.onclick = async () => {
            try {
                const data = await API.get(`/api/server/${serverId}/vnc-code`);
                
                if (data.error) {
                    Dialog.warning(data.error, 'VNC Bridge');
                    return;
                }
                
                const codeHtml = `
                    <div style="margin-bottom: 1rem;">
                        <p class="text-sm text-muted mb-2">Use this code with <strong>vncbridge</strong> to connect from a native VNC client:</p>
                        <div style="background: #1a1a1a; padding: 0.75rem; border-radius: 4px; word-break: break-all; font-family: monospace; font-size: 11px; max-height: 100px; overflow-y: auto;">
                            ${data.code}
                        </div>
                    </div>
                    <div class="text-sm text-muted">
                        <p><strong>Usage:</strong></p>
                        <code style="display: block; background: #1a1a1a; padding: 0.5rem; border-radius: 4px; margin-top: 0.5rem;">
                            npx vncbridge -p 5900
                        </code>
                        <p class="mt-2">Then connect your VNC client to <strong>127.0.0.1:5900</strong></p>
                    </div>
                `;
                
                Dialog.alert('VNC Bridge Code', codeHtml, { confirmText: 'Copy Code' }).then(() => {
                    navigator.clipboard.writeText(data.code).then(() => {
                        Dialog.success('Code copied to clipboard!', 'Copied');
                    }).catch(() => {});
                });
            } catch (err) {
                Dialog.warning('Failed to get VNC code', 'Error');
            }
        };
    }
};

export default Server;
